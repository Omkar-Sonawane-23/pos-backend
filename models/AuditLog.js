const mongoose = require('mongoose');
const { Schema, model, Types } = mongoose;


const AuditLogSchema = new Schema({
restaurant: { type: Types.ObjectId, ref: 'Restaurant' },
outlet: { type: Types.ObjectId, ref: 'Outlet' },
user: { type: Types.ObjectId, ref: 'User' },
action: { type: String, required: true },
payload: { type: Schema.Types.Mixed }
}, { timestamps: true });


module.exports = model('AuditLog', AuditLogSchema);