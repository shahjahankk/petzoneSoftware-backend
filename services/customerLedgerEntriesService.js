/**
 * Immutable append-only customer sub-ledger (source of truth for AR balance in scope).
 * Balance owed (customer perspective): SUM(debit - credit) per scope + party.
 */
const { LEDGER_SORT_AT_BARE } = require('../utils/ledgerSortAtSql');
const { isLedgerMigrationComplete } = require('./ledgerMigrationMeta');

/**
 * Posting instant for `customer_ledger_entries.entry_date` — always matches sale row creation time.
 * Business / invoice date stays on `sales.sale_date` for reporting only.
 */
function entryDateFromSaleRow(row) {
  if (row.created_at) return new Date(row.created_at);
  return new Date();
}

function classifyRefType(row) {
  const pt = row.payment_type || '';
  const pm = row.payment_method || '';
  if (pt === 'OUTSTANDING_SETTLEMENT' || pt === 'CREDIT_REFUND_SETTLEMENT') return 'SETTLEMENT';
  if (pt === 'BILTY_CHARGE') return 'EXPENSE';
  if (pm === 'REFUND' && pt === 'REFUND') return 'RETURN';
  return 'SALE';
}

function debitCreditForSaleRow(row) {
  const ref = classifyRefType(row);
  const subtotal = parseFloat(row.subtotal) || 0;
  const total = parseFloat(row.total) || 0;
  const payment = parseFloat(row.payment_amount) || 0;

  if (ref === 'SETTLEMENT') {
    if (row.payment_type === 'CREDIT_REFUND_SETTLEMENT') {
      const p = Math.abs(payment);
      return { refType: 'SETTLEMENT', debit: 0, credit: p };
    }
    return { refType: 'SETTLEMENT', debit: 0, credit: Math.abs(payment) };
  }
  if (ref === 'RETURN') {
    const mag = Math.abs(total || subtotal);
    return { refType: 'RETURN', debit: 0, credit: mag };
  }
  if (ref === 'EXPENSE') {
    const amt = Math.abs(total || subtotal);
    return { refType: 'EXPENSE', debit: amt, credit: 0 };
  }
  // Invoice financial leg: debit = invoice total, credit = cash/collected on this document
  const debitAmt = Math.abs(total) > 0 ? total : subtotal;
  return { refType: 'SALE', debit: debitAmt, credit: payment };
}

async function ledgerRowCountForParty(conn, party, scopeType, scopeName) {
  const p = buildPartyClause(party.retailerId, party.customerPhone, party.customerName);
  const [r] = await conn.execute(
    `SELECT COUNT(*) AS c FROM customer_ledger_entries
     WHERE scope_type = ? AND scope_id = ? AND (${p.sql})`,
    [scopeType, String(scopeName), ...p.params]
  );
  return r[0]?.c || 0;
}

/**
 * Party filter matches typical sales customer resolution (warehouse retailer vs walk-in).
 */
function buildPartyClause(retailerId, customerPhone, customerName) {
  if (retailerId != null && retailerId !== '') {
    return {
      sql: 'retailer_id = ?',
      params: [parseInt(retailerId, 10)],
    };
  }
  return {
    sql: `(TRIM(LOWER(IFNULL(customer_name,''))) = TRIM(LOWER(?)) AND TRIM(IFNULL(customer_phone,'')) = TRIM(?))`,
    params: [customerName || '', customerPhone || ''],
  };
}

/**
 * Authoritative AR balance for a party in a scope: SUM(debit − credit) on customer_ledger_entries only.
 * Call sites must not substitute sales.running_balance when ledger_migration_completed = 1.
 */
async function getCustomerBalance(conn, { scopeType, scopeId, retailerId, customerName, customerPhone }) {
  const party = buildPartyClause(retailerId, customerPhone, customerName);
  const [rows] = await conn.execute(
    `SELECT COALESCE(SUM(debit - credit), 0) AS bal
     FROM customer_ledger_entries
     WHERE scope_type = ? AND scope_id = ? AND ${party.sql}`,
    [scopeType, String(scopeId), ...party.params]
  );
  return parseFloat(rows[0]?.bal) || 0;
}

/**
 * AR balance for warehouse retailer search: includes ledger rows keyed by retailer_id
 * AND settlement rows that were posted before retailer_id was stored on the sale (retailer_id IS NULL but same name/phone).
 */
async function getScopePartyBalanceForRetailer(conn, { scopeType, scopeId, retailerId, customerName, customerPhone }) {
  const rid = retailerId != null && retailerId !== '' ? parseInt(retailerId, 10) : NaN;
  if (Number.isNaN(rid)) {
    return getCustomerBalance(conn, { scopeType, scopeId, retailerId: null, customerName, customerPhone });
  }
  const phone = (customerPhone || '').trim();
  const name = (customerName || '').trim();
  const [rows] = await conn.execute(
    `SELECT COALESCE(SUM(debit - credit), 0) AS bal
     FROM customer_ledger_entries
     WHERE scope_type = ? AND scope_id = ?
       AND (
         retailer_id = ?
         OR (
           retailer_id IS NULL
           AND TRIM(IFNULL(customer_phone,'')) <=> TRIM(?)
           AND LOWER(TRIM(IFNULL(customer_name,''))) = LOWER(TRIM(?))
         )
       )`,
    [scopeType, String(scopeId), rid, phone, name]
  );
  return parseFloat(rows[0]?.bal) || 0;
}

/**
 * Balance from ledger entries with created_at strictly before `beforeExclusive` (MySQL datetime).
 * Use for time-cutoff tools only — new sales use getCustomerBalance (no business-date as-of).
 */
