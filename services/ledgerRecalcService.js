const { pool } = require('../config/database');
const { LEDGER_SORT_AT_BARE } = require('../utils/ledgerSortAtSql');
const { isLedgerMigrationComplete } = require('./ledgerMigrationMeta');

/**
 * LEGACY / DISABLED IN PRODUCTION WHEN MIGRATED
 * ─────────────────────────────────────────────
 * When admin_settings.ledger_migration_completed = 1, this module MUST NOT mutate
 * sales.old_balance / sales.running_balance (caller returns immediately).
 * Financial truth is SUM(customer_ledger_entries.debit - credit) only.
 */

/**
 * Recalculate the complete running balance chain for a customer/retailer
 * within a specific scope, ordered by posting time: created_at ASC, id ASC.
 *
 * Legacy path only (when ledger migration not complete). Used after edits/deletes
 * that change amounts — not for reordering by business date.
 *
 * @param {object} params
 * @param {number|null} params.retailerId - retailer_id (warehouse customers)
 * @param {string|null} params.customerPhone - phone (branch walk-in customers)
 * @param {string|null} params.customerName - name (fallback if no phone)
 * @param {string} params.scopeType - 'BRANCH' | 'WAREHOUSE'
 * @param {string} params.scopeName - the scope_id string stored in sales table
 * @param {object|null} params.connection - existing DB connection (for transactions)
 * if null, uses pool directly
 */
const recalculateCustomerLedger = async ({
  retailerId,
  customerPhone,
  customerName,
  scopeType,
  scopeName,
  connection = null
}) => {
  const db = connection || pool;

  if (await isLedgerMigrationComplete(db)) {
    return { success: true, updated: 0, skipped: true };
  }

  // Step 1: Fetch ALL records for this customer in this scope
  // ordered chronologically - this is the source of truth order
  let whereClause = '';
  let params = [];

  if (retailerId) {
    // Warehouse retailer - strict match by retailer_id
    whereClause = `retailer_id = ? AND scope_type = ? AND scope_id = ?`;
    params = [retailerId, scopeType, scopeName];
  } else if (customerPhone && customerPhone.trim().length > 0) {
    // Branch walk-in - match by phone within scope (phone is unique key within scope)
    whereClause = `customer_phone = ? AND scope_type = ? AND scope_id = ?`;
    params = [customerPhone.trim(), scopeType, scopeName];
  } else if (customerName && customerName.trim().length > 0) {
    // Last resort - name match within scope
    whereClause = `LOWER(TRIM(customer_name)) = LOWER(TRIM(?)) AND scope_type = ? AND scope_id = ?`;
    params = [customerName.trim(), scopeType, scopeName];
  } else {
    return { success: false, message: 'No customer identifier provided' };
  }

  const [records] = await db.execute(
    `SELECT id, total, payment_amount, credit_amount, payment_type, payment_method,
            old_balance, running_balance, sale_date, created_at
     FROM sales
     WHERE ${whereClause}
       AND deleted_at IS NULL
     ORDER BY ${LEDGER_SORT_AT_BARE} ASC, id ASC`,
    params
  );

  if (records.length === 0) {
    return { success: true, updated: 0 };
  }

  // Step 2: Walk through records and recalculate each row
  let runningBalance = 0;
  const updates = [];

  for (const record of records) {
    const oldBalance = runningBalance; // previous row's running_balance

    const total = parseFloat(record.total) || 0;
    const paymentAmount = parseFloat(record.payment_amount) || 0;
    const creditAmount = parseFloat(record.credit_amount) || 0;
    const paymentType = record.payment_type || '';
    const paymentMethod = record.payment_method || '';

    let newRunningBalance;

    if (paymentType === 'OUTSTANDING_SETTLEMENT') {
      // Settlement: reduces balance by payment_amount
      newRunningBalance = oldBalance - paymentAmount;
    } else if (paymentType === 'BILTY_CHARGE') {
      // Bilty: increases balance by total (the charge amount)
      newRunningBalance = oldBalance + total;
    } else if (paymentMethod === 'REFUND' && paymentType === 'REFUND') {
      // Return: reduces balance by abs(total) since total is negative
      newRunningBalance = oldBalance + total; // total is negative, so this reduces
    } else if (paymentType === 'CREDIT_REFUND_SETTLEMENT') {
      // Credit refund reduces what retailer owes (negative balance becomes less negative)
      newRunningBalance = oldBalance - paymentAmount;
    } else {
      // Regular sale: balance increases by credit_amount (unpaid portion)
      // running_balance = old_balance + total - payment_amount
      newRunningBalance = oldBalance + total - paymentAmount;
    }

    // Round to 2 decimal places to avoid floating point drift
    newRunningBalance = parseFloat(newRunningBalance.toFixed(2));

    updates.push({
      id: record.id,
      old_balance: parseFloat(oldBalance.toFixed(2)),
      running_balance: newRunningBalance
    });

    runningBalance = newRunningBalance;
  }

  // Step 3: Batch update all records
  // Only update rows where values actually changed (avoid unnecessary writes)
  let updatedCount = 0;
  for (const update of updates) {
    const existing = records.find((r) => r.id === update.id);
    const oldBalanceChanged = parseFloat(existing.old_balance) !== update.old_balance;
    const runningBalanceChanged = parseFloat(existing.running_balance) !== update.running_balance;

    if (oldBalanceChanged || runningBalanceChanged) {
      await db.execute(
        `UPDATE sales
         SET old_balance = ?, running_balance = ?, updated_at = NOW()
         WHERE id = ?`,
        [update.old_balance, update.running_balance, update.id]
      );
      updatedCount++;
    }
  }


  return {
    success: true,
    total: records.length,
    updated: updatedCount,
    finalBalance: runningBalance
  };
};

module.exports = { recalculateCustomerLedger };
