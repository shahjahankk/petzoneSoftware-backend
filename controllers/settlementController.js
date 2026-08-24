const { pool } = require('../config/database');
const InvoiceNumberService = require('../services/invoiceNumberService');
const trashService = require('../services/trashService');
const CustomerLedgerEntries = require('../services/customerLedgerEntriesService');
const { isLedgerMigrationComplete } = require('../services/ledgerMigrationMeta');
const { getPosCustomerBalance } = require('../services/posCustomerBalanceService');
const { recalculateCustomerLedger } = require('../services/ledgerRecalcService');
const {
  mergeSaleRowWithSnapshotBalances,
  mergeSaleRowsWithSnapshotBalances,
} = require('../utils/invoiceSnapshotBalances');

const ALLOWED_METHODS = ['CASH', 'CARD', 'BANK_TRANSFER', 'MOBILE_PAYMENT', 'CHEQUE'];

async function resolveScopeName(connection, scopeType, scopeId) {
  if (scopeType === 'BRANCH') {
    const [rows] = await connection.execute('SELECT name FROM branches WHERE id = ? LIMIT 1', [scopeId]);
    return rows[0]?.name || null;
  }
  if (scopeType === 'WAREHOUSE') {
    const [rows] = await connection.execute('SELECT name FROM warehouses WHERE id = ? LIMIT 1', [scopeId]);
    return rows[0]?.name || null;
  }
  return null;
}

function applyRoleScope(user, bodyScopeType, bodyScopeId) {
  if (user.role === 'CASHIER') return { scopeType: 'BRANCH', scopeId: user.branchId };
  if (user.role === 'WAREHOUSE_KEEPER') return { scopeType: 'WAREHOUSE', scopeId: user.warehouseId };
  return { scopeType: bodyScopeType, scopeId: bodyScopeId };
}

async function getCurrentRunningBalance(connection, { retailerId, customerName, customerPhone, scopeType, scopeName }) {
  if (retailerId != null && retailerId !== '') {
    return getPosCustomerBalance(connection, {
      scopeType,
      scopeId: scopeName,
      retailerId: parseInt(retailerId, 10),
      customerName: '',
      customerPhone: '',
    });
  }
  if (customerName && customerPhone) {
    return getPosCustomerBalance(connection, {
      scopeType,
      scopeId: scopeName,
      retailerId: null,
      customerName,
      customerPhone,
    });
  }
  return 0;
}

const createSettlement = async (req, res, next) => {
  const connection = await pool.getConnection();
  try {
    const {
      customerName,
      customerPhone,
      retailerId = null,
      customerId = null,
      paymentAmount,
      paymentMethod,
      notes = '',
      settlementDate = null,
      scopeType: bodyScopeType,
      scopeId: bodyScopeId,
    } = req.body;

    const amount = parseFloat(paymentAmount);
    if (!amount || amount <= 0) return res.status(400).json({ success: false, message: 'Payment amount must be > 0' });
    if (!ALLOWED_METHODS.includes(paymentMethod)) return res.status(400).json({ success: false, message: 'Invalid payment method' });
    if (!retailerId && !(customerName && customerPhone)) {
      return res.status(400).json({ success: false, message: 'Customer is required' });
    }

    const roleScope = applyRoleScope(req.user, bodyScopeType, bodyScopeId);
    if (!roleScope.scopeType || !roleScope.scopeId) {
      return res.status(400).json({ success: false, message: 'Scope is required' });
    }

    await connection.beginTransaction();
    const scopeName = await resolveScopeName(connection, roleScope.scopeType, roleScope.scopeId);
    if (!scopeName) throw new Error('Scope not found');

    const invoiceNo = await InvoiceNumberService.generateSettlementNumber(roleScope.scopeType, roleScope.scopeId);
    const migrationDone = await isLedgerMigrationComplete(connection);
    const oldBalance = await getCurrentRunningBalance(connection, {
      retailerId,
      customerName,
      customerPhone,
      scopeType: roleScope.scopeType,
      scopeName,
    });
    const newRunningBalance = oldBalance - amount;

    const insertOldBal = migrationDone ? 0 : oldBalance;
    const insertRunBal = migrationDone ? 0 : newRunningBalance;

    const [insertResult] = await connection.execute(
      `INSERT INTO sales (
        invoice_no, scope_type, scope_id, user_id,
        subtotal, tax, discount, total,
        payment_method, payment_type, payment_status,
        customer_info, customer_name, customer_phone,
        payment_amount, credit_amount,
        old_balance, running_balance, credit_status,
        retailer_id, customer_id,
        notes, status, sale_date, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?,
        0, 0, 0, ?,
        ?, 'OUTSTANDING_SETTLEMENT', 'COMPLETED',
        ?, ?, ?,
        ?, 0,
        ?, ?, 'NONE',
        ?, ?,
        ?, 'COMPLETED', ?, NOW(), NOW()
      )`,
      [
        invoiceNo, roleScope.scopeType, scopeName, req.user.id,
        amount,
        paymentMethod,
        JSON.stringify({ name: customerName || '', phone: customerPhone || '' }),
        customerName || '',
        customerPhone || '',
        amount,
        insertOldBal,
        insertRunBal,
        retailerId || null,
        customerId || null,
        notes,
        settlementDate || null,
      ]
    );

    const saleId = insertResult.insertId;

    const [insertedSale] = await connection.execute('SELECT * FROM sales WHERE id = ?', [saleId]);
    if (insertedSale.length > 0) {
      const row0 = insertedSale[0];
      await CustomerLedgerEntries.appendFromSalesRow(connection, row0);
      const balAfter = await CustomerLedgerEntries.getCustomerBalance(connection, {
        scopeType: row0.scope_type,
        scopeId: row0.scope_id,
        retailerId: row0.retailer_id,
        customerName: row0.customer_name,
        customerPhone: row0.customer_phone,
      });
      const { debit, credit } = CustomerLedgerEntries.debitCreditForSaleRow(row0);
      const oldSnap = balAfter - (debit - credit);
      await CustomerLedgerEntries.insertInvoiceSnapshot(connection, {
        sale_id: saleId,
        customer_id: row0.customer_id,
        retailer_id: row0.retailer_id,
        scope_type: row0.scope_type,
        scope_id: row0.scope_id,
        invoice_no: row0.invoice_no,
        old_balance: oldSnap,
        total: 0,
        payment: amount,
        final_balance: balAfter,
      });
    }

    const [rows] = await connection.execute('SELECT * FROM sales WHERE id = ?', [saleId]);
    await connection.commit();
    let payload = rows[0];
    if (migrationDone && payload) {
      payload = await mergeSaleRowWithSnapshotBalances(pool, payload);
    }
    return res.status(201).json({ success: true, data: payload });
  } catch (error) {
    await connection.rollback();
    return next(error);
  } finally {
    connection.release();
  }
};

