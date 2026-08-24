const express = require('express');
const router = express.Router();
const customerController = require('../controllers/customerController');
const { requireCashier, requireAdmin } = require('../middleware/rbac');
const { validateCustomer } = require('../middleware/validation');
const { checkCashierCustomerEditPermission } = require('../middleware/branchPermissions');

router.post('/', requireCashier, validateCustomer, customerController.createCustomer);
router.get('/', requireCashier, customerController.getCustomers);
router.get('/:id', requireCashier, customerController.getCustomer);
router.put('/:id', requireCashier, checkCashierCustomerEditPermission, validateCustomer, customerController.updateCustomer);
router.delete('/:id', requireAdmin, customerController.deleteCustomer);
router.get('/:id/transactions', requireCashier, customerController.getCustomerTransactions);

module.exports = router;