const express = require('express');
const router = express.Router();
const warehouseSalesController = require('../controllers/warehouseSalesController');
const { requireWarehouseKeeper, requireAdmin } = require('../middleware/rbac');
const { validateWarehouseSale } = require('../middleware/validation');
// auth is already applied globally in server.js — do NOT add it here

router.get('/', requireWarehouseKeeper, warehouseSalesController.getWarehouseSales);
router.get('/summary', requireWarehouseKeeper, warehouseSalesController.getWarehouseSalesSummary);
router.get('/last-price', requireWarehouseKeeper, warehouseSalesController.getLastCustomerItemPrice);
router.get('/:id', requireWarehouseKeeper, warehouseSalesController.getWarehouseSale);
router.post('/', requireWarehouseKeeper, validateWarehouseSale, warehouseSalesController.createWarehouseSale);
router.put('/:id', requireAdmin, validateWarehouseSale, warehouseSalesController.updateWarehouseSale);
router.delete('/:id', requireAdmin, warehouseSalesController.deleteWarehouseSale);

module.exports = router;