const getSettlements = async (req, res, next) => {
  try {
    const { scopeType, scopeId, startDate, endDate, customerName, customerPhone, retailerId, page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page, 10) - 1) * parseInt(limit, 10);
    const where = [`s.payment_type = 'OUTSTANDING_SETTLEMENT'`, 's.deleted_at IS NULL'];
    const params = [];

    if (req.user.role === 'CASHIER') {
      const [rows] = await pool.execute('SELECT name FROM branches WHERE id = ? LIMIT 1', [req.user.branchId]);
      where.push('s.scope_type = ? AND s.scope_id = ?');
      params.push('BRANCH', rows[0]?.name || '');
    } else if (req.user.role === 'WAREHOUSE_KEEPER') {
      const [rows] = await pool.execute('SELECT name FROM warehouses WHERE id = ? LIMIT 1', [req.user.warehouseId]);
      where.push('s.scope_type = ? AND s.scope_id = ?');
      params.push('WAREHOUSE', rows[0]?.name || '');
    } else {
      if (scopeType && scopeId) {
        const [rows] = await pool.execute(
          scopeType === 'BRANCH' ? 'SELECT name FROM branches WHERE id = ? LIMIT 1' : 'SELECT name FROM warehouses WHERE id = ? LIMIT 1',
          [scopeId]
        );
        where.push('s.scope_type = ? AND s.scope_id = ?');
        params.push(scopeType, rows[0]?.name || '');
      }
    }

    if (startDate) { where.push('COALESCE(s.sale_date, s.created_at) >= ?'); params.push(startDate); }
    if (endDate) { where.push('COALESCE(s.sale_date, s.created_at) <= ?'); params.push(endDate); }
    if (customerName) { where.push('LOWER(TRIM(s.customer_name)) LIKE LOWER(?)'); params.push(`%${customerName}%`); }
    if (customerPhone) { where.push('s.customer_phone LIKE ?'); params.push(`%${customerPhone}%`); }
    if (retailerId) { where.push('s.retailer_id = ?'); params.push(retailerId); }

    const whereSql = `WHERE ${where.join(' AND ')}`;
    const [rows] = await pool.execute(
      `SELECT s.*, u.username AS created_by
       FROM sales s
       LEFT JOIN users u ON s.user_id = u.id
       ${whereSql}
       ORDER BY s.created_at DESC, s.id DESC
       LIMIT ? OFFSET ?`,
      [...params, parseInt(limit, 10), offset]
    );
    const [countRows] = await pool.execute(`SELECT COUNT(*) AS total FROM sales s ${whereSql}`, params);
    let items = rows;
    if (await isLedgerMigrationComplete(pool)) {
      items = await mergeSaleRowsWithSnapshotBalances(pool, rows);
    }
    return res.json({
      success: true,
      data: {
        items,
        total: countRows[0]?.total || 0,
        page: parseInt(page, 10),
        limit: parseInt(limit, 10),
      },
    });
  } catch (error) {
    return next(error);
  }
};

