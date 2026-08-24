const express = require('express');
const router = express.Router();
const { rbac } = require('../middleware/rbac');
const {
  validateLedgerEntry,
  validateLedgerAccount,
  validateLedgerAccountUpdate,
  validateLedgerEntryUpdate,
  handleValidation
} = require('../middleware/validation');
const {
  getLedger, getLedgersByScope, addDebitEntry, addCreditEntry, addEntryByAccountId,
  getLedgerEntries, getBalanceSummary, getLedgerAccounts, createLedgerAccount,
  updateLedgerAccount, deleteLedgerAccount, updateLedgerEntry, deleteLedgerEntry,
  populateDefaultAccounts
} = require('../controllers/ledgerController');
// auth is already applied globally in server.js

const requireLedgerAccess = (req, res, next) => {
  if (!['ADMIN', 'MANAGER', 'WAREHOUSE_KEEPER'].includes(req.user.role))
    return res.status(403).json({ success: false, message: 'Insufficient permissions' });
  next();
};

// Accounts
router.get('/accounts', requireLedgerAccess, getLedgerAccounts);
router.post('/accounts', rbac('ADMIN'), validateLedgerAccount, handleValidation, createLedgerAccount);
router.post('/accounts/populate', rbac('ADMIN'), populateDefaultAccounts);
router.put('/accounts/:id', rbac('ADMIN', 'WAREHOUSE_KEEPER'), validateLedgerAccountUpdate, handleValidation, updateLedgerAccount);
router.delete('/accounts/:id', rbac('ADMIN'), deleteLedgerAccount);

// Entries
router.get('/entries', requireLedgerAccess, getLedgerEntries);
router.put('/entries/:id', requireLedgerAccess, validateLedgerEntryUpdate, handleValidation, updateLedgerEntry);
router.delete('/entries/:id', requireLedgerAccess, deleteLedgerEntry);

// Summary & scope
router.get('/balance/:scopeType/:scopeId', requireLedgerAccess, getBalanceSummary);
router.get('/scope/:scopeType/:scopeId', requireLedgerAccess, getLedgersByScope);

// Party-based
router.get('/:scopeType/:scopeId/:partyType/:partyId/entries', requireLedgerAccess, getLedgerEntries);
router.post('/:scopeType/:scopeId/:partyType/:partyId/debit', requireLedgerAccess, validateLedgerEntry, handleValidation, addDebitEntry);
router.post('/:scopeType/:scopeId/:partyType/:partyId/credit', requireLedgerAccess, validateLedgerEntry, handleValidation, addCreditEntry);
router.post('/account/:accountId/entry', requireLedgerAccess, validateLedgerEntry, handleValidation, addEntryByAccountId);
router.get('/:scopeType/:scopeId/:partyType/:partyId', requireLedgerAccess, getLedger);

module.exports = router;