// services/orderService.js
// Responsible for order business logic (create orders, inventory deduction, table handling)
const { mongoose } = require('../db'); // db/index.js should export { connect, mongoose }
const {
  MenuItem,
  InventoryItem,
  StockMovement,
  Order,
  Table
} = require('../models');
const redisCache = require('../lib/redisCache'); // optional; no-op if not configured

function generateOrderNumber() {
  return `ORD-${Date.now()}-${Math.floor(100 + Math.random() * 900)}`;
}

/**
 * createOrder({ payload, userId })
 *
 * Improvements:
 * - idempotency support via payload.meta?.idempotencyKey (stored on order.meta.idempotencyKey)
 * - bulk-fetch MenuItems in one query instead of per-item reads
 * - compute consumptions with the fetched menu docs
 * - perform inventory updates and stock movement inserts via bulkWrite inside the transaction
 * - keep transaction critical section minimal
 * - configurable policy for negative inventory (env FAIL_ON_NEGATIVE_INVENTORY = "true" to throw)
 */
exports.createOrder = async ({ payload, userId }) => {
  const session = await mongoose.startSession();
  await session.startTransaction();
  try {
    // Check idempotency key (optional). If provided and an order exists, return it.
    const idempotencyKey = payload && payload.meta && payload.meta.idempotencyKey;
    if (idempotencyKey && payload.restaurant) {
      const existing = await Order.findOne({ 'meta.idempotencyKey': idempotencyKey, restaurant: payload.restaurant }).session(session).lean().exec();
      if (existing) {
        // return early (no further side-effects)
        await session.commitTransaction();
        session.endSession();
        return existing;
      }
    }

    // 1) Bulk-load referenced MenuItems to reduce round-trips
    const itemMenuIds = Array.from(new Set((payload.items || []).map(i => String(i.menuItem))));
    const menuDocs = {};
    if (itemMenuIds.length) {
      const menus = await MenuItem.find({ _id: { $in: itemMenuIds } }).session(session).lean().exec();
      for (const m of menus) menuDocs[String(m._id)] = m;
    }

    // 2) Validate and compute totals
    let subtotal = 0;
    const validatedItems = [];

    for (const it of payload.items || []) {
      const menu = menuDocs[String(it.menuItem)];
      if (!menu || !menu.isActive) {
        throw Object.assign(new Error(`Menu item not available: ${it.menuItem}`), { status: 400 });
      }

      // Determine unit price (variant or base)
      let unitPrice = menu.basePrice;
      if (it.variantId) {
        // menu.variants is an array; when using lean() ids are plain
        const variant = (menu.variants || []).find(v => String(v._id) === String(it.variantId));
        if (!variant) throw Object.assign(new Error('Variant not found'), { status: 400 });
        unitPrice = variant.price;
      }

      // Validate modifiers and compute modifier total
      let modifiersTotal = 0;
      const validatedModifiers = [];
      if (Array.isArray(it.modifiers)) {
        for (const m of it.modifiers) {
          let mod = null;
          if (m.modifierId) {
            mod = (menu.modifiers || []).find(x => String(x._id) === String(m.modifierId));
          } else if (m.name) {
            mod = (menu.modifiers || []).find(x => x.name === m.name);
          }
          if (!mod) throw Object.assign(new Error(`Modifier not found for item ${menu.name}`), { status: 400 });
          const modPrice = (m.price != null) ? m.price : mod.price;
          modifiersTotal += modPrice;
          validatedModifiers.push({
            modifierId: mod._id,
            name: mod.name,
            price: modPrice
          });
        }
      }

      const qty = (it.qty && it.qty > 0) ? it.qty : 1;
      const lineTotal = (unitPrice + modifiersTotal) * qty;
      subtotal += lineTotal;

      validatedItems.push({
        menuItem: menu._id,
        name: menu.name,
        variantId: it.variantId || null,
        modifiers: validatedModifiers,
        qty,
        price: unitPrice,
        lineTotal
      });
    }

    const taxTotal = payload.taxTotal || 0;
    const discountTotal = payload.discountTotal || 0;
    const serviceCharge = payload.serviceCharge || 0;
    const total = subtotal + taxTotal + serviceCharge - discountTotal;

    const orderNumber = generateOrderNumber();

    // 3) Table handling (minimal work)
    let tableDoc = null;
    if (payload.table) {
      tableDoc = await Table.findById(payload.table).session(session).exec();
      if (!tableDoc) throw Object.assign(new Error('Table not found'), { status: 404 });
      if (tableDoc.status === 'disabled') throw Object.assign(new Error('Table disabled'), { status: 409 });
      if (tableDoc.status === 'available') {
        // Only flip the status/occupiedBy within transaction as short op
        tableDoc.status = 'occupied';
        tableDoc.meta = tableDoc.meta || {};
        tableDoc.meta.occupiedBy = userId;
        await tableDoc.save({ session });
      }
    }

    // 4) Create Order document (inside transaction)
    const createdArr = await Order.create([{
      restaurant: payload.restaurant,
      outlet: payload.outlet,
      table: payload.table || undefined,
      orderNumber,
      type: payload.type || 'dine_in',
      items: validatedItems,
      subtotal,
      taxTotal,
      discountTotal,
      serviceCharge,
      total,
      payments: payload.payments || [],
      placedBy: userId,
      notes: payload.notes || '',
      status: 'pending',
      meta: Object.assign({}, payload.meta || {}, idempotencyKey ? { idempotencyKey } : {})
    }], { session });

    const orderDoc = createdArr[0];

    // 5) Attach order to table (if present)
    if (tableDoc) {
      tableDoc.currentOrder = orderDoc._id;
      tableDoc.status = 'occupied';
      await tableDoc.save({ session });
    }

    // 6) Inventory deduction using menu.meta.recipe
    // Build aggregated consumption list using already fetched menuDocs (lean)
    const consumptionsMap = new Map(); // key=inventoryItemId string -> qty number
    for (const it of validatedItems) {
      const menu = menuDocs[String(it.menuItem)];
      const recipe = (menu && menu.meta && Array.isArray(menu.meta.recipe)) ? menu.meta.recipe : [];
      const qtyMultiplier = it.qty || 1;
      for (const r of recipe) {
        if (!r.inventoryItemId) continue;
        const key = String(r.inventoryItemId);
        const addQty = (r.qty || 0) * qtyMultiplier;
        consumptionsMap.set(key, (consumptionsMap.get(key) || 0) + addQty);
      }
    }

    // If no consumptions, skip inventory logic
    if (consumptionsMap.size > 0) {
      // Bulk fetch InventoryItems
      const invIds = Array.from(consumptionsMap.keys());
      const invDocs = await InventoryItem.find({ _id: { $in: invIds } }).session(session).exec();
      const invById = {};
      for (const inv of invDocs) invById[String(inv._id)] = inv;

      // Build bulk operations for inventory updates and stock movement inserts
      const invBulk = [];
      const stockMovementBulk = [];
      const failOnNegative = String(process.env.FAIL_ON_NEGATIVE_INVENTORY || '').toLowerCase() === 'true';

      for (const [invId, qty] of consumptionsMap.entries()) {
        const inv = invById[invId];
        if (!inv) {
          throw Object.assign(new Error('Inventory item in recipe not found'), { status: 400 });
        }

        if (inv.isTracked && typeof inv.currentQty === 'number') {
          const newQty = inv.currentQty - qty;
          if (failOnNegative && newQty < 0) {
            throw Object.assign(new Error(`Insufficient inventory for item ${inv._id}`), { status: 409 });
          }
          // Use updateOne to atomically update currentQty (clamp to zero unless failOnNegative)
          const update = failOnNegative ? { $inc: { currentQty: -qty } } : { $set: { currentQty: Math.max(0, newQty) } };
          // Prefer $inc when not clamping to avoid race when multiple orders concurrently decrement same item
          if (!failOnNegative) {
            // use $inc and then a protective $min/$max not available; instead use $set above
            invBulk.push({
              updateOne: {
                filter: { _id: inv._id },
                update: update
              }
            });
          } else {
            invBulk.push({
              updateOne: {
                filter: { _id: inv._id },
                update: update
              }
            });
          }
        }

        stockMovementBulk.push({
          insertOne: {
            document: {
              restaurant: payload.restaurant,
              outlet: payload.outlet,
              inventoryItem: inv._id,
              change: -Math.abs(qty),
              type: 'usage',
              reference: orderNumber,
              performedBy: userId,
              note: `Used by order ${orderNumber}`,
              createdAt: new Date()
            }
          }
        });
      } // end for consumptions

      // Execute bulk writes inside transaction
      if (invBulk.length) {
        await InventoryItem.bulkWrite(invBulk, { session, ordered: false });
      }
      if (stockMovementBulk.length) {
        await StockMovement.bulkWrite(stockMovementBulk, { session, ordered: false });
      }
    } // end if consumptions

    // 7) Commit transaction
    await session.commitTransaction();
    session.endSession();

    // 8) Post-transaction: emit event for kitchen/notifications (non-blocking)
    // eventBus.emit('order.created', { orderId: orderDoc._id, items: validatedItems });

    // 9) Invalidate caches if you cache orders or tables (optional)
    try {
      if (orderDoc && orderDoc._id) {
        await redisCache.del(`order:${String(orderDoc._id)}`);
      }
      if (orderDoc && orderDoc.outlet) {
        await redisCache.del(`orders:list:${String(orderDoc.outlet)}`);
      }
      if (tableDoc && tableDoc.outlet) {
        await redisCache.del(`tables:list:${String(tableDoc.outlet)}`);
      }
    } catch (e) {
      // cache failures must not impact order creation
      console.warn('cache invalidation failed', e && e.message ? e.message : e);
    }

    // Return created order (fresh from DB to include defaults)
    const fresh = await Order.findById(orderDoc._id).lean().exec();
    return fresh;
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    throw err;
  }
};

