// services/orderService.js
const { mongoose } = require('../db'); // must export mongoose
const {
  MenuItem,
  InventoryItem,
  StockMovement,
  Order,
  Table,
  // Payment model optional - we keep payments embedded in Order
} = require('../models');

const redisCache = require('../lib/redisCache'); // optional noop

const FAIL_ON_NEGATIVE = String(process.env.FAIL_ON_NEGATIVE_INVENTORY || '').toLowerCase() === 'true';

function generateOrderNumber() {
  return `ORD-${Date.now()}-${Math.floor(100 + Math.random() * 900)}`;
}

async function recalculateTotals(order) {
  // order.items: [{ price, qty, discount?, taxes? , modifiers? }]
  let subtotal = 0;
  for (const it of order.items || []) {
    const modTotal = (it.modifiers || []).reduce((s, m) => s + (m.price || 0), 0);
    const line = (it.price + modTotal) * (it.qty || 1);
    subtotal += line - (it.discount || 0);
  }
  const taxTotal = order.taxTotal || 0; // keeping server-provided tax or compute via rules
  const discountTotal = order.discountTotal || 0;
  const serviceCharge = order.serviceCharge || 0;
  const total = subtotal + taxTotal + serviceCharge - discountTotal;
  order.subtotal = subtotal;
  order.total = total;
  return order;
}

/**
 * computeConsumptions(validatedItems)
 * returns map { inventoryItemIdString => qty }
 * validatedItems must be items with menuItem IDs and qty.
 */
function computeConsumptionsFromMenus(menuDocs, validatedItems) {
  const map = new Map();
  for (const it of validatedItems) {
    const menu = menuDocs[String(it.menuItem)];
    if (!menu) continue;
    const recipe = (menu.meta && Array.isArray(menu.meta.recipe)) ? menu.meta.recipe : [];
    const qty = it.qty || 1;
    for (const r of recipe) {
      if (!r.inventoryItemId) continue;
      const key = String(r.inventoryItemId);
      const add = (r.qty || 0) * qty;
      map.set(key, (map.get(key) || 0) + add);
    }
  }
  return map;
}

/**
 * applyConsumptions(session, consumptionsMap, opts)
 * - performs bulk updates on InventoryItem and creates StockMovement docs
 * - consumptionsMap: Map(inventoryItemIdStr => qtyNumber)
 */
async function applyConsumptions(session, consumptionsMap, payload) {
  if (!consumptionsMap || consumptionsMap.size === 0) return;
  const invIds = Array.from(consumptionsMap.keys()).map(id => mongoose.Types.ObjectId(id));
  const invDocs = await InventoryItem.find({ _id: { $in: invIds } }).session(session).exec();
  const invById = {};
  for (const inv of invDocs) invById[String(inv._id)] = inv;

  const invBulk = [];
  const stockBulk = [];

  for (const [invIdStr, qty] of consumptionsMap.entries()) {
    const inv = invById[invIdStr];
    if (!inv) throw Object.assign(new Error(`Inventory item ${invIdStr} not found`), { status: 400 });
    if (inv.isTracked && typeof inv.currentQty === 'number') {
      const newQty = inv.currentQty - qty;
      if (FAIL_ON_NEGATIVE && newQty < 0) {
        throw Object.assign(new Error(`Insufficient stock for ${inv.name}`), { status: 409 });
      }
      // Use $inc for atomic decrement; if not failing on negative we clamp after read or via pipeline in newer Mongo.
      invBulk.push({
        updateOne: {
          filter: { _id: inv._id },
          update: { $inc: { currentQty: -qty } }
        }
      });
    }
    stockBulk.push({
      insertOne: {
        document: {
          restaurant: payload.restaurant,
          outlet: payload.outlet,
          inventoryItem: inv._id,
          change: -Math.abs(qty),
          type: 'usage',
          reference: payload.reference || null,
          performedBy: payload.performedBy || null,
          note: payload.note || `Used by order ${payload.orderNumber || ''}`,
          createdAt: new Date()
        }
      }
    });
  }

  if (invBulk.length) await InventoryItem.bulkWrite(invBulk, { session, ordered: false });
  if (stockBulk.length) await StockMovement.bulkWrite(stockBulk, { session, ordered: false });
}

