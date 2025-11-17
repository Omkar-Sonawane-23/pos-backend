const mongoose = require('mongoose');
const { Schema, model, Types } = mongoose;


const OutletRefSchema = new Schema({ outlet: { type: Types.ObjectId, ref: 'Outlet' } }, { _id: false });


const RestaurantSchema = new Schema({
name: { type: String, required: true },
legalName: { type: String },
taxNumber: { type: String },
ownerName: { type: String },
contactEmail: { type: String },
contactPhone: { type: String },
address: { type: String },
cuisine: { type: [String], default: [] },
settings: { type: Schema.Types.Mixed, default: {} },
outlets: [{ type: Types.ObjectId, ref: 'Outlet' }]
}, { timestamps: true });


module.exports = model('Restaurant', RestaurantSchema);