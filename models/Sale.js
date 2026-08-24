const { pool } = require('../config/database');
const { isLedgerMigrationComplete } = require('../services/ledgerMigrationMeta');
const CustomerLedgerEntries = require('../services/customerLedgerEntriesService');
const { normalizeScope } = require('../services/inventoryLedgerService');
const InventoryProjection = require('../services/inventoryProjectionService');
const { createSaleTransaction } = require('../middleware/stockTracking');
const LedgerService = require('../services/ledgerService');
const { resolveSaleTimestamps } = require('../utils/saleDateUtils');
const { normalizeSaleLineIdentity } = require('../utils/clinicSaleItem');

class SaleItem {
  constructor(data) {
    this.id = data.id;
    this.saleId = data.sale_id;
    this.inventoryItemId = data.inventory_item_id;
    this.clinicServiceId = data.clinic_service_id ?? null;
    this.sku = data.sku;
    this.name = data.name;
    this.quantity = data.quantity;
    this.unitPrice = data.unit_price;
    this.originalPrice = data.original_price;
    this.discount = data.discount;
    this.discountType = data.discount_type;
    this.total = data.total;
    this.createdAt = data.created_at;
  }
}

class Sale {
  constructor(data) {
    this.id = data.id;
    this.invoiceNo = data.invoice_no;
    this.scopeType = data.scope_type;
    this.scopeId = data.scope_id;
    this.userId = data.user_id;
    this.shiftId = data.shift_id;
    this.subtotal = data.subtotal;
    this.tax = data.tax;
    this.discount = data.discount;
    this.total = data.total;
    this.paymentMethod = data.payment_method;
    this.paymentType = data.payment_type;
    this.paymentStatus = data.payment_status;
    this.paymentAmount = data.payment_amount;
    this.creditAmount = data.credit_amount;
    this.oldBalance = data.old_balance || 0; // ADDED: Old balance field
    this.runningBalance = data.running_balance || 0; // ADDED: Running balance field
    this.creditStatus = data.credit_status;
    this.creditDueDate = data.credit_due_date;
    this.customerId = data.customer_id;
    this.retailerId = data.retailer_id;
    this.customerName = data.customer_name;
    this.customerPhone = data.customer_phone;
    this.customerInfo = data.customer_info ? JSON.parse(data.customer_info) : null;
    this.notes = data.notes;
    this.status = data.status;
    this.saleDate = data.sale_date || null;
    this.createdAt = data.created_at;
    this.updatedAt = data.updated_at;
    this.items = data.items || [];
  }

