const Ledger = require('../models/Ledger');
const InventoryItem = require('../models/InventoryItem');
const Branch = require('../models/Branch');
const Warehouse = require('../models/Warehouse');
const Company = require('../models/Company');
const { pool } = require('../config/database');

// Get ledger by scope and party
const getLedger = async (req, res) => {
  try {
    const { scopeType, scopeId, partyType, partyId } = req.params;
    
    const ledger = await Ledger.findOne({
      scopeType,
      scopeId,
      partyType,
      partyId,
    });

    if (!ledger) {
      return res.status(404).json({
        success: false,
        message: 'Ledger not found',
      });
    }

    res.status(200).json({
      success: true,
      data: ledger,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error retrieving ledger',
      error: error.message
    });
  }
};

// Get all ledgers for a scope
const getLedgersByScope = async (req, res) => {
  try {
    const { scopeType, scopeId } = req.params;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const skip = (page - 1) * limit;

    const ledgers = await Ledger.find(
      { scopeType, scopeId },
      { sort: '-updated_at', limit, skip }
    );

    const total = await Ledger.count({ scopeType, scopeId });

    res.status(200).json({
      success: true,
      data: ledgers,
      pagination: {
        current: page,
        pages: Math.ceil(total / limit) || 1,
        total,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error retrieving ledgers',
      error: error.message
    });
  }
};

// Add debit entry
const addDebitEntry = async (req, res) => {
  try {
    const { scopeType, scopeId, partyType, partyId } = req.params;
    const { amount, description, reference, referenceId } = req.body;
    
    // Validate scope exists
    await validateScope(scopeType, scopeId);
    
    const ledger = await Ledger.findOrCreate(scopeType, scopeId, partyType, partyId);
    
    await ledger.addEntry(
      'DEBIT',
      amount,
      description,
      reference,
      referenceId,
      req.user.id
    );
    
    // Get the created entry
    const [entries] = await pool.execute(
      'SELECT * FROM ledger_entries WHERE branch_id = ? ORDER BY created_at DESC LIMIT 1',
      [ledger.id]
    );
    
    res.status(201).json({
      success: true,
      message: 'Debit entry added successfully',
      data: entries[0] || { ledgerId: ledger.id, balance: ledger.balance }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error adding debit entry',
      error: error.message
    });
  }
};

// Add credit entry
const addCreditEntry = async (req, res) => {
  try {
    const { scopeType, scopeId, partyType, partyId } = req.params;
    const { amount, description, reference, referenceId } = req.body;
    
    // Validate scope exists
    await validateScope(scopeType, scopeId);
    
    const ledger = await Ledger.findOrCreate(scopeType, scopeId, partyType, partyId);
    
    await ledger.addEntry(
      'CREDIT',
      amount,
      description,
      reference,
      referenceId,
      req.user.id
    );
    
    // Get the created entry
    const [entries] = await pool.execute(
      'SELECT * FROM ledger_entries WHERE branch_id = ? ORDER BY created_at DESC LIMIT 1',
      [ledger.id]
    );
    
    res.status(201).json({
      success: true,
      message: 'Credit entry added successfully',
      data: entries[0] || { ledgerId: ledger.id, balance: ledger.balance }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error adding credit entry',
      error: error.message
    });
  }
};

// Add entry by account ID (simpler approach)
const addEntryByAccountId = async (req, res) => {
  try {
    const { accountId } = req.params;
    const { type, amount, description, reference, referenceId } = req.body;
    
    // Validate account exists
    const [accounts] = await pool.execute('SELECT * FROM ledgers WHERE id = ?', [accountId]);
    
    if (accounts.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Account not found'
      });
    }
    
    const account = accounts[0];
    
    const [result] = await pool.execute(
      `INSERT INTO ledger_entries (entry_type, reference_id, description, debit_amount, credit_amount, branch_id, created_by, created_at) 
       VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        type,
        referenceId || null,
        description || null,
        type === 'DEBIT' ? amount : 0,
        type === 'CREDIT' ? amount : 0,
        accountId,
        req.user.id || null,
      ]
    );
    
    // Update account balance
    let newBalance = parseFloat(account.balance);
    if (type === 'DEBIT') {
      newBalance += parseFloat(amount);
    } else {
      newBalance -= parseFloat(amount);
    }
    
    await pool.execute(
      'UPDATE ledgers SET balance = ? WHERE id = ?',
      [newBalance, accountId]
    );
    
    // Get the created entry
    const [entries] = await pool.execute(
      'SELECT * FROM ledger_entries WHERE id = ?',
      [result.insertId]
    );
    
    res.status(201).json({
      success: true,
      message: `${type} entry added successfully`,
      data: entries[0] || { ledgerId: accountId, balance: newBalance }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: `Error adding ${req.body.type || 'ledger'} entry`,
      error: error.message
    });
  }
};

// Get ledger entries
const getLedgerEntries = async (req, res) => {
  try {
    const { scopeType, scopeId, partyType, partyId } = req.params;
    const { limit: limitRaw = 1000, offset = 0, ledgerId, type, startDate, endDate } = req.query;
    const limit = Math.min(5000, Math.max(1, parseInt(limitRaw, 10) || 1000));
    
    // If called from general /entries endpoint
    if (!scopeType || !scopeId || !partyType || !partyId) {
      // Get all entries from ledger_entries table
      try {
        let query = `
          SELECT 
            le.id,
            le.entry_type as type,
            le.reference_id,
            le.description,
            le.debit_amount,
            le.credit_amount,
            le.branch_id as ledger_id,
            le.created_by,
            le.created_at as date,
            l.account_name as ledger_account_name,
            l.scope_type,
            l.scope_id,
            CASE 
              WHEN le.entry_type = 'DEBIT' THEN le.debit_amount
              WHEN le.entry_type = 'CREDIT' THEN le.credit_amount
              ELSE 0
            END as amount
          FROM ledger_entries le
          LEFT JOIN ledgers l ON le.branch_id = l.id
          WHERE le.entry_type IS NOT NULL AND le.entry_type != ''
        `;
        const params = [];
        
        if (ledgerId) {
          query += ' AND le.branch_id = ?';
          params.push(ledgerId);
        }
        
        if (type) {
          query += ' AND le.entry_type = ?';
          params.push(type);
        }
        
        if (startDate) {
          query += ' AND le.created_at >= ?';
          params.push(startDate);
        }
        
        if (endDate) {
          query += ' AND le.created_at <= ?';
          params.push(endDate);
        }
        
        const limitInt = limit;
        const offsetInt = parseInt(offset) || 0;
        query += ` GROUP BY le.id ORDER BY le.created_at DESC LIMIT ${limitInt} OFFSET ${offsetInt}`;
        
        const [entries] = await pool.execute(query, params);
        
        return res.status(200).json({
          success: true,
          data: entries
        });
      } catch (dbError) {
        // If ledger_entries table doesn't exist, return empty array
        return res.status(200).json({
          success: true,
          data: []
        });
      }
    }
    
    // Original parameterized logic
    const ledger = await Ledger.findOne({
      scopeType,
      scopeId,
      partyType,
      partyId,
    });

    if (!ledger) {
      return res.status(404).json({
        success: false,
        message: 'Ledger not found',
      });
    }

    const entries = ledger.getEntries(limit, parseInt(offset, 10) || 0);

    res.status(200).json({
      success: true,
      data: {
        ledgerId: ledger.id,
        balance: ledger.balance,
        entries,
        totalEntries: ledger.entries.length,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error retrieving ledger entries',
      error: error.message
    });
  }
};

// Get balance summary for scope
const getBalanceSummary = async (req, res) => {
  try {
    const { scopeType, scopeId } = req.params;
    
    // Try to get balances from ledger table
    let balances = [];
    try {
      balances = await Ledger.getBalancesByScope(scopeType, scopeId);
    } catch (ledgerError) {
      // If ledger table doesn't exist or has issues, return empty summary
    }
    
    const summary = balances.reduce((acc, ledger) => {
      const partyType = ledger.party_type || 'UNKNOWN';
      if (!acc[partyType]) {
        acc[partyType] = 0;
      }
      acc[partyType] += parseFloat(ledger.balance) || 0;
      return acc;
    }, {});
    
    res.status(200).json({
      success: true,
      data: {
        scopeType,
        scopeId,
        balances: summary,
        totalBalance: Object.values(summary).reduce((sum, balance) => sum + balance, 0)
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error retrieving balance summary',
      error: error.message
    });
  }
};

// Helper function to validate scope
const validateScope = async (scopeType, scopeId) => {
  let scope;
  
  switch (scopeType) {
    case 'BRANCH':
      scope = await Branch.findById(scopeId);
      break;
    case 'WAREHOUSE':
      scope = await Warehouse.findById(scopeId);
      break;
    case 'COMPANY':
      scope = await Company.findById(scopeId);
      break;
    default:
      throw new Error('Invalid scope type');
  }
  
  if (!scope) {
    throw new Error(`${scopeType} not found`);
  }
  
  return scope;
};

// Get all ledger accounts (chart of accounts)
const getLedgerAccounts = async (req, res) => {
  try {
    const { page = 1, limit = 20, status, accountType } = req.query;
    const { pool } = require('../config/database');
    
    try {
      // Build query for distinct accounts from ledgers table
      let query = `
        SELECT DISTINCT 
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
        WHERE account_name IS NOT NULL
      `;
      const params = [];
      
      if (status) {
        query += ' AND status = ?';
        params.push(status);
      }
      
      if (accountType) {
        query += ' AND account_type = ?';
        params.push(accountType);
      }
      
      const limitInt = parseInt(limit) || 20;
      const offsetInt = parseInt((parseInt(page) - 1) * parseInt(limit)) || 0;
      query += ` ORDER BY account_name ASC LIMIT ${limitInt} OFFSET ${offsetInt}`;
      
      const [accounts] = await pool.execute(query, params);
      
      // Check if ledger table is empty and return default accounts
      if (accounts.length === 0) {
        
        const defaultAccounts = [
          {
            id: 1,
            accountName: 'Cash Account',
            accountType: 'asset',
            balance: 0,
            currency: 'USD',
            status: 'ACTIVE',
            description: 'Main cash account for transactions',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          },
          {
            id: 2,
            accountName: 'Bank Account',
            accountType: 'asset',
            balance: 0,
            currency: 'USD',
            status: 'ACTIVE',
            description: 'Main bank account for transactions',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          },
          {
            id: 3,
            accountName: 'Accounts Receivable',
            accountType: 'asset',
            balance: 0,
            currency: 'USD',
            status: 'ACTIVE',
            description: 'Money owed by customers',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          },
          {
            id: 4,
            accountName: 'Sales Revenue',
            accountType: 'revenue',
            balance: 0,
            currency: 'USD',
            status: 'ACTIVE',
            description: 'Revenue from sales',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          },
          {
            id: 5,
            accountName: 'Cost of Goods Sold',
            accountType: 'expense',
            balance: 0,
            currency: 'USD',
            status: 'ACTIVE',
            description: 'Cost of inventory sold',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          }
        ];
        
        const response = {
          success: true,
          data: defaultAccounts,
          pagination: {
            current: 1,
            pages: 1,
            total: defaultAccounts.length
          }
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
      
      
      // Get total count
      let countQuery = 'SELECT COUNT(DISTINCT account_name) as total FROM ledgers WHERE account_name IS NOT NULL';
      const countParams = [];
      
      if (status) {
        countQuery += ' AND status = ?';
        countParams.push(status);
      }
      
      if (accountType) {
        countQuery += ' AND account_type = ?';
        countParams.push(accountType);
      }
      
      const [countResult] = await pool.execute(countQuery, countParams);
      const total = countResult[0].total;
      
      const response = {
        success: true,
        data: transformedAccounts,
        pagination: {
          current: parseInt(page),
          pages: Math.ceil(total / limit),
          total
        }
      };
      
      res.status(200).json(response);
    } catch (dbError) {
      // If ledger table doesn't exist or is empty, return default accounts
      
      const defaultAccounts = [
        {
          id: 1,
          accountName: 'Cash Account',
          accountType: 'asset',
          balance: 0,
          currency: 'USD',
          status: 'ACTIVE',
          description: 'Main cash account for transactions',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        },
        {
          id: 2,
          accountName: 'Accounts Receivable',
          accountType: 'asset',
          balance: 0,
          currency: 'USD',
          status: 'ACTIVE',
          description: 'Outstanding customer payments',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        },
        {
          id: 3,
          accountName: 'Sales Revenue',
          accountType: 'revenue',
          balance: 0,
          currency: 'USD',
          status: 'ACTIVE',
          description: 'Revenue from sales transactions',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
      ];
      
      const response = {
        success: true,
        data: defaultAccounts,
        pagination: {
          current: 1,
          pages: 1,
          total: defaultAccounts.length
        }
      };
      
      res.status(200).json(response);
    }
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error retrieving ledger accounts',
      error: error.message
    });
  }
};

// Create ledger account
const createLedgerAccount = async (req, res) => {
  try {
    const { accountName, accountType, balance = 0, description, status = 'ACTIVE' } = req.body;
    
    // Get the first available company ID
    const { pool } = require('../config/database');
    const [companies] = await pool.execute('SELECT id FROM companies LIMIT 1');
    const companyId = companies.length > 0 ? companies[0].id : 1;
    
    // Create a ledger account in the ledgers table
    const [result] = await pool.execute(`
      INSERT INTO ledgers (
        scope_type,
        scope_id,
        party_type,
        party_id,
        balance,
        currency,
        status,
        account_name,
        account_type,
        description
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      'COMPANY',
      companyId,
      'ACCOUNT',
      accountName.toLowerCase().replace(/\s+/g, '_'),
      balance,
      'USD',
      status,
      accountName,
      accountType,
      description
    ]);
    
    // Get the created account
    const [accounts] = await pool.execute(
      'SELECT * FROM ledgers WHERE id = ?',
      [result.insertId]
    );
    
    const account = accounts[0];
    const ledgerAccount = {
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
      message: 'Ledger account created successfully',
      data: ledgerAccount
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error creating ledger account',
      error: error.message
    });
  }
};

