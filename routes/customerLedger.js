const express = require('express');
const router = express.Router();
const customerLedgerController = require('../controllers/customerLedgerController');
const { requireCashier } = require('../middleware/rbac');
const { checkCashierCustomerEditPermission, checkWarehouseKeeperCustomerEditPermission } = require('../middleware/branchPermissions');

router.get('/customers', customerLedgerController.getAllCustomersWithSummaries);
router.get('/:customerId', customerLedgerController.getCustomerLedger);
router.get('/:customerId/export', customerLedgerController.exportCustomerLedger);
router.put('/:customerId/update-info', requireCashier, checkCashierCustomerEditPermission, checkWarehouseKeeperCustomerEditPermission, customerLedgerController.updateCustomerLedgerInfo);

module.exports = router;