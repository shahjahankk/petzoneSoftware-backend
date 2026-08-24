// models/SalesReturn.js
const { pool } = require('../config/database');

class SalesReturn {
  constructor(data) {
    this.id = data.id;
    this.returnNo = data.return_no;
    this.originalSaleId = data.original_sale_id;
    this.userId = data.user_id;
    this.reason = data.reason;
    this.notes = data.notes;
    this.totalRefund = data.total_refund;
    this.status = data.status;
    this.processedBy = data.processed_by;
    this.approvedBy = data.approved_by;
    this.createdAt = data.created_at;
    this.updatedAt = data.updated_at;
    this.items = data.items || [];
  }

  static async create(returnData, connection = null) {
    const useConnection = connection || await pool.getConnection();
    const isExternalConn = !!connection;

    try {
      if (!isExternalConn) await useConnection.beginTransaction();

      const {
        originalSaleId,
        userId,
        reason = 'Customer Return',
        notes = null,
        totalRefund = 0,
        items = [],
        processedBy
      } = returnData;

      // Generate return number
      const [last] = await useConnection.execute(
        'SELECT return_no FROM sales_returns ORDER BY id DESC LIMIT 1'
      );
      const nextNum = last.length > 0 
        ? (parseInt(last[0].return_no.replace('RET-', '')) || 0) + 1 
        : 1;
      const returnNo = `RET-${nextNum.toString().padStart(10, '0')}`;

      // Insert main return
      const [result] = await useConnection.execute(
        `INSERT INTO sales_returns (
          return_no, original_sale_id, user_id, reason, notes, 
          total_refund, processed_by, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'COMPLETED')`,
        [returnNo, originalSaleId, userId, reason, notes, totalRefund, processedBy]
      );

      const returnId = result.insertId;

      // Insert return items (using individual inserts like Sale model)
      if (items && items.length > 0) {
        for (const item of items) {
          await useConnection.execute(
            `INSERT INTO sales_return_items (
              return_id, inventory_item_id, item_name, sku, barcode, category,
              quantity, original_quantity, remaining_quantity, unit_price, refund_amount
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              returnId,
              item.inventoryItemId || null, // Allow null for manual items
              item.itemName || item.productName || 'Unknown Item',
              item.sku || 'N/A',
              item.barcode || null,
              item.category || null,
              parseFloat(item.quantity) || 0,
              parseFloat(item.originalQuantity || item.quantity) || 0,
              parseFloat(item.remainingQuantity || item.quantity) || 0,
              parseFloat(item.unitPrice) || 0,
              parseFloat(item.refundAmount) || 0
            ]
          );
        }
      }

      if (!isExternalConn) await useConnection.commit();

      return await SalesReturn.findById(returnId, useConnection);
    } catch (error) {
      if (!isExternalConn) await useConnection.rollback();
      throw error;
    } finally {
      if (!isExternalConn && useConnection) useConnection.release();
    }
  }

  // findById remains perfect — no change needed
  static async findById(id, connection = null) {
    const useConnection = connection || await pool.getConnection();
    try {
      const [rows] = await useConnection.execute(
        'SELECT * FROM sales_returns WHERE id = ?',
        [id]
      );
      if (rows.length === 0) return null;

      const returnRecord = rows[0];

      const [itemRows] = await useConnection.execute(
        `SELECT 
          sri.*,
          ii.name as inventory_item_name,
          ii.sku as inventory_sku,
          ii.selling_price as inventory_price,
          ii.category as inventory_category,
          ii.barcode as inventory_barcode
         FROM sales_return_items sri
         LEFT JOIN inventory_items ii ON sri.inventory_item_id = ii.id
         WHERE sri.return_id = ?
         ORDER BY sri.id`,
        [id]
      );

      return new SalesReturn({
        ...returnRecord,
        items: itemRows.map(item => ({
          id: item.id,
          returnId: item.return_id,
          inventoryItemId: item.inventory_item_id,
          itemName: item.item_name || item.inventory_item_name || 'Unknown Item',
          sku: item.sku || item.inventory_sku || 'N/A',
          barcode: item.barcode || item.inventory_barcode || null,
          category: item.category || item.inventory_category || null,
          quantity: parseFloat(item.quantity),
          originalQuantity: parseFloat(item.original_quantity),
          remainingQuantity: parseFloat(item.remaining_quantity),
          unitPrice: parseFloat(item.unit_price),
          refundAmount: parseFloat(item.refund_amount),
          createdAt: item.created_at
        }))
      });
    } finally {
      if (!connection) useConnection.release();
    }
  }

  // Find one record with conditions
  static async findOne(conditions) {
    let query = 'SELECT * FROM sales_returns WHERE ';
    const params = [];
    const conditionsArray = [];

    if (conditions.returnNo) {
      conditionsArray.push('return_no = ?');
      params.push(conditions.returnNo);
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
    return new SalesReturn(rows[0]);
  }

  // Save (update or create) instance
  async save() {
    if (this.id) {
      // Update existing sales return
      await pool.execute(
        `UPDATE sales_returns SET return_no = ?, original_sale_id = ?, reason = ?, 
         notes = ?, total_refund = ?, status = ?, processed_by = ?, approved_by = ?, 
         updated_at = NOW() WHERE id = ?`,
        [this.returnNo, this.originalSaleId, this.reason, this.notes, this.totalRefund,
         this.status, this.processedBy, this.approvedBy, this.id]
      );
    } else {
      // Create new sales return
      const result = await pool.execute(
        `INSERT INTO sales_returns (return_no, original_sale_id, reason, notes, 
         total_refund, status, processed_by, approved_by, created_at, updated_at) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
        [this.returnNo, this.originalSaleId, this.reason, this.notes, this.totalRefund,
         this.status, this.processedBy, this.approvedBy]
      );
      this.id = result[0].insertId;
    }
    return this;
  }

  // Find with pagination and conditions
  static async find(conditions = {}, options = {}) {
    let query = 'SELECT * FROM sales_returns WHERE 1=1';
    const params = [];

    if (conditions.status) {
      query += ' AND status = ?';
      params.push(conditions.status);
    }

    if (conditions.processedBy) {
      query += ' AND processed_by = ?';
      params.push(conditions.processedBy);
    }

    if (conditions.approvedBy) {
      query += ' AND approved_by = ?';
      params.push(conditions.approvedBy);
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
    return rows.map(row => new SalesReturn(row));
  }

  // Count records
  static async count(conditions = {}) {
    let query = 'SELECT COUNT(*) as count FROM sales_returns WHERE 1=1';
    const params = [];

    if (conditions.status) {
      query += ' AND status = ?';
      params.push(conditions.status);
    }

    if (conditions.processedBy) {
      query += ' AND processed_by = ?';
      params.push(conditions.processedBy);
    }

    if (conditions.approvedBy) {
      query += ' AND approved_by = ?';
      params.push(conditions.approvedBy);
    }

    const [rows] = await pool.execute(query, params);
    return rows[0].count;
  }

  // Update one record
  static async updateOne(conditions, updateData) {
    let query = 'UPDATE sales_returns SET ';
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
    if (conditions.returnNo) {
      whereClauses.push('return_no = ?');
      params.push(conditions.returnNo);
    }

    if (whereClauses.length === 0) return { modifiedCount: 0 };

    query += whereClauses.join(' AND ');

    const [result] = await pool.execute(query, params);
    return { modifiedCount: result.affectedRows };
  }

  // Delete one record
  static async deleteOne(conditions) {
    let query = 'DELETE FROM sales_returns WHERE ';
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
    if (conditions.returnNo) {
      whereClauses.push('return_no = ?');
      params.push(conditions.returnNo);
    }

    if (whereClauses.length === 0) return { deletedCount: 0 };

    query += whereClauses.join(' AND ');

    const [result] = await pool.execute(query, params);
    return { deletedCount: result.affectedRows };
  }
}

module.exports = SalesReturn;