const mysql = require('mysql2/promise');

const getConnection = () =>
  mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD || process.env.DB_PASS,
    database: process.env.DB_NAME,
  });

class Customer {
  constructor(data) {
    this.id = data.id;
    this.name = data.name;
    this.email = data.email;
    this.phone = data.phone;
    this.address = data.address;
    this.city = data.city;
    this.state = data.state;
    this.zipCode = data.zip_code;
    this.customerType = data.customer_type;
    this.creditLimit = data.credit_limit;
    this.currentBalance = data.current_balance;
    this.paymentTerms = data.payment_terms;
    this.branchId = data.branch_id;
    this.warehouseId = data.warehouse_id;
    this.status = data.status;
    this.notes = data.notes;
    this.createdAt = data.created_at;
    this.updatedAt = data.updated_at;
  }

  // Create new customer
  static async create(customerData) {
    const connection = await getConnection();

    try {
      const {
        name,
        email,
        phone,
        address,
        city,
        state,
        zipCode,
        customerType,
        creditLimit,
        paymentTerms,
        branchId,
        warehouseId,
        notes
      } = customerData;

      const toNullable = (v) => (v === undefined ? null : v);
      const payload = [
        name,
        toNullable(email),
        toNullable(phone),
        toNullable(address),
        toNullable(city),
        toNullable(state),
        toNullable(zipCode),
        customerType || 'INDIVIDUAL',
        creditLimit !== undefined && creditLimit !== null ? Number(creditLimit) : 0,
        paymentTerms || 'CASH',
        toNullable(branchId),
        toNullable(warehouseId),
        toNullable(notes),
      ];

      const [result] = await connection.execute(
        `INSERT INTO customers (name, email, phone, address, city, state, zip_code, customer_type, credit_limit, current_balance, payment_terms, branch_id, warehouse_id, notes, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 'ACTIVE')`,
        payload
      );

      return await Customer.findById(result.insertId);
    } finally {
      await connection.end();
    }
  }

  // Find customer by ID
  static async findById(id) {
    const connection = await getConnection();

    try {
      const [rows] = await connection.execute(
        `SELECT c.*, b.name as branch_name, w.name as warehouse_name
         FROM customers c
         LEFT JOIN branches b ON c.branch_id = b.id
         LEFT JOIN warehouses w ON c.warehouse_id = w.id
         WHERE c.id = ?`,
        [id]
      );

      if (rows.length === 0) return null;
      return new Customer(rows[0]);
    } finally {
      await connection.end();
    }
  }

  // Find all customers
  static async findAll(filters = {}) {
    const connection = await getConnection();

    try {
      let query = `SELECT c.*, b.name as branch_name, w.name as warehouse_name
                   FROM customers c
                   LEFT JOIN branches b ON c.branch_id = b.id
                   LEFT JOIN warehouses w ON c.warehouse_id = w.id
                   WHERE 1=1`;
      const params = [];

      if (filters.status) {
        query += ' AND c.status = ?';
        params.push(filters.status);
      }

      if (filters.customerType) {
        query += ' AND c.customer_type = ?';
        params.push(filters.customerType);
      }

      if (filters.branchId) {
        query += ' AND c.branch_id = ?';
        params.push(filters.branchId);
      }

      if (filters.warehouseId) {
        query += ' AND c.warehouse_id = ?';
        params.push(filters.warehouseId);
      }

      if (filters.search) {
        query += ' AND (c.name LIKE ? OR c.email LIKE ? OR c.phone LIKE ?)';
        const searchTerm = `%${filters.search}%`;
        params.push(searchTerm, searchTerm, searchTerm);
      }

      if (filters.hasBalance) {
        query += ' AND c.current_balance != 0';
      }

      query += ' ORDER BY c.created_at DESC';

      if (filters.limit) {
        query += ' LIMIT ?';
        params.push(filters.limit);
      }

      if (filters.offset) {
        query += ' OFFSET ?';
        params.push(filters.offset);
      }

      const [rows] = await connection.execute(query, params);
      return rows.map(row => new Customer(row));
    } finally {
      await connection.end();
    }
  }

  // Update customer
  async update(updateData) {
    const connection = await getConnection();

    try {
      const fields = [];
      const values = [];

      Object.keys(updateData).forEach(key => {
        if (updateData[key] !== undefined) {
          fields.push(`${key} = ?`);
          values.push(updateData[key]);
        }
      });

      if (fields.length === 0) return this;

      values.push(this.id);

      await connection.execute(
        `UPDATE customers SET ${fields.join(', ')}, updated_at = NOW() WHERE id = ?`,
        values
      );

      return await Customer.findById(this.id);
    } finally {
      await connection.end();
    }
  }

  // Update customer balance
  async updateBalance(amount, transactionType) {
    const connection = await getConnection();

    try {
      await connection.beginTransaction();

      // Update customer balance
      if (transactionType === 'CREDIT') {
        await connection.execute(
          'UPDATE customers SET current_balance = current_balance + ?, updated_at = NOW() WHERE id = ?',
          [amount, this.id]
        );
      } else if (transactionType === 'DEBIT') {
        await connection.execute(
          'UPDATE customers SET current_balance = current_balance - ?, updated_at = NOW() WHERE id = ?',
          [amount, this.id]
        );
      }

      await connection.commit();
      return await Customer.findById(this.id);
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      await connection.end();
    }
  }

  // Delete customer
  async delete() {
    const connection = await getConnection();

    try {
      await connection.execute(
        'UPDATE customers SET status = "INACTIVE", updated_at = NOW() WHERE id = ?',
        [this.id]
      );
      return true;
    } finally {
      await connection.end();
    }
  }
}

module.exports = Customer;
