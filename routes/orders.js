// routes/orders.js
const express = require('express');
const router = express.Router();
const orderController = require('../controllers/orderController');
const auth = require('../middleware/auth');
const roleCheck = require('../middleware/roleCheck');

// require auth for creating orders
router.post('/', auth, roleCheck(['Cashier', 'Admin', 'SuperAdmin']), orderController.createOrder);
router.get('/', auth, roleCheck(['Cashier', 'Admin', 'SuperAdmin']), orderController.listOrders);
router.get('/:id', auth, roleCheck(['Admin', 'SuperAdmin']), orderController.getById);

module.exports = router;
