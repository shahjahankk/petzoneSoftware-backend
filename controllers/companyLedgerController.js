const { pool } = require('../config/database');
const { ensureSchema, addEntry } = require('../services/companyLedgerService');

const COMPANY_PAYMENT_METHODS = new Set(['CASH', 'CARD', 'BANK_TRANSFER', 'CHEQUE']);

const getCompanyOr404 = async (companyId, res) => {
  const [rows] = await pool.execute('SELECT * FROM companies WHERE id = ?', [companyId]);
  if (!rows.length) {
    res.status(404).json({ success: false, message: 'Company not found' });
    return null;
  }
  return rows[0];
};

const getCompanyLedger = async (req, res) => {
  try {
    await ensureSchema();
    const company = await getCompanyOr404(req.params.companyId, res);
    if (!company) return;
    const { startDate, endDate } = req.query;
    const params = [company.id];
    let dateWhere = '';
    if (startDate) { dateWhere += ' AND entry_date >= ?'; params.push(startDate); }
    if (endDate) { dateWhere += ' AND entry_date <= ?'; params.push(endDate); }

    const [entries] = await pool.execute(`
      SELECT cle.*, u.username AS created_by_name
      FROM company_ledger_entries cle
      LEFT JOIN users u ON u.id = cle.created_by
      WHERE cle.company_id = ? ${dateWhere}
      ORDER BY cle.entry_date DESC, cle.id DESC
      LIMIT 500
    `, params);
    const [summaryRows] = await pool.execute(`
      SELECT COALESCE(SUM(debit_amount), 0) AS purchases,
             COALESCE(SUM(credit_amount), 0) AS paid,
             COALESCE(SUM(debit_amount - credit_amount), 0) AS balance
      FROM company_ledger_entries WHERE company_id = ? ${dateWhere}
    `, params);
    const summary = summaryRows[0] || {};
    res.json({
      success: true,
      data: {
        company,
        summary: {
          purchases: Number(summary.purchases) || 0,
          paid: Number(summary.paid) || 0,
          balance: Number(summary.balance) || 0
        },
        entries
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error retrieving company ledger', error: error.message });
  }
};

const createCompanySettlement = async (req, res) => {
  try {
    await ensureSchema();
    const company = await getCompanyOr404(req.body.companyId, res);
    if (!company) return;
    const amount = Number(req.body.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ success: false, message: 'Settlement amount must be greater than zero' });
    }
    const paymentMethod = String(req.body.paymentMethod || 'CASH').toUpperCase();
    if (!COMPANY_PAYMENT_METHODS.has(paymentMethod)) {
      return res.status(400).json({ success: false, message: 'Invalid settlement payment method' });
    }
    const [balanceRows] = await pool.execute(`
      SELECT COALESCE(SUM(debit_amount - credit_amount), 0) AS balance
      FROM company_ledger_entries WHERE company_id = ?
    `, [company.id]);
    const outstanding = Number(balanceRows[0]?.balance) || 0;
    if (amount > outstanding + 0.01) {
      return res.status(400).json({ success: false, message: `Settlement exceeds outstanding balance of ${outstanding.toFixed(2)}` });
    }
    const entryId = await addEntry({
      companyId: company.id,
      entryType: 'PAYMENT',
      referenceType: 'COMPANY_SETTLEMENT',
      referenceId: `SETTLEMENT-${Date.now()}-${req.user.id}`,
      paymentMethod,
      creditAmount: amount,
      description: req.body.description || `Payment to ${company.name}`,
      entryDate: req.body.entryDate || null,
      createdBy: req.user.id
    });
    res.status(201).json({ success: true, message: 'Company settlement recorded', data: { id: entryId } });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error recording company settlement', error: error.message });
  }
};

module.exports = { getCompanyLedger, createCompanySettlement };