/* ---------------------- Public API ---------------------- */

exports.createOrder = async ({ payload, userId }) => {
  const session = await mongoose.startSession();
  await session.startTransaction();
  try {
    // idempotency
    const idempotencyKey = payload.meta && payload.meta.idempotencyKey;
    if (idempotencyKey && payload.restaurant) {
      const existing = await Order.findOne({ 'meta.idempotencyKey': idempotencyKey, restaurant: payload.restaurant }).session(session).lean().exec();
      if (existing) {
        await session.commitTransaction();
        session.endSession();
        return existing;
      }
    }

    // Bulk load menu docs referenced
    const menuIds = Array.from(new Set((payload.items || []).map(i => String(i.menuItem))));
    const menuDocs = {};
    if (menuIds.length) {
      const menus = await MenuItem.find({ _id: { $in: menuIds } }).session(session).lean().exec();
      for (const m of menus) menuDocs[String(m._id)] = m;
    }

    // validate items and prepare validatedItems
    const validatedItems = [];
    for (const it of (payload.items || [])) {
      const menu = menuDocs[String(it.menuItem)];
      if (!menu || !menu.isActive) throw Object.assign(new Error(`Menu not available: ${it.menuItem}`), { status: 400 });
      let unitPrice = menu.basePrice;
      if (it.variantId) {
        const variant = (menu.variants || []).find(v => String(v._id) === String(it.variantId));
        if (!variant) throw Object.assign(new Error('Variant not found'), { status: 400 });
        unitPrice = variant.price;
      }
      const modifiers = [];
      let modifiersTotal = 0;
      if (Array.isArray(it.modifiers)) {
        for (const m of it.modifiers) {
          let mod = null;
          if (m.modifierId) mod = (menu.modifiers || []).find(x => String(x._id) === String(m.modifierId));
          else if (m.name) mod = (menu.modifiers || []).find(x => x.name === m.name);
          if (!mod) throw Object.assign(new Error(`Modifier not found on ${menu.name}`), { status: 400 });
          const price = (m.price != null) ? m.price : mod.price;
          modifiers.push({ modifierId: mod._id, name: mod.name, price });
          modifiersTotal += price;
        }
      }
      const qty = (it.qty && it.qty > 0) ? it.qty : 1;
      validatedItems.push({
        menuItem: menu._id,
        name: menu.name,
        variantId: it.variantId || null,
        modifiers,
        qty,
        price: unitPrice,
        discount: it.discount || 0
      });
    }

    // compute totals
    let order = {
      restaurant: payload.restaurant,
      outlet: payload.outlet,
      table: payload.table,
      items: validatedItems,
      taxTotal: payload.taxTotal || 0,
      discountTotal: payload.discountTotal || 0,
      serviceCharge: payload.serviceCharge || 0,
      payments: payload.payments || [],
      notes: payload.notes || '',
      placedBy: userId,
      status: 'pending',
      meta: Object.assign({}, payload.meta || {}, idempotencyKey ? { idempotencyKey } : {})
    };
    order = await recalculateTotals(order);
    order.orderNumber = generateOrderNumber();

    // table handling
    let tableDoc = null;
    if (order.table) {
      tableDoc = await Table.findById(order.table).session(session).exec();
      if (!tableDoc) throw Object.assign(new Error('Table not found'), { status: 404 });
      if (tableDoc.status === 'disabled') throw Object.assign(new Error('Table disabled'), { status: 409 });
      if (tableDoc.status === 'available') {
        tableDoc.status = 'occupied';
        tableDoc.meta = tableDoc.meta || {};
        tableDoc.meta.occupiedBy = userId;
        await tableDoc.save({ session });
      }
    }

    // create order
    const created = await Order.create([order], { session });
    const orderDoc = created[0];

    // attach to table
    if (tableDoc) {
      tableDoc.currentOrder = orderDoc._id;
      tableDoc.status = 'occupied';
      await tableDoc.save({ session });
    }

    // compute consumptions and apply
    const consumptionsMap = computeConsumptionsFromMenus(menuDocs, validatedItems); // Map<string, qty>
    if (consumptionsMap.size > 0) {
      await applyConsumptions(session, consumptionsMap, {
        restaurant: orderDoc.restaurant,
        outlet: orderDoc.outlet,
        orderNumber: orderDoc.orderNumber,
        performedBy: userId,
        note: `Usage for ${orderDoc.orderNumber}`
      });
    }

    await session.commitTransaction();
    session.endSession();

    // optional cache invalidation
    try {
      if (redisCache && redisCache.del) {
        await redisCache.del(`orders:list:${String(orderDoc.outlet)}`);
        await redisCache.del(`table:${String(orderDoc.table)}`);
      }
    } catch (e) { /* noop */ }

    return await Order.findById(orderDoc._id).lean().exec();
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    throw err;
  }
};

