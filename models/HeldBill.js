const { pool } = require('../config/database');

class HeldBillItem {
  constructor(data) {
    this.id = data.id;
    this.heldBillId = data.held_bill_id;
    this.inventoryItemId = data.inventory_item_id;
    this.sku = data.sku;
    this.name = data.name;
    this.quantity = data.quantity;
    this.unitPrice = data.unit_price;
    this.discount = data.discount;
    this.total = data.total;
  }
}

class HeldBill {
  constructor(data) {
    this.id = data.id;
    this.billId = data.bill_id;
    this.branchId = data.branch_id;
    this.userId = data.user_id;
    this.terminalId = data.terminal_id;
    this.subtotal = data.subtotal;
    this.tax = data.tax;
    this.discount = data.discount;
    this.total = data.total;
    this.status = data.status;
    this.customerInfo = data.customer_info ? JSON.parse(data.customer_info) : null;
    this.notes = data.notes;
    this.holdReason = data.hold_reason;
    this.lastActivity = data.last_activity;
    this.completedAt = data.completed_at;
    this.completedBy = data.completed_by;
    this.createdAt = data.created_at;
    this.updatedAt = data.updated_at;
    this.items = data.items || [];
  }

  // Static method to create a new held bill
  static async create(billData) {
    const { 
      billId, branchId, userId, terminalId, items, subtotal, tax, discount, 
      total, status = 'HELD', customerInfo, notes, holdReason 
    } = billData;
    
    const connection = await pool.getConnection();
    
    try {
      await connection.beginTransaction();
      
      // Insert held bill
      const [billResult] = await connection.execute(
        `INSERT INTO held_bills (bill_id, branch_id, user_id, terminal_id, subtotal, tax, discount, 
         total, status, customer_info, notes, hold_reason, last_activity) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
        [billId, branchId, userId, terminalId, subtotal, tax, discount, 
         total, status, JSON.stringify(customerInfo), notes, holdReason]
      );
      
      const heldBillId = billResult.insertId;
      
      // Insert held bill items
      if (items && items.length > 0) {
        for (const item of items) {
          await connection.execute(
            `INSERT INTO held_bill_items (held_bill_id, inventory_item_id, sku, name, 
             quantity, unit_price, discount, total) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [heldBillId, item.inventoryItemId, item.sku, item.name, 
             item.quantity, item.unitPrice, item.discount, item.total]
          );
        }
      }
      
      await connection.commit();
      
      return await HeldBill.findById(heldBillId);
      
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  // Static method to find held bill by ID
  static async findById(id) {
    const [rows] = await pool.execute(
      'SELECT * FROM held_bills WHERE id = ?',
      [id]
    );
    
    if (rows.length === 0) return null;
    
    const heldBill = new HeldBill(rows[0]);
    
    // Get held bill items
    const [itemRows] = await pool.execute(
      'SELECT * FROM held_bill_items WHERE held_bill_id = ?',
      [id]
    );
    
    heldBill.items = itemRows.map(item => new HeldBillItem(item));
    
    return heldBill;
  }

  // Static method to find held bill by bill ID
  static async findByBillId(billId) {
    const [rows] = await pool.execute(
      'SELECT * FROM held_bills WHERE bill_id = ?',
      [billId]
    );
    
    if (rows.length === 0) return null;
    
    const heldBill = new HeldBill(rows[0]);
    
    // Get held bill items
    const [itemRows] = await pool.execute(
      'SELECT * FROM held_bill_items WHERE held_bill_id = ?',
      [heldBill.id]
    );
    
    heldBill.items = itemRows.map(item => new HeldBillItem(item));
    
    return heldBill;
  }

  // Static method to find held bill
  static async findOne(conditions) {
    let query = 'SELECT * FROM held_bills WHERE ';
    const params = [];
    const conditionsArray = [];

    if (conditions.billId) {
      conditionsArray.push('bill_id = ?');
      params.push(conditions.billId);
    }

    if (conditions._id) {
      conditionsArray.push('id = ?');
      params.push(conditions._id);
    }

    if (conditions.id) {
      conditionsArray.push('id = ?');
      params.push(conditions.id);
    }

    if (conditions.branchId) {
      conditionsArray.push('branch_id = ?');
      params.push(conditions.branchId);
    }

    if (conditions.userId) {
      conditionsArray.push('user_id = ?');
      params.push(conditions.userId);
    }

    if (conditions.terminalId) {
      conditionsArray.push('terminal_id = ?');
      params.push(conditions.terminalId);
    }

    if (conditions.status) {
      conditionsArray.push('status = ?');
      params.push(conditions.status);
    }

    if (conditionsArray.length === 0) return null;

    query += conditionsArray.join(' AND ');
    query += ' LIMIT 1';

    const [rows] = await pool.execute(query, params);
    
    if (rows.length === 0) return null;
    
    const heldBill = new HeldBill(rows[0]);
    
    // Get held bill items
    const [itemRows] = await pool.execute(
      'SELECT * FROM held_bill_items WHERE held_bill_id = ?',
      [heldBill.id]
    );
    
    heldBill.items = itemRows.map(item => new HeldBillItem(item));
    
    return heldBill;
  }

