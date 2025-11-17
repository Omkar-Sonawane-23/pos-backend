const mongoose = require('mongoose');
const { Schema, model, Types } = mongoose;


const StockMovementSchema = new Schema({
restaurant: { type: Types.ObjectId, ref: 'Restaurant', required: true },
outlet: { type: Types.ObjectId, ref: 'Outlet' },
inventoryItem: { type: Types.ObjectId, ref: 'InventoryItem', required: true },
change: { type: Number, required: true },
type: { type: String, enum: ['purchase','usage','adjustment','transfer'], required: true },
reference: { type: String },
note: { type: String },
performedBy: { type: Types.ObjectId, ref: 'User' }
}, { timestamps: true });


module.exports = model('StockMovement', StockMovementSchema);