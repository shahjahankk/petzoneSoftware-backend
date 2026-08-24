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

function applyRoleScope(user, bodyScopeType, bodyScopeId) {
  if (user.role === 'CASHIER') return { scopeType: 'BRANCH', scopeId: user.branchId };
  if (user.role === 'WAREHOUSE_KEEPER') return { scopeType: 'WAREHOUSE', scopeId: user.warehouseId };
  return { scopeType: bodyScopeType, scopeId: bodyScopeId };
}

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

const createBilty = async (req, res, next) => {
  const connection = await pool.getConnection();
  try {
    const {
      customerName,
      customerPhone,
      retailerId = null,
      customerId = null,
      items = [],
      notes = '',
      biltyDate = null,
      scopeType: bodyScopeType,
      scopeId: bodyScopeId,
    } = req.body;

    if (!items.length) return res.status(400).json({ success: false, message: 'At least one item is required' });
    if (!retailerId && !(customerName && customerPhone)) return res.status(400).json({ success: false, message: 'Customer is required' });

    const normalizedItems = items.map((item) => ({
      description: item.description,
      amount: parseFloat(item.amount || 0),
      quantity: parseFloat(item.quantity || 1),
      vehicleNumber: item.vehicleNumber || null,
    }));
    if (normalizedItems.some((x) => !x.description || x.amount <= 0 || x.quantity <= 0)) {
      return res.status(400).json({ success: false, message: 'Each item must have description and amount > 0' });
    }
    const totalAmount = normalizedItems.reduce((sum, item) => sum + (item.amount * item.quantity), 0);

    const roleScope = applyRoleScope(req.user, bodyScopeType, bodyScopeId);
    await connection.beginTransaction();
    const scopeName = await resolveScopeName(connection, roleScope.scopeType, roleScope.scopeId);
    if (!scopeName) throw new Error('Scope not found');

    const invoiceNo = await InvoiceNumberService.generateBiltyNumber(roleScope.scopeType, roleScope.scopeId);
    const migrationDone = await isLedgerMigrationComplete(connection);
    const oldBalance = await getCurrentRunningBalance(connection, {
      retailerId, customerName, customerPhone, scopeType: roleScope.scopeType, scopeName,
    });
    const newRunningBalance = oldBalance + totalAmount;

    const insOld = migrationDone ? 0 : oldBalance;
    const insRun = migrationDone ? 0 : newRunningBalance;

    const [saleResult] = await connection.execute(
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
        ?, 0, 0, ?,
        'BILTY', 'BILTY_CHARGE', 'PENDING',
        ?, ?, ?,
        0, ?,
        ?, ?, 'PENDING',
        ?, ?,
        ?, 'COMPLETED', ?, NOW(), NOW()
      )`,
      [
        invoiceNo, roleScope.scopeType, scopeName, req.user.id,
        totalAmount, totalAmount,
        JSON.stringify({ name: customerName || '', phone: customerPhone || '' }),
        customerName || '',
        customerPhone || '',
        totalAmount,
        insOld, insRun,
        retailerId || null, customerId || null,
        notes, biltyDate || null,
      ]
    );

    const saleId = saleResult.insertId;
    for (const item of normalizedItems) {
      await connection.execute(
        `INSERT INTO bilty_items (sale_id, description, amount, quantity, vehicle_number, total, created_at)
         VALUES (?, ?, ?, ?, ?, ?, NOW())`,
        [saleId, item.description, item.amount, item.quantity, item.vehicleNumber, item.amount * item.quantity]
      );
    }

    const [rows] = await connection.execute('SELECT * FROM sales WHERE id = ?', [saleId]);
    if (migrationDone && rows.length > 0) {
      await CustomerLedgerEntries.appendFromSalesRow(connection, rows[0]);
      const balAfter = await CustomerLedgerEntries.getCustomerBalance(connection, {
        scopeType: rows[0].scope_type,
        scopeId: rows[0].scope_id,
        retailerId: rows[0].retailer_id,
        customerName: rows[0].customer_name,
        customerPhone: rows[0].customer_phone,
      });
      const { debit, credit } = CustomerLedgerEntries.debitCreditForSaleRow(rows[0]);
      const oldSnap = balAfter - (debit - credit);
      await CustomerLedgerEntries.insertInvoiceSnapshot(connection, {
        sale_id: saleId,
        customer_id: rows[0].customer_id,
        retailer_id: rows[0].retailer_id,
        scope_type: rows[0].scope_type,
        scope_id: rows[0].scope_id,
        invoice_no: rows[0].invoice_no,
        old_balance: oldSnap,
        total: rows[0].total,
        payment: rows[0].payment_amount,
        final_balance: balAfter,
      });
    }
    const [biltyItems] = await connection.execute('SELECT * FROM bilty_items WHERE sale_id = ? ORDER BY id ASC', [saleId]);
    await connection.commit();
    let base = rows[0];
    if (migrationDone && base) {
      base = await mergeSaleRowWithSnapshotBalances(pool, base);
    }
    const out = { ...base, items: biltyItems };
    return res.status(201).json({ success: true, data: out });
  } catch (error) {
    await connection.rollback();
    return next(error);
  } finally {
    connection.release();
  }
};

const getBilties = async (req, res, next) => {
  try {
    const { scopeType, scopeId, startDate, endDate, customerName, customerPhone, retailerId, page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page, 10) - 1) * parseInt(limit, 10);
    const where = [`s.payment_type = 'BILTY_CHARGE'`, 's.deleted_at IS NULL'];
    const params = [];

    if (req.user.role === 'CASHIER') {
      const [rows] = await pool.execute('SELECT name FROM branches WHERE id = ? LIMIT 1', [req.user.branchId]);
      where.push('s.scope_type = ? AND s.scope_id = ?');
      params.push('BRANCH', rows[0]?.name || '');
    } else if (req.user.role === 'WAREHOUSE_KEEPER') {
      const [rows] = await pool.execute('SELECT name FROM warehouses WHERE id = ? LIMIT 1', [req.user.warehouseId]);
      where.push('s.scope_type = ? AND s.scope_id = ?');
      params.push('WAREHOUSE', rows[0]?.name || '');
    } else if (scopeType && scopeId) {
      const [rows] = await pool.execute(
        scopeType === 'BRANCH' ? 'SELECT name FROM branches WHERE id = ? LIMIT 1' : 'SELECT name FROM warehouses WHERE id = ? LIMIT 1',
        [scopeId]
      );
      where.push('s.scope_type = ? AND s.scope_id = ?');
      params.push(scopeType, rows[0]?.name || '');
    }

    if (startDate) { where.push('COALESCE(s.sale_date, s.created_at) >= ?'); params.push(startDate); }
    if (endDate) { where.push('COALESCE(s.sale_date, s.created_at) <= ?'); params.push(endDate); }
    if (customerName) { where.push('LOWER(TRIM(s.customer_name)) LIKE LOWER(?)'); params.push(`%${customerName}%`); }
    if (customerPhone) { where.push('s.customer_phone LIKE ?'); params.push(`%${customerPhone}%`); }
    if (retailerId) { where.push('s.retailer_id = ?'); params.push(retailerId); }

    const whereSql = `WHERE ${where.join(' AND ')}`;
    const [rows] = await pool.execute(
      `SELECT s.*, u.username as created_by
       FROM sales s
       LEFT JOIN users u ON s.user_id = u.id
       ${whereSql}
       ORDER BY s.created_at DESC, s.id DESC
       LIMIT ? OFFSET ?`,
      [...params, parseInt(limit, 10), offset]
    );
    let listRows = rows;
    if (await isLedgerMigrationComplete(pool)) {
      listRows = await mergeSaleRowsWithSnapshotBalances(pool, rows);
    }
    const enriched = await Promise.all(listRows.map(async (row) => {
      const [items] = await pool.execute('SELECT * FROM bilty_items WHERE sale_id = ? ORDER BY id ASC', [row.id]);
      return { ...row, items };
    }));
    const [countRows] = await pool.execute(`SELECT COUNT(*) as total FROM sales s ${whereSql}`, params);
    return res.json({ success: true, data: { items: enriched, total: countRows[0]?.total || 0, page: parseInt(page, 10), limit: parseInt(limit, 10) } });
  } catch (error) {
    return next(error);
  }
};

const getBilty = async (req, res, next) => {
  try {
    const [rows] = await pool.execute(
      `SELECT * FROM sales WHERE id = ? AND payment_type = 'BILTY_CHARGE' AND deleted_at IS NULL LIMIT 1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'Bilty not found' });
    const [items] = await pool.execute('SELECT * FROM bilty_items WHERE sale_id = ? ORDER BY id ASC', [req.params.id]);
    let data = rows[0];
    if (await isLedgerMigrationComplete(pool)) {
      data = await mergeSaleRowWithSnapshotBalances(pool, data);
    }
    return res.json({ success: true, data: { ...data, items } });
  } catch (error) {
    return next(error);
  }
};

