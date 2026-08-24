'use strict';

const { pool } = require('../../config/database');
const { applyOutstandingSettlement } = require('../../services/outstandingSettlementService');
const { getPosCustomerBalance } = require('../../services/posCustomerBalanceService');
const { isLedgerMigrationComplete } = require('../../services/ledgerMigrationMeta');
const { mergeSaleRowWithSnapshotBalances } = require('../../utils/invoiceSnapshotBalances');
const { resolveActingScope } = require('../../utils/resolveActingScope');

const searchOutstandingPayments = async (req, res) => {
  try {
    const { phone, customerName, retailerId, scopeType: queryScopeType, scopeId: queryScopeId } = req.query;

    if (!retailerId && !customerName && !phone) {
      return res.status(400).json({
        success: false,
        message: 'Retailer ID, customer name, or phone is required'
      });
    }

    // ── Step 1: Resolve scope (branch/warehouse NAME stored in sales.scope_id) ──
    const actingScope = await resolveActingScope(req, {
      scopeType: queryScopeType,
      scopeId: queryScopeId,
    });
    const scopeType = actingScope.scopeType;
    const scopeName = actingScope.scopeName;

    // ── Step 2: Build customer match conditions ──────────────────────────────
    let whereClause = '';
    let queryParams = [];

    if (retailerId) {
      // Strict match by retailer_id — never use name/phone when retailer_id is available
      whereClause = `
        WHERE s.retailer_id = ?
        AND s.scope_type = 'WAREHOUSE'
        AND s.deleted_at IS NULL
      `;
      queryParams = [retailerId];
      // Restrict to this user's warehouse (sales.scope_id = warehouse NAME) — otherwise LIMIT 1 can pick another warehouse and break ledger scope / balance.
      if (req.user.role !== 'ADMIN' && scopeType === 'WAREHOUSE' && scopeName) {
        whereClause += ` AND s.scope_id = ?`;
        queryParams.push(scopeName);
      }
    } else {
      // Walk-in customer — match by phone and/or name within the acting user's branch/warehouse scope
      const conditions = ['s.deleted_at IS NULL'];
      queryParams = [];

      if (phone && phone.trim().length >= 3) {
        conditions.push('s.customer_phone = ?');
        queryParams.push(phone.trim());
      }

      if (customerName && customerName.trim().length >= 3) {
        conditions.push('LOWER(TRIM(s.customer_name)) = LOWER(TRIM(?))');
        queryParams.push(customerName.trim());
      }

      if (queryParams.length === 0) {
        return res.json({ success: true, data: [] });
      }

      if (scopeType && scopeName) {
        conditions.push('s.scope_type = ?');
        conditions.push('s.scope_id = ?');
        queryParams.push(scopeType, scopeName);
      } else if (req.user.role !== 'ADMIN') {
        return res.json({ success: true, data: [] });
      }

      whereClause = `WHERE ${conditions.join(' AND ')}`;
    }

    const ledgerDoneSearch = true; // POS outstanding must always use ledger truth

    // ── Step 3: Latest invoice row for display metadata; balance from ledger when migrated ──
    const balanceCols = ledgerDoneSearch
      ? ''
      : `s.running_balance,
        s.old_balance`;
    const query = `
      SELECT 
        s.id,
        s.customer_name,
        s.customer_phone,
        s.retailer_id,
        ${balanceCols ? `${balanceCols},` : ''}
        s.invoice_no,
        s.created_at,
        s.sale_date,
        s.payment_status,
        s.credit_amount,
        s.payment_amount,
        s.total,
        s.subtotal,
        s.payment_method,
        s.payment_type,
        s.scope_type,
        s.scope_id
      FROM sales s
      ${whereClause}
      ORDER BY s.created_at DESC, s.id DESC
      LIMIT 1
    `;

    const [results] = await pool.execute(query, queryParams);

    if (results.length > 0) {
    }

    if (results.length === 0) {
      return res.json({ success: true, data: [] });
    }

    const customer = results[0];
    // Ledger balance must use the acting user's warehouse/branch scope when known — not only metadata from the latest sale row (avoids wrong SUM vs customer ledger UI).
    const balanceScopeType =
      scopeType && scopeName ? scopeType : customer.scope_type;
    const balanceScopeIdRaw =
      scopeType && scopeName ? scopeName : customer.scope_id;
    const balanceScopeId =
      balanceScopeIdRaw != null && balanceScopeIdRaw !== ''
        ? String(balanceScopeIdRaw)
        : '';

    const ridFromQuery =
      retailerId != null && retailerId !== ''
        ? parseInt(retailerId, 10)
        : NaN;

    // For POS phone/name lookup, we must NOT auto-force retailer_id from the latest sale row.
    // Otherwise some ledger settlement/credit entries (with null/different retailer_id)
    // can be excluded, and the due amount shown in POS will ignore those settlements.
    const effectiveRid = !Number.isNaN(ridFromQuery) ? ridFromQuery : null;

    const outstanding = await getPosCustomerBalance(pool, {
      scopeType: balanceScopeType,
      scopeId: balanceScopeId,
      retailerId: effectiveRid,
      customerName: customer.customer_name,
      customerPhone: customer.customer_phone,
    });

    // No meaningful balance → nothing to surface in the UI
    if (Math.abs(outstanding) <= 0.01) {
      return res.json({ success: true, data: [] });
    }

    // outstanding > 0 → customer OWES money (debit)
    // outstanding < 0 → customer has ADVANCE CREDIT (credit)
    const formattedResult = {
      customerName:        customer.customer_name,
      phone:               customer.customer_phone,
      totalOutstanding:    Math.abs(outstanding),
      outstandingAmount:   Math.abs(outstanding),
      creditAmount:        outstanding,
      finalAmount:         outstanding,
      pendingSalesCount:   1,
      isCredit:            outstanding < 0,
      latestInvoice:       customer.invoice_no,
      lastTransactionDate: customer.created_at,
      paymentStatus:       customer.payment_status,
      scopeType:           customer.scope_type,
      scopeId:             customer.scope_id,
      _debug: ledgerDoneSearch
        ? {
            record_id: customer.id,
            outstanding_from_ledger: outstanding,
            balance_source: 'customer_ledger_entries',
            credit_amount: customer.credit_amount,
            payment_amount: customer.payment_amount,
            scope_name_used: scopeName,
            scope_type_used: scopeType,
            match_strategy: phone ? 'phone+scope' : 'name+scope',
          }
        : {
            record_id:       customer.id,
            running_balance: customer.running_balance,
            old_balance:     customer.old_balance,
            credit_amount:   customer.credit_amount,
            payment_amount:  customer.payment_amount,
            scope_name_used: scopeName,
            scope_type_used: scopeType,
            match_strategy:  phone ? 'phone+scope' : 'name+scope'
          }
    };

    return res.json({ success: true, data: [formattedResult] });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error searching outstanding payments',
      error: error.message
    });
  }
};

