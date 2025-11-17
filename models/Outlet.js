const mongoose = require('mongoose');
const { Schema, model } = mongoose;


const OutletSchema = new Schema({
    name: { type: String, required: true },
    code: { type: String },
    address: { type: String },
    phone: { type: String },
    timeZone: { type: String, default: 'UTC' },
    currency: { type: String, default: 'USD' },
    openTime: { type: String },
    closeTime: { type: String },
    settings: { type: Schema.Types.Mixed, default: {} }
}, { timestamps: true });


module.exports = model('Outlet', OutletSchema);