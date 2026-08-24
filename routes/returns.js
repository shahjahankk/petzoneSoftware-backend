const express = require('express');
const router = express.Router();
const { rbac } = require('../middleware/rbac');
const { getReturnRestock, restockReturnItem } = require('../controllers/returnsController');
// auth is already applied globally in server.js — do NOT add it here

router.get('/restock', rbac('ADMIN'), getReturnRestock);
router.post('/:returnId/items/:itemId/restock', rbac('ADMIN', 'WAREHOUSE_KEEPER', 'CASHIER'), restockReturnItem);

module.exports = router;