const express = require('express');
const router = express.Router();
const { getCompanyLedger, createCompanySettlement } = require('../controllers/companyLedgerController');
const { requireAdmin } = require('../middleware/rbac');
// auth is already applied globally in server.js — do NOT add it here

router.get('/:companyId', requireAdmin, getCompanyLedger);
router.post('/settlements', requireAdmin, createCompanySettlement);

module.exports = router;