/* listOrders, getById already included in your earlier code — provide lightweight versions */

exports.listOrders = async ({ outlet, restaurant, limit = 25, page = 0 } = {}) => {
  const q = {};
  if (outlet) q.outlet = outlet;
  if (restaurant) q.restaurant = restaurant;
  return Order.find(q)
    .sort({ placedAt: -1 })
    .skip(page * limit)
    .limit(Math.min(100, limit))
    .select('restaurant outlet orderNumber items table status placedAt placedBy total')
    .populate('placedBy', 'name email')
    .lean()
    .exec();
};

exports.getById = async (id) => {
  return Order.findById(id)
    .populate('placedBy', 'name email')
    .populate('items.menuItem', 'name basePrice sku')
    .lean()
    .exec();
};

/* addItems: add line items to an existing order (recalculate totals and consume inventory) */
exports.addItems = async ({ orderId, items, userId }) => {
  const session = await mongoose.startSession();
  await session.startTransaction();
  try {
    const order = await Order.findById(orderId).session(session).exec();
    if (!order) throw Object.assign(new Error('Order not found'), { status: 404 });
    if (['completed','cancelled'].includes(order.status)) throw Object.assign(new Error('Cannot modify closed order'), { status: 409 });

    // bulk load menus
    const menuIds = Array.from(new Set(items.map(i => String(i.menuItem))));
    const menus = await MenuItem.find({ _id: { $in: menuIds } }).session(session).lean().exec();
    const menuDocs = {};
    for (const m of menus) menuDocs[String(m._id)] = m;

    // validate incoming items (reuse logic from createOrder)
    const validated = [];
    for (const it of items) {
      const menu = menuDocs[String(it.menuItem)];
      if (!menu || !menu.isActive) throw Object.assign(new Error('Menu not available'), { status: 400 });
      let unitPrice = menu.basePrice;
      if (it.variantId) {
        const variant = (menu.variants || []).find(v => String(v._id) === String(it.variantId));
        if (!variant) throw Object.assign(new Error('Variant not found'), { status: 400 });
        unitPrice = variant.price;
      }
      const modifiers = [];
      if (Array.isArray(it.modifiers)) {
        for (const m of it.modifiers) {
          const mod = (menu.modifiers || []).find(x => String(x._id) === String(m.modifierId) || x.name === m.name);
          if (!mod) throw Object.assign(new Error('Modifier not found'), { status: 400 });
          const price = (m.price != null) ? m.price : mod.price;
          modifiers.push({ modifierId: mod._id, name: mod.name, price });
        }
      }
      validated.push({
        menuItem: menu._id,
        name: menu.name,
        variantId: it.variantId || null,
        modifiers,
        qty: it.qty || 1,
        price: unitPrice,
        discount: it.discount || 0
      });
    }

    // append and recalc
    order.items = order.items.concat(validated);
    await recalculateTotals(order);
    await order.save({ session });

    // compute consumptions and apply
    const consumptionsMap = computeConsumptionsFromMenus(menuDocs, validated);
    if (consumptionsMap.size > 0) {
      await applyConsumptions(session, consumptionsMap, {
        restaurant: order.restaurant,
        outlet: order.outlet,
        orderNumber: order.orderNumber,
        performedBy: userId,
        note: `Usage for added items to ${order.orderNumber}`
      });
    }

    await session.commitTransaction();
    session.endSession();

    return await Order.findById(order._id).lean().exec();
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    throw err;
  }
};

