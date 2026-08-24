const mysql = require('mysql2/promise');

class CreditDebitTransaction {
  constructor(data) {
    this.id = data.id;
    this.customerId = data.customer_id;
    this.transactionType = data.transaction_type;
    this.amount = data.amount;
    this.description = data.description;
    this.referenceType = data.reference_type;
    this.referenceId = data.reference_id;
    this.branchId = data.branch_id;
    this.warehouseId = data.warehouse_id;
    this.userId = data.user_id;
    this.userRole = data.user_role;
    this.paymentMethod = data.payment_method;
    this.status = data.status;
    this.notes = data.notes;
    this.createdAt = data.created_at;
    this.updatedAt = data.updated_at;
  }

  // Create new credit/debit transaction
  static async create(transactionData) {
    const connection = await mysql.createConnection({
      host: process.env.DB_HOST,
      user: process.env.DB_USER,
      password: process.env.DB_PASS,
      database: process.env.DB_NAME
    });

    try {
      await connection.beginTransaction();

      const {
        customerId,
        transactionType,
        amount,
        description,
        referenceType,
        referenceId,
        branchId,
        warehouseId,
        userId,
        userRole,
        paymentMethod,
        notes
      } = transactionData;

      // Create transaction record
      const [result] = await connection.execute(
        `INSERT INTO credit_debit_transactions (customer_id, transaction_type, amount, description, reference_type, reference_id, branch_id, warehouse_id, user_id, user_role, payment_method, notes, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'COMPLETED')`,
        [customerId, transactionType, amount, description, referenceType, referenceId, branchId, warehouseId, userId, userRole, paymentMethod, notes]
      );

      // Update customer balance
      if (transactionType === 'CREDIT') {
        await connection.execute(
          'UPDATE customers SET current_balance = current_balance + ?, updated_at = NOW() WHERE id = ?',
          [amount, customerId]
        );
      } else if (transactionType === 'DEBIT') {
        await connection.execute(
          'UPDATE customers SET current_balance = current_balance - ?, updated_at = NOW() WHERE id = ?',
          [amount, customerId]
        );
      }

      await connection.commit();
      return await CreditDebitTransaction.findById(result.insertId);
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      await connection.end();
    }
  }

  // Find transaction by ID
  static async findById(id) {
    const connection = await mysql.createConnection({
      host: process.env.DB_HOST,
      user: process.env.DB_USER,
      password: process.env.DB_PASS,
      database: process.env.DB_NAME
    });

    try {
      const [rows] = await connection.execute(
        `SELECT cdt.*, c.name as customer_name, c.email as customer_email, u.username as user_name, b.name as branch_name, w.name as warehouse_name
         FROM credit_debit_transactions cdt
         LEFT JOIN customers c ON cdt.customer_id = c.id
         LEFT JOIN users u ON cdt.user_id = u.id
         LEFT JOIN branches b ON cdt.branch_id = b.id
         LEFT JOIN warehouses w ON cdt.warehouse_id = w.id
         WHERE cdt.id = ?`,
        [id]
      );

      if (rows.length === 0) return null;
      return new CreditDebitTransaction(rows[0]);
    } finally {
      await connection.end();
    }
  }

  // Find all transactions
  static async findAll(filters = {}) {
    const connection = await mysql.createConnection({
      host: process.env.DB_HOST,
      user: process.env.DB_USER,
      password: process.env.DB_PASS,
      database: process.env.DB_NAME
    });

    try {
      let query = `SELECT cdt.*, c.name as customer_name, c.email as customer_email, u.username as user_name, b.name as branch_name, w.name as warehouse_name
                   FROM credit_debit_transactions cdt
                   LEFT JOIN customers c ON cdt.customer_id = c.id
                   LEFT JOIN users u ON cdt.user_id = u.id
                   LEFT JOIN branches b ON cdt.branch_id = b.id
                   LEFT JOIN warehouses w ON cdt.warehouse_id = w.id
                   WHERE 1=1`;
      const params = [];

      if (filters.customerId) {
        query += ' AND cdt.customer_id = ?';
        params.push(filters.customerId);
      }

      if (filters.transactionType) {
        query += ' AND cdt.transaction_type = ?';
        params.push(filters.transactionType);
      }

      if (filters.branchId) {
        query += ' AND cdt.branch_id = ?';
        params.push(filters.branchId);
      }

      if (filters.warehouseId) {
        query += ' AND cdt.warehouse_id = ?';
        params.push(filters.warehouseId);
      }

      if (filters.userId) {
        query += ' AND cdt.user_id = ?';
        params.push(filters.userId);
      }

      if (filters.userRole) {
        query += ' AND cdt.user_role = ?';
        params.push(filters.userRole);
      }

      if (filters.status) {
        query += ' AND cdt.status = ?';
        params.push(filters.status);
      }

      if (filters.startDate) {
        query += ' AND cdt.created_at >= ?';
        params.push(filters.startDate);
      }

      if (filters.endDate) {
        query += ' AND cdt.created_at <= ?';
        params.push(filters.endDate);
      }

      if (filters.search) {
        query += ' AND (c.name LIKE ? OR cdt.description LIKE ?)';
        const searchTerm = `%${filters.search}%`;
        params.push(searchTerm, searchTerm);
      }

      query += ' ORDER BY cdt.created_at DESC';

      if (filters.limit) {
        query += ' LIMIT ?';
        params.push(filters.limit);
      }

      if (filters.offset) {
        query += ' OFFSET ?';
        params.push(filters.offset);
      }

      const [rows] = await connection.execute(query, params);
      return rows.map(row => new CreditDebitTransaction(row));
    } finally {
      await connection.end();
    }
  }

