/**
 * Shared DB logic for clearing outstanding balances (same transaction as caller).
 * Extracted from salesController.clearOutstandingPayment — must run on an existing connection
 * that already has BEGIN TRANSACTION (caller commits/rolls back).
 */

const InvoiceNumberService = require('./invoiceNumberService');
const FinancialVoucher = require('../models/FinancialVoucher');
const CustomerLedgerEntries = require('./customerLedgerEntriesService');
const { isLedgerMigrationComplete } = require('./ledgerMigrationMeta');
const { finalizeSettlementSale } = require('./saleLedgerSyncService');
const { resolveSaleTimestamps } = require('../utils/saleDateUtils');

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

/**
 * @param {import('mysql2/promise').PoolConnection} connection
 * @param {object} params
 * @returns {Promise<object>} Summary for HTTP responses and callers
 */
async function applyOutstandingSettlement(connection, params) {
  const {
    scopeType,
    scopeName,
    /** When false (e.g. ADMIN global), balance query is not scoped */
    applyScopeFilter = true,
    userId,
    userName,
    userRole,
    customerName,
    phone,
    paymentAmount,
    paymentMethod,
    notes: userNotes,
    /** Warehouse / branch id for InvoiceNumberService.generateSettlementNumber */
    numericScopeIdForInvoice,
    retailerId = null,
    saleDate = null,
  } = params;

  if (!customerName || !phone || !paymentMethod) {
    throw badRequest('Customer name, phone, and payment method are required');
  }

  if (applyScopeFilter && (!scopeType || !scopeName)) {
    throw badRequest('Could not determine your store scope. Please contact admin.');
  }

  const normalizedPaymentAmount = parseFloat(paymentAmount) || 0;
  if (normalizedPaymentAmount < 0) {
    throw badRequest('Payment amount cannot be negative');
  }

  let customerMatchClause = '';
  const balanceParams = [];

  if (phone && phone.trim().length > 0) {
    customerMatchClause = `(customer_phone = ? OR JSON_EXTRACT(customer_info, "$.phone") = ?)`;
    balanceParams.push(phone.trim(), phone.trim());
  } else {
    customerMatchClause = `(LOWER(TRIM(customer_name)) = LOWER(TRIM(?)) OR LOWER(TRIM(JSON_EXTRACT(customer_info, "$.name"))) = LOWER(TRIM(?)))`;
    balanceParams.push(customerName.trim(), customerName.trim());
  }

  const migrated = await isLedgerMigrationComplete(connection);
  let latestRunningBalance;
  if (migrated) {
    if (retailerId != null && retailerId !== '') {
      latestRunningBalance = await CustomerLedgerEntries.getCustomerBalance(connection, {
        scopeType,
        scopeId: scopeName,
        retailerId: parseInt(retailerId, 10),
        customerName: '',
        customerPhone: '',
      });
    } else {
      latestRunningBalance = await CustomerLedgerEntries.getCustomerBalance(connection, {
        scopeType,
        scopeId: scopeName,
        retailerId: null,
        customerName,
        customerPhone: phone,
      });
    }
  } else {
    latestRunningBalance = await CustomerLedgerEntries.getBalanceWithFallback(
      connection,
      {
        retailerId,
        customerName,
        customerPhone: phone,
      },
      scopeType,
      scopeName
    );
  }

  const [historyProbe] = await connection.execute(
    `SELECT id FROM sales WHERE deleted_at IS NULL AND ${customerMatchClause}
     ${applyScopeFilter && scopeType && scopeName ? 'AND scope_type = ? AND scope_id = ?' : ''}
     LIMIT 1`,
    applyScopeFilter && scopeType && scopeName
      ? [...balanceParams, scopeType, scopeName]
      : balanceParams
  );

  if (historyProbe.length === 0) {
    throw badRequest('No transaction history found for this customer in your store');
  }

  if (Math.abs(latestRunningBalance) <= 0.01) {
    throw badRequest('Customer has no outstanding balance or credit to settle');
  }

  const isCreditSettlement = latestRunningBalance < 0;
  const absoluteBalance = Math.abs(latestRunningBalance);
  let actualPaymentAmount = normalizedPaymentAmount;

  if (isCreditSettlement) {
    if (actualPaymentAmount === 0) {
      actualPaymentAmount = absoluteBalance;
    } else if (actualPaymentAmount > absoluteBalance) {
      throw badRequest(
        `Refund amount (${actualPaymentAmount}) cannot exceed available credit (${absoluteBalance})`
      );
    }
  } else {
    if (actualPaymentAmount === 0) {
      throw badRequest('Payment amount must be greater than 0 for outstanding balance');
    }
    if (actualPaymentAmount > absoluteBalance) {
      throw badRequest(
        `Payment amount (${actualPaymentAmount}) cannot exceed outstanding balance (${absoluteBalance})`
      );
    }
  }

  const oldBalance = latestRunningBalance;
  let newRunningBalance;
  let actualPaymentMethod;
  let settlementType;
  let totalAmount;
  let notes;

  if (isCreditSettlement) {
    newRunningBalance = oldBalance + actualPaymentAmount;
    actualPaymentMethod = 'CASH_REFUND';
    settlementType = 'CREDIT_REFUND_SETTLEMENT';
    totalAmount = -actualPaymentAmount;
    notes = [
      userNotes,
      `Credit refund: Customer received ${actualPaymentAmount.toFixed(2)} cash back from credit balance of ${Math.abs(oldBalance).toFixed(2)}`
    ]
      .filter(Boolean)
      .join(' | ');
  } else {
    newRunningBalance = oldBalance - actualPaymentAmount;
    actualPaymentMethod = paymentMethod;
    settlementType = 'OUTSTANDING_SETTLEMENT';
    totalAmount = actualPaymentAmount;
    notes = [
      userNotes,
      `Outstanding payment settlement: Customer paid ${actualPaymentAmount.toFixed(2)} toward balance of ${oldBalance.toFixed(2)}`
    ]
      .filter(Boolean)
      .join(' | ');
  }

  const paymentStatus = Math.abs(newRunningBalance) <= 0.01 ? 'COMPLETED' : 'PARTIAL';

  let settlementInvoiceNo;
  try {
    settlementInvoiceNo = await InvoiceNumberService.generateSettlementNumber(
      scopeType || 'WAREHOUSE',
      numericScopeIdForInvoice
    );
  } catch {
    settlementInvoiceNo = `SETTLE-${Date.now()}-${Math.random().toString(36).substr(2, 5).toUpperCase()}`;
  }

  const persistOldBal = migrated ? 0 : oldBalance;
  const persistRunBal = migrated ? 0 : newRunningBalance;

  const settlementRetailerId =
    retailerId != null && retailerId !== '' ? parseInt(retailerId, 10) : null;

  const saleTimestamps = resolveSaleTimestamps(saleDate);

  const [settlementResult] = await connection.execute(
    `
    INSERT INTO sales (
      invoice_no, scope_type, scope_id, user_id,
      subtotal, tax, discount, total,
      payment_method, payment_type, payment_status,
      customer_info, customer_name, customer_phone,
      payment_amount, credit_amount,
      old_balance, running_balance,
      credit_status, notes, status,
      retailer_id, sale_date,
      created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?,
      0, 0, 0, ?,
      ?, ?, ?,
      ?, ?, ?,
      ?, 0,
      ?, ?,
      'NONE', ?, 'COMPLETED',
      ?, ?,
      ?, ?
    )
  `,
    [
      settlementInvoiceNo,
      scopeType,
      scopeName,
      userId,
      totalAmount,
      actualPaymentMethod,
      settlementType,
      paymentStatus,
      JSON.stringify({
        name: customerName,
        phone: phone,
        isCreditRefund: isCreditSettlement,
        refundAmount: isCreditSettlement ? actualPaymentAmount : 0,
        paymentAmount: !isCreditSettlement ? actualPaymentAmount : 0
      }),
      customerName,
      phone,
      isCreditSettlement ? -actualPaymentAmount : actualPaymentAmount,
      persistOldBal,
      persistRunBal,
      notes,
      Number.isFinite(settlementRetailerId) ? settlementRetailerId : null,
      saleTimestamps.saleDateSql,
      saleTimestamps.createdAt,
      saleTimestamps.updatedAt,
    ]
  );

  const settlementId = settlementResult.insertId;

  const sr = await finalizeSettlementSale(connection, settlementId);

  let responseNewBalance = newRunningBalance;
  if (migrated && sr) {
    responseNewBalance = await CustomerLedgerEntries.getCustomerBalance(connection, {
      scopeType: sr.scope_type,
      scopeId: sr.scope_id,
      retailerId: sr.retailer_id,
      customerName: sr.customer_name,
      customerPhone: sr.customer_phone,
    });
  }

  try {
    if (typeof FinancialVoucher !== 'undefined' && FinancialVoucher?.create) {
      await FinancialVoucher.create({
        voucherNo: `VCH-${isCreditSettlement ? 'REFUND' : 'SETTLE'}-${Date.now()}`,
        type: isCreditSettlement ? 'EXPENSE' : 'INCOME',
        category: isCreditSettlement ? 'CREDIT_REFUND' : 'SETTLEMENT',
        paymentMethod: actualPaymentMethod.toUpperCase(),
        amount: Math.abs(totalAmount),
        description: notes,
        reference: settlementInvoiceNo,
        scopeType,
        scopeId: scopeName,
        userId: userId,
        userName: userName || 'System',
        userRole: userRole || 'USER',
        status: 'APPROVED',
        approvedBy: userId
      });
    }
  } catch (voucherErr) {
  }

  return {
    settlementId,
    settlementInvoiceNo,
    customerName,
    phone,
    paymentAmount: actualPaymentAmount,
    paymentMethod: actualPaymentMethod,
    remainingOutstanding: responseNewBalance,
    isFullyCleared: Math.abs(responseNewBalance) <= 0.01,
    settlementAmount: actualPaymentAmount,
    isCreditRefund: isCreditSettlement,
    originalBalance: oldBalance,
    newBalance: responseNewBalance,
    refundAmount: isCreditSettlement ? actualPaymentAmount : 0,
    message: isCreditSettlement
      ? `Credit refund processed: Customer received ${actualPaymentAmount.toFixed(2)} cash back`
      : `Settlement processed: Customer paid ${actualPaymentAmount.toFixed(2)}`
  };
}

module.exports = {
  applyOutstandingSettlement
};
