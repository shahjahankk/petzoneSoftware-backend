const { pool } = require('../config/database');

/**
 * Frozen totals at posting time — stable invoice reprint (GET does not recompute from sales).
 * GET /api/sales/:id/invoice-snapshot (registered before generic GET /api/sales/:id)
 */
const getInvoiceSnapshotBySaleId = async (req, res, next) => {
  try {
    const saleId = parseInt(req.params.id, 10);
    if (!Number.isFinite(saleId)) {
      return res.status(400).json({ success: false, message: 'Invalid sale id' });
    }
    const [rows] = await pool.execute(
      'SELECT * FROM invoice_snapshots WHERE sale_id = ? LIMIT 1',
      [saleId]
    );
    return res.json({ success: true, data: rows[0] || null });
  } catch (err) {
    return next(err);
  }
};

module.exports = { getInvoiceSnapshotBySaleId };
