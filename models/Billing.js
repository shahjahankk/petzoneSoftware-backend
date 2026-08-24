const { pool } = require('../config/database');

class Billing {
  constructor(data) {
    this.id = data.id;
    this.invoiceNumber = data.invoice_number;
    this.clientName = data.client_name;
    this.clientEmail = data.client_email;
    this.clientPhone = data.client_phone;
    this.clientAddress = data.client_address;
    this.amount = data.amount;
    this.tax = data.tax || 0;
    this.discount = data.discount || 0;
    this.total = data.total;
    this.dueDate = data.due_date;
    this.service = data.service;
    this.description = data.description;
    this.status = data.status;
    this.paymentMethod = data.payment_method;
    this.paymentDate = data.payment_date;
    this.notes = data.notes;
    this.scopeType = data.scope_type;
    this.scopeId = data.scope_id;
    this.createdBy = data.created_by;
    this.createdAt = data.created_at;
    this.updatedAt = data.updated_at;
  }

  // Static method to create billing record
  static async create(billingData) {
    const {
      invoiceNumber,
      clientName,
      clientEmail = null,
      clientPhone = null,
      clientAddress = null,
      amount = 0,
      tax = 0,
      discount = 0,
      total = 0,
      dueDate = null,
      service = null,
      description = null,
      status = 'pending',
      paymentMethod = null,
      paymentDate = null,
      notes = null,
      scopeType = 'BRANCH',
      scopeId = 1,
      createdBy = 1
    } = billingData;

    const query = `
      INSERT INTO billing (
        invoice_number, client_name, client_email, client_phone, client_address,
        amount, tax, discount, total, due_date, service, description,
        status, payment_method, payment_date, notes, scope_type, scope_id, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const params = [
      invoiceNumber, clientName, clientEmail, clientPhone, clientAddress,
      amount, tax, discount, total, dueDate, service, description,
      status, paymentMethod, paymentDate, notes, scopeType, scopeId, createdBy
    ];

    const [result] = await pool.execute(query, params);
    return await Billing.findById(result.insertId);
  }

  // Static method to find billing by ID
  static async findById(id) {
    const [rows] = await pool.execute(
      'SELECT * FROM billing WHERE id = ?',
      [id]
    );
    
    if (rows.length === 0) return null;
    return new Billing(rows[0]);
  }

  // Static method to find all billing records
  static async findAll(conditions = {}, options = {}) {
    let query = 'SELECT * FROM billing WHERE 1=1';
    const params = [];

    if (conditions.status) {
      query += ' AND status = ?';
      params.push(conditions.status);
    }

    if (conditions.clientName) {
      query += ' AND client_name LIKE ?';
      params.push(`%${conditions.clientName}%`);
    }

    if (conditions.scopeType) {
      query += ' AND scope_type = ?';
      params.push(conditions.scopeType);
    }

    if (conditions.scopeId) {
      query += ' AND scope_id = ?';
      params.push(conditions.scopeId);
    }

    if (conditions.startDate) {
      query += ' AND due_date >= ?';
      params.push(conditions.startDate);
    }

    if (conditions.endDate) {
      query += ' AND due_date <= ?';
      params.push(conditions.endDate);
    }

    query += ' ORDER BY created_at DESC';

    // Add pagination
    if (options.limit) {
      query += ' LIMIT ?';
      params.push(parseInt(options.limit));
      
      if (options.offset) {
        query += ' OFFSET ?';
        params.push(parseInt(options.offset));
      }
    }

    const [rows] = await pool.execute(query, params);
    return rows.map(row => new Billing(row));
  }

  // Static method to update billing record
  static async update(id, updateData) {
    return await Billing.updateOne({ id }, updateData);
  }

  // Static method to update billing record
  static async updateOne(conditions, updateData) {
    let query = 'UPDATE billing SET ';
    const params = [];
    const setClauses = [];

    // Fields to exclude from updates (computed fields)
    const excludedFields = ['id', 'created_at'];

    Object.keys(updateData).forEach(key => {
      if (!excludedFields.includes(key)) {
        // Map camelCase to snake_case for database columns
        const fieldMapping = {
          'invoiceNumber': 'invoice_number',
          'clientName': 'client_name',
          'clientEmail': 'client_email',
          'clientPhone': 'client_phone',
          'clientAddress': 'client_address',
          'dueDate': 'due_date',
          'paymentMethod': 'payment_method',
          'paymentDate': 'payment_date',
          'scopeType': 'scope_type',
          'scopeId': 'scope_id',
          'createdBy': 'created_by',
          'updatedAt': 'updated_at'
        };
        
        const dbColumn = fieldMapping[key] || key;
        setClauses.push(`${dbColumn} = ?`);
        params.push(updateData[key]);
      }
    });

    if (setClauses.length === 0) return { modifiedCount: 0 };

    query += setClauses.join(', ');
    query += ', updated_at = NOW() WHERE ';

    const whereClauses = [];
    if (conditions.id) {
      whereClauses.push('id = ?');
      params.push(conditions.id);
    }

    if (whereClauses.length === 0) return { modifiedCount: 0 };

    query += whereClauses.join(' AND ');

    const [result] = await pool.execute(query, params);
    return { modifiedCount: result.affectedRows };
  }

  // Static method to delete billing record
  static async delete(id) {
    return await Billing.deleteOne({ id });
  }

  // Static method to delete billing record
  static async deleteOne(conditions) {
    let query = 'DELETE FROM billing WHERE ';
    const params = [];

    if (conditions.id) {
      query += 'id = ?';
      params.push(conditions.id);
    }

    const [result] = await pool.execute(query, params);
    return { deletedCount: result.affectedRows };
  }

  // Instance method to save changes
  async save() {
    if (this.id) {
      // Update existing record
      const updateData = {
        invoiceNumber: this.invoiceNumber,
        clientName: this.clientName,
        clientEmail: this.clientEmail,
        clientPhone: this.clientPhone,
        clientAddress: this.clientAddress,
        amount: this.amount,
        tax: this.tax,
        discount: this.discount,
        total: this.total,
        dueDate: this.dueDate,
        service: this.service,
        description: this.description,
        status: this.status,
        paymentMethod: this.paymentMethod,
        paymentDate: this.paymentDate,
        notes: this.notes,
        scopeType: this.scopeType,
        scopeId: this.scopeId
      };

      await Billing.updateOne({ id: this.id }, updateData);
    } else {
      // Create new record
      const newRecord = await Billing.create({
        invoiceNumber: this.invoiceNumber,
        clientName: this.clientName,
        clientEmail: this.clientEmail,
        clientPhone: this.clientPhone,
        clientAddress: this.clientAddress,
        amount: this.amount,
        tax: this.tax,
        discount: this.discount,
        total: this.total,
        dueDate: this.dueDate,
        service: this.service,
        description: this.description,
        status: this.status,
        paymentMethod: this.paymentMethod,
        paymentDate: this.paymentDate,
        notes: this.notes,
        scopeType: this.scopeType,
        scopeId: this.scopeId,
        createdBy: this.createdBy
      });

      Object.assign(this, newRecord);
    }

    return this;
  }
}

module.exports = Billing;
