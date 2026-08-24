const express = require('express');
const router = express.Router();
const billingController = require('../controllers/billingController');
const { requireAdmin, requireWarehouseKeeper } = require('../middleware/rbac');
const { checkWarehouseKeeperCompanyPermission } = require('../middleware/branchPermissions');
const { validateBilling, validateBillingUpdate } = require('../middleware/validation');
// auth is already applied globally in server.js — do NOT add it here

// GET /api/billing
router.get('/', billingController.getBillingRecords);

// POST /api/billing
router.post('/', validateBilling, billingController.createBillingRecord);

// PUT /api/billing/:id
router.put('/:id', validateBillingUpdate, billingController.updateBillingRecord);

// DELETE /api/billing/:id
router.delete('/:id', requireAdmin, billingController.deleteBillingRecord);

// POST /api/billing/generate
router.post('/generate', requireWarehouseKeeper, checkWarehouseKeeperCompanyPermission, billingController.generateBill);

// POST /api/billing/:saleId/print
router.post('/:saleId/print', requireWarehouseKeeper, billingController.printInvoice);

// GET /api/billing/history
router.get('/history', billingController.getBillingHistory);

module.exports = router;