// Update ledger account
const updateLedgerAccount = async (req, res) => {
  try {
    const { id } = req.params;
    const { accountName, accountType, balance, description, status } = req.body;
    
    const updateData = {};
    if (accountName) updateData.accountName = accountName;
    if (accountType) updateData.accountType = accountType;
    if (balance !== undefined) updateData.balance = balance;
    if (description) updateData.description = description;
    if (status) updateData.status = status;
    
    const result = await Ledger.updateOne({ id }, updateData);
    
    if (result.modifiedCount === 0) {
      return res.status(404).json({
        success: false,
        message: 'Ledger account not found'
      });
    }
    
    const updatedAccount = await Ledger.findById(id);
    
    res.status(200).json({
      success: true,
      message: 'Ledger account updated successfully',
      data: updatedAccount
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error updating ledger account',
      error: error.message
    });
  }
};

// Delete ledger account
const deleteLedgerAccount = async (req, res) => {
  try {
    const { id } = req.params;
    const trashService = require('../services/trashService');
    await trashService.softDelete('ledger', id, req.user.id);
    
    res.status(200).json({
      success: true,
      message: 'Ledger account moved to trash successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error deleting ledger account',
      error: error.message
    });
  }
};

// Update ledger entry
const updateLedgerEntry = async (req, res) => {
  try {
    const { id } = req.params;
    const { amount, description, reference, referenceId } = req.body;
    
    const { pool } = require('../config/database');
    
    const updateData = {};
    if (amount !== undefined) updateData.amount = amount;
    if (description) updateData.description = description;
    if (reference) updateData.reference = reference;
    if (referenceId) updateData.reference_id = referenceId;
    
    const updateFields = Object.keys(updateData).map(key => `${key} = ?`).join(', ');
    const values = Object.values(updateData);
    values.push(id);
    
    const query = `UPDATE ledger_entries SET ${updateFields}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`;
    
    const [result] = await pool.execute(query, values);
    
    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        message: 'Ledger entry not found'
      });
    }
    
    // Get updated entry
    const [updatedEntry] = await pool.execute(
      'SELECT * FROM ledger_entries WHERE id = ?',
      [id]
    );
    
    res.status(200).json({
      success: true,
      message: 'Ledger entry updated successfully',
      data: updatedEntry[0]
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error updating ledger entry',
      error: error.message
    });
  }
};

