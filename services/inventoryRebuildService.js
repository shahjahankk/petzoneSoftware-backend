const { pool } = require('../config/database');

/**
 * Rebuild cache from ledger truth for one item/scope.
 * No business rules here: aggregate ledger, then write cache.
 */
async function rebuildStock(itemId, scope = null, executor = pool) {
  const id = Number(itemId);
  if (!Number.isFinite(id) || id <= 0) {
    throw new Error('[inventoryRebuild] itemId must be a positive number');
  }

  const ex = executor && typeof executor.execute === 'function' ? executor : pool;
  const [itemRows] = await ex.execute(
    'SELECT id, scope_type, scope_id FROM inventory_items WHERE id = ? LIMIT 1',
    [id]
  );
  if (!itemRows.length) {
    throw new Error(`[inventoryRebuild] inventory item not found: ${id}`);
  }

  const item = itemRows[0];
  if (
    scope &&
    (String(scope.scope_type || '').toUpperCase() !== String(item.scope_type || '').toUpperCase() ||
      String(scope.scope_id ?? '') !== String(item.scope_id ?? ''))
  ) {
    throw new Error(
      `[inventoryRebuild] scope mismatch for item ${id}: expected ${item.scope_type}:${item.scope_id}`
    );
  }

  const [sumRows] = await ex.execute(
    `SELECT COALESCE(SUM(le.quantity_in - le.quantity_out), 0) AS ledger_stock
     FROM inventory_ledger_entries le
     WHERE le.inventory_item_id = ?
       AND le.scope_type = ?
       AND (CAST(le.scope_id AS CHAR) = CAST(? AS CHAR))`,
    [id, item.scope_type, item.scope_id]
  );
  const ledgerStock = Number(sumRows[0]?.ledger_stock || 0);

  await ex.execute('/*stock_write_allowed*/ UPDATE inventory_items SET current_stock = ? WHERE id = ?', [
    ledgerStock,
    id,
  ]);

  return {
    item_id: id,
    scope: `${item.scope_type}-${item.scope_id}`,
    rebuilt_stock: ledgerStock,
  };
}

module.exports = {
  rebuildStock,
};