/* changeTable: move an order from one table to another */
exports.changeTable = async ({ orderId, newTableId, userId }) => {
  const session = await mongoose.startSession();
  await session.startTransaction();
  try {
    const order = await Order.findById(orderId).session(session).exec();
    if (!order) throw Object.assign(new Error('Order not found'), { status: 404 });
    const oldTable = order.table ? await Table.findById(order.table).session(session).exec() : null;
    const newTable = await Table.findById(newTableId).session(session).exec();
    if (!newTable) throw Object.assign(new Error('New table not found'), { status: 404 });
    if (newTable.status === 'disabled') throw Object.assign(new Error('Table disabled'), { status: 409 });
    if (newTable.currentOrder && String(newTable.currentOrder) !== String(order._id)) {
      throw Object.assign(new Error('Target table has another active order'), { status: 409 });
    }

    // detach old table
    if (oldTable) {
      oldTable.currentOrder = null;
      oldTable.status = 'available';
      delete oldTable.meta?.occupiedBy;
      await oldTable.save({ session });
    }

    // attach new table
    newTable.currentOrder = order._id;
    newTable.status = 'occupied';
    newTable.meta = newTable.meta || {};
    newTable.meta.occupiedBy = userId;
    await newTable.save({ session });

    order.table = newTable._id;
    await order.save({ session });

    await session.commitTransaction();
    session.endSession();
    return await Order.findById(order._id).lean().exec();
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    throw err;
  }
};

/* updateOrderStatus: used to set in_kitchen, served, completed, cancelled */
exports.updateOrderStatus = async (orderId, status, userId) => {
  const session = await mongoose.startSession();
  await session.startTransaction();
  try {
    const order = await Order.findById(orderId).session(session).exec();
    if (!order) throw Object.assign(new Error('Order not found'), { status: 404 });

    order.status = status;
    order.meta = order.meta || {};
    order.meta.lastStatusChangedBy = userId;
    order.meta.lastStatusChangedAt = new Date();
    await order.save({ session });

    if (order.table && ['completed', 'cancelled'].includes(status)) {
      // free table
      const table = await Table.findById(order.table).session(session).exec();
      if (table) {
        table.currentOrder = null;
        table.status = 'available';
        table.mergedInto = null;
        if (table.meta) delete table.meta.occupiedBy;
        await table.save({ session });
      }
    }

    await session.commitTransaction();
    session.endSession();
    return await Order.findById(order._id).lean().exec();
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    throw err;
  }
};

/* addPayment: append payment (method, amount, transactionRef), and set order to completed if fully paid */
exports.addPayment = async ({ orderId, payment, userId }) => {
  const session = await mongoose.startSession();
  await session.startTransaction();
  try {
    const order = await Order.findById(orderId).session(session).exec();
    if (!order) throw Object.assign(new Error('Order not found'), { status: 404 });
    if (order.status === 'cancelled') throw Object.assign(new Error('Cannot pay cancelled order'), { status: 409 });

    order.payments = order.payments || [];
    order.payments.push(Object.assign({ paidAt: new Date(), recordedBy: userId }, payment));

    // compute total paid
    const paid = order.payments.reduce((s, p) => s + (p.amount || 0), 0);
    if (paid >= order.total) {
      order.status = 'completed';
      // free table if any
      if (order.table) {
        const table = await Table.findById(order.table).session(session).exec();
        if (table) {
          table.currentOrder = null;
          table.status = 'available';
          if (table.meta) delete table.meta.occupiedBy;
          await table.save({ session });
        }
      }
    }

    await order.save({ session });
    await session.commitTransaction();
    session.endSession();
    return await Order.findById(order._id).lean().exec();
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    throw err;
  }
};

