const express = require('express');
const router = express.Router();
const inventoryController = require('../controllers/inventoryController');
const excelImportController = require('../controllers/excelImportController');
const { requireAdmin, rbac } = require('../middleware/rbac');
const { inventoryItemValidation, inventoryItemUpdateValidation } = require('../middleware/validation');
const { checkWarehouseKeeperInventoryPermission, checkCashierInventoryPermission, checkCrossBranchVisibility } = require('../middleware/branchPermissions');
const { requireShiftAccessForInventory } = require('../middleware/shiftAccess');
const { uploadSingle, handleUploadError } = require('../middleware/upload');
// auth is already applied globally in server.js — do NOT add it here

// Inventory access check (inline, replaces repeated auth checks)
const hasInventoryAccess = (req, res, next) => {
  if (req.user.role === 'ADMIN' || req.user.role === 'WAREHOUSE_KEEPER' ||
    (req.user.role === 'CASHIER' && req.user.inventoryPermission !== false)) return next();
  return res.status(403).json({ success: false, message: 'Access denied. Inventory permission required.' });
};

router.get('/', rbac('ADMIN', 'WAREHOUSE_KEEPER', 'CASHIER'), inventoryController.getInventoryItems);
router.get('/cross-warehouse', rbac('ADMIN', 'WAREHOUSE_KEEPER'), inventoryController.getCrossWarehouseInventory);
router.get('/cross-branch', rbac('ADMIN', 'WAREHOUSE_KEEPER', 'CASHIER'), checkCrossBranchVisibility, inventoryController.getCrossBranchInventory);
router.get('/changes', rbac('ADMIN', 'WAREHOUSE_KEEPER', 'CASHIER'), inventoryController.getLatestInventoryChanges);
router.get('/changes/since', rbac('ADMIN', 'WAREHOUSE_KEEPER', 'CASHIER'), inventoryController.getInventoryChangesSince);
router.get('/summary', rbac('ADMIN', 'WAREHOUSE_KEEPER', 'CASHIER'), inventoryController.getSummary);
router.get('/excel-template', hasInventoryAccess, excelImportController.getExcelTemplate);
router.get('/export-excel', hasInventoryAccess, excelImportController.exportInventoryExcel);
router.get('/:id', rbac('ADMIN', 'WAREHOUSE_KEEPER', 'CASHIER'), inventoryController.getInventoryItem);

router.post('/', rbac('ADMIN', 'WAREHOUSE_KEEPER', 'CASHIER'), requireShiftAccessForInventory, checkWarehouseKeeperInventoryPermission, checkCashierInventoryPermission, inventoryItemValidation, inventoryController.createInventoryItem);
router.post('/import-excel', hasInventoryAccess, uploadSingle, handleUploadError, excelImportController.importInventoryFromExcel);

router.put('/:id', rbac('ADMIN', 'WAREHOUSE_KEEPER', 'CASHIER'), requireShiftAccessForInventory, checkWarehouseKeeperInventoryPermission, checkCashierInventoryPermission, inventoryItemUpdateValidation, inventoryController.updateInventoryItem);

router.delete('/:id', requireAdmin, inventoryController.deleteInventoryItem);

router.patch('/:id/quantity', rbac('ADMIN', 'WAREHOUSE_KEEPER', 'CASHIER'), requireShiftAccessForInventory, checkWarehouseKeeperInventoryPermission, checkCashierInventoryPermission, inventoryController.updateQuantity);

module.exports = router;