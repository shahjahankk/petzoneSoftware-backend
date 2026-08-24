const { pool } = require('../config/database');
const InvoiceNumberService = require('../services/invoiceNumberService');
const LedgerService = require('../services/ledgerService');
const CustomerLedgerEntries = require('../services/customerLedgerEntriesService');
const { getPosCustomerBalance } = require('../services/posCustomerBalanceService');
const { isLedgerMigrationComplete } = require('../services/ledgerMigrationMeta');
const { applyOutstandingSettlement } = require('../services/outstandingSettlementService');
const { createSaleTransaction } = require('../middleware/stockTracking');
const { resolveSaleTimestamps } = require('../utils/saleDateUtils');

class WarehouseSale {
  constructor(data) {
    this.id = data.id;
    this.retailerId = data.retailer_id;
    this.warehouseKeeperId = data.warehouse_keeper_id;
    this.totalAmount = data.total_amount;
    this.taxAmount = data.tax_amount;
    this.discountAmount = data.discount_amount;
    this.finalAmount = data.final_amount;
    this.paymentMethod = data.payment_method;
    this.paymentStatus = data.payment_status;
    this.invoiceNumber = data.invoice_number;
    this.notes = data.notes;  
    this.status = data.status;
    this.createdAt = data.created_at;
    this.updatedAt = data.updated_at;
  }

