const mongoose = require('mongoose');
const { Schema, model } = mongoose;


const RoleSchema = new Schema({
name: { type: String, required: true, unique: true },
description: { type: String },
permissions: { type: [Object], default: [] }, // store permission objects or keys
scope: { type: String, enum: ['global','restaurant','outlet'], default: 'restaurant' }
}, { timestamps: true });


module.exports = model('Role', RoleSchema);