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

function generateOrderNumber() {
  return `ORD-${Date.now()}-${Math.floor(100 + Math.random() * 900)}`;
}

/**
 * createOrder({ payload, userId })
 * payload shape (example):
 * {
 *   restaurant,
 *   outlet,
 *   table,            // optional table id
 *   type,             // dine_in|takeaway|delivery|counter
 *   items: [
 *     { menuItem, variantId?, modifiers: [{ modifierId?, name, price }], qty }
 *   ],
 *   taxTotal?, discountTotal?, serviceCharge?, notes?
 * }
 */
exports.createOrder = async ({ payload, userId }) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    // 1) Authoritative validation & totals calculation
    let subtotal = 0;
    const validatedItems = [];

    for (const it of payload.items || []) {
      const menu = await MenuItem.findById(it.menuItem).session(session);
      if (!menu || !menu.isActive) {
        throw Object.assign(new Error(`Menu item not available: ${it.menuItem}`), { status: 400 });
      }

      // Determine unit price (variant or base)
      let unitPrice = menu.basePrice;
      if (it.variantId) {
        const variant = menu.variants.id(it.variantId);
        if (!variant) throw Object.assign(new Error('Variant not found'), { status: 400 });
        unitPrice = variant.price;
      }

      // Validate modifiers and compute modifier total
      let modifiersTotal = 0;
      const validatedModifiers = [];
      if (Array.isArray(it.modifiers)) {
        for (const m of it.modifiers) {
          // allow matching by modifierId or name
          let mod = null;
          if (m.modifierId) {
            mod = menu.modifiers.id(m.modifierId);
          } else if (m.name) {
            mod = menu.modifiers.find(x => x.name === m.name);
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

      // push validated item (store authoritative unit price)
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

    // 2) Table handling: auto-occupy if provided and attach order later
    let tableDoc = null;
    if (payload.table) {
      tableDoc = await Table.findById(payload.table).session(session);
      if (!tableDoc) throw Object.assign(new Error('Table not found'), { status: 404 });
      if (tableDoc.status === 'disabled') throw Object.assign(new Error('Table disabled'), { status: 409 });
      if (tableDoc.status === 'available') {
        tableDoc.status = 'occupied';
        tableDoc.meta = tableDoc.meta || {};
        tableDoc.meta.occupiedBy = userId;
        await tableDoc.save({ session });
      }
    }

    // 3) Create Order document
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
      status: 'pending'
    }], { session });

    const orderDoc = createdArr[0];

    // 4) Attach order to table (if present)
    if (tableDoc) {
      tableDoc.currentOrder = orderDoc._id;
      tableDoc.status = 'occupied';
      await tableDoc.save({ session });
    }

    // 5) Inventory deduction using menu.meta.recipe
    // Build aggregated consumption list: [{ inventoryItemId, qty }]
    const consumptions = []; // { inventoryItemId: ObjectId, qty: Number }
    for (const it of validatedItems) {
      const menu = await MenuItem.findById(it.menuItem).session(session);
      const recipe = (menu && menu.meta && Array.isArray(menu.meta.recipe)) ? menu.meta.recipe : [];
      const qtyMultiplier = it.qty || 1;
      for (const r of recipe) {
        // r: { inventoryItemId, qty, unit }
        if (!r.inventoryItemId) continue;
        const existing = consumptions.find(c => c.inventoryItemId.toString() === r.inventoryItemId.toString());
        const addQty = (r.qty || 0) * qtyMultiplier;
        if (existing) existing.qty += addQty;
        else consumptions.push({ inventoryItemId: r.inventoryItemId, qty: addQty });
      }
    }

    // Apply consumptions: update InventoryItem.currentQty and create StockMovement
    for (const c of consumptions) {
      const inv = await InventoryItem.findById(c.inventoryItemId).session(session);
      if (!inv) throw Object.assign(new Error('Inventory item in recipe not found'), { status: 400 });
      if (inv.isTracked && typeof inv.currentQty === 'number') {
        inv.currentQty = inv.currentQty - c.qty;
        // policy: clamp at zero to avoid negative inventory, could instead throw if insufficient
        if (inv.currentQty < 0) inv.currentQty = 0;
        await inv.save({ session });
      }
      await StockMovement.create([{
        restaurant: payload.restaurant,
        outlet: payload.outlet,
        inventoryItem: inv._id,
        change: -Math.abs(c.qty),
        type: 'usage',
        reference: orderNumber,
        performedBy: userId,
        note: `Used by order ${orderNumber}`
      }], { session });
    }

    // 6) Commit transaction
    await session.commitTransaction();
    session.endSession();

    // Emit kitchen notifications here (outside transaction)
    // e.g., eventBus.emit('order.created', { orderId: orderDoc._id, items: validatedItems });

    // Return created order
    return orderDoc;
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    throw err;
  }
};

/**
 * getById(id) - returns order with some populated fields
 */
exports.getById = async (id) => {
  return Order.findById(id)
    .populate('placedBy', 'name email')
    .populate('items.menuItem')
    .lean();
};

exports.listOrders = async () => {
  return Order.find()
    .sort({ createdAt: -1 })
    .limit(100)
    .populate('placedBy', 'name email')
    .lean();
};

/**
 * updateOrderStatus(orderId, status, performedBy)
 * - updates status
 * - if status is completed or cancelled, frees the table (if attached)
 */
exports.updateOrderStatus = async (orderId, status, performedBy) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const order = await Order.findById(orderId).session(session);
    if (!order) throw Object.assign(new Error('Order not found'), { status: 404 });

    order.status = status;
    // optionally record who updated status in meta or audit log
    order.meta = order.meta || {};
    order.meta.lastStatusChangedBy = performedBy;
    order.meta.lastStatusChangedAt = new Date();
    await order.save({ session });

    // If order completed/cancelled, free the table
    if (order.table && ['completed', 'cancelled'].includes(status)) {
      const table = await Table.findById(order.table).session(session);
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
    return order;
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    throw err;
  }
};
