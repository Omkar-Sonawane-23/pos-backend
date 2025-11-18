// controllers/menuController.js
const menuService = require('../services/menuService');

exports.list = async (req, res, next) => {
  try {
    const { outlet_id, for_pos, page = 0, limit = 100 } = req.query;
    const items = await menuService.list({
      outletId: outlet_id,
      forPos: !!(for_pos === '1' || for_pos === 'true' || for_pos === true),
      page: Number(page),
      limit: Number(limit)
    });
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
