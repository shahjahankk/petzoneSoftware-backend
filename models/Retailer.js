const { pool } = require('../config/database');

class Retailer {
  constructor(data) {
    this.id = data.id;
    this.warehouseId = data.warehouse_id; 
    this.name = data.name;
    this.email = data.email;
    this.phone = data.phone;
    this.address = data.address;
    this.city = data.city;
    this.state = data.state;
    this.zipCode = data.zip_code;
    this.businessType = data.business_type;
    this.taxId = data.tax_id;
    this.creditLimit = data.credit_limit;
    this.paymentTerms = data.payment_terms;
    this.status = data.status;
    this.notes = data.notes;
    this.creditBalance = data.credit_balance !== undefined ? parseFloat(data.credit_balance) : 0;
    this.createdAt = data.created_at;
    this.updatedAt = data.updated_at;
  }

  // Create new retailer
  static async create(retailerData) {
    const connection = await pool.getConnection();

    try {
      const {
        name,
        email,
        phone,
        address,
        city,
        state,
        zipCode,
        businessType,
        taxId,
        creditLimit,
        paymentTerms,
        notes
      } = retailerData;

      const [result] = await connection.execute(
        `INSERT INTO retailers (name, email, phone, address, city, state, zip_code, business_type, tax_id, credit_limit, payment_terms, notes, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE')`,
        [name, email, phone, address, city, state, zipCode, businessType, taxId, creditLimit, paymentTerms, notes]
      );

      return await Retailer.findById(result.insertId);
    } finally {
      connection.release();
    }
  }

  // Find retailer by ID
  static async findById(id) {
    const connection = await pool.getConnection();

    try {
      const [rows] = await connection.execute(
        'SELECT * FROM retailers WHERE id = ?',
        [id]
      );

      if (rows.length === 0) return null;
      return new Retailer(rows[0]);
    } finally {
      connection.release();
    }
  }

  // Find all retailers
  static async findAll(filters = {}) {
    const connection = await pool.getConnection();

    try {
      let query = 'SELECT * FROM retailers WHERE 1=1';
      const params = [];

      if (filters.search) {
        query += ' AND (name LIKE ? OR contact LIKE ?)';
        const searchTerm = `%${filters.search}%`;
        params.push(searchTerm, searchTerm);
      }

      query += ' ORDER BY created_at DESC';

      if (filters.limit) {
        query += ' LIMIT ?';
        params.push(filters.limit);
      }

      if (filters.offset) {
        query += ' OFFSET ?';
        params.push(filters.offset);
      }

      const [rows] = await connection.execute(query, params);
      return rows.map(row => new Retailer(row));
    } finally {
      connection.release();
    }
  }

  // Update retailer
  async update(updateData) {
    const connection = await pool.getConnection();

    try {
      // Map allowed fields to DB columns (prevents bad column names and accidental wipes)
      const fieldMap = {
        name: 'name',
        email: 'email',
        phone: 'phone',
        address: 'address',
        city: 'city',
        state: 'state',
        zipCode: 'zip_code',
        businessType: 'business_type',
        taxId: 'tax_id',
        creditLimit: 'credit_limit',
        paymentTerms: 'payment_terms',
        status: 'status',
        notes: 'notes',
        creditBalance: 'credit_balance'
      };

      const fields = [];
      const values = [];

      Object.keys(updateData).forEach(key => {
        const column = fieldMap[key];
        if (column && updateData[key] !== undefined) {
          fields.push(`${column} = ?`);
          values.push(updateData[key]);
        }
      });

      if (fields.length === 0) return this;

      values.push(this.id);

      await connection.execute(
        `UPDATE retailers SET ${fields.join(', ')}, updated_at = NOW() WHERE id = ?`,
        values
      );

      return await Retailer.findById(this.id);
    } finally {
      connection.release();
    }
  }

  // Delete retailer
  async delete() {
    const connection = await pool.getConnection();

    try {
      await connection.execute(
        'UPDATE retailers SET status = "INACTIVE", updated_at = NOW() WHERE id = ?',
        [this.id]
      );
      return true;
    } finally {
      connection.release();
    }
  }
}

module.exports = Retailer;
