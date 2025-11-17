// controllers/menuController.js
const menuService = require('../services/menuService');

exports.list = async (req, res, next) => {
  try {
    const { outlet_id, for_pos } = req.query;
    const items = await menuService.list({ outletId: outlet_id, forPos: !!for_pos });
    res.json({ data: items });
  } catch (err) {
    next(err);
  }
};

exports.getById = async (req, res, next) => {
  try {
    const item = await menuService.getById(req.params.id);
    if (!item) return res.status(404).json({ error: 'Not found' });
    res.json({ data: item });
  } catch (err) {
    next(err);
  }
};
