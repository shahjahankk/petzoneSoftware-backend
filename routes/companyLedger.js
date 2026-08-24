const express = require('express');
const router = express.Router();
const { getCompanyLedgerEntries, createCompanyLedgerEntry, getCompanyLedgerBalance } = require('../controllers/companyLedgerController');
// auth is already applied globally in server.js — do NOT add it here

router.get('/entries/:companyId', getCompanyLedgerEntries);
router.post('/entries', createCompanyLedgerEntry);
router.get('/balance/:companyId', getCompanyLedgerBalance);

module.exports = router;