  // Instance method to save held bill
  async save() {
    const connection = await pool.getConnection();
    
    try {
      await connection.beginTransaction();
      
      if (this.id) {
        // Update existing held bill
        await connection.execute(
          `UPDATE held_bills SET bill_id = ?, branch_id = ?, user_id = ?, terminal_id = ?, 
           subtotal = ?, tax = ?, discount = ?, total = ?, status = ?, customer_info = ?, 
           notes = ?, hold_reason = ?, last_activity = ?, completed_at = ?, completed_by = ? 
           WHERE id = ?`,
          [this.billId, this.branchId, this.userId, this.terminalId, this.subtotal, 
           this.tax, this.discount, this.total, this.status, JSON.stringify(this.customerInfo), 
           this.notes, this.holdReason, this.lastActivity, this.completedAt, this.completedBy, this.id]
        );
        
        // Update held bill items if provided
        if (this.items && this.items.length > 0) {
          // Delete existing items
          await connection.execute('DELETE FROM held_bill_items WHERE held_bill_id = ?', [this.id]);
          
          // Insert new items
          for (const item of this.items) {
            await connection.execute(
              `INSERT INTO held_bill_items (held_bill_id, inventory_item_id, sku, name, 
               quantity, unit_price, discount, total) 
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
              [this.id, item.inventoryItemId, item.sku, item.name, 
               item.quantity, item.unitPrice, item.discount, item.total]
            );
          }
        }
      } else {
        // Create new held bill
        const result = await connection.execute(
          `INSERT INTO held_bills (bill_id, branch_id, user_id, terminal_id, subtotal, tax, discount, 
           total, status, customer_info, notes, hold_reason, last_activity) 
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
          [this.billId, this.branchId, this.userId, this.terminalId, this.subtotal, 
           this.tax, this.discount, this.total, this.status, JSON.stringify(this.customerInfo), 
           this.notes, this.holdReason]
        );
        
        this.id = result[0].insertId;
        
        // Insert held bill items
        if (this.items && this.items.length > 0) {
          for (const item of this.items) {
            await connection.execute(
              `INSERT INTO held_bill_items (held_bill_id, inventory_item_id, sku, name, 
               quantity, unit_price, discount, total) 
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
              [this.id, item.inventoryItemId, item.sku, item.name, 
               item.quantity, item.unitPrice, item.discount, item.total]
            );
          }
        }
      }
      
      await connection.commit();
      return this;
      
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  // Method to update last activity
  async updateActivity() {
    this.lastActivity = new Date();
    return await this.save();
  }

  // Method to complete bill
  async completeBill(userId) {
    this.status = 'COMPLETED';
    this.completedAt = new Date();
    this.completedBy = userId;
    return await this.save();
  }

  // Static method to find held bills with pagination
  static async find(conditions = {}, options = {}) {
    let query = 'SELECT * FROM held_bills WHERE 1=1';
    const params = [];

    if (conditions.branchId) {
      query += ' AND branch_id = ?';
      params.push(conditions.branchId);
    }

    if (conditions.userId) {
      query += ' AND user_id = ?';
      params.push(conditions.userId);
    }

    if (conditions.terminalId) {
      query += ' AND terminal_id = ?';
      params.push(conditions.terminalId);
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
      query += ' ORDER BY last_activity DESC';
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
    const heldBills = [];

    for (const row of rows) {
      const heldBill = new HeldBill(row);
      
      // Get held bill items
      const [itemRows] = await pool.execute(
        'SELECT * FROM held_bill_items WHERE held_bill_id = ?',
        [heldBill.id]
      );
      
      heldBill.items = itemRows.map(item => new HeldBillItem(item));
      heldBills.push(heldBill);
    }

    return heldBills;
  }

  // Static method to count held bills
  static async count(conditions = {}) {
    let query = 'SELECT COUNT(*) as count FROM held_bills WHERE 1=1';
    const params = [];

    if (conditions.branchId) {
      query += ' AND branch_id = ?';
      params.push(conditions.branchId);
    }

    if (conditions.userId) {
      query += ' AND user_id = ?';
      params.push(conditions.userId);
    }

    if (conditions.terminalId) {
      query += ' AND terminal_id = ?';
      params.push(conditions.terminalId);
    }

    if (conditions.status) {
      query += ' AND status = ?';
      params.push(conditions.status);
    }

    const [rows] = await pool.execute(query, params);
    return rows[0].count;
  }

  // Static method to update held bill
  static async updateOne(conditions, updateData) {
    let query = 'UPDATE held_bills SET ';
    const params = [];
    const setClauses = [];

    Object.keys(updateData).forEach(key => {
      if (key !== 'id' && key !== 'items') {
        if (key === 'customerInfo') {
          setClauses.push('customer_info = ?');
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
    if (conditions.billId) {
      whereClauses.push('bill_id = ?');
      params.push(conditions.billId);
    }

    if (whereClauses.length === 0) return { modifiedCount: 0 };

    query += whereClauses.join(' AND ');

    const [result] = await pool.execute(query, params);
    return { modifiedCount: result.affectedRows };
  }

  // Static method to delete held bill
  static async deleteOne(conditions) {
    let query = 'DELETE FROM held_bills WHERE ';
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
    if (conditions.billId) {
      whereClauses.push('bill_id = ?');
      params.push(conditions.billId);
    }

    if (whereClauses.length === 0) return { deletedCount: 0 };

    query += whereClauses.join(' AND ');

    const [result] = await pool.execute(query, params);
    return { deletedCount: result.affectedRows };
  }
}

module.exports = HeldBill;