const updateBilty = async (req, res, next) => {
  const connection = await pool.getConnection();
  try {
    const { id } = req.params;
    const { items = [], notes, biltyDate, customerName, customerPhone } = req.body;
    await connection.beginTransaction();
    const [rows] = await connection.execute(
      `SELECT * FROM sales WHERE id = ? AND payment_type = 'BILTY_CHARGE' AND deleted_at IS NULL LIMIT 1`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'Bilty not found' });
    const current = rows[0];

    let normalizedItems = items;
    if (!Array.isArray(normalizedItems) || normalizedItems.length === 0) {
      const [existingItems] = await connection.execute('SELECT * FROM bilty_items WHERE sale_id = ?', [id]);
      normalizedItems = existingItems.map((x) => ({ description: x.description, amount: x.amount, quantity: x.quantity, vehicleNumber: x.vehicle_number }));
    }
    const safeItems = normalizedItems.map((item) => ({
      description: item.description,
      amount: parseFloat(item.amount || 0),
      quantity: parseFloat(item.quantity || 1),
      vehicleNumber: item.vehicleNumber || null,
    }));
    if (safeItems.some((x) => !x.description || x.amount <= 0 || x.quantity <= 0)) {
      return res.status(400).json({ success: false, message: 'Invalid bilty items' });
    }
    const newTotal = safeItems.reduce((sum, item) => sum + (item.amount * item.quantity), 0);
    const newRunning = parseFloat(current.old_balance || 0) + newTotal;
    const migrationDone = await isLedgerMigrationComplete(connection);

    if (migrationDone) {
      await connection.execute(
        `UPDATE sales SET subtotal = ?, total = ?, credit_amount = ?, notes = ?, sale_date = ?, customer_name = ?, customer_phone = ?, updated_at = NOW() WHERE id = ?`,
        [
          newTotal,
          newTotal,
          newTotal,
          notes !== undefined ? notes : current.notes,
          biltyDate !== undefined ? biltyDate : current.sale_date,
          customerName || current.customer_name,
          customerPhone || current.customer_phone,
          id,
        ]
      );
    } else {
      await connection.execute(
        `UPDATE sales SET subtotal = ?, total = ?, credit_amount = ?, running_balance = ?, notes = ?, sale_date = ?, customer_name = ?, customer_phone = ?, updated_at = NOW() WHERE id = ?`,
        [
          newTotal, newTotal, newTotal, newRunning,
          notes !== undefined ? notes : current.notes,
          biltyDate !== undefined ? biltyDate : current.sale_date,
          customerName || current.customer_name,
          customerPhone || current.customer_phone,
          id,
        ]
      );
    }
    await connection.execute('DELETE FROM bilty_items WHERE sale_id = ?', [id]);
    for (const item of safeItems) {
      await connection.execute(
        `INSERT INTO bilty_items (sale_id, description, amount, quantity, vehicle_number, total, created_at)
         VALUES (?, ?, ?, ?, ?, ?, NOW())`,
        [id, item.description, item.amount, item.quantity, item.vehicleNumber, item.amount * item.quantity]
      );
    }

    if (!migrationDone) {
      await recalculateCustomerLedger({
        retailerId: current.retailer_id || null,
        customerPhone: (customerPhone || current.customer_phone) || null,
        customerName: (customerName || current.customer_name) || null,
        scopeType: current.scope_type,
        scopeName: current.scope_id,
        connection,
      });
    } else {
      const [upd] = await connection.execute('SELECT * FROM sales WHERE id = ?', [id]);
      if (upd.length > 0) {
        await CustomerLedgerEntries.appendFromSalesRow(connection, upd[0]);
        const balAfter = await CustomerLedgerEntries.getCustomerBalance(connection, {
          scopeType: upd[0].scope_type,
          scopeId: upd[0].scope_id,
          retailerId: upd[0].retailer_id,
          customerName: upd[0].customer_name,
          customerPhone: upd[0].customer_phone,
        });
        const { debit, credit } = CustomerLedgerEntries.debitCreditForSaleRow(upd[0]);
        const oldSnap = balAfter - (debit - credit);
        await CustomerLedgerEntries.insertInvoiceSnapshot(connection, {
          sale_id: parseInt(id, 10),
          customer_id: upd[0].customer_id,
          retailer_id: upd[0].retailer_id,
          scope_type: upd[0].scope_type,
          scope_id: upd[0].scope_id,
          invoice_no: upd[0].invoice_no,
          old_balance: oldSnap,
          total: upd[0].total,
          payment: upd[0].payment_amount,
          final_balance: balAfter,
        });
      }
    }

    const [updatedRows] = await connection.execute('SELECT * FROM sales WHERE id = ?', [id]);
    const [updatedItems] = await connection.execute('SELECT * FROM bilty_items WHERE sale_id = ? ORDER BY id ASC', [id]);
    await connection.commit();
    let saleOut = updatedRows[0];
    if (await isLedgerMigrationComplete(pool)) {
      saleOut = await mergeSaleRowWithSnapshotBalances(pool, saleOut);
    }
    return res.json({ success: true, data: { ...saleOut, items: updatedItems } });
  } catch (error) {
    await connection.rollback();
    return next(error);
  } finally {
    connection.release();
  }
};

const deleteBilty = async (req, res, next) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute(
      `SELECT * FROM sales WHERE id = ? AND payment_type = 'BILTY_CHARGE' AND deleted_at IS NULL LIMIT 1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'Bilty not found' });
    const row = rows[0];
    await trashService.softDelete('sale', req.params.id, req.user.id);
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
  createBilty,
  getBilties,
  getBilty,
  updateBilty,
  deleteBilty,
};
