const mongoose = require('mongoose');
const { Schema, model, Types } = mongoose;


const InventoryItemSchema = new Schema({
restaurant: { type: Types.ObjectId, ref: 'Restaurant', required: true },
outlet: { type: Types.ObjectId, ref: 'Outlet' },
name: { type: String, required: true },
sku: { type: String, index: true },
unit: { type: String, default: 'pcs' },
costPrice: { type: Number, default: 0 },
currentQty: { type: Number, default: 0 },
parLevel: { type: Number, default: 0 },
supplier: { type: Types.ObjectId, ref: 'Supplier' },
isTracked: { type: Boolean, default: true },
location: { type: String },
meta: { type: Schema.Types.Mixed }
}, { timestamps: true });


module.exports = model('InventoryItem', InventoryItemSchema);