/**
 * Immutable event log — sole source of truth for quantity movements.
 * inventory_items.current_stock is NOT written here; see inventoryProjectionService (cache only).
 *
 * @module services/inventoryLedgerService
 */
const crypto = require('crypto');
const { pool } = require('../config/database');
const { allowsNegativeStock } = require('../config/inventory');

const EVENT_TYPES = new Set([
  'OPENING',
  'PURCHASE',
  'SALE',
  'RETURN',
  'RESTOCK',
  'TRANSFER_IN',
  'TRANSFER_OUT',
  'ADJUSTMENT',
]);

function normalizeScope(scopeType) {
  const u = String(scopeType || '').toUpperCase();
  return u === 'BRANCH' ? 'BRANCH' : 'WAREHOUSE';
}

function normalizeExecutor(connectionOrPool) {
  if (!connectionOrPool || typeof connectionOrPool.execute !== 'function') {
    throw new Error('[inventoryLedger] invalid executor (expected connection or pool)');
  }
  return connectionOrPool;
}

/**
 * Single writer for stock mutations.
 *
 * @param {object} connectionOrPool - mysql2 pool or connection (same transaction)
 * @param {object} params
 * @returns {Promise<{ ok: boolean, idempotent?: boolean, event_id: string, net: number }>}
 */