  // Static method to create a new sale with items
  static async create(saleData) {
    const {
      invoiceNo, scopeType, scopeId, userId, shiftId, items,
      subtotal, tax, discount, total, paymentMethod, paymentType, paymentStatus,
      customerInfo, notes, status = 'COMPLETED', customerName, customerPhone,
      paymentAmount, creditAmount, oldBalance, runningBalance, creditStatus, creditDueDate, customerId, retailerId,
      saleDate
    } = saleData;
    
    
    const connection = await pool.getConnection();
    
    try {
      await connection.beginTransaction();

      const migrationDoneInsert = await isLedgerMigrationComplete(connection);
      const persistOldBal = migrationDoneInsert ? 0 : (oldBalance || 0);
      const persistRunBal = migrationDoneInsert ? 0 : (runningBalance || 0);

      const saleTimestamps = resolveSaleTimestamps(saleDate);

      // Insert sale; when migrated, balance columns are archival zeros — ledger + invoice_snapshots are truth
      const [saleResult] = await connection.execute(
        `INSERT INTO sales (invoice_no, scope_type, scope_id, user_id, shift_id,
         subtotal, tax, discount, total, payment_method, payment_type, payment_status,
         customer_info, notes, status, customer_name, customer_phone,
         payment_amount, credit_amount, old_balance, running_balance, credit_status, credit_due_date, customer_id, retailer_id,
         sale_date, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [invoiceNo || null, scopeType || null, scopeId || null, userId || null, shiftId || null,
         subtotal || 0, tax || 0, discount || 0, total || 0, paymentMethod || null,
         paymentType || null, paymentStatus || null, customerInfo || null, notes || null, status || null,
         customerName || null, customerPhone || null, paymentAmount || 0,
         creditAmount || 0, persistOldBal, persistRunBal, creditStatus || 'NONE', creditDueDate || null, customerId || null, retailerId || null,
         saleTimestamps.saleDateSql, saleTimestamps.createdAt, saleTimestamps.updatedAt]
      );
      
      const saleId = saleResult.insertId;
      
      // sale_items = sales line storage only (not stock truth). Stock = inventory_ledger_entries + projection cache.
      // Insert sale items + inventory ledger (source of truth) + legacy stock_reports row
      if (items && items.length > 0) {
        const actingUserName = saleData.userName || saleData.username || 'System';
        const actingUserRole = saleData.userRole || 'CASHIER';
        for (const item of items) {
          const identity = normalizeSaleLineIdentity(item);
          const inventoryItemId = identity.inventoryItemId;
          const clinicServiceId = identity.clinicServiceId;
          const sku = identity.sku || item.sku || null;
          const [insResult] = await connection.execute(
            `INSERT INTO sale_items (sale_id, inventory_item_id, clinic_service_id, sku, name, 
             quantity, unit_price, original_price, discount, discount_type, total) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [saleId, inventoryItemId, clinicServiceId, sku, item.name, 
             item.quantity, item.unitPrice, item.originalPrice || item.unitPrice, 
             item.discount || 0, item.discountType || 'amount', item.total]
          );
          const saleItemId = insResult.insertId;

          if (inventoryItemId) {
            const [invRows] = await connection.execute(
              'SELECT scope_type, scope_id FROM inventory_items WHERE id = ?',
              [inventoryItemId]
            );
            if (invRows.length > 0) {
              const inv = invRows[0];
              const st = normalizeScope(inv.scope_type);
              const sid = String(inv.scope_id != null ? inv.scope_id : '');
              await InventoryProjection.applyEvent(connection, {
                event_type: 'SALE',
                inventory_item_id: inventoryItemId,
                scope_type: st,
                scope_id: sid,
                quantity_in: 0,
                quantity_out: parseFloat(item.quantity) || 0,
                reference_type: 'sale',
                reference_id: `${saleId}:${saleItemId}`,
                created_by: userId,
              });
              await createSaleTransaction(
                inventoryItemId,
                item.quantity,
                item.unitPrice,
                userId,
                actingUserName,
                actingUserRole,
                saleId,
                connection
              );
            }
          }
        }
      }

      if (migrationDoneInsert) {
        const [saleRows] = await connection.execute('SELECT * FROM sales WHERE id = ?', [saleId]);
        if (saleRows.length > 0) {
          const sr = saleRows[0];
          await CustomerLedgerEntries.appendFromSalesRow(connection, sr);
          const balAfter = await CustomerLedgerEntries.getCustomerBalance(connection, {
            scopeType: sr.scope_type,
            scopeId: sr.scope_id,
            retailerId: sr.retailer_id,
            customerName: sr.customer_name,
            customerPhone: sr.customer_phone,
          });
          const { debit, credit } = CustomerLedgerEntries.debitCreditForSaleRow(sr);
          const oldSnap = balAfter - (debit - credit);
          await CustomerLedgerEntries.insertInvoiceSnapshot(connection, {
            sale_id: saleId,
            customer_id: sr.customer_id,
            retailer_id: sr.retailer_id,
            scope_type: sr.scope_type,
            scope_id: sr.scope_id,
            invoice_no: sr.invoice_no,
            old_balance: oldSnap,
            total: sr.total,
            payment: sr.payment_amount,
            final_balance: balAfter,
          });
        }
      }

