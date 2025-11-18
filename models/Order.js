// models/Order.js
const mongoose = require('mongoose');
const { Schema, model, Types } = mongoose;

const OrderItemSchema = new Schema({
    menuItem: { type: Types.ObjectId, ref: 'MenuItem', required: true },
    name: { type: String, required: true },
    variantId: { type: Types.ObjectId },
    modifiers: [{ name: String, price: Number, modifierId: Types.ObjectId }],
    qty: { type: Number, required: true, min: 1 },
    price: { type: Number, required: true },
    discount: { type: Number, default: 0 },
    taxes: { type: Number, default: 0 },
    note: { type: String }
}, { _id: false });

const OrderSchema = new Schema({
    restaurant: { type: Types.ObjectId, ref: 'Restaurant', required: true },
    outlet: { type: Types.ObjectId, ref: 'Outlet' },
    table: { type: Types.ObjectId, ref: 'Table' },
    orderNumber: { type: String, required: true, index: true },
    type: { type: String, enum: ['dine_in', 'takeaway', 'delivery', 'counter'], default: 'dine_in' },
    items: { type: [OrderItemSchema], default: [] },
    subtotal: { type: Number, required: true, default: 0 },
    taxTotal: { type: Number, default: 0 },
    discountTotal: { type: Number, default: 0 },
    serviceCharge: { type: Number, default: 0 },
    total: { type: Number, required: true, default: 0 },
    payments: [{ method: String, amount: Number, transactionRef: String, paidAt: Date }],
    status: { type: String, enum: ['pending', 'in_kitchen', 'served', 'completed', 'cancelled'], default: 'pending' },
    placedAt: { type: Date, default: Date.now },
    placedBy: { type: Types.ObjectId, ref: 'User' },
    notes: { type: String },
    meta: { type: Schema.Types.Mixed } // used for idempotency e.g. meta.idempotencyKey
}, { timestamps: true, autoIndex: false });

// Indexes (create via migration script in prod)
OrderSchema.index({ restaurant: 1, outlet: 1, orderNumber: 1 }, { unique: true, background: true });
OrderSchema.index({ restaurant: 1, placedAt: -1 }, { background: true });
OrderSchema.index({ restaurant: 1, status: 1, placedAt: -1 }, { background: true });

// If you want fast lookup for idempotency by meta.idempotencyKey
OrderSchema.index({ 'meta.idempotencyKey': 1, restaurant: 1 }, { unique: false, background: true });

module.exports = model('Order', OrderSchema);
