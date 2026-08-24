const { pool } = require('../config/database');
const inventoryRebuildService = require('./inventoryRebuildService');

async function tryWriteDriftLog(executor, row, corrected) {
  try {
    await executor.execute(
      `INSERT INTO inventory_drift_logs
       (item_id, scope, expected_stock, actual_stock, corrected, created_at)
       VALUES (?, ?, ?, ?, ?, NOW())`,
      [row.item_id, row.scope, row.ledger_stock, row.cached_stock, corrected ? 1 : 0]
    );
  } catch (_) {
    // Optional table: silently ignore if absent.
  }
}

async function checkItem(itemId, scope = null, executor = pool) {
  const ex = executor && typeof executor.execute === 'function' ? executor : pool;
  const id = Number(itemId);
  if (!Number.isFinite(id) || id <= 0) {
    throw new Error('[inventoryDriftDetector] itemId must be a positive number');
  }

  const [rows] = await ex.execute(
    `SELECT
       i.id AS item_id,
       i.scope_type,
       i.scope_id,
       COALESCE(i.current_stock, 0) AS cached_stock,
       COALESCE(SUM(le.quantity_in - le.quantity_out), 0) AS ledger_stock
     FROM inventory_items i
     LEFT JOIN inventory_ledger_entries le
       ON le.inventory_item_id = i.id
      AND le.scope_type = i.scope_type
      AND (CAST(le.scope_id AS CHAR) = CAST(i.scope_id AS CHAR))
     WHERE i.id = ?
     GROUP BY i.id, i.scope_type, i.scope_id, i.current_stock`,
    [id]
  );
  if (!rows.length) {
    throw new Error(`[inventoryDriftDetector] inventory item not found: ${id}`);
  }

  const r = rows[0];
  if (
    scope &&
    (String(scope.scope_type || '').toUpperCase() !== String(r.scope_type || '').toUpperCase() ||
      String(scope.scope_id ?? '') !== String(r.scope_id ?? ''))
  ) {
    throw new Error(
      `[inventoryDriftDetector] scope mismatch for item ${id}: expected ${r.scope_type}:${r.scope_id}`
    );
  }

  const output = {
    item_id: Number(r.item_id),
    scope: `${r.scope_type}-${r.scope_id}`,
    ledger_stock: Number(r.ledger_stock || 0),
    cached_stock: Number(r.cached_stock || 0),
    drift: Number(r.ledger_stock || 0) - Number(r.cached_stock || 0),
  };

  if (output.drift !== 0) {
    const autoHeal = String(process.env.INVENTORY_AUTO_HEAL || 'true').toLowerCase() === 'true';
    if (autoHeal) {
      const rebuilt = await inventoryRebuildService.rebuildStock(id, {
        scope_type: r.scope_type,
        scope_id: r.scope_id,
      }, ex);
      await tryWriteDriftLog(ex, output, true);
      return { ...output, healed: true, healed_stock: rebuilt.rebuilt_stock };
    }
    await tryWriteDriftLog(ex, output, false);
  }

  return output;
}

module.exports = {
  checkItem,
};