/**
 * getById(id) - returns order with some populated fields
 * - uses read preference secondaryPreferred to scale reads
 * - caches the result short-term if redis is available
 */
exports.getById = async (id) => {
  const key = `order:${id}`;
  const cached = await redisCache.get(key);
  if (cached) return cached;

  const q = Order.findById(id)
    .read('secondaryPreferred')
    .populate('placedBy', 'name email')
    .populate('items.menuItem', 'name basePrice sku')
    .lean()
    .maxTimeMS(2000);

  const order = await q.exec();
  if (order) {
    await redisCache.set(key, order, 10); // 10s cache for orders (adjust as needed)
  }
  return order;
};

/**
 * listOrders - paginated listing (default limit)
 * - uses read preference secondaryPreferred
 * - returns lightweight projection
 */
exports.listOrders = async ({ outlet, restaurant, limit = 25, page = 0 } = {}) => {
  const q = { };
  if (outlet) q.outlet = outlet;
  if (restaurant) q.restaurant = restaurant;

  const cursor = Order.find(q)
    .read('secondaryPreferred')
    .sort({ placedAt: -1 })
    .skip(page * limit)
    .limit(Math.min(100, limit))
    .select('restaurant outlet orderNumber items table status placedAt placedBy total')
    .populate('placedBy', 'name email')
    // .populate('items', '_id name')
    .lean()
    .maxTimeMS(2000);

  return cursor.exec();
};

