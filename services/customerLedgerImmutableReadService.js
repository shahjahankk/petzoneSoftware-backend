/**
 * Immutable ledger read path: customer_ledger_entries + window cumulative balance.
 * Used only when admin_settings.ledger_migration_completed = 1.
 * Does not use normalizeLedgerTransactions or sales.running_balance for balances.
 */
const { LEDGER_SORT_AT_S } = require('../utils/ledgerSortAtSql');

/** One party per scope + phone + display name (omit retailer/customer id so NULL vs set id does not split the chain). */
const LEDGER_WINDOW_PARTITION = `
  e.scope_type, e.scope_id,
  TRIM(IFNULL(e.customer_phone, '')),
  TRIM(LOWER(IFNULL(e.customer_name, '')))
`;

function resolveNormalizedType(s) {
  const pt = s.payment_type || '';
  const pm = s.payment_method || '';
  if (pt === 'CREDIT_REFUND_SETTLEMENT') return 'CREDIT_REFUND_SETTLEMENT';
  if (pt === 'OUTSTANDING_SETTLEMENT') return 'SETTLEMENT';
  if (pt === 'BILTY_CHARGE') return 'BILTY';
  if (pm === 'REFUND' && pt === 'REFUND') return 'RETURN';
  return 'SALE';
}

/**
 * Map one joined row (sales + ledger amounts + cum_balance) to the same shape
 * as normalizeLedgerTransactions() for API compatibility.
 */
function mapJoinedRowToLedgerShape(row) {
  const s = row;
  const debit = parseFloat(row.ledger_row_debit) || 0;
  const credit = parseFloat(row.ledger_row_credit) || 0;
  const netDelta = debit - credit;
  const cumBalance = parseFloat(row.cum_balance) || 0;
  const oldBalance = cumBalance - netDelta;

  const paymentType = s.payment_type || '';
  const paymentMethod = s.payment_method || '';
  const normalizedType = resolveNormalizedType(s);

  const paidRaw = parseFloat(
    s.corrected_paid ?? s.paid_amount ?? s.payment_amount ?? 0
  ) || 0;
  const amountRaw =
    parseFloat(s.amount ?? s.subtotal ?? s.total ?? 0) || 0;

  let currentBillAmount = amountRaw;
  let actualPayment = paidRaw;

  if (paymentType === 'OUTSTANDING_SETTLEMENT' || normalizedType === 'SETTLEMENT') {
    currentBillAmount = 0;
    if (paymentMethod === 'FULLY_CREDIT') actualPayment = 0;
  } else if (paymentType === 'BILTY_CHARGE' || normalizedType === 'BILTY') {
    const biltyTotal =
      parseFloat(s.total) ||
      parseFloat(s.amount) ||
      parseFloat(s.subtotal) ||
      0;
    currentBillAmount = biltyTotal;
    actualPayment = 0;
  } else if (
    paymentType === 'CREDIT_REFUND_SETTLEMENT' ||
    normalizedType === 'CREDIT_REFUND_SETTLEMENT'
  ) {
    currentBillAmount = 0;
  } else if (
    normalizedType === 'RETURN' ||
    (paymentMethod === 'REFUND' && paymentType === 'REFUND')
  ) {
    // Returns are stored as negative totals on sales; display positive refund amount.
    currentBillAmount = Math.abs(amountRaw) || Math.abs(parseFloat(s.total) || 0);
    actualPayment = 0;
  } else {
    if (paymentMethod === 'FULLY_CREDIT' && paymentType !== 'OUTSTANDING_SETTLEMENT') {
      actualPayment = 0;
    } else if (credit > 0) {
      actualPayment = credit;
    }
    // Bill = ledger debit (invoice total); payment = ledger credit. Net (debit−credit) is balance delta only.
    if (debit > 0) {
      currentBillAmount = debit;
    } else {
      const totalNum = parseFloat(s.total);
      currentBillAmount =
        Number.isFinite(totalNum) && Math.abs(totalNum) > 1e-9 ? totalNum : amountRaw;
    }
  }

  const totalAmountDue = oldBalance + currentBillAmount;

  const {
    ledger_row_debit: _d,
    ledger_row_credit: _c,
    cum_balance: _cum,
    ...rest
  } = row;

  return {
    ...rest,
    payment_type: paymentType,
    transaction_type: normalizedType,
    old_balance: oldBalance,
    amount: currentBillAmount,
    total_amount: totalAmountDue,
    corrected_paid: actualPayment,
    paid_amount: actualPayment,
    running_balance: cumBalance,
    balance: cumBalance,
  };
}

