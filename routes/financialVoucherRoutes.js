const express = require('express');
const router = express.Router();
const {
  getFinancialVouchers, getFinancialVoucherById, createFinancialVoucher,
  updateFinancialVoucher, approveFinancialVoucher, rejectFinancialVoucher,
  deleteFinancialVoucher, getFinancialVouchersByScope, getVoucherApprovalHistory,
  getVoucherItems, getFinancialSummary, getDailySummary, getPaymentMethodSummary,
  getFinancialAccounts, updateAccountBalance, createFinancialAccount, generateVoucherReport
} = require('../controllers/financialVoucherController');
const { rbac } = require('../middleware/rbac');
const { financialVoucherValidation, handleValidation } = require('../middleware/validation');
// auth is already applied globally in server.js

router.get('/', rbac('ADMIN', 'CASHIER', 'WAREHOUSE_KEEPER'), getFinancialVouchers);
router.get('/scope/:scopeType/:scopeId', rbac('ADMIN'), getFinancialVouchersByScope);
router.get('/summary', rbac('ADMIN'), getFinancialSummary);
router.get('/daily-summary', rbac('ADMIN'), getDailySummary);
router.get('/payment-method-summary', rbac('ADMIN'), getPaymentMethodSummary);
router.get('/accounts', rbac('ADMIN'), getFinancialAccounts);
router.get('/:id', rbac('ADMIN', 'CASHIER', 'WAREHOUSE_KEEPER'), getFinancialVoucherById);
router.get('/:id/approval-history', rbac('ADMIN', 'CASHIER', 'WAREHOUSE_KEEPER'), getVoucherApprovalHistory);
router.get('/:id/items', rbac('ADMIN', 'CASHIER', 'WAREHOUSE_KEEPER'), getVoucherItems);

router.post('/', rbac('ADMIN', 'CASHIER', 'WAREHOUSE_KEEPER'), financialVoucherValidation, handleValidation, createFinancialVoucher);
router.post('/accounts', rbac('ADMIN'), createFinancialAccount);
router.post('/reports/generate', rbac('ADMIN', 'CASHIER', 'WAREHOUSE_KEEPER'), generateVoucherReport);

router.put('/:id', rbac('ADMIN', 'CASHIER', 'WAREHOUSE_KEEPER'), financialVoucherValidation, handleValidation, updateFinancialVoucher);
router.put('/:id/approve', rbac('ADMIN'), approveFinancialVoucher);
router.put('/:id/reject', rbac('ADMIN'), rejectFinancialVoucher);
router.put('/accounts/:id/balance', rbac('ADMIN'), updateAccountBalance);

router.delete('/:id', rbac('ADMIN'), deleteFinancialVoucher);

module.exports = router;