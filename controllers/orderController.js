// controllers/orderController.js
const orderService = require('../services/orderService');

exports.createOrder = async (req, res, next) => {
  try {
    const payload = req.body;
    const userId = req.currentUser ? req.currentUser._id : (req.auth && req.auth.sub);
    const order = await orderService.createOrder({ payload, userId });
    res.status(201).json({ data: order });
  } catch (err) { next(err); }
};

exports.listOrders = async (req, res, next) => {
  try {
    const { outlet, restaurant, limit = 25, page = 0 } = req.query;
    const orders = await orderService.listOrders({ outlet, restaurant, limit: Number(limit), page: Number(page) });
    res.json({ data: orders });
  } catch (err) { next(err); }
};

exports.getById = async (req, res, next) => {
  try {
    const order = await orderService.getById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    res.json({ data: order });
  } catch (err) { next(err); }
};

exports.addItems = async (req, res, next) => {
  try {
    const { id } = req.params;
    const items = req.body.items;
    const userId = req.currentUser ? req.currentUser._id : (req.auth && req.auth.sub);
    const order = await orderService.addItems({ orderId: id, items, userId });
    res.json({ data: order });
  } catch (err) { next(err); }
};

exports.changeTable = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { newTableId } = req.body;
    const userId = req.currentUser ? req.currentUser._id : (req.auth && req.auth.sub);
    const order = await orderService.changeTable({ orderId: id, newTableId, userId });
    res.json({ data: order });
  } catch (err) { next(err); }
};

exports.updateStatus = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const userId = req.currentUser ? req.currentUser._id : (req.auth && req.auth.sub);
    const order = await orderService.updateOrderStatus(id, status, userId);
    res.json({ data: order });
  } catch (err) { next(err); }
};

exports.addPayment = async (req, res, next) => {
  try {
    const { id } = req.params;
    const payment = req.body.payment; // { method, amount, transactionRef }
    const userId = req.currentUser ? req.currentUser._id : (req.auth && req.auth.sub);
    const order = await orderService.addPayment({ orderId: id, payment, userId });
    res.json({ data: order });
  } catch (err) { next(err); }
};

exports.refundPayment = async (req, res, next) => {
  try {
    const { id } = req.params;
    const refund = req.body.refund; // { amount, reason, transactionRef }
    const userId = req.currentUser ? req.currentUser._id : (req.auth && req.auth.sub);
    const order = await orderService.refundPayment({ orderId: id, refund, userId });
    res.json({ data: order });
  } catch (err) { next(err); }
};

exports.mergeOrders = async (req, res, next) => {
  try {
    const { sourceOrderId, targetOrderId } = req.body;
    const userId = req.currentUser ? req.currentUser._id : (req.auth && req.auth.sub);
    const order = await orderService.mergeOrders({ sourceOrderId, targetOrderId, performedBy: userId });
    res.json({ data: order });
  } catch (err) { next(err); }
};

exports.splitItems = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { itemIndexes = [], itemIds = [] } = req.body;
    const userId = req.currentUser ? req.currentUser._id : (req.auth && req.auth.sub);
    const newOrder = await orderService.splitItemsToNewOrder({ orderId: id, itemIndexes, itemIds, userId });
    res.status(201).json({ data: newOrder });
  } catch (err) { next(err); }
};

exports.updateItems = async (req, res, next) => {
  try {
    const orderId = req.params.id;
    const items = req.body.items; // expected: array of { menuItem, variantId?, modifiers?, qty, note?, price? }
    if (!Array.isArray(items)) return res.status(400).json({ error: 'items must be an array' });

    const userId = req.currentUser ? req.currentUser._id : (req.auth && req.auth.sub);
    const updated = await orderService.updateOrderItems({ orderId, items, userId });
    res.json({ data: updated });
  } catch (err) {
    next(err);
  }
};