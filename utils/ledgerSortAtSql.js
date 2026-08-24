/**
 * Ledger ordering for `sales` rows: posting order only (time-stable, ERP-safe).
 * `sale_date` must NOT affect ORDER BY — use it only in SELECT/WHERE for reporting.
 *
 * All ORDER BY clauses for customer ledger views must use these expressions.
 */

/** Guard for accidental reintroduction of business-date ordering in queries. */
const ledgerOrderUsesBusinessDate = false;

if (
  process.env.NODE_ENV === 'development' &&
  ledgerOrderUsesBusinessDate
) {
}

function sortAtForTableAlias(alias) {
  return `${alias}.created_at`;
}

/** `sales` table, no alias (subqueries on `sales`). */
const LEDGER_SORT_AT_BARE = 'created_at';

module.exports = {
  LEDGER_SORT_AT_BARE,
  LEDGER_SORT_AT_S: sortAtForTableAlias('s'),
  LEDGER_SORT_AT_S2: sortAtForTableAlias('s2'),
  ledgerOrderUsesBusinessDate,
};
