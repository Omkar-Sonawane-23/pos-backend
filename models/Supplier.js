const mongoose = require('mongoose');
const { Schema, model, Types } = mongoose;


const SupplierSchema = new Schema({
restaurant: { type: Types.ObjectId, ref: 'Restaurant' },
name: { type: String, required: true },
contact: { type: String },
phone: { type: String },
email: { type: String },
address: { type: String },
meta: { type: Schema.Types.Mixed }
}, { timestamps: true });


module.exports = model('Supplier', SupplierSchema);