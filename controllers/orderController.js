// controllers/orderController.js
const orderService = require('../services/orderService');

exports.createOrder = async (req, res, next) => {
  try {
    const payload = req.body;
    const userId = req.currentUser ? req.currentUser._id : (req.auth && req.auth.sub);
    const result = await orderService.createOrder({ payload, userId });
    res.status(201).json({ data: result });
  } catch (err) {
    next(err);
  }
};

exports.getById = async (req, res, next) => {
  try {
    const order = await orderService.getById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    res.json({ data: order });
  } catch (err) {
    next(err);
  }
};
