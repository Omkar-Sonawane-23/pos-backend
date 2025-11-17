const mongoose = require('mongoose');
const { Schema, model, Types } = mongoose;


const UserSchema = new Schema({
    email: { type: String, required: true, index: true },
    phone: { type: String },
    name: { type: String, required: true },
    passwordHash: { type: String },
    restaurant: { type: Types.ObjectId, ref: 'Restaurant' },
    outlet: { type: Types.ObjectId, ref: 'Outlet' },
    roles: [{ type: Types.ObjectId, ref: 'Role' }],
    isActive: { type: Boolean, default: true },
    lastLoginAt: { type: Date }
}, { timestamps: true });


UserSchema.index({ email: 1, restaurant: 1 }, { unique: true, partialFilterExpression: { email: { $exists: true } } });


module.exports = model('User', UserSchema);