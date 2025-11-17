const mongoose = require('mongoose');
const { Schema, model, Types } = mongoose;


const CategorySchema = new Schema({
restaurant: { type: Types.ObjectId, ref: 'Restaurant', required: true },
name: { type: String, required: true },
order: { type: Number, default: 0 },
parent: { type: Types.ObjectId, ref: 'Category' },
isVisible: { type: Boolean, default: true }
}, { timestamps: true });


CategorySchema.index({ restaurant: 1, name: 1 }, { unique: true });


module.exports = model('Category', CategorySchema);