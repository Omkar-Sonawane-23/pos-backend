const mongoose = require('mongoose');
const { Schema, model, Types } = mongoose;


const TableSchema = new Schema({
restaurant: { type: Types.ObjectId, ref: 'Restaurant', required: true },
outlet: { type: Types.ObjectId, ref: 'Outlet' },
name: { type: String, required: true },
seats: { type: Number, default: 2 },
zone: { type: String },
status: { type: String, enum: ['available','occupied','reserved','disabled'], default: 'available' },
meta: { type: Schema.Types.Mixed }
}, { timestamps: true });


TableSchema.index({ restaurant: 1, outlet: 1, name: 1 }, { unique: true });


module.exports = model('Table', TableSchema);