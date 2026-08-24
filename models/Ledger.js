const { pool } = require('../config/database');

class LedgerEntry {
  constructor(data) {
    this.id = data.id;
    this.ledgerId = data.ledger_id;
    this.date = data.date;
    this.type = data.type;
    this.amount = data.amount;
    this.description = data.description;
    this.reference = data.reference;
    this.referenceId = data.reference_id;
    this.createdBy = data.created_by;
    this.createdAt = data.created_at;
  }
}

class Ledger {
  constructor(data) {
    this.id = data.id;
    this.scopeType = data.scope_type;
    this.scopeId = data.scope_id;
    this.partyType = data.party_type;
    this.partyId = data.party_id;
    this.balance = data.balance;
    this.currency = data.currency;
    this.status = data.status;
    this.createdAt = data.created_at;
    this.updatedAt = data.updated_at;
    this.entries = data.entries || [];
    
    // Additional fields for ledger accounts
    this.accountName = data.account_name;
    this.accountType = data.account_type;
    this.description = data.description;
  }

  // Static method to create a new ledger
  static async create(ledgerData) {
    const { 
      scopeType, 
      scopeId, 
      partyType, 
      partyId, 
      balance = 0, 
      currency = 'PKR', 
      status = 'ACTIVE',
      accountName,
      accountType,
      description
    } = ledgerData;
    
    const [result] = await pool.execute(
      `INSERT INTO ledgers (account_name, account_type, balance, currency, status, description, scope_type, scope_id) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [accountName || `${partyType}_${partyId}`, accountType || 'asset', balance, currency, status, description || `Ledger for ${partyType} ${partyId}`, scopeType, scopeId]
    );
    
    return await Ledger.findById(result.insertId);
  }

  // Static method to find ledger by ID
  static async findById(id) {
    const [rows] = await pool.execute(
      'SELECT * FROM ledgers WHERE id = ?',
      [id]
    );
    
    if (rows.length === 0) return null;
    
    const ledger = new Ledger(rows[0]);
    ledger.entries = []; // No separate entries table
    return ledger;
  }

  // Static method to find ledger
  static async findOne(conditions) {
    let query = 'SELECT * FROM ledgers WHERE ';
    const params = [];
    const conditionsArray = [];

    if (conditions.scopeType != null && conditions.scopeId != null) {
      conditionsArray.push('scope_type = ? AND scope_id = ?');
      params.push(conditions.scopeType, conditions.scopeId);
    }

    if (conditions.partyType && conditions.partyId) {
      conditionsArray.push('party_type = ? AND party_id = ?');
      params.push(conditions.partyType, conditions.partyId);
    }

    if (conditions._id) {
      conditionsArray.push('id = ?');
      params.push(conditions._id);
    }

    if (conditions.id) {
      conditionsArray.push('id = ?');
      params.push(conditions.id);
    }

    if (conditionsArray.length === 0) return null;

    query += conditionsArray.join(' AND ');
    query += ' LIMIT 1';

    const [rows] = await pool.execute(query, params);
    
    if (rows.length === 0) return null;
    
    const ledger = new Ledger(rows[0]);
    
    // Get ledger entries
    const [entryRows] = await pool.execute(
      'SELECT * FROM ledger_entries WHERE branch_id = ? ORDER BY created_at DESC',
      [ledger.id]
    );
    
    ledger.entries = entryRows.map(entry => new LedgerEntry(entry));
    
    return ledger;
  }

  // Instance method to save ledger
  async save() {
    if (this.id) {
      // Update existing ledger
      await pool.execute(
        `UPDATE ledgers SET scope_type = ?, scope_id = ?, party_type = ?, party_id = ?, 
         balance = ?, currency = ?, status = ?, account_name = ?, account_type = ?, description = ? WHERE id = ?`,
        [this.scopeType, this.scopeId, this.partyType, this.partyId, 
         this.balance, this.currency, this.status, this.accountName, this.accountType, this.description, this.id]
      );
    } else {
      // Create new ledger
      const result = await pool.execute(
        `INSERT INTO ledgers (scope_type, scope_id, party_type, party_id, balance, currency, status, account_name, account_type, description) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [this.scopeType, this.scopeId, this.partyType, this.partyId, 
         this.balance, this.currency, this.status, this.accountName, this.accountType, this.description]
      );
      this.id = result[0].insertId;
    }
    return this;
  }

  // Method to add entry to ledger
  async addEntry(type, amount, description, reference, referenceId, createdBy) {
    const connection = await pool.getConnection();
    
    try {
      await connection.beginTransaction();
      
      await connection.execute(
        `INSERT INTO ledger_entries (entry_type, reference_id, description, debit_amount, credit_amount, branch_id, created_by, created_at) 
         VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
        [
          type,
          referenceId || null,
          description || null,
          type === 'DEBIT' ? amount : 0,
          type === 'CREDIT' ? amount : 0,
          this.id,
          createdBy || null,
        ]
      );
      
      // Update balance
      if (type === 'DEBIT') {
        this.balance += amount;
      } else {
        this.balance -= amount;
      }
      
      // Update ledger balance
      await connection.execute(
        'UPDATE ledgers SET balance = ? WHERE id = ?',
        [this.balance, this.id]
      );
      
      await connection.commit();
      
      // Refresh entries
      const [entryRows] = await pool.execute(
        'SELECT * FROM ledger_entries WHERE branch_id = ? ORDER BY created_at DESC',
        [this.id]
      );
      
      this.entries = entryRows.map(entry => new LedgerEntry(entry));
      
      return this;
      
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  // Method to get balance
  getBalance() {
    return this.balance;
  }

  // Method to get entries with pagination
  getEntries(limit = 50, offset = 0) {
    return this.entries.slice(offset, offset + limit);
  }

  // Static method to find or create ledger
  static async findOrCreate(scopeType, scopeId, partyType, partyId) {
    let ledger = await Ledger.findOne({
      scopeType,
      scopeId,
      partyType,
      partyId
    });
    
    if (!ledger) {
      ledger = await Ledger.create({
        scopeType,
        scopeId,
        partyType,
        partyId,
        balance: 0
      });
    }
    
    return ledger;
  }

  // Static method to get balances by scope
  static async getBalancesByScope(scopeType, scopeId) {
    const [rows] = await pool.execute(
      'SELECT party_type, party_id, balance FROM ledgers WHERE scope_type = ? AND scope_id = ?',
      [scopeType, scopeId]
    );
    
    return rows;
  }

  // Static method to find ledgers with pagination
  static async find(conditions = {}, options = {}) {
    let query = 'SELECT * FROM ledgers WHERE 1=1';
    const params = [];

    if (conditions.scopeType) {
      query += ' AND scope_type = ?';
      params.push(conditions.scopeType);
    }

    if (conditions.scopeId) {
      query += ' AND scope_id = ?';
      params.push(conditions.scopeId);
    }

    if (conditions.partyType) {
      query += ' AND party_type = ?';
      params.push(conditions.partyType);
    }

    if (conditions.status) {
      query += ' AND status = ?';
      params.push(conditions.status);
    }

    // Add sorting
    if (options.sort) {
      const sortField = options.sort.replace(/^-/, '');
      const sortOrder = options.sort.startsWith('-') ? 'DESC' : 'ASC';
      query += ` ORDER BY ${sortField} ${sortOrder}`;
    } else {
      query += ' ORDER BY created_at DESC';
    }

    // Add pagination
    if (options.limit) {
      query += ' LIMIT ?';
      params.push(options.limit);
      
      if (options.skip) {
        query += ' OFFSET ?';
        params.push(options.skip);
      }
    }

    const [rows] = await pool.execute(query, params);
    return rows.map(row => new Ledger(row));
  }

  // Static method to count ledgers
  static async count(conditions = {}) {
    let query = 'SELECT COUNT(*) as count FROM ledgers WHERE 1=1';
    const params = [];

    if (conditions.scopeType) {
      query += ' AND scope_type = ?';
      params.push(conditions.scopeType);
    }

    if (conditions.scopeId) {
      query += ' AND scope_id = ?';
      params.push(conditions.scopeId);
    }

    if (conditions.partyType) {
      query += ' AND party_type = ?';
      params.push(conditions.partyType);
    }

    if (conditions.status) {
      query += ' AND status = ?';
      params.push(conditions.status);
    }

    const [rows] = await pool.execute(query, params);
    return parseInt(rows[0].count, 10) || 0;
  }

  // Static method to update ledger
  static async updateOne(conditions, updateData) {
    let query = 'UPDATE ledgers SET ';
    const params = [];
    const setClauses = [];

    // Map frontend field names to database column names
    const fieldMapping = {
      accountName: 'account_name',
      accountType: 'account_type',
      balance: 'balance',
      description: 'description',
      status: 'status'
    };

    Object.keys(updateData).forEach(key => {
      if (key !== 'id' && fieldMapping[key]) {
        setClauses.push(`${fieldMapping[key]} = ?`);
        params.push(updateData[key]);
      }
    });

    if (setClauses.length === 0) return { modifiedCount: 0 };

    query += setClauses.join(', ');
    query += ' WHERE ';

    const whereClauses = [];
    if (conditions._id) {
      whereClauses.push('id = ?');
      params.push(conditions._id);
    }
    if (conditions.id) {
      whereClauses.push('id = ?');
      params.push(conditions.id);
    }

    if (whereClauses.length === 0) return { modifiedCount: 0 };

    query += whereClauses.join(' AND ');

    const [result] = await pool.execute(query, params);
    return { modifiedCount: result.affectedRows };
  }

  // Static method to delete ledger
  static async deleteOne(conditions) {
    let query = 'DELETE FROM ledgers WHERE ';
    const params = [];
    const whereClauses = [];

    if (conditions._id) {
      whereClauses.push('id = ?');
      params.push(conditions._id);
    }
    if (conditions.id) {
      whereClauses.push('id = ?');
      params.push(conditions.id);
    }

    if (whereClauses.length === 0) return { deletedCount: 0 };

    query += whereClauses.join(' AND ');

    const [result] = await pool.execute(query, params);
    return { deletedCount: result.affectedRows };
  }
}

module.exports = Ledger;
