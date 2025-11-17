// services/menuService.js
const { MenuItem } = require('../models');

exports.list = async ({ outletId, forPos }) => {
  const query = { isActive: true };
  if (outletId) {
    // only include items available in this outlet or default available
    query['$or'] = [
      { 'outletAvailability': { $exists: false } },
      { 'outletAvailability.outlet': outletId },
      { 'outletAvailability': { $elemMatch: { outlet: outletId, isAvailable: true } } }
    ];
  }
  // Add fields as needed for POS (e.g. hide description)
  const items = await MenuItem.find(query).lean();
  return items;
};

exports.getById = async (id) => {
  return MenuItem.findById(id).lean();
};