async function appendEntry(connectionOrPool, params) {
  const executor = normalizeExecutor(connectionOrPool);
  const {
    event_type,
    inventory_item_id,
    scope_type,
    scope_id,
    quantity_in = 0,
    quantity_out = 0,
    reference_type = 'adjustment',
    reference_id,
    unit_cost = null,
    entry_date = null,
    created_by = null,
    event_id = null,
  } = params;

  if (!event_type || !EVENT_TYPES.has(event_type)) {
    throw new Error(`[inventoryLedger] invalid event_type: ${event_type}`);
  }
  if (!inventory_item_id) {
    throw new Error('[inventoryLedger] inventory_item_id required');
  }

  const qIn = Number(quantity_in) || 0;
  const qOut = Number(quantity_out) || 0;
  const net = qIn - qOut;
  const st = normalizeScope(scope_type);
  const sid = scope_id != null && scope_id !== '' ? String(scope_id) : null;
  if (!st || !['BRANCH', 'WAREHOUSE'].includes(st)) {
    throw new Error(`[inventoryLedger] invalid scope_type: ${scope_type}`);
  }

  const [invRows] = await executor.execute(
    'SELECT id, scope_type, scope_id FROM inventory_items WHERE id = ?',
    [inventory_item_id]
  );
  if (!invRows || invRows.length === 0) {
    throw new Error(`[inventoryLedger] inventory item ${inventory_item_id} not found`);
  }
  const inv = invRows[0];
  const rowSt = normalizeScope(inv.scope_type);
  const rowSid = inv.scope_id != null ? String(inv.scope_id) : '';
  const sidNorm = sid || '';
  if (rowSt !== st || rowSid !== sidNorm) {
    throw new Error(
      `[inventoryLedger] scope mismatch item ${inventory_item_id}: row ${rowSt}/${rowSid} vs entry ${st}/${sidNorm}`
    );
  }

  const allowNeg = allowsNegativeStock();
  const ledgerOnHand = await getCurrentStock(inventory_item_id, executor);
  if (!allowNeg && ledgerOnHand + net < -1e-9) {
    throw new Error(
      `[inventoryLedger] negative stock blocked (ledger): item ${inventory_item_id} onHand=${ledgerOnHand} net=${net}`
    );
  }

  const eid = event_id || crypto.randomUUID().replace(/-/g, '').slice(0, 32);
  const refT = String(reference_type);
  const refI =
    reference_id != null && reference_id !== ''
      ? String(reference_id)
      : `${refT}:${eid}`;

  const ed = entry_date instanceof Date ? entry_date : entry_date ? new Date(entry_date) : new Date();

  let insertId = null;
  try {
    const [insResult] = await executor.execute(
      `INSERT INTO inventory_ledger_entries (
        event_id, event_type, inventory_item_id, scope_type, scope_id,
        quantity_in, quantity_out, reference_type, reference_id, unit_cost, entry_date, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        eid,
        event_type,
        inventory_item_id,
        st,
        sidNorm || null,
        qIn,
        qOut,
        refT,
        refI,
        unit_cost != null ? Number(unit_cost) : null,
        ed,
        created_by != null ? created_by : null,
      ]
    );
    insertId = insResult.insertId;
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY' || e.errno === 1062) {
      return { ok: true, idempotent: true, event_id: eid, net: 0, insertId: null };
    }
    throw e;
  }

  return {
    ok: true,
    idempotent: false,
    event_id: eid,
    net,
    insertId,
    row: {
      event_type,
      inventory_item_id,
      scope_type: st,
      scope_id: sidNorm || null,
      quantity_in: qIn,
      quantity_out: qOut,
      reference_type: refT,
      reference_id: refI,
    },
  };
}

/** Sum on-hand from ledger scoped to the inventory row (scope columns must match row). */
async function getCurrentStock(inventoryItemId, executor = pool) {
  const [rows] = await executor.execute(
    `SELECT COALESCE(SUM(le.quantity_in - le.quantity_out), 0) AS qty
     FROM inventory_ledger_entries le
     INNER JOIN inventory_items i ON i.id = le.inventory_item_id
       AND le.scope_type = i.scope_type
       AND (CAST(le.scope_id AS CHAR) = CAST(i.scope_id AS CHAR))
     WHERE le.inventory_item_id = ?`,
    [inventoryItemId]
  );
  return parseFloat(rows[0]?.qty) || 0;
}

async function getItemSummary(inventoryItemId, executor = pool) {
  const [rows] = await executor.execute(
    `SELECT
       COALESCE(SUM(le.quantity_in - le.quantity_out), 0) AS current_stock,
       COALESCE(SUM(CASE WHEN le.event_type IN ('PURCHASE') THEN le.quantity_in ELSE 0 END), 0) AS purchased,
       COALESCE(SUM(CASE WHEN le.event_type IN ('OPENING') THEN le.quantity_in ELSE 0 END), 0) AS opening,
       COALESCE(SUM(CASE WHEN le.event_type IN ('SALE') THEN le.quantity_out ELSE 0 END), 0) AS sold,
       COALESCE(SUM(CASE WHEN le.event_type IN ('RETURN') THEN le.quantity_in ELSE 0 END), 0) AS returned_raw,
       COALESCE(SUM(CASE WHEN le.event_type IN ('RESTOCK') THEN le.quantity_in ELSE 0 END), 0) AS restocked,
       COALESCE(SUM(CASE WHEN le.event_type IN ('TRANSFER_IN') THEN le.quantity_in ELSE 0 END), 0) AS transfer_in,
       COALESCE(SUM(CASE WHEN le.event_type IN ('TRANSFER_OUT') THEN le.quantity_out ELSE 0 END), 0) AS transfer_out,
       COALESCE(SUM(CASE WHEN le.event_type IN ('ADJUSTMENT') THEN le.quantity_in ELSE 0 END), 0) AS adjustment_in,
       COALESCE(SUM(CASE WHEN le.event_type IN ('ADJUSTMENT') THEN le.quantity_out ELSE 0 END), 0) AS adjustment_out
     FROM inventory_ledger_entries le
     INNER JOIN inventory_items i ON i.id = le.inventory_item_id
       AND le.scope_type = i.scope_type
       AND (CAST(le.scope_id AS CHAR) = CAST(i.scope_id AS CHAR))
     WHERE le.inventory_item_id = ?`,
    [inventoryItemId]
  );

  const r = rows[0] || {};
  const adjustmentsNet =
    (parseFloat(r.adjustment_in) || 0) - (parseFloat(r.adjustment_out) || 0);

  return {
    current_stock: parseFloat(r.current_stock) || 0,
    /** PURCHASE events only (OPENING tracked separately). */
    purchased: parseFloat(r.purchased) || 0,
    opening: parseFloat(r.opening) || 0,
    purchase_orders: parseFloat(r.purchased) || 0,
    sold: parseFloat(r.sold) || 0,
    returned: parseFloat(r.returned_raw) || 0,
    restocked: parseFloat(r.restocked) || 0,
    transfer_in: parseFloat(r.transfer_in) || 0,
    transfer_out: parseFloat(r.transfer_out) || 0,
    adjustments: adjustmentsNet,
  };
}

async function getBatchItemSummaries(inventoryItemIds, executor = pool) {
  if (!inventoryItemIds || inventoryItemIds.length === 0) return new Map();
  const placeholders = inventoryItemIds.map(() => '?').join(',');
  const [rows] = await executor.execute(
    `SELECT
       le.inventory_item_id,
       COALESCE(SUM(le.quantity_in - le.quantity_out), 0) AS current_stock,
       COALESCE(SUM(CASE WHEN le.event_type IN ('PURCHASE') THEN le.quantity_in ELSE 0 END), 0) AS purchase_orders,
       COALESCE(SUM(CASE WHEN le.event_type IN ('OPENING') THEN le.quantity_in ELSE 0 END), 0) AS opening,
       COALESCE(SUM(CASE WHEN le.event_type IN ('SALE') THEN le.quantity_out ELSE 0 END), 0) AS sold,
       COALESCE(SUM(CASE WHEN le.event_type IN ('RETURN') THEN le.quantity_in ELSE 0 END), 0) AS returned_raw,
       COALESCE(SUM(CASE WHEN le.event_type IN ('RESTOCK') THEN le.quantity_in ELSE 0 END), 0) AS restocked,
       COALESCE(SUM(CASE WHEN le.event_type IN ('TRANSFER_IN') THEN le.quantity_in ELSE 0 END), 0) AS transfer_in,
       COALESCE(SUM(CASE WHEN le.event_type IN ('TRANSFER_OUT') THEN le.quantity_out ELSE 0 END), 0) AS transfer_out,
       COALESCE(SUM(CASE WHEN le.event_type IN ('ADJUSTMENT') THEN le.quantity_in ELSE 0 END), 0) AS adjustment_in,
       COALESCE(SUM(CASE WHEN le.event_type IN ('ADJUSTMENT') THEN le.quantity_out ELSE 0 END), 0) AS adjustment_out
     FROM inventory_ledger_entries le
     INNER JOIN inventory_items i ON i.id = le.inventory_item_id
       AND le.scope_type = i.scope_type
       AND (CAST(le.scope_id AS CHAR) = CAST(i.scope_id AS CHAR))
     WHERE le.inventory_item_id IN (${placeholders})
     GROUP BY le.inventory_item_id`,
    inventoryItemIds
  );

  const map = new Map();
  for (const r of rows) {
    const id = r.inventory_item_id;
    const opening = parseFloat(r.opening) || 0;
    const po = parseFloat(r.purchase_orders) || 0;
    const adjustmentNet =
      (parseFloat(r.adjustment_in) || 0) - (parseFloat(r.adjustment_out) || 0);
    map.set(id, {
      current_stock: parseFloat(r.current_stock) || 0,
      /** PURCHASE sum only; OPENING is in `opening`. */
      purchased: po,
      opening,
      purchase_orders: po,
      sold: parseFloat(r.sold) || 0,
      returned: parseFloat(r.returned_raw) || 0,
      restocked: parseFloat(r.restocked) || 0,
      transfer_in: parseFloat(r.transfer_in) || 0,
      transfer_out: parseFloat(r.transfer_out) || 0,
      adjustments: adjustmentNet,
    });
  }
  return map;
}

/**
 * Reusable subquery: scoped net qty per inventory_item_id (matches appendEntry scope rules).
 * Use as: FROM inventory_items i LEFT JOIN (${ledgerScopedQuantitySubquery()}) l ON i.id = l.inventory_item_id
 */
function ledgerScopedQuantitySubquery() {
  return `(
    SELECT le.inventory_item_id,
           SUM(le.quantity_in - le.quantity_out) AS ledger_qty
    FROM inventory_ledger_entries le
    INNER JOIN inventory_items ix ON ix.id = le.inventory_item_id
      AND le.scope_type = ix.scope_type
      AND (CAST(le.scope_id AS CHAR) COLLATE utf8mb4_bin = CAST(ix.scope_id AS CHAR) COLLATE utf8mb4_bin)
    GROUP BY le.inventory_item_id
  )`;
}

module.exports = {
  appendEntry,
  getCurrentStock,
  getItemSummary,
  getBatchItemSummaries,
  ledgerScopedQuantitySubquery,
  EVENT_TYPES,
  normalizeScope,
};
