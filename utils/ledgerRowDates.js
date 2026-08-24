/**
 * Adds display-only fields for customer ledger rows without changing ordering or balances.
 * invoiceDate = business date (YYYY-MM-DD); postedAt = sale row creation time.
 */

function toYmd(val) {
  if (val == null || val === '') return null;
  if (val instanceof Date) {
    if (Number.isNaN(val.getTime())) return null;
    return val.toISOString().slice(0, 10);
  }
  const s = String(val).trim();
  if (s.length >= 10 && /^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/**
 * @param {object} t Transaction row (sales join or normalized shape)
 */
function enrichLedgerTransactionRow(t) {
  if (!t || typeof t !== 'object') return t;
  const saleDate = t.sale_date ?? t.saleDate;
  const ledgerEntryDate = t.ledger_entry_date ?? t.entry_date;
  const invoiceDate =
    toYmd(saleDate) ||
    toYmd(ledgerEntryDate) ||
    toYmd(t.transaction_date) ||
    null;
  const postedAt = t.created_at ?? t.postedAt ?? null;
  const date = t.date ?? t.transaction_date ?? invoiceDate ?? postedAt;

  return {
    ...t,
    invoiceDate,
    postedAt,
    date,
  };
}

module.exports = {
  enrichLedgerTransactionRow,
  toYmd,
};