/* refundPayment: record a refund and adjust payments/records. Not integrated with PSP here. */
exports.refundPayment = async ({ orderId, refund, userId }) => {
  const session = await mongoose.startSession();
  await session.startTransaction();
  try {
    const order = await Order.findById(orderId).session(session).exec();
    if (!order) throw Object.assign(new Error('Order not found'), { status: 404 });

    order.meta = order.meta || {};
    order.meta.refunds = order.meta.refunds || [];
    order.meta.refunds.push(Object.assign({ refundedAt: new Date(), refundedBy: userId }, refund));

    // adjust payments summary if necessary (or keep payments immutable and add refunds)
    // We'll keep payments as-is and just add refund record. Business logic may require reversing payments.

    // If refund causes total paid < total, move order back to pending
    const totalPaid = (order.payments || []).reduce((s, p) => s + (p.amount || 0), 0);
    const totalRefunded = (order.meta.refunds || []).reduce((s, r) => s + (r.amount || 0), 0);
    if ((totalPaid - totalRefunded) < order.total) {
      order.status = 'pending';
      // Re-occupy table? Business rule; we'll leave table occupied unless explicitly freed.
    }

    await order.save({ session });
    await session.commitTransaction();
    session.endSession();
    return await Order.findById(order._id).lean().exec();
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    throw err;
  }
};

/* mergeOrders: move all items/payments from source order into target order and close source */
exports.mergeOrders = async ({ sourceOrderId, targetOrderId, performedBy }) => {
  const session = await mongoose.startSession();
  await session.startTransaction();
  try {
    if (String(sourceOrderId) === String(targetOrderId)) throw Object.assign(new Error('Same order'), { status: 400 });
    const src = await Order.findById(sourceOrderId).session(session).exec();
    const tgt = await Order.findById(targetOrderId).session(session).exec();
    if (!src || !tgt) throw Object.assign(new Error('Order not found'), { status: 404 });

    // move items
    tgt.items = tgt.items.concat(src.items || []);
    // move payments
    tgt.payments = (tgt.payments || []).concat(src.payments || []);
    // re-calc totals
    await recalculateTotals(tgt);
    await tgt.save({ session });

    // free/clear source
    src.status = 'cancelled';
    src.meta = src.meta || {};
    src.meta.mergedInto = tgt._id;
    await src.save({ session });

    // transfer table if applicable (business rule choose: keep target's table)
    if (src.table && !tgt.table) {
      tgt.table = src.table;
      await tgt.save({ session });
    }

    await session.commitTransaction();
    session.endSession();
    return await Order.findById(tgt._id).lean().exec();
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    throw err;
  }
};

/* splitItemsToNewOrder: create a new order from a subset of item indexes or item ids */
exports.splitItemsToNewOrder = async ({ orderId, itemIndexes = [], itemIds = [], userId }) => {
  const session = await mongoose.startSession();
  await session.startTransaction();
  try {
    const order = await Order.findById(orderId).session(session).exec();
    if (!order) throw Object.assign(new Error('Order not found'), { status: 404 });
    if (!Array.isArray(order.items) || order.items.length === 0) throw Object.assign(new Error('No items to split'), { status: 400 });

    // pick items by index or id
    const toMove = [];
    const remaining = [];
    order.items.forEach((it, idx) => {
      const idStr = it._id ? String(it._id) : null;
      if (itemIndexes.includes(idx) || (itemIds.length && idStr && itemIds.includes(idStr))) {
        toMove.push(it);
      } else {
        remaining.push(it);
      }
    });

    if (toMove.length === 0) throw Object.assign(new Error('No matching items to split'), { status: 400 });

    // update original order
    order.items = remaining;
    await recalculateTotals(order);
    await order.save({ session });

    // create new order
    const newOrder = {
      restaurant: order.restaurant,
      outlet: order.outlet,
      table: order.table, // optionally detach
      items: toMove,
      taxTotal: 0,
      discountTotal: 0,
      serviceCharge: 0,
      payments: [],
      notes: `Split from ${order.orderNumber}`,
      placedBy: userId,
      status: 'pending',
      meta: { splitFrom: order._id }
    };
    await recalculateTotals(newOrder);
    const created = await Order.create([newOrder], { session });
    const newOrderDoc = created[0];

    // attach new order to same table if desired (business rule). We'll attach and mark both occupied.
    if (order.table) {
      const table = await Table.findById(order.table).session(session).exec();
      if (table) {
        table.currentOrder = order._id; // keep old order here; newOrder may be unassigned or you may set merged into
        table.status = 'occupied';
        await table.save({ session });
      }
    }

    await session.commitTransaction();
    session.endSession();
    return await Order.findById(newOrderDoc._id).lean().exec();
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    throw err;
  }
};
