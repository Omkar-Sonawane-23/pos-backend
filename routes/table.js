const express = require('express');
const router = express.Router();
const tableController = require('../controllers/tableController');
const auth = require('../middleware/auth');
const roleCheck = require('../middleware/roleCheck');


// list tables for an outlet (any logged-in POS user can see)
router.get('/', auth, tableController.listTables);


// occupy a table (Cashier/Admin/SuperAdmin)
router.post('/:id/occupy', auth, roleCheck(['Cashier','Admin','SuperAdmin']), tableController.occupyTable);


// free a table (Admin or SuperAdmin or same cashier)
router.post('/:id/free', auth, roleCheck(['Cashier', 'Admin','SuperAdmin']), tableController.freeTable);


// merge two tables (Admin or SuperAdmin)
router.post('/merge', auth, roleCheck(['Admin','SuperAdmin']), tableController.mergeTables);


// split a merged table (Admin or SuperAdmin)
router.post('/split', auth, roleCheck(['Admin','SuperAdmin']), tableController.splitTable);


module.exports = router;