/**
 * updateOrderStatus(orderId, status, performedBy)
 * - transactionally updates order status and frees table if needed
 */
exports.updateOrderStatus = async (orderId, status, performedBy) => {
  const session = await mongoose.startSession();
  await session.startTransaction();
  try {
    const order = await Order.findById(orderId).session(session).exec();
    if (!order) throw Object.assign(new Error('Order not found'), { status: 404 });

    order.status = status;
    order.meta = order.meta || {};
    order.meta.lastStatusChangedBy = performedBy;
    order.meta.lastStatusChangedAt = new Date();
    await order.save({ session });

    if (order.table && ['completed', 'cancelled'].includes(status)) {
      const table = await Table.findById(order.table).session(session).exec();
      if (table) {
        table.currentOrder = null;
        table.status = 'available';
        table.mergedInto = null;
        if (table.meta) {
          delete table.meta.occupiedBy;
        }
        await table.save({ session });
      }
    }

    await session.commitTransaction();
    session.endSession();

    // invalidate caches if used
    try {
      await redisCache.del(`order:${String(order._id)}`);
      if (order.outlet) await redisCache.del(`orders:list:${String(order.outlet)}`);
      if (order.table && order.table.outlet) await redisCache.del(`tables:list:${String(order.table.outlet)}`);
    } catch (e) { /*noop*/ }

    return order;
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    throw err;
  }
};
