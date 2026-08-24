const express = require('express');
const router = express.Router();
const {
  getPurchaseOrders, getPurchaseOrder, createPurchaseOrder,
  updatePurchaseOrderStatus, deletePurchaseOrder, updatePurchaseOrder, getSuppliers
} = require('../controllers/purchaseOrderController');
const { rbac, requireAdmin } = require('../middleware/rbac');
// auth is already applied globally in server.js — do NOT add it here

router.get('/', rbac('ADMIN', 'WAREHOUSE_KEEPER', 'CASHIER'), getPurchaseOrders);
router.get('/suppliers', rbac('ADMIN', 'WAREHOUSE_KEEPER', 'CASHIER'), getSuppliers);
router.get('/:id', rbac('ADMIN', 'WAREHOUSE_KEEPER', 'CASHIER'), getPurchaseOrder);
router.post('/', rbac('ADMIN', 'WAREHOUSE_KEEPER', 'CASHIER'), createPurchaseOrder);
router.put('/:id', rbac('ADMIN', 'WAREHOUSE_KEEPER', 'CASHIER'), updatePurchaseOrder);
router.put('/:id/status', requireAdmin, updatePurchaseOrderStatus);
router.delete('/:id', requireAdmin, deletePurchaseOrder);

module.exports = router;