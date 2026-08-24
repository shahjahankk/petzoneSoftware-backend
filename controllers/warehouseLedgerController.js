const { pool } = require('../config/database');
const { warehouseScopeMatchesUser } = require('../middleware/warehouseLedgerAccess');

const WAREHOUSE_ID_TAG = /\[Warehouse ID:\s*([^\]]+)\]/;

async function ensureLedgerAccountWarehouseAccess(req, accountId) {
  const [rows] = await pool.execute(
    'SELECT id, scope_type, scope_id FROM ledgers WHERE id = ? LIMIT 1',
    [accountId]
  );
  if (!rows.length) {
    return { ok: false, status: 404, message: 'Warehouse ledger account not found' };
  }
  if (rows[0].scope_type !== 'WAREHOUSE') {
    return { ok: false, status: 403, message: 'Not a warehouse ledger account' };
  }
  if (!warehouseScopeMatchesUser(req.user, rows[0].scope_id)) {
    return { ok: false, status: 403, message: 'Access denied to this warehouse ledger account' };
  }
  return { ok: true };
}

async function ensureLedgerEntryWarehouseAccess(req, entryId) {
  const [rows] = await pool.execute(
    'SELECT id, description FROM ledger_entries WHERE id = ? LIMIT 1',
    [entryId]
  );
  if (!rows.length) {
    return { ok: false, status: 404, message: 'Ledger entry not found' };
  }
  const desc = rows[0].description || '';
  const m = desc.match(WAREHOUSE_ID_TAG);
  const taggedWarehouse = m ? m[1].trim() : null;
  if (!taggedWarehouse) {
    if (req.user.role === 'ADMIN') return { ok: true };
    return {
      ok: false,
      status: 403,
      message: 'Cannot verify warehouse scope for this entry',
    };
  }
  if (!warehouseScopeMatchesUser(req.user, taggedWarehouse)) {
    return { ok: false, status: 403, message: 'Access denied to this ledger entry' };
  }
  return { ok: true };
}

// @desc    Get warehouse ledger accounts
// @route   GET /api/warehouse-ledger/accounts/:warehouseId
// @access  Private
const getWarehouseLedgerAccounts = async (req, res) => {
  try {
    const { warehouseId } = req.params;
    
    try {
      const query = `
        SELECT 
          id,
          account_name,
          account_type,
          balance,
          currency,
          status,
          description,
          created_at,
          updated_at
        FROM ledgers 
        WHERE scope_type = 'WAREHOUSE' AND scope_id = ?
        ORDER BY account_name ASC
      `;
      
      const [accounts] = await pool.execute(query, [warehouseId]);
      
      // If no ledger accounts exist for this warehouse, return empty array
      if (accounts.length === 0) {
        const response = {
          success: true,
          data: []
        };
        
        return res.status(200).json(response);
      }
      
      // Transform field names to match frontend expectations
      const transformedAccounts = accounts.map(account => ({
        id: account.id,
        accountName: account.account_name,
        accountType: account.account_type,
        balance: parseFloat(account.balance) || 0,
        currency: account.currency,
        status: account.status,
        description: account.description,
        createdAt: account.created_at,
        updatedAt: account.updated_at
      }));
      
      const response = {
        success: true,
        data: transformedAccounts
      };
      
      res.status(200).json(response);
    } catch (dbError) {
      // If ledger table doesn't exist or is empty, return empty array
      const response = {
        success: true,
        data: []
      };
      
      res.status(200).json(response);
    }
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error retrieving warehouse ledger accounts',
      error: error.message
    });
  }
};

// @desc    Create warehouse ledger account
// @route   POST /api/warehouse-ledger/accounts
// @access  Private
const createWarehouseLedgerAccount = async (req, res) => {
  try {
    const { 
      account_name, 
      account_type, 
      balance = 0, 
      description, 
      status = 'ACTIVE',
      warehouse_id 
    } = req.body;
    
    const [result] = await pool.execute(`
      INSERT INTO ledgers (
        account_name, 
        account_type, 
        balance, 
        currency, 
        status, 
        description,
        scope_type,
        scope_id,
        party_type,
        party_id
      ) VALUES (?, ?, ?, 'USD', ?, ?, 'WAREHOUSE', ?, 'ACCOUNT', ?)
    `, [
      account_name, 
      account_type, 
      balance, 
      status, 
      description,
      warehouse_id,
      account_name.toLowerCase().replace(/\s+/g, '_')
    ]);
    
    // Get the created account
    const [accounts] = await pool.execute(
      'SELECT * FROM ledgers WHERE id = ?',
      [result.insertId]
    );
    
    const account = accounts[0];
    const transformedAccount = {
      id: account.id,
      accountName: account.account_name,
      accountType: account.account_type,
      balance: parseFloat(account.balance) || 0,
      currency: account.currency,
      status: account.status,
      description: account.description,
      createdAt: account.created_at,
      updatedAt: account.updated_at
    };
    
    res.status(201).json({
      success: true,
      message: 'Warehouse ledger account created successfully',
      data: transformedAccount
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error creating warehouse ledger account',
      error: error.message
    });
  }
};