// ─────────────────────────────────────────────────────────────────────────────

const clearOutstandingPayment = async (req, res) => {
  try {
const { customerName, phone, paymentAmount, paymentMethod, notes: userNotes, retailerId: bodyRetailerId, saleDate } = req.body;

if (!customerName || !phone || !paymentMethod) {
  return res.status(400).json({
    success: false,
    message: 'Customer name, phone, and payment method are required'
  });
}

// ── Step 1: Resolve scope NAME for the acting user ───────────────────────
let scopeType = null;
let scopeName = null;   // exact string stored in sales.scope_id

if (req.user.role === 'CASHIER') {
  scopeType = 'BRANCH';
  if (req.user.branchName) {
    scopeName = req.user.branchName;
  } else if (req.user.branchId) {
    const [rows] = await pool.execute(
      'SELECT name FROM branches WHERE id = ?',
      [req.user.branchId]
    );
    scopeName = rows[0]?.name || null;
  }
} else if (req.user.role === 'WAREHOUSE_KEEPER') {
  scopeType = 'WAREHOUSE';
  if (req.user.warehouseName) {
    scopeName = req.user.warehouseName;
  } else if (req.user.warehouseId) {
    const [rows] = await pool.execute(
      'SELECT name FROM warehouses WHERE id = ?',
      [req.user.warehouseId]
    );
    scopeName = rows[0]?.name || null;
  }
}

if (req.user.role !== 'ADMIN' && (!scopeType || !scopeName)) {
  return res.status(400).json({
    success: false,
    message: 'Could not determine your store scope. Please contact admin.'
  });
}

const normalizedPaymentAmount = parseFloat(paymentAmount) || 0;
if (normalizedPaymentAmount < 0) {
  return res.status(400).json({
    success: false,
    message: 'Payment amount cannot be negative'
  });
}

const connection = await pool.getConnection();

try {
  await connection.beginTransaction();

  const numericScopeIdForInvoice = req.user.role === 'CASHIER'
    ? req.user.branchId
    : req.user.warehouseId;

  const settlementResult = await applyOutstandingSettlement(connection, {
    scopeType,
    scopeName,
    applyScopeFilter: req.user.role !== 'ADMIN',
    userId: req.user.id,
    userName: req.user.name,
    userRole: req.user.role,
    customerName,
    phone,
    paymentAmount: normalizedPaymentAmount,
    paymentMethod,
    notes: userNotes,
    numericScopeIdForInvoice,
    retailerId: bodyRetailerId != null ? parseInt(bodyRetailerId, 10) : null,
    saleDate: saleDate || null,
  });

  await connection.commit();

  const ledgerDoneClear = await isLedgerMigrationComplete(pool);
  const settlementSelect = ledgerDoneClear
    ? `SELECT id, invoice_no, created_at, total, payment_method,
            payment_amount, credit_amount,
            customer_name, customer_phone
     FROM sales WHERE id = ?`
    : `SELECT id, invoice_no, created_at, total, payment_method,
            payment_amount, credit_amount, running_balance,
            customer_name, customer_phone
     FROM sales WHERE id = ?`;

  const [settlementSaleRows] = await connection.execute(
    settlementSelect,
    [settlementResult.settlementId]
  );

  let settlementSaleOut = settlementSaleRows[0] || null;
  if (settlementSaleOut && ledgerDoneClear) {
    settlementSaleOut = await mergeSaleRowWithSnapshotBalances(pool, settlementSaleOut);
  }

  return res.json({
    success: true,
    message: settlementResult.message,
    data: {
      customerName,
      phone,
      paymentAmount:        settlementResult.paymentAmount,
      paymentMethod:        settlementResult.paymentMethod,
      remainingOutstanding: settlementResult.newBalance,
      isFullyCleared:       settlementResult.isFullyCleared,
      settlementCreated:    true,
      settlementAmount:     settlementResult.settlementAmount,
      settlementSale:       settlementSaleOut,
      isCreditRefund:       settlementResult.isCreditRefund,
      originalBalance:      settlementResult.originalBalance,
      newBalance:           settlementResult.newBalance,
      refundAmount:         settlementResult.refundAmount
    }
  });

} catch (error) {
  await connection.rollback();
  if (error.statusCode === 400) {
    return res.status(400).json({
      success: false,
      message: error.message
    });
  }
  throw error;
} finally {
  connection.release();
}

  } catch (error) {
res.status(500).json({
  success: false,
  message: 'Error clearing outstanding payment',
  error: error.message
});
  }
};    

module.exports = {
  searchOutstandingPayments,
  clearOutstandingPayment,
};
