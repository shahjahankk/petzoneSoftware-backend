/**
 * Inventory behaviour flags (env-driven).
 *
 * INVENTORY_ALLOW_NEGATIVE_STOCK:
 *   true / 1  — allow sales & adjustments below zero (default)
 *   false / 0 — block ledger entries that would go negative
 */
function allowsNegativeStock() {
  const flag = String(process.env.INVENTORY_ALLOW_NEGATIVE_STOCK ?? 'true')
    .trim()
    .toLowerCase();
  if (flag === 'false' || flag === '0' || flag === 'no') return false;
  return true;
}

module.exports = {
  allowsNegativeStock,
};
