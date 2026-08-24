const { pool } = require('../config/database');

class BranchLedger {
  constructor(data) {
    this.id = data.id;
    this.branchId = data.branch_id;
    this.invoiceSequence = data.invoice_sequence;
    this.invoicePrefix = data.invoice_prefix;
    this.returnSequence = data.return_sequence;
    this.returnPrefix = data.return_prefix;
    this.fiscalYear = data.fiscal_year;
    this.settings = data.settings ? JSON.parse(data.settings) : {};
    this.createdAt = data.created_at;
    this.updatedAt = data.updated_at;
  }

  // Static method to create a new branch ledger
  static async create(ledgerData) {
    const { 
      branchId, 
      invoiceSequence = 1, 
      invoicePrefix = 'INV', 
      returnSequence = 1, 
      returnPrefix = 'RET', 
      fiscalYear,
      settings = {}
    } = ledgerData;
    
    const [result] = await pool.execute(
      `INSERT INTO branch_ledger (branch_id, invoice_sequence, invoice_prefix, return_sequence, return_prefix, fiscal_year, settings) 
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [branchId, invoiceSequence, invoicePrefix, returnSequence, returnPrefix, fiscalYear, JSON.stringify(settings)]
    );
    
    return await BranchLedger.findById(result.insertId);
  }

  // Static method to find branch ledger by ID
  static async findById(id) {
    const [rows] = await pool.execute(
      'SELECT * FROM branch_ledger WHERE id = ?',
      [id]
    );
    
    if (rows.length === 0) return null;
    return new BranchLedger(rows[0]);
  }

  // Static method to find branch ledger by branch ID
  static async findByBranchId(branchId) {
    const [rows] = await pool.execute(
      'SELECT * FROM branch_ledger WHERE branch_id = ?',
      [branchId]
    );
    
    if (rows.length === 0) return null;
    return new BranchLedger(rows[0]);
  }

  // Static method to find branch ledger
  static async findOne(conditions) {
    let query = 'SELECT * FROM branch_ledger WHERE ';
    const params = [];
    const conditionsArray = [];

    if (conditions.branchId) {
      conditionsArray.push('branch_id = ?');
      params.push(conditions.branchId);
    }

    if (conditions._id) {
      conditionsArray.push('id = ?');
      params.push(conditions._id);
    }

    if (conditions.id) {
      conditionsArray.push('id = ?');
      params.push(conditions.id);
    }

    if (conditions.fiscalYear) {
      conditionsArray.push('fiscal_year = ?');
      params.push(conditions.fiscalYear);
    }

    if (conditionsArray.length === 0) return null;

    query += conditionsArray.join(' AND ');
    query += ' LIMIT 1';

    const [rows] = await pool.execute(query, params);
    
    if (rows.length === 0) return null;
    return new BranchLedger(rows[0]);
  }

  // Instance method to save branch ledger
  async save() {
    if (this.id) {
      // Update existing branch ledger
      await pool.execute(
        `UPDATE branch_ledger SET branch_id = ?, invoice_sequence = ?, invoice_prefix = ?, 
         return_sequence = ?, return_prefix = ?, fiscal_year = ?, settings = ? 
         WHERE id = ?`,
        [this.branchId, this.invoiceSequence, this.invoicePrefix, this.returnSequence, 
         this.returnPrefix, this.fiscalYear, JSON.stringify(this.settings), this.id]
      );
    } else {
      // Create new branch ledger
      const result = await pool.execute(
        `INSERT INTO branch_ledger (branch_id, invoice_sequence, invoice_prefix, return_sequence, return_prefix, fiscal_year, settings) 
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [this.branchId, this.invoiceSequence, this.invoicePrefix, this.returnSequence, 
         this.returnPrefix, this.fiscalYear, JSON.stringify(this.settings)]
      );
      this.id = result[0].insertId;
    }
    return this;
  }

  // Method to generate next invoice number
  generateInvoiceNumber() {
    const sequence = this.invoiceSequence.toString().padStart(this.settings.sequenceLength || 6, '0');
    const invoiceNumber = `${this.invoicePrefix}-${this.fiscalYear}-${sequence}`;
    this.invoiceSequence += 1;
    return invoiceNumber;
  }

  // Method to generate next return number
  generateReturnNumber() {
    const sequence = this.returnSequence.toString().padStart(this.settings.sequenceLength || 6, '0');
    const returnNumber = `${this.returnPrefix}-${this.fiscalYear}-${sequence}`;
    this.returnSequence += 1;
    return returnNumber;
  }

  // Static method to add transaction to branch ledger
  static async addTransaction(branchId, transactionData) {
    // For now, just return success - this can be expanded later
    // to actually track financial transactions
    return { success: true, message: 'Transaction recorded' };
  }

  // Static method to find branch ledgers with pagination
  static async find(conditions = {}, options = {}) {
    let query = 'SELECT * FROM branch_ledger WHERE 1=1';
    const params = [];

    if (conditions.branchId) {
      query += ' AND branch_id = ?';
      params.push(conditions.branchId);
    }

    if (conditions.fiscalYear) {
      query += ' AND fiscal_year = ?';
      params.push(conditions.fiscalYear);
    }

    // Add sorting
    if (options.sort) {
      const sortField = options.sort.replace(/^-/, ''); // Remove minus sign
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
    return rows.map(row => new BranchLedger(row));
  }

  // Static method to count branch ledgers
  static async count(conditions = {}) {
    let query = 'SELECT COUNT(*) as count FROM branch_ledger WHERE 1=1';
    const params = [];

    if (conditions.branchId) {
      query += ' AND branch_id = ?';
      params.push(conditions.branchId);
    }

    if (conditions.fiscalYear) {
      query += ' AND fiscal_year = ?';
      params.push(conditions.fiscalYear);
    }

    const [rows] = await pool.execute(query, params);
    return rows[0].count;
  }

  // Static method to update branch ledger
  static async updateOne(conditions, updateData) {
    let query = 'UPDATE branch_ledger SET ';
    const params = [];
    const setClauses = [];

    Object.keys(updateData).forEach(key => {
      if (key !== 'id') {
        if (key === 'settings') {
          setClauses.push('settings = ?');
          params.push(JSON.stringify(updateData[key]));
        } else {
          setClauses.push(`${key} = ?`);
          params.push(updateData[key]);
        }
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
    if (conditions.branchId) {
      whereClauses.push('branch_id = ?');
      params.push(conditions.branchId);
    }

    if (whereClauses.length === 0) return { modifiedCount: 0 };

    query += whereClauses.join(' AND ');

    const [result] = await pool.execute(query, params);
    return { modifiedCount: result.affectedRows };
  }

  // Static method to delete branch ledger
  static async deleteOne(conditions) {
    let query = 'DELETE FROM branch_ledger WHERE ';
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
    if (conditions.branchId) {
      whereClauses.push('branch_id = ?');
      params.push(conditions.branchId);
    }

    if (whereClauses.length === 0) return { deletedCount: 0 };

    query += whereClauses.join(' AND ');

    const [result] = await pool.execute(query, params);
    return { deletedCount: result.affectedRows };
  }
}

module.exports = BranchLedger;