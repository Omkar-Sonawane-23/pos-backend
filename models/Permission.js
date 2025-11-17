const mongoose = require('mongoose');
const { Schema, model } = mongoose;


const PermissionSchema = new Schema({
key: { type: String, required: true },
name: { type: String, required: true },
description: { type: String }
}, { _id: false });


module.exports = model('Permission', PermissionSchema);