      const glItems = [];
      if (items && items.length > 0) {
        const invIds = items.map((i) => i.inventoryItemId).filter(Boolean);
        let costMap = new Map();
        if (invIds.length > 0) {
          const ph = invIds.map(() => '?').join(',');
          const [costRows] = await connection.execute(
            `SELECT id, cost_price FROM inventory_items WHERE id IN (${ph})`,
            invIds
          );
          costMap = new Map(costRows.map((r) => [r.id, parseFloat(r.cost_price) || 0]));
        }
        for (const item of items) {
          glItems.push({
            quantity: parseFloat(item.quantity) || 0,
            costPrice: costMap.get(item.inventoryItemId) || 0,
          });
        }
      }

      await LedgerService.recordSaleTransaction(
        {
          saleId,
          invoiceNo: invoiceNo || null,
          scopeType: scopeType || null,
          scopeId: scopeId || null,
          totalAmount: parseFloat(total) || 0,
          paymentAmount: parseFloat(paymentAmount) || 0,
          creditAmount: parseFloat(creditAmount) || 0,
          paymentMethod: paymentMethod || null,
          customerInfo: customerInfo || null,
          userId: userId || null,
          items: glItems,
        },
        connection
      );

      await connection.commit();

      return await Sale.findById(saleId);
      
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  // Static method to find sale by ID
  static async findById(id) {
    const [rows] = await pool.execute(
      'SELECT * FROM sales WHERE id = ?',
      [id]
    );
    
    if (rows.length === 0) return null;
    
    const sale = new Sale(rows[0]);
    
    // Get sale items
    const [itemRows] = await pool.execute(
      'SELECT * FROM sale_items WHERE sale_id = ?',
      [id]
    );
    
    sale.items = itemRows.map(item => new SaleItem(item));
    
    return sale;
  }

