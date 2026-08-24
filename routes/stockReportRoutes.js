const express = require('express');
const router = express.Router();
const { getStockReports, getStockSummary, getProductStockHistory, getStockReportsByScope, getStockReportStatistics } = require('../controllers/stockReportController');
// auth is already applied globally in server.js — do NOT add router.use(auth) here

router.get('/', getStockReports);
router.get('/summary', getStockSummary);
router.get('/product/:id', getProductStockHistory);
router.get('/scope/:scopeType/:scopeId', getStockReportsByScope);
router.get('/statistics', getStockReportStatistics);

module.exports = router;