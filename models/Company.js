const { executeQuery } = require('../config/database');

class Company {
  constructor(data) {
    this.id = data.id;
    this.name = data.name;
    this.code = data.code;
    this.contactPerson = data.contact_person;
    this.phone = data.phone;
    this.email = data.email;
    this.address = data.address;
    this.status = data.status;
    this.scopeType = data.scope_type;
    this.scopeId = data.scope_id;
    this.transactionType = data.transaction_type;
    this.createdBy = data.created_by;
    this.createdByUsername = data.created_by_username;
    this.createdAt = data.created_at;
    this.updatedAt = data.updated_at;
  }

  // Static method to create a new company
  static async create(companyData) {
    const { name, code, contactPerson, phone, email, address, status, scopeType, scopeId, transactionType, createdBy } = companyData;
    
    const result = await executeQuery(
      `INSERT INTO companies (name, code, contact_person, phone, email, address, status, scope_type, scope_id, transaction_type, created_by) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [name, code, contactPerson, phone, email, address, status, scopeType, scopeId, transactionType, createdBy]
    );
    
    return await Company.findById(result.insertId || result.lastID);
  }

  // Static method to find company by ID
  static async findById(id) {
    const rows = await executeQuery(
      'SELECT * FROM companies WHERE id = ?',
      [id]
    );
    
    if (rows.length === 0) return null;
    return new Company(rows[0]);
  }

  // Static method to find company
  static async findOne(conditions) {
    let query = 'SELECT * FROM companies WHERE ';
    const params = [];
    const conditionsArray = [];

    if (conditions.name) {
      conditionsArray.push('name = ?');
      params.push(conditions.name);
    }

    if (conditions._id) {
      conditionsArray.push('id = ?');
      params.push(conditions._id);
    }

    if (conditions.id) {
      conditionsArray.push('id = ?');
      params.push(conditions.id);
    }

    if (conditions.scopeType && conditions.scopeId) {
      conditionsArray.push('scope_type = ? AND scope_id = ?');
      params.push(conditions.scopeType, conditions.scopeId);
    }

    if (conditionsArray.length === 0) return null;

    query += conditionsArray.join(' AND ');
    query += ' LIMIT 1';

    const rows = await executeQuery(query, params);
    
    if (rows.length === 0) return null;
    return new Company(rows[0]);
  }

  // Instance method to save company
  async save() {
    if (this.id) {
      // Update existing company
      await executeQuery(
        `UPDATE companies SET name = ?, code = ?, contact_person = ?, phone = ?, email = ?, address = ?, status = ?, transaction_type = ?, 
         created_by = ?, scope_type = ?, scope_id = ? WHERE id = ?`,
        [this.name, this.code, this.contactPerson, this.phone, this.email, this.address, this.status, this.transactionType, 
         this.createdBy, this.scopeType, this.scopeId, this.id]
      );
    } else {
      // Create new company
      const result = await executeQuery(
        `INSERT INTO companies (name, code, contact_person, phone, email, address, status, transaction_type, created_by, scope_type, scope_id) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [this.name, this.code, this.contactPerson, this.phone, this.email, this.address, this.status, this.transactionType, 
         this.createdBy, this.scopeType, this.scopeId]
      );
      this.id = result.insertId || result.lastID;
    }
    return this;
  }

  // Static method to find companies with pagination
  static async find(conditions = {}, options = {}) {
    let query = `SELECT c.*, u.username as created_by_username 
                 FROM companies c 
                 LEFT JOIN users u ON c.created_by = u.id 
                 WHERE c.deleted_at IS NULL`;
    const params = [];

    if (conditions.name) {
      query += ' AND c.name LIKE ?';
      params.push(`%${conditions.name}%`);
    }

    if (conditions.status) {
      query += ' AND c.status = ?';
      params.push(conditions.status);
    }

    if (conditions.scopeType) {
      query += ' AND c.scope_type = ?';
      params.push(conditions.scopeType);
    }

    if (conditions.scopeId) {
      query += ' AND c.scope_id = ?';
      params.push(conditions.scopeId);
    }

    if (conditions.transactionType) {
      query += ' AND c.transaction_type = ?';
      params.push(conditions.transactionType);
    }

    if (conditions.createdBy) {
      query += ' AND c.created_by = ?';
      params.push(conditions.createdBy);
    }

    // Add sorting
    if (options.sort) {
      const sortField = options.sort.replace(/^-/, ''); // Remove minus sign
      const sortOrder = options.sort.startsWith('-') ? 'DESC' : 'ASC';
      query += ` ORDER BY c.${sortField} ${sortOrder}`;
    } else {
      query += ' ORDER BY c.created_at DESC';
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

    const rows = await executeQuery(query, params);
    return rows.map(row => new Company(row));
  }

  // Static method to count companies
  static async count(conditions = {}) {
    let query = 'SELECT COUNT(*) as count FROM companies WHERE 1=1';
    const params = [];

    if (conditions.name) {
      query += ' AND name LIKE ?';
      params.push(`%${conditions.name}%`);
    }

    if (conditions.status) {
      query += ' AND status = ?';
      params.push(conditions.status);
    }

    if (conditions.createdBy) {
      query += ' AND created_by = ?';
      params.push(conditions.createdBy);
    }

    const rows = await executeQuery(query, params);
    return rows[0].count;
  }

  // Static method to update company
  static async updateOne(conditions, updateData) {
    let query = 'UPDATE companies SET ';
    const params = [];
    const setClauses = [];

    Object.keys(updateData).forEach(key => {
      if (key !== 'id') {
        setClauses.push(`${key} = ?`);
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
    if (conditions.name) {
      whereClauses.push('name = ?');
      params.push(conditions.name);
    }

    if (whereClauses.length === 0) return { modifiedCount: 0 };

    query += whereClauses.join(' AND ');

    const result = await executeQuery(query, params);
    return { modifiedCount: result.affectedRows };
  }

  // Static method to delete company
  static async deleteOne(conditions) {
    let query = 'DELETE FROM companies WHERE ';
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
    if (conditions.name) {
      whereClauses.push('name = ?');
      params.push(conditions.name);
    }

    if (whereClauses.length === 0) return { deletedCount: 0 };

    query += whereClauses.join(' AND ');

    const result = await executeQuery(query, params);
    return { deletedCount: result.affectedRows };
  }
}

module.exports = Company;
