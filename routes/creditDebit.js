const express = require('express');
const router = express.Router();
const creditDebitController = require('../controllers/creditDebitController');
const { requireCashier, requireAdmin } = require('../middleware/rbac');
const { validateCreditDebitTransaction } = require('../middleware/validation');
// auth is already applied globally in server.js — do NOT add it here

router.post('/', requireCashier, validateCreditDebitTransaction, creditDebitController.createTransaction);
router.get('/', requireCashier, creditDebitController.getTransactions);
router.get('/summary', requireCashier, creditDebitController.getSummary);
router.get('/customer-balances', requireCashier, creditDebitController.getCustomerBalances);
router.get('/:id', requireCashier, creditDebitController.getTransaction);
router.put('/:id', requireAdmin, validateCreditDebitTransaction, creditDebitController.updateTransaction);
router.delete('/:id', requireAdmin, creditDebitController.deleteTransaction);

module.exports = router;