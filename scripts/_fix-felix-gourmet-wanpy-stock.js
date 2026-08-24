require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { pool } = require('../config/database');
const InventoryProjection = require('../services/inventoryProjectionService');
const InventoryLedger = require('../services/inventoryLedgerService');

/** Unit 6 Warehouse — explicit item id → target qty */
const TARGETS = [
  { itemId: 2397, label: 'Felix Orignal Lamb 85 g', target: 24 },
  { itemId: 1886, label: 'Felix Pouch Original Chicken jelly 85g', target: 408 },
  { itemId: 1887, label: 'Felix Cat Pouch Original Salmon Jelly 85g', target: 168 },
  { itemId: 1911, label: 'Goumet pouch perle with Beef 85g', target: 52 },
  { itemId: 1912, label: 'Goumet Pouch Perle With Chicken 85g', target: 104 },
  { itemId: 1913, label: 'Goumet Pouch Perle With Duo Salmon&Saithe 85g', target: 0 },
  { itemId: 1714, label: 'Wanpy Meat Paste Duck&Pumpkin 90g', target: 0 },
  { itemId: 1717, label: 'Wanpy Meat Paste Chicken & Carrot 90g', target: 310 },
];

const WAREHOUSE_ID = 2;
const CREATED_BY = 3;
const REF_PREFIX = 'manual_stock_fix:felix_gourmet_wanpy:v1';

async function getLedgerStock(itemId, conn = pool) {
  const stock = await InventoryLedger.getCurrentStock(itemId, conn);
  return parseFloat(stock) || 0;
}

async function setStock(itemId, targetQty, dryRun) {
  const [rows] = await pool.execute(
    `SELECT id, name, sku, current_stock, scope_type, scope_id
     FROM inventory_items
     WHERE id = ? AND deleted_at IS NULL`,
    [itemId]
  );
  if (!rows.length) throw new Error(`Item ${itemId} not found`);
  const item = rows[0];
  if (String(item.scope_type).toUpperCase() !== 'WAREHOUSE' || String(item.scope_id) !== String(WAREHOUSE_ID)) {
    throw new Error(`Item ${itemId} is not in Unit 6 Warehouse (got ${item.scope_type}/${item.scope_id})`);
  }

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
            scope_type: 'WAREHOUSE',
            scope_id: String(item.scope_id ?? WAREHOUSE_ID),
            quantity_in: delta,
            quantity_out: 0,
            reference_type: 'manual_stock_fix',
            reference_id: refId,
            created_by: CREATED_BY,
          }
        : {
            event_type: 'ADJUSTMENT',
            inventory_item_id: itemId,
            scope_type: 'WAREHOUSE',
            scope_id: String(item.scope_id ?? WAREHOUSE_ID),
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
  console.log(dryRun ? '*** DRY RUN (pass --fix to apply) ***\n' : '*** APPLY STOCK FIX — Unit 6 Warehouse ***\n');

  const results = [];
  for (const t of TARGETS) {
    const r = await setStock(t.itemId, t.target, dryRun);
    results.push({ ...t, ...r });
    console.log(`${t.label} (id=${t.itemId}, sku=${r.item.sku})`);
    console.log(`  Target: ${t.target} | Before: ${r.before} | Delta: ${r.delta}${r.skipped ? ' | SKIPPED (already correct)' : ''}`);
    if (!dryRun && !r.skipped) console.log(`  After:  ${r.after}`);
    console.log('');
  }

  if (!dryRun) {
    console.log('Verification (cache vs ledger):');
    for (const r of results) {
      if (r.skipped) {
        console.log(`  ${r.label}: ${r.before} (unchanged)`);
        continue;
      }
      const [row] = await pool.execute('SELECT current_stock FROM inventory_items WHERE id = ?', [r.itemId]);
      const ledger = await getLedgerStock(r.itemId);
      console.log(`  ${r.label}: cache=${row[0].current_stock} ledger=${ledger} target=${r.target}`);
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