// Delete ledger entry
const deleteLedgerEntry = async (req, res) => {
  try {
    const { id } = req.params;
    const trashService = require('../services/trashService');
    await trashService.softDelete('ledger_entry', id, req.user.id);
    
    res.status(200).json({
      success: true,
      message: 'Ledger entry moved to trash successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error deleting ledger entry',
      error: error.message
    });
  }
};

// Populate default ledger accounts
const populateDefaultAccounts = async (req, res) => {
  try {
    const { pool } = require('../config/database');
    
    // Check if accounts already exist
    const [existing] = await pool.execute('SELECT COUNT(*) as count FROM ledgers');
    if (existing[0].count > 0) {
      return res.status(400).json({
        success: false,
        message: 'Ledger accounts already exist. Use the regular create endpoint to add new accounts.'
      });
    }
    
    // Insert default accounts
    const defaultAccounts = [
      ['Cash Account', 'asset', 0.00, 'USD', 'ACTIVE', 'Main cash account for transactions', 'BRANCH', 1],
      ['Bank Account', 'asset', 0.00, 'USD', 'ACTIVE', 'Main bank account for transactions', 'BRANCH', 1],
      ['Accounts Receivable', 'asset', 0.00, 'USD', 'ACTIVE', 'Money owed by customers', 'BRANCH', 1],
      ['Inventory', 'asset', 0.00, 'USD', 'ACTIVE', 'Inventory value', 'BRANCH', 1],
      ['Accounts Payable', 'liability', 0.00, 'USD', 'ACTIVE', 'Money owed to suppliers', 'BRANCH', 1],
      ['Sales Revenue', 'revenue', 0.00, 'USD', 'ACTIVE', 'Revenue from sales', 'BRANCH', 1],
      ['Cost of Goods Sold', 'expense', 0.00, 'USD', 'ACTIVE', 'Cost of inventory sold', 'BRANCH', 1],
      ['Operating Expenses', 'expense', 0.00, 'USD', 'ACTIVE', 'General operating expenses', 'BRANCH', 1]
    ];
    
    for (const account of defaultAccounts) {
      await pool.execute(`
        INSERT INTO ledgers (account_name, account_type, balance, currency, status, description, scope_type, scope_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
      `, account);
    }
    
    // Get the inserted accounts
    const [accounts] = await pool.execute('SELECT * FROM ledgers ORDER BY account_name');
    
    res.status(201).json({
      success: true,
      message: 'Default ledger accounts created successfully',
      data: accounts,
      count: accounts.length
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to populate default accounts',
      error: error.message
    });
  }
};

module.exports = {
  getLedger,
  getLedgersByScope,
  addDebitEntry,
  addCreditEntry,
  addEntryByAccountId,
  getLedgerEntries,
  getBalanceSummary,
  getLedgerAccounts,
  createLedgerAccount,
  updateLedgerAccount,
  deleteLedgerAccount,
  updateLedgerEntry,
  deleteLedgerEntry,
  populateDefaultAccounts
};