  // Create new warehouse sale
  static async create(saleData, customerName = 'Company', paymentMethod = 'CASH', paymentTerms = null) {
    const connection = await pool.getConnection();

    const parseNumber = (value, fallback = 0) => {
      if (value === undefined || value === null || value === '') {
        return fallback;
      }
      const parsed = parseFloat(value);
      return Number.isNaN(parsed) ? fallback : parsed;
    };

    const normalizeId = (value) => {
      if (value === undefined || value === null || value === '') {
        return null;
      }
      const parsed = Number(value);
      return Number.isNaN(parsed) ? value : parsed;
    };

    try {
      await connection.beginTransaction();

      const {
        retailerId,
        warehouseKeeperId,
        salespersonId = null,
        salespersonName = null,
        salespersonPhone = null,
        items = [],
        subtotal = 0,
        taxAmount = 0,
        discountAmount = 0,
        billAmount: providedBillAmount,
        totalWithOutstanding: providedTotalWithOutstanding,
        paymentMethod: incomingPaymentMethod,
        paymentType,
        paymentStatus,
        paymentAmount = 0,
        creditAmount = 0,
        outstandingPayments = [],
        notes = null,
        customerInfo: incomingCustomerInfo,
        scopeWarehouseId = null,
        outstandingPortion = null,
        saleDate = null
      } = saleData;

      if (!warehouseKeeperId) {
        throw new Error('Warehouse keeper ID is required to create a warehouse sale');
      }

      const subtotalAmount = parseNumber(subtotal);
      const taxAmountValue = parseNumber(taxAmount);
      const discountAmountValue = parseNumber(discountAmount);
      const billAmount = parseNumber(providedBillAmount, subtotalAmount + taxAmountValue - discountAmountValue);
      const totalWithOutstanding = parseNumber(providedTotalWithOutstanding, billAmount);

      const paymentMethodValue = (incomingPaymentMethod || paymentMethod || 'CASH').toUpperCase();
      let paymentTypeValue = paymentType || null;
      const paymentAmountValue = parseNumber(paymentAmount, 0);
      const creditAmountValue = parseNumber(creditAmount, 0);

      if (!paymentTypeValue) {
        if (paymentMethodValue === 'FULLY_CREDIT') {
          paymentTypeValue = 'FULLY_CREDIT';
        } else if (creditAmountValue > 0 && paymentAmountValue > 0) {
          paymentTypeValue = 'PARTIAL_PAYMENT';
        } else if (creditAmountValue > 0) {
          paymentTypeValue = 'PARTIAL_PAYMENT';
        } else {
          paymentTypeValue = 'FULL_PAYMENT';
        }
      }

      let paymentStatusValue = paymentStatus || null;
      if (!paymentStatusValue) {
        if (paymentTypeValue === 'BALANCE_PAYMENT') {
          paymentStatusValue = 'COMPLETED';
        } else if (paymentMethodValue === 'FULLY_CREDIT') {
          paymentStatusValue = 'PENDING';
        } else if (creditAmountValue > 0) {
          paymentStatusValue = 'PENDING';
        } else {
          paymentStatusValue = 'COMPLETED';
        }
      }

      const normalizedItems = items.map((item) => {
        const inventoryItemId = normalizeId(item.itemId || item.inventoryItemId || item.id || null);
        const quantity = parseNumber(item.quantity, 0);
        const unitPrice = parseNumber(
          item.unitPrice !== undefined ? item.unitPrice : (item.customPrice !== undefined ? item.customPrice : item.price),
          0
        );
        const discountValue = parseNumber(item.discount, 0);
        const lineTotal = parseNumber(
          item.totalPrice !== undefined ? item.totalPrice : item.total,
          (unitPrice * quantity) - discountValue
        );

        return {
          itemId: inventoryItemId,
          inventoryItemId,
          sku: item.sku || '',
          name: item.name || '',
          quantity,
          unitPrice,
          discount: discountValue,
          totalPrice: lineTotal
        };
      });

      let warehouseId = normalizeId(scopeWarehouseId);
      let warehouseName = null;
      let warehouseCode = null;

      try {
        if (warehouseId) {
          const [warehouses] = await connection.execute(
            'SELECT id, name, code FROM warehouses WHERE id = ?',
            [warehouseId]
          );
          if (warehouses.length > 0) {
            warehouseName = warehouses[0].name;
            warehouseCode = warehouses[0].code;
          }
        }

        if (!warehouseName) {
          const [users] = await connection.execute(
            'SELECT warehouse_id FROM users WHERE id = ?',
            [warehouseKeeperId]
          );

          if (users.length > 0 && users[0].warehouse_id) {
            warehouseId = users[0].warehouse_id;

            const [warehouses] = await connection.execute(
              'SELECT id, name, code FROM warehouses WHERE id = ?',
              [warehouseId]
            );

            if (warehouses.length > 0) {
              warehouseName = warehouses[0].name;
              warehouseCode = warehouses[0].code;
            }
          }
        }
      } catch (warehouseError) {
      }

      let invoiceNumber;
      try {
        // Must use InvoiceNumberService (flat REGEXP + numeric max). Raw LIKE + ORDER BY invoice_no DESC
        // wrongly picks HYDWH-STL-000001 before HYDWH-000241; ^CODE-(\\d+)$ then fails → resets to 000001.
        const scopeForInvoice = warehouseId || warehouseName;
        if (!scopeForInvoice) {
          throw new Error('Warehouse scope not resolved for invoice numbering');
        }
        invoiceNumber = await InvoiceNumberService.generateInvoiceNumber('WAREHOUSE', scopeForInvoice);
      } catch (invoiceError) {
        try {
          invoiceNumber = await InvoiceNumberService.generateInvoiceNumber('WAREHOUSE', warehouseId || warehouseKeeperId);
        } catch (fallbackError) {
          const timestamp = Date.now().toString().slice(-6);
          invoiceNumber = `WH${warehouseId || warehouseKeeperId}-${timestamp}`;
        }
      }

      const scopeIdForSale = warehouseName || (warehouseId !== null ? String(warehouseId) : String(warehouseKeeperId));

      const customerInfoPayload = {
        id: incomingCustomerInfo?.id || retailerId,
        name: incomingCustomerInfo?.name || customerName,
        phone: incomingCustomerInfo?.phone || '',
        paymentTerms: paymentMethodValue === 'CREDIT' ? paymentTerms : incomingCustomerInfo?.paymentTerms || null,
        paymentMethod: paymentMethodValue,
        salesperson: {
          id: salespersonId || null,
          name: salespersonName || null,
          phone: salespersonPhone || null
        },
        ...(incomingCustomerInfo || {})
      };
      customerInfoPayload.name = customerInfoPayload.name || customerName;
      customerInfoPayload.id = customerInfoPayload.id || retailerId;

      let previousRunningBalance = 0;
      try {
        if (retailerId) {
          previousRunningBalance = await getPosCustomerBalance(connection, {
            scopeType: 'WAREHOUSE',
            scopeId: scopeIdForSale,
            retailerId: normalizeId(retailerId),
            customerName: '',
            customerPhone: '',
          });
        } else {
          const finalCustName = customerInfoPayload?.name || customerName || '';
          const finalCustPhone = customerInfoPayload?.phone || '';
          if (finalCustName && finalCustPhone) {
            previousRunningBalance = await getPosCustomerBalance(connection, {
              scopeType: 'WAREHOUSE',
              scopeId: scopeIdForSale,
              retailerId: null,
              customerName: finalCustName,
              customerPhone: finalCustPhone,
            });
          }
        }
      } catch (balanceError) {
        previousRunningBalance = 0;
      }

      const finalCustomerName = customerInfoPayload?.name || customerName || 'Walk-in Customer';
      const customerPhone = customerInfoPayload?.phone || '';

      let settleAmount = parseNumber(outstandingPortion, 0);
      if (!(settleAmount > 0)) {
        settleAmount = Math.max(0, parseNumber(totalWithOutstanding - billAmount, 0));
      }
      if (!(settleAmount > 0) && outstandingPayments?.length) {
        settleAmount = paymentAmountValue;
      }
      settleAmount = Math.min(settleAmount, paymentAmountValue);

      let balanceForSaleOld = previousRunningBalance;
      let paymentForSaleRow = paymentAmountValue;
      let settlementRan = false;

      if (
        outstandingPayments?.length > 0 &&
        settleAmount > 0.01 &&
        customerPhone &&
        String(customerPhone).trim().length > 0
      ) {
        const [keeperRows] = await connection.execute(
          'SELECT username FROM users WHERE id = ? LIMIT 1',
          [warehouseKeeperId]
        );
        const keeperName = keeperRows[0]?.username || 'Warehouse Keeper';

        const settlementResult = await applyOutstandingSettlement(connection, {
          scopeType: 'WAREHOUSE',
          scopeName: scopeIdForSale,
          applyScopeFilter: true,
          userId: warehouseKeeperId,
          userName: keeperName,
          userRole: 'WAREHOUSE_KEEPER',
          customerName: finalCustomerName,
          phone: String(customerPhone).trim(),
          paymentAmount: settleAmount,
          paymentMethod: paymentMethodValue,
          notes: `Outstanding settlement before warehouse invoice ${invoiceNumber}`,
          numericScopeIdForInvoice: warehouseId || warehouseKeeperId,
          retailerId: normalizeId(retailerId) || null,
        });

        settlementRan = true;
        balanceForSaleOld = settlementResult.newBalance;
        paymentForSaleRow = Math.max(0, paymentAmountValue - settleAmount);
      }

      const oldBalance = balanceForSaleOld;
      const runningBalance = oldBalance + billAmount - paymentForSaleRow;
      const creditAmountForInsert = settlementRan
        ? billAmount - paymentForSaleRow
        : creditAmountValue;
      const creditStatus = creditAmountForInsert !== 0 ? 'PENDING' : 'NONE';

      const migrationDoneWhInsert = await isLedgerMigrationComplete(connection);
      const persistSaleOld = migrationDoneWhInsert ? 0 : oldBalance;
      const persistSaleRun = migrationDoneWhInsert ? 0 : runningBalance;

      const saleTimestamps = resolveSaleTimestamps(saleDate);

      const [saleResult] = await connection.execute(
        `INSERT INTO sales (user_id, scope_type, scope_id, invoice_no, subtotal, tax, discount, total, payment_method, payment_type, payment_status, payment_amount, credit_amount, old_balance, running_balance, status, customer_info, customer_name, customer_phone, notes, retailer_id, sale_date, created_at, updated_at)
         VALUES (?, 'WAREHOUSE', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'COMPLETED', ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          warehouseKeeperId,
          scopeIdForSale,
          invoiceNumber,
          subtotalAmount,
          taxAmountValue,
          discountAmountValue,
          billAmount,
          paymentMethodValue,
          paymentTypeValue,
          paymentStatusValue,
          paymentForSaleRow,
          creditAmountForInsert,
          persistSaleOld,
          persistSaleRun,
          JSON.stringify({
            ...customerInfoPayload,
            creditStatus,
            runningBalance,
            outstandingPortion: outstandingPortion ?? (totalWithOutstanding - billAmount)
          }),
          finalCustomerName,
          customerPhone || null,
          notes ?? null,
          normalizeId(retailerId) || null,
          saleTimestamps.saleDateSql,
          saleTimestamps.createdAt,
          saleTimestamps.updatedAt
        ]
      );

      const saleId = saleResult.insertId;

      const saleRowForLedger = {
        id: saleId,
        subtotal: subtotalAmount,
        total: billAmount,
        payment_amount: paymentForSaleRow,
        payment_type: paymentTypeValue,
        payment_method: paymentMethodValue,
        scope_type: 'WAREHOUSE',
        scope_id: scopeIdForSale,
        customer_id: null,
        retailer_id: normalizeId(retailerId) || null,
        customer_name: finalCustomerName,
        customer_phone: customerPhone,
        sale_date: saleDate,
        created_at: new Date(),
      };
      await CustomerLedgerEntries.appendFromSalesRow(connection, saleRowForLedger);
      if (migrationDoneWhInsert) {
        const [fullSale] = await connection.execute('SELECT * FROM sales WHERE id = ?', [saleId]);
        if (fullSale.length > 0) {
          const u = fullSale[0];
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
            sale_id: saleId,
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
        await CustomerLedgerEntries.insertInvoiceSnapshot(connection, {
          sale_id: saleId,
          customer_id: null,
          retailer_id: normalizeId(retailerId) || null,
          scope_type: 'WAREHOUSE',
          scope_id: scopeIdForSale,
          invoice_no: invoiceNumber,
          old_balance: oldBalance,
          total: billAmount,
          payment: paymentForSaleRow,
          final_balance: runningBalance,
        });
      }

      for (const item of normalizedItems) {
        await connection.execute(
          `INSERT INTO sale_items (sale_id, inventory_item_id, sku, name, quantity, unit_price, discount, total)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            saleId,
            item.itemId,
            item.sku || '',
            item.name || '',
            item.quantity,
            item.unitPrice,
            item.discount || 0,
            item.totalPrice
          ]
        );

        if (item.itemId) {
          const [invRows] = await connection.execute(
            'SELECT scope_type, scope_id FROM inventory_items WHERE id = ?',
            [item.itemId]
          );
          if (invRows.length > 0) {
            const { normalizeScope } = require('../services/inventoryLedgerService');
            const InventoryProjection = require('../services/inventoryProjectionService');
            await InventoryProjection.applyEvent(connection, {
              event_type: 'SALE',
              inventory_item_id: item.itemId,
              scope_type: normalizeScope(invRows[0].scope_type),
              scope_id: String(invRows[0].scope_id != null ? invRows[0].scope_id : ''),
              quantity_in: 0,
              quantity_out: item.quantity,
              reference_type: 'sale',
              reference_id: `${saleId}:ws:${item.itemId}`,
              created_by: warehouseKeeperId,
            });
          }

          try {
            const [warehouseKeeperInfo] = await connection.execute(
              'SELECT username FROM users WHERE id = ?',
              [warehouseKeeperId]
            );

            const userName = warehouseKeeperInfo.length > 0
              ? warehouseKeeperInfo[0].username
              : 'Warehouse Keeper';

            await createSaleTransaction(
              item.itemId,
              item.quantity,
              item.unitPrice,
              warehouseKeeperId,
              userName,
              'WAREHOUSE_KEEPER',
              saleId,
              connection
            );
          } catch (stockError) {
            throw stockError;
          }
        }
      }

