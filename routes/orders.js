const express = require('express');
const router = express.Router();
const orderController = require('../controllers/orderController');
const auth = require('../middleware/auth');
const roleCheck = require('../middleware/roleCheck');

router.post('/', auth, roleCheck(['Cashier','Admin','SuperAdmin']), orderController.createOrder);
router.get('/', auth, roleCheck(['Cashier','Admin','SuperAdmin']), orderController.listOrders);
router.get('/:id', auth, roleCheck(['Cashier','Admin','SuperAdmin']), orderController.getById);

// extra operations
router.post('/:id/add-items', auth, roleCheck(['Cashier','Admin','SuperAdmin']), orderController.addItems);
router.post('/:id/change-table', auth, roleCheck(['Cashier','Admin','SuperAdmin']), orderController.changeTable);
router.post('/:id/status', auth, roleCheck(['Cashier','Admin','SuperAdmin']), orderController.updateStatus);
router.post('/:id/payments', auth, roleCheck(['Cashier','Admin','SuperAdmin']), orderController.addPayment);
router.post('/:id/refund', auth, roleCheck(['Admin','SuperAdmin']), orderController.refundPayment);
router.post('/merge', auth, roleCheck(['Admin','SuperAdmin']), orderController.mergeOrders);
router.post('/:id/split', auth, roleCheck(['Admin','SuperAdmin']), orderController.splitItems);
router.put('/:id/items', auth, roleCheck(['Cashier', 'Admin', 'SuperAdmin']), orderController.updateItems);


module.exports = router;