async function getCustomerBalanceAsOf(
  conn,
  { scopeType, scopeId, retailerId, customerName, customerPhone },
  beforeExclusive
) {
  if (process.env.DISABLE_BALANCE_AS_OF === 'true') {
    throw new Error('getCustomerBalanceAsOf is disabled for POS safety');
  }
  const party = buildPartyClause(retailerId, customerPhone, customerName);
  const params = [scopeType, String(scopeId), ...party.params];
  let sql = `SELECT COALESCE(SUM(debit - credit), 0) AS bal
     FROM customer_ledger_entries
     WHERE scope_type = ? AND scope_id = ? AND ${party.sql}`;
  if (beforeExclusive != null) {
    sql += ` AND created_at < ?`;
    params.push(beforeExclusive);
  }
  const [rows] = await conn.execute(sql, params);
  return parseFloat(rows[0]?.bal) || 0;
}

async function appendEntry(conn, row) {
  const {
    customer_id = null,
    retailer_id = null,
    customer_name = null,
    customer_phone = null,
    scope_type,
    scope_id,
    ref_type,
    ref_id,
    debit,
    credit,
    entry_date,
  } = row;

  const normalizedRefType = String(ref_type || 'SALE').toUpperCase();

  await conn.execute(
    `INSERT INTO customer_ledger_entries (
      customer_id, retailer_id, customer_name, customer_phone,
      scope_type, scope_id, ref_type, ref_id, debit, credit, entry_date
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      debit = VALUES(debit),
      credit = VALUES(credit),
      entry_date = VALUES(entry_date),
      customer_name = VALUES(customer_name),
      customer_phone = VALUES(customer_phone),
      retailer_id = VALUES(retailer_id),
      customer_id = VALUES(customer_id)`,
    [
      customer_id,
      retailer_id,
      customer_name,
      customer_phone,
      scope_type,
      String(scope_id),
      normalizedRefType,
      ref_id,
      debit,
      credit,
      entry_date,
    ]
  );
}

/**
 * Idempotent append from a sales row (one ledger line per sale id).
 */
async function appendFromSalesRow(conn, saleRow) {
  const { refType, debit, credit } = debitCreditForSaleRow(saleRow);
  const entryDate = entryDateFromSaleRow(saleRow);
  await appendEntry(conn, {
    customer_id: saleRow.customer_id ?? null,
    retailer_id: saleRow.retailer_id ?? null,
    customer_name: saleRow.customer_name ?? null,
    customer_phone: saleRow.customer_phone ?? null,
    scope_type: saleRow.scope_type,
    scope_id: saleRow.scope_id,
    ref_type: refType,
    ref_id: saleRow.id,
    debit,
    credit,
    entry_date: entryDate,
  });
}

async function insertInvoiceSnapshot(conn, payload) {
  const {
    sale_id,
    customer_id = null,
    retailer_id = null,
    scope_type,
    scope_id,
    invoice_no,
    old_balance,
    total,
    payment,
    final_balance,
  } = payload;
  await conn.execute(
    `INSERT INTO invoice_snapshots (
      sale_id, customer_id, retailer_id, scope_type, scope_id, invoice_no,
      old_balance, total, payment, final_balance
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      invoice_no = VALUES(invoice_no),
      old_balance = VALUES(old_balance),
      total = VALUES(total),
      payment = VALUES(payment),
      final_balance = VALUES(final_balance)`,
    [
      sale_id,
      customer_id,
      retailer_id,
      scope_type,
      String(scope_id),
      invoice_no,
      old_balance,
      total,
      payment,
      final_balance,
    ]
  );
}

/**
 * Pre-migration: prefers customer_ledger_entries when present, else latest sales.running_balance.
 * Post-migration (ledger_migration_completed = 1): ONLY getCustomerBalance (SUM debit−credit); never reads sales.
 */
async function getBalanceWithFallback(conn, party, scopeType, scopeName) {
  if (await isLedgerMigrationComplete(conn)) {
    return getCustomerBalance(conn, {
      scopeType,
      scopeId: scopeName,
      retailerId: party.retailerId,
      customerName: party.customerName,
      customerPhone: party.customerPhone,
    });
  }

  const n = await ledgerRowCountForParty(conn, party, scopeType, scopeName);
  if (n > 0) {
    return getCustomerBalance(conn, {
      scopeType,
      scopeId: scopeName,
      retailerId: party.retailerId,
      customerName: party.customerName,
      customerPhone: party.customerPhone,
    });
  }
  let q = `SELECT running_balance FROM sales WHERE deleted_at IS NULL AND scope_type = ? AND scope_id = ?`;
  const params = [scopeType, scopeName];
  if (party.retailerId) {
    q += ` AND retailer_id = ? ORDER BY ${LEDGER_SORT_AT_BARE} DESC, id DESC LIMIT 1`;
    params.push(party.retailerId);
  } else if (party.customerPhone) {
    q += ` AND (customer_phone = ? AND LOWER(TRIM(customer_name)) = LOWER(TRIM(?))) ORDER BY ${LEDGER_SORT_AT_BARE} DESC, id DESC LIMIT 1`;
    params.push(party.customerPhone, party.customerName || '');
  } else {
    return 0;
  }
  const [rows] = await conn.execute(q, params);
  return parseFloat(rows[0]?.running_balance) || 0;
}

module.exports = {
  entryDateFromSaleRow,
  classifyRefType,
  debitCreditForSaleRow,
  appendEntry,
  appendFromSalesRow,
  insertInvoiceSnapshot,
  getCustomerBalance,
  getScopePartyBalanceForRetailer,
  getCustomerBalanceAsOf,
  getBalanceWithFallback,
  ledgerRowCountForParty,
  buildPartyClause,
};
