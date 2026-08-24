require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { pool } = require('../config/database');
const InventoryProjection = require('../services/inventoryProjectionService');
const InventoryLedger = require('../services/inventoryLedgerService');

/** name pattern → target qty */
const TARGETS = [
  { match: /1\.2\s*kg/i, target: 55, label: 'Fluffy 1.2 kg' },
  { match: /400\s*g/i, target: 0, label: 'Fluffy 400g' },
];

const CREATED_BY = 3;
const REF_PREFIX = 'manual_stock_fix:v1';

async function getLedgerStock(itemId, conn = pool) {
  const stock = await InventoryLedger.getCurrentStock(itemId, conn);
  return parseFloat(stock) || 0;
}

async function setStock(itemId, targetQty, dryRun) {
  const [rows] = await pool.execute(
    `SELECT id, name, sku, current_stock, scope_type, scope_id FROM inventory_items WHERE id = ? AND deleted_at IS NULL`,
    [itemId]
  );
  if (!rows.length) throw new Error(`Item ${itemId} not found`);
  const item = rows[0];
  const before = await getLedgerStock(itemId);
  const delta = targetQty - before;

  if (Math.abs(delta) < 0.001) {
    return { item, before, after: before, delta: 0, skipped: true };
  }

  if (dryRun) {
    return { item, before, after: targetQty, delta, skipped: false, dryRun: true };
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const refId = `${REF_PREFIX}:${itemId}`;
    const params =
      delta > 0
        ? {
            event_type: 'ADJUSTMENT',
            inventory_item_id: itemId,
            scope_type: String(item.scope_type).toUpperCase(),
            scope_id: String(item.scope_id ?? ''),
            quantity_in: delta,
            quantity_out: 0,
            reference_type: 'manual_stock_fix',
            reference_id: refId,
            created_by: CREATED_BY,
          }
        : {
            event_type: 'ADJUSTMENT',
            inventory_item_id: itemId,
            scope_type: String(item.scope_type).toUpperCase(),
            scope_id: String(item.scope_id ?? ''),
            quantity_in: 0,
            quantity_out: Math.abs(delta),
            reference_type: 'manual_stock_fix',
            reference_id: refId,
            created_by: CREATED_BY,
          };
    await InventoryProjection.applyEvent(connection, params);
    await connection.commit();
  } catch (e) {
    await connection.rollback();
    throw e;
  } finally {
    connection.release();
  }

  const after = await getLedgerStock(itemId);
  return { item, before, after, delta, skipped: false };
}

(async () => {
  const dryRun = !process.argv.includes('--fix');
  console.log(dryRun ? '*** DRY RUN (pass --fix to apply) ***\n' : '*** APPLY STOCK FIX ***\n');

  const [fluffy] = await pool.execute(`
    SELECT id, name, sku, current_stock
    FROM inventory_items
    WHERE deleted_at IS NULL
      AND (name LIKE '%fluffy%' OR name LIKE '%Fluffy%')
    ORDER BY name
  `);

  const results = [];
  for (const t of TARGETS) {
    const item = fluffy.find((f) => t.match.test(f.name));
    if (!item) {
      console.log(`NOT FOUND: ${t.label}`);
      continue;
    }
    const r = await setStock(item.id, t.target, dryRun);
    results.push({ ...t, ...r });
    console.log(`${t.label} (id=${item.id} ${item.name})`);
    console.log(`  Before: ${r.before} → Target: ${t.target} (delta ${r.delta})`);
    if (!dryRun && !r.skipped) console.log(`  After:  ${r.after}`);
    console.log('');
  }

  if (!dryRun) {
    console.log('Verification:');
    for (const r of results) {
      if (r.skipped) continue;
      const [row] = await pool.execute('SELECT current_stock FROM inventory_items WHERE id = ?', [r.item.id]);
      console.log(`  ${r.label}: cache=${row[0].current_stock} ledger=${await getLedgerStock(r.item.id)}`);
    }
  }

  await pool.end();
})().catch(async (e) => {
  console.error('FAILED:', e.message);
  try {
    await pool.end();
  } catch (_) {}
  process.exit(1);
});