      await LedgerService.recordSaleTransaction(
        {
          saleId,
          invoiceNo: invoiceNumber,
          scopeType: 'WAREHOUSE',
          scopeId: scopeIdForSale,
          totalAmount: billAmount,
          paymentAmount: paymentForSaleRow,
          creditAmount: creditAmountForInsert,
          paymentMethod: paymentMethodValue,
          customerInfo: customerInfoPayload,
          userId: warehouseKeeperId,
          items: normalizedItems,
        },
        connection
      );

      await connection.commit();

      return await WarehouseSale.findById(saleId);
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  // Find warehouse sale by ID
  static async findById(id) {
    const connection = await pool.getConnection();

    try {
      const [rows] = await connection.execute(
        `SELECT s.id, s.invoice_no as invoice_number, s.scope_type, s.scope_id, s.user_id, s.shift_id, 
                s.subtotal as total_amount, s.tax as tax_amount, s.discount as discount_amount, s.total as final_amount,
                s.payment_method, s.payment_status, s.customer_info, s.customer_name, s.customer_phone, s.notes, s.status, 
                s.created_at, s.updated_at,
                u.username as warehouse_keeper_name
         FROM sales s
         LEFT JOIN users u ON s.user_id = u.id
         WHERE s.id = ? AND s.scope_type = 'WAREHOUSE'`,
        [id]
      );

      if (rows.length === 0) return null;

      const sale = new WarehouseSale(rows[0]);
      
      // Get sale items
      const [items] = await connection.execute(
        `SELECT si.*, ii.name as item_name, ii.sku as item_sku
         FROM sale_items si
         LEFT JOIN inventory_items ii ON si.inventory_item_id = ii.id
         WHERE si.sale_id = ?`,
        [id]
      );

      sale.items = items;
      return sale;
    } finally {
      connection.release();
    }
  }

