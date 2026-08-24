const express = require('express');
const router = express.Router();
const reportsController = require('../controllers/reportsController');

// auth is already applied globally in server.js — do NOT add it here

router.get('/summary', reportsController.getReportsSummary);
router.get('/sales', reportsController.getSalesReports);
router.get('/clinic', reportsController.getClinicSalesReports);
router.get('/inventory', reportsController.getInventoryReports);
router.get('/ledger', reportsController.getLedgerReports);
router.get('/financial', reportsController.getFinancialReports);

module.exports = router;