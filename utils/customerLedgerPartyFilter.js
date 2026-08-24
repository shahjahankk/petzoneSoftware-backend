/**
 * Warehouse retailer ids are small numeric PKs; customer phones are longer digit strings.
 * e.g. phone 943877733 must not be treated as retailer_id 943877733.
 */
function isRetailerIdToken(id) {
  const trimmed = String(id || '').trim();
  if (!/^\d+$/.test(trimmed)) return false;
  const rid = parseInt(trimmed, 10);
  return Number.isFinite(rid) && rid > 0 && String(rid) === trimmed && trimmed.length <= 5;
}

/**
 * Flexible customer party match for ledger queries (name, phone, JSON, retailer id).
 */
function appendCustomerPartyFilter(whereParts, params, customerId, aliases = { sales: 's', entry: 'e' }) {
  const id = String(customerId || '').trim();
  if (!id || id === '__all__' || id === 'all') return;

  const s = aliases.sales;
  const e = aliases.entry;

  if (isRetailerIdToken(id)) {
    const rid = parseInt(id, 10);
    if (e) {
      whereParts.push(`(${s}.retailer_id = ? OR ${e}.retailer_id = ?)`);
      params.push(rid, rid);
    } else {
      whereParts.push(`${s}.retailer_id = ?`);
      params.push(rid);
    }
    return;
  }

  const entryClause = e
    ? `OR LOWER(TRIM(${e}.customer_name)) = LOWER(TRIM(?))
    OR TRIM(IFNULL(${e}.customer_phone, '')) = TRIM(?)`
    : '';
  whereParts.push(`(
    LOWER(TRIM(${s}.customer_name)) = LOWER(TRIM(?))
    OR TRIM(IFNULL(${s}.customer_phone, '')) = TRIM(?)
    ${entryClause}
    OR LOWER(TRIM(JSON_UNQUOTE(JSON_EXTRACT(${s}.customer_info, '$.name')))) = LOWER(TRIM(?))
    OR TRIM(JSON_UNQUOTE(JSON_EXTRACT(${s}.customer_info, '$.phone'))) = TRIM(?)
  )`);
  params.push(id, id);
  if (e) params.push(id, id);
  params.push(id, id);
}

function parseLedgerLimit(raw, defaultLimit = 1000, maxLimit = 5000) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return defaultLimit;
  return Math.min(n, maxLimit);
}

module.exports = { appendCustomerPartyFilter, parseLedgerLimit, isRetailerIdToken };
