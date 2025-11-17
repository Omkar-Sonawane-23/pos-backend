// routes/menu.js
const express = require('express');
const router = express.Router();
const menuController = require('../controllers/menuController');
const auth = require('../middleware/auth');

router.get('/', menuController.list); // public for POS, adjust auth as needed
router.get('/:id', menuController.getById);

module.exports = router;
