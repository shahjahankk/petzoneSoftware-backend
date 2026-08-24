const express = require('express');
const router = express.Router();
const { rbac } = require('../middleware/rbac');
const { getWarehouseSalesAnalytics, exportWarehouseSalesAnalytics } = require('../controllers/warehouseSalesAnalyticsController');
// auth is already applied globally in server.js — do NOT add it here

router.get('/:warehouseId/analytics', rbac('ADMIN', 'WAREHOUSE_KEEPER'), getWarehouseSalesAnalytics);
router.get('/:warehouseId/analytics/export', rbac('ADMIN', 'WAREHOUSE_KEEPER'), exportWarehouseSalesAnalytics);

module.exports = router;