const getSettlement = async (req, res, next) => {
  try {
    const [rows] = await pool.execute(
      `SELECT * FROM sales WHERE id = ? AND payment_type = 'OUTSTANDING_SETTLEMENT' AND deleted_at IS NULL LIMIT 1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'Settlement not found' });
    let data = rows[0];
    if (await isLedgerMigrationComplete(pool)) {
      data = await mergeSaleRowWithSnapshotBalances(pool, data);
    }
    return res.json({ success: true, data });
  } catch (error) {
    return next(error);
  }
};

const updateSettlement = async (req, res, next) => {
  const connection = await pool.getConnection();
  try {
    const { id } = req.params;
    const { paymentAmount, paymentMethod, notes, settlementDate, customerName, customerPhone } = req.body;
    await connection.beginTransaction();
    const [rows] = await connection.execute(
      `SELECT * FROM sales WHERE id = ? AND payment_type = 'OUTSTANDING_SETTLEMENT' AND deleted_at IS NULL LIMIT 1`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'Settlement not found' });
    const current = rows[0];
    const newAmount = paymentAmount !== undefined ? parseFloat(paymentAmount) : parseFloat(current.payment_amount || 0);

    const migrationDone = await isLedgerMigrationComplete(connection);

    if (migrationDone) {
      await connection.execute(
        `UPDATE sales SET payment_amount = ?, total = ?, payment_method = ?, notes = ?, sale_date = ?, customer_name = ?, customer_phone = ?, updated_at = NOW() WHERE id = ?`,
        [
          newAmount,
          newAmount,
          paymentMethod || current.payment_method,
          notes !== undefined ? notes : current.notes,
          settlementDate !== undefined ? settlementDate : current.sale_date,
          customerName || current.customer_name,
          customerPhone || current.customer_phone,
          id,
        ]
      );
      const [updRows] = await connection.execute('SELECT * FROM sales WHERE id = ?', [id]);
      if (updRows.length > 0) {
        await CustomerLedgerEntries.appendFromSalesRow(connection, updRows[0]);
        const balAfter = await CustomerLedgerEntries.getCustomerBalance(connection, {
          scopeType: updRows[0].scope_type,
          scopeId: updRows[0].scope_id,
          retailerId: updRows[0].retailer_id,
          customerName: updRows[0].customer_name,
          customerPhone: updRows[0].customer_phone,
        });
        const { debit, credit } = CustomerLedgerEntries.debitCreditForSaleRow(updRows[0]);
        const oldSnap = balAfter - (debit - credit);
        await CustomerLedgerEntries.insertInvoiceSnapshot(connection, {
          sale_id: id,
          customer_id: updRows[0].customer_id,
          retailer_id: updRows[0].retailer_id,
          scope_type: updRows[0].scope_type,
          scope_id: updRows[0].scope_id,
          invoice_no: updRows[0].invoice_no,
          old_balance: oldSnap,
          total: 0,
          payment: newAmount,
          final_balance: balAfter,
        });
      }
    } else {
      const updatedRunning = parseFloat(current.old_balance || 0) - newAmount;
      await connection.execute(
        `UPDATE sales SET payment_amount = ?, total = ?, payment_method = ?, notes = ?, sale_date = ?, customer_name = ?, customer_phone = ?, running_balance = ?, updated_at = NOW() WHERE id = ?`,
        [
          newAmount,
          newAmount,
          paymentMethod || current.payment_method,
          notes !== undefined ? notes : current.notes,
          settlementDate !== undefined ? settlementDate : current.sale_date,
          customerName || current.customer_name,
          customerPhone || current.customer_phone,
          updatedRunning,
          id,
        ]
      );
      await recalculateCustomerLedger({
        retailerId: current.retailer_id || null,
        customerPhone: (customerPhone || current.customer_phone) || null,
        customerName: (customerName || current.customer_name) || null,
        scopeType: current.scope_type,
        scopeName: current.scope_id,
        connection,
      });
    }

    const [updated] = await connection.execute('SELECT * FROM sales WHERE id = ?', [id]);
    await connection.commit();
    let out = updated[0];
    if (migrationDone && out) {
      out = await mergeSaleRowWithSnapshotBalances(pool, out);
    }
    return res.json({ success: true, data: out });
  } catch (error) {
    await connection.rollback();
    return next(error);
  } finally {
    connection.release();
  }
};

const deleteSettlement = async (req, res, next) => {
  const connection = await pool.getConnection();
  try {
    const { id } = req.params;
    await connection.beginTransaction();
    const [rows] = await connection.execute(
      `SELECT * FROM sales WHERE id = ? AND payment_type = 'OUTSTANDING_SETTLEMENT' AND deleted_at IS NULL LIMIT 1`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'Settlement not found' });
    const row = rows[0];
    await trashService.softDelete('sale', id, req.user.id);
    if (!(await isLedgerMigrationComplete(connection))) {
      await recalculateCustomerLedger({
        retailerId: row.retailer_id || null,
        customerPhone: row.customer_phone || null,
        customerName: row.customer_name || null,
        scopeType: row.scope_type,
        scopeName: row.scope_id,
        connection,
      });
    }
    await connection.commit();
    return res.json({ success: true, message: 'Moved to trash' });
  } catch (error) {
    await connection.rollback();
    return next(error);
  } finally {
    connection.release();
  }
};

module.exports = {
  createSettlement,
  getSettlements,
  getSettlement,
  updateSettlement,
  deleteSettlement,
};
