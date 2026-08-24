const { pool } = require('../config/database');

// @desc    Get company ledger entries
// @route   GET /api/company-ledger/entries/:companyId
// @access  Private
const getCompanyLedgerEntries = async (req, res) => {
  try {
    const { companyId } = req.params;
    const { entryType, startDate, endDate } = req.query;
    
    // First, get the company name to search for
    const [companyResult] = await pool.execute('SELECT name FROM companies WHERE id = ?', [companyId]);
    if (companyResult.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Company not found'
      });
    }
    
    const companyName = companyResult[0].name;
    
    let query = `
      SELECT 
        id,
        entry_type,
        reference_id,
        description,
        debit_amount,
        credit_amount,
        branch_id,
        created_by,
        created_at
      FROM ledger_entries 
      WHERE description LIKE ?
    `;
    const params = [`%${companyName}%`];
    
    if (entryType) {
      query += ' AND entry_type = ?';
      params.push(entryType);
    }
    
    if (startDate) {
      query += ' AND created_at >= ?';
      params.push(startDate);
    }
    
    if (endDate) {
      query += ' AND created_at <= ?';
      params.push(endDate);
    }
    
    query += ' ORDER BY created_at DESC LIMIT 100';
    
    const [entries] = await pool.execute(query, params);
    
    
    // Transform entries to match frontend expectations
    const transformedEntries = entries.map(entry => ({
      id: entry.id,
      type: entry.debit_amount ? 'DEBIT' : 'CREDIT',
      amount: entry.debit_amount || entry.credit_amount,
      description: entry.description,
      reference: entry.entry_type,
      referenceId: entry.reference_id,
      createdAt: entry.created_at,
      createdBy: entry.created_by
    }));
    
    res.status(200).json({
      success: true,
      data: transformedEntries
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error retrieving company ledger entries',
      error: error.message
    });
  }
};

// @desc    Create company ledger entry
// @route   POST /api/company-ledger/entries
// @access  Private
const createCompanyLedgerEntry = async (req, res) => {
  try {
    const { 
      type, 
      amount, 
      description, 
      reference, 
      reference_id,
      companyId 
    } = req.body;
    
    // Insert ledger entry with company identifier in description
    const [result] = await pool.execute(`
      INSERT INTO ledger_entries (
        entry_type, 
        reference_id, 
        description, 
        debit_amount, 
        credit_amount, 
        branch_id, 
        created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
      reference || 'company_transaction', 
      reference_id || null, 
      `${description || 'Company Transaction'} [Company ID: ${companyId}]`, 
      type === 'DEBIT' ? amount : null,
      type === 'CREDIT' ? amount : null,
      null, // Set to null for company operations
      req.user?.id || null
    ]);
    
    // Get the created entry
    const [entries] = await pool.execute(
      'SELECT * FROM ledger_entries WHERE id = ?',
      [result.insertId]
    );
    
    const entry = entries[0];
    const transformedEntry = {
      id: entry.id,
      type: entry.debit_amount ? 'DEBIT' : 'CREDIT',
      amount: entry.debit_amount || entry.credit_amount,
      description: entry.description,
      reference: entry.entry_type,
      referenceId: entry.reference_id,
      createdAt: entry.created_at,
      createdBy: entry.created_by
    };
    
    res.status(201).json({
      success: true,
      message: 'Company ledger entry created successfully',
      data: transformedEntry
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error creating company ledger entry',
      error: error.message
    });
  }
};

// @desc    Get company ledger balance summary
// @route   GET /api/company-ledger/balance/:companyId
// @access  Private
const getCompanyLedgerBalance = async (req, res) => {
  try {
    const { companyId } = req.params;
    
    // First, get the company name to search for
    const [companyResult] = await pool.execute('SELECT name FROM companies WHERE id = ?', [companyId]);
    if (companyResult.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Company not found'
      });
    }
    
    const companyName = companyResult[0].name;
    
    const [balanceData] = await pool.execute(`
      SELECT 
        COALESCE(SUM(debit_amount), 0) as total_debits,
        COALESCE(SUM(credit_amount), 0) as total_credits,
        COALESCE(SUM(credit_amount), 0) - COALESCE(SUM(debit_amount), 0) as balance
      FROM ledger_entries 
      WHERE description LIKE ?
    `, [`%${companyName}%`]);
    
    const balance = balanceData[0];
    
    res.status(200).json({
      success: true,
      data: {
        totalDebits: parseFloat(balance.total_debits) || 0,
        totalCredits: parseFloat(balance.total_credits) || 0,
        balance: parseFloat(balance.balance) || 0
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error retrieving company ledger balance',
      error: error.message
    });
  }
};

module.exports = {
  getCompanyLedgerEntries,
  createCompanyLedgerEntry,
  getCompanyLedgerBalance
};