  // Get customer balance summary
  static async getCustomerBalanceSummary(customerId) {
    const connection = await mysql.createConnection({
      host: process.env.DB_HOST,
      user: process.env.DB_USER,
      password: process.env.DB_PASS,
      database: process.env.DB_NAME
    });

    try {
      const [rows] = await connection.execute(
        `SELECT 
           SUM(CASE WHEN transaction_type = 'CREDIT' THEN amount ELSE 0 END) as total_credit,
           SUM(CASE WHEN transaction_type = 'DEBIT' THEN amount ELSE 0 END) as total_debit,
           COUNT(*) as total_transactions
         FROM credit_debit_transactions 
         WHERE customer_id = ?`,
        [customerId]
      );

      return rows[0];
    } finally {
      await connection.end();
    }
  }

  // Get branch/warehouse summary
  static async getBranchWarehouseSummary(filters = {}) {
    const connection = await mysql.createConnection({
      host: process.env.DB_HOST,
      user: process.env.DB_USER,
      password: process.env.DB_PASS,
      database: process.env.DB_NAME
    });

    try {
      let query = `SELECT 
                     cdt.branch_id,
                     cdt.warehouse_id,
                     b.name as branch_name,
                     w.name as warehouse_name,
                     SUM(CASE WHEN cdt.transaction_type = 'CREDIT' THEN cdt.amount ELSE 0 END) as total_credit,
                     SUM(CASE WHEN cdt.transaction_type = 'DEBIT' THEN cdt.amount ELSE 0 END) as total_debit,
                     COUNT(*) as total_transactions
                   FROM credit_debit_transactions cdt
                   LEFT JOIN branches b ON cdt.branch_id = b.id
                   LEFT JOIN warehouses w ON cdt.warehouse_id = w.id
                   WHERE 1=1`;
      const params = [];

      if (filters.startDate) {
        query += ' AND cdt.created_at >= ?';
        params.push(filters.startDate);
      }

      if (filters.endDate) {
        query += ' AND cdt.created_at <= ?';
        params.push(filters.endDate);
      }

      query += ' GROUP BY cdt.branch_id, cdt.warehouse_id ORDER BY total_transactions DESC';

      const [rows] = await connection.execute(query, params);
      return rows;
    } finally {
      await connection.end();
    }
  }

  // Update transaction
  async update(updateData) {
    const connection = await mysql.createConnection({
      host: process.env.DB_HOST,
      user: process.env.DB_USER,
      password: process.env.DB_PASS,
      database: process.env.DB_NAME
    });

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
        `UPDATE credit_debit_transactions SET ${fields.join(', ')}, updated_at = NOW() WHERE id = ?`,
        values
      );

      return await CreditDebitTransaction.findById(this.id);
    } finally {
      await connection.end();
    }
  }

  // Delete transaction
  async delete() {
    const connection = await mysql.createConnection({
      host: process.env.DB_HOST,
      user: process.env.DB_USER,
      password: process.env.DB_PASS,
      database: process.env.DB_NAME
    });

    try {
      await connection.beginTransaction();

      // Reverse the balance change
      if (this.transactionType === 'CREDIT') {
        await connection.execute(
          'UPDATE customers SET current_balance = current_balance - ?, updated_at = NOW() WHERE id = ?',
          [this.amount, this.customerId]
        );
      } else if (this.transactionType === 'DEBIT') {
        await connection.execute(
          'UPDATE customers SET current_balance = current_balance + ?, updated_at = NOW() WHERE id = ?',
          [this.amount, this.customerId]
        );
      }

      // Delete transaction
      await connection.execute(
        'DELETE FROM credit_debit_transactions WHERE id = ?',
        [this.id]
      );

      await connection.commit();
      return true;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      await connection.end();
    }
  }
}

module.exports = CreditDebitTransaction;