// @desc    Update warehouse ledger account
// @route   PUT /api/warehouse-ledger/accounts/:id
// @access  Private
const updateWarehouseLedgerAccount = async (req, res) => {
  try {
    const { id } = req.params;
    const access = await ensureLedgerAccountWarehouseAccess(req, id);
    if (!access.ok) {
      return res.status(access.status).json({ success: false, message: access.message });
    }

    const { account_name, account_type, balance, description, status } = req.body;
    
    const updateData = {};
    if (account_name) updateData.account_name = account_name;
    if (account_type) updateData.account_type = account_type;
    if (balance !== undefined) updateData.balance = balance;
    if (description) updateData.description = description;
    if (status) updateData.status = status;
    
    const updateFields = Object.keys(updateData).map(key => `${key} = ?`).join(', ');
    const values = Object.values(updateData);
    values.push(id);
    
    const query = `UPDATE ledgers SET ${updateFields}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`;
    
    const [result] = await pool.execute(query, values);
    
    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        message: 'Warehouse ledger account not found'
      });
    }
    
    // Get updated account
    const [accounts] = await pool.execute(
      'SELECT * FROM ledgers WHERE id = ?',
      [id]
    );
    
    const account = accounts[0];
    const transformedAccount = {
      id: account.id,
      accountName: account.account_name,
      accountType: account.account_type,
      balance: parseFloat(account.balance) || 0,
      currency: account.currency,
      status: account.status,
      description: account.description,
      createdAt: account.created_at,
      updatedAt: account.updated_at
    };
    
    res.status(200).json({
      success: true,
      message: 'Warehouse ledger account updated successfully',
      data: transformedAccount
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error updating warehouse ledger account',
      error: error.message
    });
  }
};

// @desc    Delete warehouse ledger account
// @route   DELETE /api/warehouse-ledger/accounts/:id
// @access  Private
const deleteWarehouseLedgerAccount = async (req, res) => {
  try {
    const { id } = req.params;

    const access = await ensureLedgerAccountWarehouseAccess(req, id);
    if (!access.ok) {
      return res.status(access.status).json({ success: false, message: access.message });
    }

    const trashService = require('../services/trashService');
    await trashService.softDelete('ledger', id, req.user.id);
    
    res.status(200).json({
      success: true,
      message: 'Warehouse ledger account moved to trash successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error deleting warehouse ledger account',
      error: error.message
    });
  }
};

