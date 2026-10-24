const { pool } = require('../config/database');

// Reporting analytics live in the standalone petzone-data-warehouse service.
// The POS backend only keeps this lightweight dashboard counter endpoint; all
// /api/reports/* analytics routes are proxied by routes/reports.js.

// @desc    Get reports summary
// @route   GET /api/reports/summary
// @access  Private
const getReportsSummary = async (req, res) => {
  try {
    const user = req.user;
    const summary = {
      totalSales: 0, totalRevenue: 0, totalCustomers: 0, totalProducts: 0,
      totalOrders: 0, totalInventory: 0, totalCompanies: 0, totalTransfers: 0,
      totalLedgerEntries: 0, totalBillingRecords: 0,
    };

    try {
      let q = 'SELECT COUNT(*) as count FROM companies'; const p = [];
      if (user?.role === 'WAREHOUSE_KEEPER' && user?.warehouseId) { q += ' WHERE warehouse_id = ?'; p.push(user.warehouseId); }
      const [r] = await pool.execute(q, p); summary.totalCompanies = r[0]?.count || 0;
    } catch (e) { /* optional */ }

    try {
      let q = 'SELECT COUNT(*) as count FROM ledgers'; const p = [];
      if (user?.role === 'WAREHOUSE_KEEPER' && user?.warehouseId) { q += ' WHERE scope_id = ? AND scope_type = "WAREHOUSE"'; p.push(user.warehouseId); }
      const [r] = await pool.execute(q, p); summary.totalLedgerEntries = r[0]?.count || 0;
    } catch (e) { /* optional */ }

    try {
      let q = `SELECT COUNT(*) as count FROM sales WHERE status='COMPLETED'
               AND deleted_at IS NULL
               AND (payment_type IS NULL OR payment_type NOT IN ('OUTSTANDING_SETTLEMENT','CASH_REFUND','REFUND','BILTY_CHARGE','CREDIT_REFUND_SETTLEMENT'))
               AND (payment_method IS NULL OR payment_method NOT IN ('CASH_REFUND','REFUND'))`;
      const p = [];
      if (user?.role === 'WAREHOUSE_KEEPER' && user?.warehouseId) { q += ' AND scope_type = "WAREHOUSE" AND scope_id = ?'; p.push(String(user.warehouseId)); }
      const [r] = await pool.execute(q, p); summary.totalSales = r[0]?.count || 0;
    } catch (e) { /* optional */ }

    try {
      let q = 'SELECT COUNT(*) as count FROM inventory_items'; const p = [];
      if (user?.role === 'WAREHOUSE_KEEPER' && user?.warehouseId) { q += ' WHERE scope_type = "WAREHOUSE" AND scope_id = ?'; p.push(String(user.warehouseId)); }
      const [r] = await pool.execute(q, p); summary.totalProducts = r[0]?.count || 0;
    } catch (e) { /* optional */ }

    try {
      const [r] = await pool.execute('SELECT COUNT(*) as count FROM transfers');
      summary.totalTransfers = r[0]?.count || 0;
    } catch (e) { /* optional */ }

    res.json({ success: true, data: summary });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error retrieving reports summary', error: error.message });
  }
};

module.exports = { getReportsSummary };