  // Static method to find sale by invoice number
  static async findOne(conditions) {
    let query = 'SELECT * FROM sales WHERE ';
    const params = [];
    const conditionsArray = [];

    if (conditions.invoiceNo) {
      conditionsArray.push('invoice_no = ?');
      params.push(conditions.invoiceNo);
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

    const [rows] = await pool.execute(query, params);
    
    if (rows.length === 0) return null;
    
    const sale = new Sale(rows[0]);
    
    // Get sale items
    const [itemRows] = await pool.execute(
      'SELECT * FROM sale_items WHERE sale_id = ?',
      [sale.id]
    );
    
    sale.items = itemRows.map(item => new SaleItem(item));
    
    return sale;
  }

  // Instance method to save sale
  async save() {
    const connection = await pool.getConnection();
    
    try {
      await connection.beginTransaction();
      
      if (this.id) {
        const migrationDone = await isLedgerMigrationComplete(connection);
        if (migrationDone) {
          await connection.execute(
            `UPDATE sales SET invoice_no = ?, scope_type = ?, scope_id = ?, user_id = ?, 
             shift_id = ?, subtotal = ?, tax = ?, discount = ?, total = ?, 
             payment_method = ?, payment_status = ?, customer_info = ?, notes = ?, status = ?,
             payment_amount = ?, credit_amount = ?, credit_status = ? 
             WHERE id = ?`,
            [
              this.invoiceNo, this.scopeType, this.scopeId, this.userId, this.shiftId,
              this.subtotal, this.tax, this.discount, this.total, this.paymentMethod,
              this.paymentStatus, JSON.stringify(this.customerInfo), this.notes, this.status,
              this.paymentAmount, this.creditAmount, this.creditStatus, this.id
            ]
          );
          const [upRows] = await connection.execute('SELECT * FROM sales WHERE id = ?', [this.id]);
          if (upRows.length > 0) {
            const u = upRows[0];
            await CustomerLedgerEntries.appendFromSalesRow(connection, u);
            const balAfter = await CustomerLedgerEntries.getCustomerBalance(connection, {
              scopeType: u.scope_type,
              scopeId: u.scope_id,
              retailerId: u.retailer_id,
              customerName: u.customer_name,
              customerPhone: u.customer_phone,
            });
            const { debit, credit } = CustomerLedgerEntries.debitCreditForSaleRow(u);
            const oldSnap = balAfter - (debit - credit);
            await CustomerLedgerEntries.insertInvoiceSnapshot(connection, {
              sale_id: this.id,
              customer_id: u.customer_id,
              retailer_id: u.retailer_id,
              scope_type: u.scope_type,
              scope_id: u.scope_id,
              invoice_no: u.invoice_no,
              old_balance: oldSnap,
              total: u.total,
              payment: u.payment_amount,
              final_balance: balAfter,
            });
          }
        } else {
        await connection.execute(
          `UPDATE sales SET invoice_no = ?, scope_type = ?, scope_id = ?, user_id = ?, 
           shift_id = ?, subtotal = ?, tax = ?, discount = ?, total = ?, 
           payment_method = ?, payment_status = ?, customer_info = ?, notes = ?, status = ?,
           payment_amount = ?, credit_amount = ?, old_balance = ?, running_balance = ?, credit_status = ? 
           WHERE id = ?`,
          [this.invoiceNo, this.scopeType, this.scopeId, this.userId, this.shiftId,
           this.subtotal, this.tax, this.discount, this.total, this.paymentMethod,
           this.paymentStatus, JSON.stringify(this.customerInfo), this.notes, this.status,
           this.paymentAmount, this.creditAmount, this.oldBalance, this.runningBalance, this.creditStatus, this.id]
        );
        }
        
        // Update sale items if provided
        if (this.items && this.items.length > 0) {
          // Delete existing items
          await connection.execute('DELETE FROM sale_items WHERE sale_id = ?', [this.id]);
          
          // Insert new items
          for (const item of this.items) {
            const identity = normalizeSaleLineIdentity(item);
            await connection.execute(
              `INSERT INTO sale_items (sale_id, inventory_item_id, clinic_service_id, sku, name, 
               quantity, unit_price, discount, total) 
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                this.id,
                identity.inventoryItemId,
                identity.clinicServiceId,
                identity.sku || item.sku || null,
                item.name,
                item.quantity,
                item.unitPrice,
                item.discount,
                item.total,
              ]
            );
          }
        }
      } else {
        // Create new sale
        const result = await connection.execute(
          `INSERT INTO sales (invoice_no, scope_type, scope_id, user_id, shift_id, 
           subtotal, tax, discount, total, payment_method, payment_status, 
           customer_info, notes, status, payment_amount, credit_amount, old_balance, running_balance, credit_status) 
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [this.invoiceNo, this.scopeType, this.scopeId, this.userId, this.shiftId,
           this.subtotal, this.tax, this.discount, this.total, this.paymentMethod,
           this.paymentStatus, JSON.stringify(this.customerInfo), this.notes, this.status,
           this.paymentAmount, this.creditAmount, this.oldBalance, this.runningBalance, this.creditStatus]
        );
        
        this.id = result[0].insertId;
        
        // Insert sale items
        if (this.items && this.items.length > 0) {
          for (const item of this.items) {
            const identity = normalizeSaleLineIdentity(item);
            await connection.execute(
              `INSERT INTO sale_items (sale_id, inventory_item_id, clinic_service_id, sku, name, 
               quantity, unit_price, original_price, discount, discount_type, total) 
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                this.id,
                identity.inventoryItemId,
                identity.clinicServiceId,
                identity.sku || item.sku || null,
                item.name,
                item.quantity,
                item.unitPrice,
                item.originalPrice || item.unitPrice,
                item.discount || 0,
                item.discountType || 'amount',
                item.total,
              ]
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

  // Static method to find sales with pagination
  static async find(conditions = {}, options = {}) {
    let query = 'SELECT * FROM sales WHERE 1=1';
    const params = [];

    if (conditions.scopeType) {
      query += ' AND scope_type = ?';
      params.push(conditions.scopeType);
    }

    if (conditions.scopeId) {
      query += ' AND scope_id = ?';
      params.push(conditions.scopeId);
    }

    if (conditions.userId) {
      query += ' AND user_id = ?';
      params.push(conditions.userId);
    }

    if (conditions.shiftId) {
      query += ' AND shift_id = ?';
      params.push(conditions.shiftId);
    }

    if (conditions.status) {
      query += ' AND status = ?';
      params.push(conditions.status);
    }

    if (conditions.paymentStatus) {
      query += ' AND payment_status = ?';
      params.push(conditions.paymentStatus);
    }

    if (conditions.paymentMethod) {
      query += ' AND payment_method = ?';
      params.push(conditions.paymentMethod);
    }

    if (conditions.invoiceNo) {
      query += ' AND invoice_no LIKE ?';
      params.push(`%${conditions.invoiceNo}%`);
    }

    // Date range filtering
    if (conditions.createdAt) {
      if (conditions.createdAt.$gte) {
        query += ' AND created_at >= ?';
        params.push(conditions.createdAt.$gte);
      }
      if (conditions.createdAt.$lte) {
        query += ' AND created_at <= ?';
        params.push(conditions.createdAt.$lte);
      }
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
    const sales = [];

    for (const row of rows) {
      const sale = new Sale(row);
      
      // Get sale items
      const [itemRows] = await pool.execute(
        'SELECT * FROM sale_items WHERE sale_id = ?',
        [sale.id]
      );
      
      sale.items = itemRows.map(item => new SaleItem(item));
      sales.push(sale);
    }

    return sales;
  }

  // Static method to count sales
  static async count(conditions = {}) {
    let query = 'SELECT COUNT(*) as count FROM sales WHERE 1=1';
    const params = [];

    if (conditions.scopeType) {
      query += ' AND scope_type = ?';
      params.push(conditions.scopeType);
    }

    if (conditions.scopeId) {
      query += ' AND scope_id = ?';
      params.push(conditions.scopeId);
    }

    if (conditions.userId) {
      query += ' AND user_id = ?';
      params.push(conditions.userId);
    }

    if (conditions.shiftId) {
      query += ' AND shift_id = ?';
      params.push(conditions.shiftId);
    }

    if (conditions.status) {
      query += ' AND status = ?';
      params.push(conditions.status);
    }

    if (conditions.paymentStatus) {
      query += ' AND payment_status = ?';
      params.push(conditions.paymentStatus);
    }

    if (conditions.paymentMethod) {
      query += ' AND payment_method = ?';
      params.push(conditions.paymentMethod);
    }

    if (conditions.invoiceNo) {
      query += ' AND invoice_no LIKE ?';
      params.push(`%${conditions.invoiceNo}%`);
    }

    // Date range filtering
    if (conditions.createdAt) {
      if (conditions.createdAt.$gte) {
        query += ' AND created_at >= ?';
        params.push(conditions.createdAt.$gte);
      }
      if (conditions.createdAt.$lte) {
        query += ' AND created_at <= ?';
        params.push(conditions.createdAt.$lte);
      }
    }

    const [rows] = await pool.execute(query, params);
    return rows[0].count;
  }

  // Static method to update sale by ID (alias for updateOne)
  static async update(id, updateData) {
    return await Sale.updateOne({ id }, updateData);
  }

  // Static method to update sale
  static async updateOne(conditions, updateData) {
    
    let query = 'UPDATE sales SET ';
    const params = [];
    const setClauses = [];

    Object.keys(updateData).forEach(key => {
      if (key !== 'id' && key !== 'items') {
        if (key === 'customerInfo') {
          setClauses.push('customer_info = ?');
          params.push(JSON.stringify(updateData[key]));
        } else {
          // Map camelCase to snake_case for database columns
          const fieldMapping = {
            'paymentStatus': 'payment_status',
            'paymentMethod': 'payment_method',
            'scopeType': 'scope_type',
            'scopeId': 'scope_id',
            'userId': 'user_id',
            'shiftId': 'shift_id',
            'customerInfo': 'customer_info',
            'paymentAmount': 'payment_amount',
            'creditAmount': 'credit_amount',
            'oldBalance': 'old_balance', // ADDED: old_balance mapping
            'runningBalance': 'running_balance', // ADDED: running_balance mapping
            'creditStatus': 'credit_status',
            'creditDueDate': 'credit_due_date',
            'customerId': 'customer_id',
            'retailerId': 'retailer_id',
            'customerName': 'customer_name',
            'customerPhone': 'customer_phone',
            'createdAt': 'created_at',
            'updatedAt': 'updated_at'
          };
          
          const dbColumn = fieldMapping[key] || key.replace(/([A-Z])/g, '_$1').toLowerCase().replace(/^_/, '');
          
          setClauses.push(`${dbColumn} = ?`);
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
    if (conditions.invoiceNo) {
      whereClauses.push('invoice_no = ?');
      params.push(conditions.invoiceNo);
    }

    if (whereClauses.length === 0) return { modifiedCount: 0 };

    query += whereClauses.join(' AND ');

    const [result] = await pool.execute(query, params);
    return { modifiedCount: result.affectedRows };
  }

  // Static method to delete sale
  static async deleteOne(conditions) {
    let query = 'DELETE FROM sales WHERE ';
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
    if (conditions.invoiceNo) {
      whereClauses.push('invoice_no = ?');
      params.push(conditions.invoiceNo);
    }

    if (whereClauses.length === 0) return { deletedCount: 0 };

    query += whereClauses.join(' AND ');

    const [result] = await pool.execute(query, params);
    return { deletedCount: result.affectedRows };
  }

  // Static method to delete sale by ID (alias for deleteOne)
  static async delete(id) {
    return await Sale.deleteOne({ id });
  }

  // Static method to get sale items
  static async getSaleItems(saleId) {
    const [rows] = await pool.execute(
      'SELECT * FROM sale_items WHERE sale_id = ?',
      [saleId]
    );
    
    return rows.map(item => new SaleItem(item));
  }

  // ADDED: Static method to get customer's latest running balance
  static async getCustomerRunningBalance(customerName, customerPhone, scopeType, scopeName) {
    try {
      if (await isLedgerMigrationComplete(pool)) {
        return CustomerLedgerEntries.getCustomerBalance(pool, {
          scopeType,
          scopeId: scopeName,
          retailerId: null,
          customerName,
          customerPhone,
        });
      }
      const [latestSale] = await pool.execute(`
        SELECT running_balance 
        FROM sales 
        WHERE (customer_name = ? OR customer_phone = ?)
          AND scope_type = ? 
          AND scope_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `, [customerName, customerPhone, scopeType, scopeName]);
      
      if (latestSale.length > 0) {
        return parseFloat(latestSale[0].running_balance) || 0;
      }
      return 0;
    } catch (error) {
      return 0;
    }
  }

  // ADDED: Static method to get sales by customer with running balances
  static async findByCustomer(customerName, customerPhone, scopeType = null, scopeName = null) {
    let query = `
      SELECT * FROM sales 
      WHERE (customer_name = ? OR customer_phone = ?)
    `;
    const params = [customerName, customerPhone];

    if (scopeType && scopeName) {
      query += ' AND scope_type = ? AND scope_id = ?';
      params.push(scopeType, scopeName);
    }

    query += ' ORDER BY created_at ASC';

    const [rows] = await pool.execute(query, params);
    const sales = [];

    for (const row of rows) {
      const sale = new Sale(row);
      
      // Get sale items
      const [itemRows] = await pool.execute(
        'SELECT * FROM sale_items WHERE sale_id = ?',
        [sale.id]
      );
      
      sale.items = itemRows.map(item => new SaleItem(item));
      sales.push(sale);
    }

    return sales;
  }
}

module.exports = Sale;