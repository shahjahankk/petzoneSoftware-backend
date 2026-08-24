const express = require('express')
const router = express.Router()
const auth = require('../middleware/auth')
const { getDashboardAnalytics, getDashboardSummary } = require('../controllers/dashboardController')

// Dashboard analytics endpoint
router.get('/analytics', getDashboardAnalytics)

// Dashboard summary endpoint (lighter version)
router.get('/summary', getDashboardSummary)

module.exports = router