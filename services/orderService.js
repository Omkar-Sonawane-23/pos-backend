// services/orderService.js
const { mongoose } = require('../db').mongoose || require('mongoose');
const {
  Order,
  InventoryItem,
  StockMovement,
  MenuItem
} = require('../models');

function generateOrderNumber() {
  return `ORD-${Date.now()}-${Math.floor(100 + Math.random() * 900)}`;
}

/**
 * payload: {
 *   restaurant, outlet, table, type, items: [{ menuItem, name, qty, price, modifiers }]
 * }
 */
exports.createOrder = async ({ payload, userId }) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    // calculate totals
    let subtotal = 0;
    for (const it of payload.items) {
      subtotal += (it.price || 0) * (it.qty || 1);
    }
    const taxTotal = payload.taxTotal || 0;
    const discountTotal = payload.discountTotal || 0;
    const serviceCharge = payload.serviceCharge || 0;
    const total = subtotal + taxTotal + serviceCharge - discountTotal;

    const orderNumber = generateOrderNumber();
    const orderDoc = await Order.create([{
      restaurant: payload.restaurant,
      outlet: payload.outlet,
      table: payload.table,
      orderNumber,
      type: payload.type || 'dine_in',
      items: payload.items,
      subtotal,
      taxTotal,
      discountTotal,
      serviceCharge,
      total,
      placedBy: userId,
      notes: payload.notes || ''
    }], { session });

    // inventory deduction logic:
    // For each ordered menu item, if menu item maps to ingredient inventory consumption,
    // reduce inventory items accordingly. This schema doesn't include recipe mapping,
    // but we'll show an example where payload includes `consumptions`: [{ inventoryItemId, qty }]
    if (payload.consumptions && Array.isArray(payload.consumptions)) {
      for (const c of payload.consumptions) {
        // decrement inventory
        const inv = await InventoryItem.findById(c.inventoryItemId).session(session);
        if (!inv) throw Object.assign(new Error('Inventory item not found'), { status: 400 });
        if (inv.isTracked && typeof inv.currentQty === 'number') {
          inv.currentQty = inv.currentQty - c.qty;
          if (inv.currentQty < 0) inv.currentQty = 0; // or throw
          await inv.save({ session });
        }
        // log movement
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
    }

    await session.commitTransaction();
    session.endSession();

    // return created order (first element)
    return orderDoc[0];
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    throw err;
  }
};

exports.getById = async (id) => {
  return Order.findById(id)
    .populate('items.menuItem')
    .populate('placedBy', 'name email')
    .lean();
};