function buildTransactionSelectSql() {
  return `
    e.id AS ledger_entry_id,
    e.debit AS ledger_row_debit,
    e.credit AS ledger_row_credit,
    SUM(e.debit - e.credit) OVER (
      PARTITION BY ${LEDGER_WINDOW_PARTITION}
      ORDER BY e.created_at ASC, e.id ASC
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ) AS cum_balance,
    s.id AS transaction_id,
    s.invoice_no,
    s.scope_type,
    s.scope_id,
    COALESCE(s.sale_date, s.created_at) AS transaction_date,
    s.created_at AS created_at,
    ${LEDGER_SORT_AT_S} AS sort_at,
    s.payment_method,
    s.payment_type,
    s.payment_status,
    s.payment_amount,
    s.credit_amount,
    s.subtotal,
    s.total,
    s.customer_name,
    s.customer_phone,
    s.customer_info,
    s.notes,
    s.status,
    u.username AS cashier_name,
    b.name AS branch_name,
    w.name AS warehouse_name,
    CASE
      WHEN s.payment_type = 'OUTSTANDING_SETTLEMENT' THEN 'SETTLEMENT'
      WHEN s.payment_type = 'CREDIT_REFUND_SETTLEMENT' THEN 'CREDIT_REFUND_SETTLEMENT'
      WHEN s.payment_type = 'BILTY_CHARGE' THEN 'BILTY'
      WHEN s.payment_method = 'REFUND' AND s.payment_type = 'REFUND' THEN 'RETURN'
      ELSE 'SALE'
    END AS transaction_type,
    s.payment_amount AS paid_amount,
    s.credit_amount AS credit_amount,
    s.subtotal AS amount,
    sr.id AS return_id,
    sr.reason AS return_reason,
    CASE
      WHEN s.payment_method = 'REFUND' THEN ABS(s.total)
      ELSE NULL
    END AS return_refund_amount
  `;
}

/**
 * @returns {{ sql: string, fromClause: string }}
 */
function ledgerJoinFromClause() {
  return {
    fromClause: `
    FROM customer_ledger_entries e
    INNER JOIN sales s ON s.id = e.ref_id AND s.deleted_at IS NULL
    LEFT JOIN sales_returns sr ON sr.original_sale_id = s.id OR sr.return_no = s.invoice_no
    LEFT JOIN users u ON s.user_id = u.id
    LEFT JOIN branches b ON s.scope_type = 'BRANCH' AND s.scope_id = b.name
    LEFT JOIN warehouses w ON s.scope_type = 'WAREHOUSE' AND s.scope_id = w.name
    `,
  };
}

async function queryLedgerTransactions(pool, whereClause, params, options = {}) {
  const {
    limit = null,
    offset = 0,
    orderDesc = true,
    orderByEntry = true,
  } = options;
  const { fromClause } = ledgerJoinFromClause();
  const orderDir = orderDesc ? 'DESC' : 'ASC';
  const orderSecondary = orderDesc ? 'DESC' : 'ASC';
  const orderExpr = orderByEntry
    ? `e.created_at ${orderDir}, e.id ${orderSecondary}`
    : `${LEDGER_SORT_AT_S} ${orderDir}, s.id ${orderSecondary}`;
  let sql = `
    SELECT ${buildTransactionSelectSql()}
    ${fromClause}
    ${whereClause || ''}
    ORDER BY ${orderExpr}
  `;
  const qparams = [...params];
  if (limit != null && Number.isFinite(Number(limit))) {
    sql += ` LIMIT ? OFFSET ?`;
    qparams.push(Number(limit), Number(offset) || 0);
  }
  const [rows] = await pool.execute(sql, qparams);
  return rows.map(mapJoinedRowToLedgerShape);
}

async function countLedgerTransactions(pool, whereClause, params) {
  const { fromClause } = ledgerJoinFromClause();
  const sql = `
    SELECT COUNT(*) AS total
    ${fromClause}
    ${whereClause || ''}
  `;
  const [rows] = await pool.execute(sql, params);
  const raw = rows[0]?.total ?? 0;
  return typeof raw === 'bigint' ? Number(raw) : parseInt(raw, 10) || 0;
}

/** Build OR clause for batch party filter (max ~80 parties per query). */
function buildPartyOrClause(parties, paramsOut) {
  if (!parties?.length) return { sql: '', params: [] };
  const parts = [];
  for (const p of parties) {
    parts.push(
      `(TRIM(LOWER(s.customer_name)) = TRIM(LOWER(?)) AND TRIM(IFNULL(s.customer_phone, '')) = TRIM(IFNULL(?, '')))`
    );
    paramsOut.push(p.name || '', p.phone || '');
  }
  return { sql: `(${parts.join(' OR ')})`, params: paramsOut };
}

function customerKeyFromRow(row) {
  const name = row.customer_name ?? '';
  const phone = row.customer_phone ?? '';
  return `${name}|${phone}`;
}

module.exports = {
  mapJoinedRowToLedgerShape,
  buildTransactionSelectSql,
  ledgerJoinFromClause,
  LEDGER_WINDOW_PARTITION,
  queryLedgerTransactions,
  countLedgerTransactions,
  buildPartyOrClause,
  customerKeyFromRow,
};