  // Find all warehouse sales
  static async findAll(filters = {}) {
    const connection = await pool.getConnection();

    try {
      let query = `SELECT s.id, s.invoice_no as invoice_number, s.scope_type, s.scope_id, s.user_id, s.shift_id, 
                           s.subtotal as total_amount, s.tax as tax_amount, s.discount as discount_amount, s.total as final_amount,
                           s.payment_method, s.payment_status, s.customer_info, s.notes, s.status, 
                           s.created_at, s.updated_at,
                           u.username as warehouse_keeper_name
                   FROM sales s
                   LEFT JOIN users u ON s.user_id = u.id
                   WHERE s.scope_type = 'WAREHOUSE'`;
      const params = [];

      if (filters.retailerId) {
        query += ' AND JSON_EXTRACT(s.customer_info, "$.id") = ?';
        params.push(filters.retailerId);
      }

      if (filters.warehouseKeeperId) {
        query += ' AND s.user_id = ?';
        params.push(filters.warehouseKeeperId);
      }

      if (filters.status) {
        query += ' AND s.status = ?';
        params.push(filters.status);
      }

      if (filters.startDate) {
        query += ' AND s.created_at >= ?';
        params.push(filters.startDate);
      }

      if (filters.endDate) {
        query += ' AND s.created_at <= ?';
        params.push(filters.endDate);
      }

      query += ' ORDER BY s.created_at DESC';

      if (filters.limit) {
        query += ' LIMIT ?';
        params.push(filters.limit);
      }

      if (filters.offset) {
        query += ' OFFSET ?';
        params.push(filters.offset);
      }

      const [rows] = await connection.execute(query, params);
      return rows.map(row => new WarehouseSale(row));
    } finally {
      connection.release();
    }
  }

