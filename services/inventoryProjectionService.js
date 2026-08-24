/**
 * Projection layer — ONLY module that may execute UPDATE inventory_items.current_stock.
 * inventory_items.current_stock is cache/projection from inventory_ledger_entries.
 *
 * DO NOT WRITE DIRECTLY — LEDGER OWNS THIS VALUE (via applyEvent / rebuildItemStock).
 *
 * @module services/inventoryProjectionService
 */
const { pool } = require('../config/database');
const InventoryLedger = require('./inventoryLedgerService');
const ALLOWED_EVENT_TYPES = new Set([
  'SALE',
  'PURCHASE',
  'RETURN',
  'RESTOCK',
  'TRANSFER_OUT',
  'TRANSFER_IN',
  'ADJUSTMENT',
]);

function normalizeExecutor(connectionOrPool) {
  if (!connectionOrPool || typeof connectionOrPool.execute !== 'function') {
    throw new Error('[inventoryProjection] invalid executor');
  }
  return connectionOrPool;
}

function validateEventType(eventType) {
  if (!ALLOWED_EVENT_TYPES.has(String(eventType || '').toUpperCase())) {
    throw new Error(
      `[inventoryProjection] invalid event_type for applyEvent: ${eventType}. Allowed: ${Array.from(ALLOWED_EVENT_TYPES).join(
        ', '
      )}`
    );
  }
}

/**
 * Full replay: SUM ledger scoped to item row, write cache once.
 *
 * @param {number} inventoryItemId
 * @param {object} [executor]
 * @returns {Promise<number>} projected on-hand quantity
 */
async function rebuildItemStock(inventoryItemId, executor = pool) {
  const ex = normalizeExecutor(executor);
  const qty = await InventoryLedger.getCurrentStock(inventoryItemId, ex);
  const [upd] = await ex.execute('/*stock_write_allowed*/ UPDATE inventory_items SET current_stock = ? WHERE id = ?', [
    qty,
    inventoryItemId,
  ]);
  if (!upd || upd.affectedRows !== 1) {
    throw new Error(`[inventoryProjection] rebuildItemStock: item ${inventoryItemId} not found`);
  }
  return qty;
}

/**
 * Incremental cache update from one logical event (same deltas as one ledger row).
 *
 * @param {object} executor
 * @param {object} event
 * @param {number} event.inventory_item_id
 * @param {number} [event.quantity_in]
 * @param {number} [event.quantity_out]
 */
async function applyLedgerEvent(executor, event) {
  const ex = normalizeExecutor(executor);
  const qIn = Number(event.quantity_in) || 0;
  const qOut = Number(event.quantity_out) || 0;
  const net = qIn - qOut;
  const id = event.inventory_item_id;
  if (!id) throw new Error('[inventoryProjection] applyLedgerEvent: inventory_item_id required');

  const [upd] = await ex.execute(
    '/*stock_write_allowed*/ UPDATE inventory_items SET current_stock = current_stock + ? WHERE id = ?',
    [net, id]
  );
  if (!upd || upd.affectedRows !== 1) {
    throw new Error(`[inventoryProjection] applyLedgerEvent: update failed for item ${id}`);
  }
  return net;
}

/**
 * REQUIRED mutation pattern:
 * BEGIN -> ledger append -> cache update -> COMMIT
 * Any failure rolls back all stock changes.
 *
 * @returns {Promise<object>} combined appendEntry result + projected net applied
 */
async function applyEvent(connectionOrPool, params) {
  validateEventType(params?.event_type);

  // Existing transaction (connection): participate, no nested BEGIN/COMMIT.
  if (connectionOrPool && typeof connectionOrPool.beginTransaction === 'function') {
    const conn = normalizeExecutor(connectionOrPool);
    const result = await InventoryLedger.appendEntry(conn, params);
    if (result.idempotent) return { ...result, projected: false };
    await applyLedgerEvent(conn, {
      inventory_item_id: params.inventory_item_id,
      quantity_in: params.quantity_in,
      quantity_out: params.quantity_out,
    });
    return { ...result, projected: true };
  }

  // Pool (or unspecified): create dedicated transaction.
  const source = connectionOrPool || pool;
  if (typeof source.getConnection !== 'function') {
    throw new Error('[inventoryProjection] applyEvent requires pool or active connection');
  }
  const conn = await source.getConnection();
  try {
    await conn.beginTransaction();
    const result = await InventoryLedger.appendEntry(conn, params);
    if (!result.idempotent) {
      await applyLedgerEvent(conn, {
        inventory_item_id: params.inventory_item_id,
        quantity_in: params.quantity_in,
        quantity_out: params.quantity_out,
      });
    }
    await conn.commit();
    return { ...result, projected: !result.idempotent };
  } catch (err) {
    try {
      await conn.rollback();
    } catch (_) {}
    throw err;
  } finally {
    conn.release();
  }
}

/** Alias for admin repair scripts (batch rebuild). */
async function syncCacheFromLedger(executor, inventoryItemId) {
  return rebuildItemStock(inventoryItemId, executor);
}

module.exports = {
  rebuildItemStock,
  applyLedgerEvent,
  applyEvent,
  // Backward-compatible alias while refactoring callers.
  appendAndProject: applyEvent,
  syncCacheFromLedger,
};