// @desc    Get warehouse ledger entries
// @route   GET /api/warehouse-ledger/entries/:warehouseId
// @access  Private
const getWarehouseLedgerEntries = async (req, res) => {
  try {
    const { warehouseId } = req.params;
    const { entryType, startDate, endDate } = req.query;
    
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
      WHERE branch_id IS NULL AND description LIKE ?
    `;
    const params = [`%Warehouse ID: ${warehouseId}%`];
    
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
      message: 'Error retrieving warehouse ledger entries',
      error: error.message
    });
  }
};

// @desc    Create warehouse ledger entry
// @route   POST /api/warehouse-ledger/entries
// @access  Private
const createWarehouseLedgerEntry = async (req, res) => {
  try {
    const { 
      type, 
      amount, 
      description, 
      reference, 
      reference_id,
      warehouseId 
    } = req.body;
    
    // Insert ledger entry with warehouse identifier in description
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
      reference || 'warehouse_sale', 
      reference_id || null, 
      `${description || 'Warehouse Sale'} [Warehouse ID: ${warehouseId}]`, 
      type === 'DEBIT' ? amount : null,
      type === 'CREDIT' ? amount : null,
      null, // Set to null for warehouse operations
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
      message: 'Warehouse ledger entry created successfully',
      data: transformedEntry
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error creating warehouse ledger entry',
      error: error.message
    });
  }
};

// @desc    Update warehouse ledger entry
// @route   PUT /api/warehouse-ledger/entries/:id
// @access  Private
const updateWarehouseLedgerEntry = async (req, res) => {
  try {
    const { id } = req.params;

    const access = await ensureLedgerEntryWarehouseAccess(req, id);
    if (!access.ok) {
      return res.status(access.status).json({ success: false, message: access.message });
    }

    const { amount, description, reference, reference_id } = req.body;
    
    const updateData = {};
    if (amount !== undefined) {
      // Determine if it's debit or credit based on existing entry
      const [existing] = await pool.execute('SELECT * FROM ledger_entries WHERE id = ?', [id]);
      if (existing.length > 0) {
        if (existing[0].debit_amount) {
          updateData.debit_amount = amount;
          updateData.credit_amount = null;
        } else {
          updateData.credit_amount = amount;
          updateData.debit_amount = null;
        }
      }
    }
    if (description) updateData.description = description;
    if (reference) updateData.entry_type = reference;
    if (reference_id) updateData.reference_id = reference_id;
    
    const updateFields = Object.keys(updateData).map(key => `${key} = ?`).join(', ');
    const values = Object.values(updateData);
    values.push(id);
    
    const query = `UPDATE ledger_entries SET ${updateFields} WHERE id = ?`;
    
    const [result] = await pool.execute(query, values);
    
    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        message: 'Warehouse ledger entry not found'
      });
    }
    
    // Get updated entry
    const [entries] = await pool.execute(
      'SELECT * FROM ledger_entries WHERE id = ?',
      [id]
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
    
    res.status(200).json({
      success: true,
      message: 'Warehouse ledger entry updated successfully',
      data: transformedEntry
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error updating warehouse ledger entry',
      error: error.message
    });
  }
};

// @desc    Delete warehouse ledger entry
// @route   DELETE /api/warehouse-ledger/entries/:id
// @access  Private
const deleteWarehouseLedgerEntry = async (req, res) => {
  try {
    const { id } = req.params;

    const access = await ensureLedgerEntryWarehouseAccess(req, id);
    if (!access.ok) {
      return res.status(access.status).json({ success: false, message: access.message });
    }

    const trashService = require('../services/trashService');
    await trashService.softDelete('ledger_entry', id, req.user.id);
    
    res.status(200).json({
      success: true,
      message: 'Warehouse ledger entry moved to trash successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error deleting warehouse ledger entry',
      error: error.message
    });
  }
};

// @desc    Get warehouse balance summary
// @route   GET /api/warehouse-ledger/balance-summary/:warehouseId
// @access  Private
const getWarehouseBalanceSummary = async (req, res) => {
  try {
    const { warehouseId } = req.params;
    
    const [accounts] = await pool.execute(`
      SELECT 
        account_type,
        SUM(balance) as total_balance
      FROM ledgers 
      WHERE scope_type = 'WAREHOUSE' AND scope_id = ?
      GROUP BY account_type
    `, [warehouseId]);
    
    const summary = {
      totalAssets: 0,
      totalLiabilities: 0,
      totalEquity: 0,
      totalRevenue: 0,
      totalExpenses: 0
    };
    
    accounts.forEach(account => {
      const balance = parseFloat(account.total_balance) || 0;
      switch (account.account_type) {
        case 'asset':
          summary.totalAssets = balance;
          break;
        case 'liability':
          summary.totalLiabilities = balance;
          break;
        case 'equity':
          summary.totalEquity = balance;
          break;
        case 'revenue':
          summary.totalRevenue = balance;
          break;
        case 'expense':
          summary.totalExpenses = balance;
          break;
      }
    });
    
    summary.netIncome = summary.totalRevenue - summary.totalExpenses;
    
    res.status(200).json({
      success: true,
      data: summary
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error retrieving warehouse balance summary',
      error: error.message
    });
  }
};

module.exports = {
  getWarehouseLedgerAccounts,
  createWarehouseLedgerAccount,
  updateWarehouseLedgerAccount,
  deleteWarehouseLedgerAccount,
  getWarehouseLedgerEntries,
  createWarehouseLedgerEntry,
  updateWarehouseLedgerEntry,
  deleteWarehouseLedgerEntry,
  getWarehouseBalanceSummary
};