  // Update warehouse sale
  async update(updateData) {
    const connection = await pool.getConnection();

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
        `UPDATE sales SET ${fields.join(', ')}, updated_at = NOW() WHERE id = ?`,
        values
      );

      return await WarehouseSale.findById(this.id);
    } finally {
      connection.release();
    }
  }

  // Delete warehouse sale
  async delete() {
    const connection = await pool.getConnection();

    try {
      await connection.beginTransaction();

      // Restore inventory quantities
      const [items] = await connection.execute(
        'SELECT inventory_item_id, quantity FROM sale_items WHERE sale_id = ?',
        [this.id]
      );

      for (const item of items) {
        const [invRows] = await connection.execute(
          'SELECT scope_type, scope_id FROM inventory_items WHERE id = ?',
          [item.inventory_item_id]
        );
        if (invRows.length > 0) {
          const { normalizeScope } = require('../services/inventoryLedgerService');
          const InventoryProjection = require('../services/inventoryProjectionService');
          await InventoryProjection.applyEvent(connection, {
            event_type: 'RESTOCK',
            inventory_item_id: item.inventory_item_id,
            scope_type: normalizeScope(invRows[0].scope_type),
            scope_id: String(invRows[0].scope_id != null ? invRows[0].scope_id : ''),
            quantity_in: parseFloat(item.quantity) || 0,
            quantity_out: 0,
            reference_type: 'sale_delete',
            reference_id: `${this.id}:del:${item.inventory_item_id}`,
            created_by: null,
          });
        }
      }

      // Delete sale items
      await connection.execute(
        'DELETE FROM sale_items WHERE sale_id = ?',
        [this.id]
      );

      // Delete sale
      await connection.execute(
        'DELETE FROM sales WHERE id = ?',
        [this.id]
      );

      await connection.commit();
      return true;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }
}

module.exports = WarehouseSale;
