// models/MenuItem.js
const mongoose = require('mongoose');
const { Schema, model, Types } = mongoose;

const ModifierSchema = new Schema({
    name: { type: String, required: true },
    price: { type: Number, default: 0 },
    sku: { type: String },
    isRequired: { type: Boolean, default: false },
    maxChoices: { type: Number, default: 1 }
}, { _id: true });

const VariantSchema = new Schema({
    name: { type: String, required: true },
    price: { type: Number, required: true },
    sku: { type: String },
    isAvailable: { type: Boolean, default: true },
    meta: { type: Schema.Types.Mixed }
}, { _id: true });

const MenuItemSchema = new Schema({
    restaurant: { type: Types.ObjectId, ref: 'Restaurant', required: true },
    outletAvailability: [{ outlet: { type: Types.ObjectId, ref: 'Outlet' }, isAvailable: { type: Boolean, default: true } }],
    categories: [{ type: Types.ObjectId, ref: 'Category' }],
    name: { type: String, required: true },
    description: { type: String },
    image: { type: String },
    basePrice: { type: Number, required: true },
    sku: { type: String, index: true },
    isActive: { type: Boolean, default: true },
    isTaxable: { type: Boolean, default: true },
    variants: { type: [VariantSchema], default: [] },
    modifiers: { type: [ModifierSchema], default: [] },
    prepTimeMins: { type: Number },
    calories: { type: Number },
    tags: { type: [String], default: [] },
    meta: { type: Schema.Types.Mixed }
}, { timestamps: true, autoIndex: false }); // autoIndex=false for prod: create indexes via migration

// Indexes tuned for POS read patterns:
//  - fast lookup of active menu items per restaurant (and recent updates for cache invalidation)
//  - fast lookup for outlet availability queries
//  - sku lookup
MenuItemSchema.index({ restaurant: 1, isActive: 1, updatedAt: -1 }, { background: true });
MenuItemSchema.index({ restaurant: 1, "outletAvailability.outlet": 1, "outletAvailability.isAvailable": 1 }, { background: true });
MenuItemSchema.index({ restaurant: 1, sku: 1 }, { background: true });

module.exports = model('MenuItem', MenuItemSchema);
