require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { pool } = require('../config/database');
const inventoryRebuildService = require('../services/inventoryRebuildService');

/** keep = survivor (billing SKU), retire = duplicate to soft-delete */
const MERGE_PAIRS = [
  { name: 'Balls', keep: 2763, retire: 1822 },
  { name: 'Royal Canin Gastrointestinal 400g', keep: 1539, retire: 2753 },
  { name: 'Royal Canin Hair & Skin Care 2 KG', keep: 1535, retire: 2759 },
  { name: 'Royal Canin Jelly Instintcive 85G', keep: 1543, retire: 2755 },
  { name: 'Royal Canin jelly Sensitive pouch', keep: 2409, retire: 2760 },
  { name: 'Royal Canin Maxi Adult 15 KG', keep: 1554, retire: 2757 },
  { name: 'Royal Canin Maxi puppy 15 KG', keep: 1553, retire: 2758 },
  { name: 'Royal Canin Maxi Starter  15 KG', keep: 1551, retire: 2761 },
  { name: 'Royal Canin Persian Adult 10 KG', keep: 1569, retire: 2750 },
  { name: 'Royal Canin Persian Adult 2 KG', keep: 1567, retire: 2752 },
  { name: 'Royal Canin Persian Adult 4 KG', keep: 1568, retire: 2751 },
  { name: 'Royal Canin Renal Liquid', keep: 1573, retire: 2756 },
];

const REF_TABLES = [
  { table: 'sale_items', col: 'inventory_item_id' },
  { table: 'sales_return_items', col: 'inventory_item_id' },
  { table: 'purchase_order_items', col: 'inventory_item_id' },
  { table: 'inventory_ledger_entries', col: 'inventory_item_id' },
  { table: 'transfer_items', col: 'inventory_item_id' },
  { table: 'stock_reports', col: 'inventory_item_id' },
];

async function tableExists(conn, table) {
  const [rows] = await conn.execute(
    `SELECT 1 FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? LIMIT 1`,
    [table]
  );
  return rows.length > 0;
}

async function countRefs(conn, table, col, itemId) {
  if (!(await tableExists(conn, table))) return 0;
  const [rows] = await conn.execute(`SELECT COUNT(*) AS c FROM \`${table}\` WHERE \`${col}\` = ?`, [itemId]);
  return parseInt(rows[0].c, 10);
}

async function getItem(conn, id) {
  const [rows] = await conn.execute(
    `SELECT id, name, sku, current_stock, scope_type, scope_id, deleted_at FROM inventory_items WHERE id = ?`,
    [id]
  );
  return rows[0] || null;
}

async function mergePair(conn, pair, dryRun) {
  const keep = await getItem(conn, pair.keep);
  const retire = await getItem(conn, pair.retire);
  if (!keep) throw new Error(`${pair.name}: keep id ${pair.keep} not found`);
  if (!retire) throw new Error(`${pair.name}: retire id ${pair.retire} not found`);
  if (keep.deleted_at) throw new Error(`${pair.name}: keep id ${pair.keep} is deleted`);
  if (retire.deleted_at) throw new Error(`${pair.name}: retire id ${pair.retire} already deleted`);

  const before = {
    keep_stock: parseFloat(keep.current_stock),
    retire_stock: parseFloat(retire.current_stock),
    refs: {},
  };
  for (const { table, col } of REF_TABLES) {
    before.refs[table] = await countRefs(conn, table, col, pair.retire);
  }

  const [saleInvoicesBefore] = await conn.execute(
    `SELECT COUNT(DISTINCT sale_id) AS c FROM sale_items WHERE inventory_item_id IN (?, ?)`,
    [pair.keep, pair.retire]
  );

  if (dryRun) {
    return {
      ...pair,
      keep_sku: keep.sku,
      retire_sku: retire.sku,
      before,
      sale_invoices_combined: parseInt(saleInvoicesBefore[0].c, 10),
      action: 'DRY_RUN',
    };
  }

  // 1) Repoint all FK references retire → keep
  for (const { table, col } of REF_TABLES) {
    if (!(await tableExists(conn, table))) continue;
    const n = before.refs[table];
    if (n > 0) {
      await conn.execute(`UPDATE \`${table}\` SET \`${col}\` = ? WHERE \`${col}\` = ?`, [pair.keep, pair.retire]);
    }
  }

  // 2) Normalize sale_items sku/name on keeper (all invoices show same item)
  await conn.execute(`UPDATE sale_items SET sku = ?, name = ? WHERE inventory_item_id = ?`, [
    keep.sku,
    keep.name,
    pair.keep,
  ]);

  // 3) Normalize PO line names/skus where linked
  if (await tableExists(conn, 'purchase_order_items')) {
    await conn.execute(
      `UPDATE purchase_order_items SET item_sku = ?, item_name = ? WHERE inventory_item_id = ?`,
      [keep.sku, keep.name, pair.keep]
    );
  }

  // 4) Rebuild stock from combined ledger on keeper
  const rebuilt = await inventoryRebuildService.rebuildStock(pair.keep, null, conn);

  // 5) Zero and soft-delete retire row
  await conn.execute('/*stock_write_allowed*/ UPDATE inventory_items SET current_stock = 0 WHERE id = ?', [
    pair.retire,
  ]);
  await conn.execute(`UPDATE inventory_items SET deleted_at = NOW(), updated_at = NOW() WHERE id = ?`, [pair.retire]);

  const [saleInvoicesAfter] = await conn.execute(
    `SELECT COUNT(DISTINCT sale_id) AS c, COALESCE(SUM(quantity), 0) AS qty
     FROM sale_items si
     INNER JOIN sales s ON s.id = si.sale_id AND s.deleted_at IS NULL
     WHERE si.inventory_item_id = ?`,
    [pair.keep]
  );

  const [retireRefsAfter] = await conn.execute(
    `SELECT COUNT(*) AS c FROM sale_items WHERE inventory_item_id = ?`,
    [pair.retire]
  );

  return {
    ...pair,
    keep_sku: keep.sku,
    retire_sku: retire.sku,
    before,
    after: {
      keep_stock: rebuilt.rebuilt_stock,
      sale_invoices: parseInt(saleInvoicesAfter[0].c, 10),
      sale_qty: parseFloat(saleInvoicesAfter[0].qty),
      retire_sale_refs_left: parseInt(retireRefsAfter[0].c, 10),
    },
    action: 'MERGED',
  };
}

(async () => {
  const dryRun = !process.argv.includes('--fix');
  console.log(dryRun ? '*** DRY RUN (pass --fix to apply) ***\n' : '*** APPLY MERGE ***\n');

  const conn = await pool.getConnection();
  const results = [];

  try {
    if (!dryRun) await conn.beginTransaction();

    for (const pair of MERGE_PAIRS) {
      const result = await mergePair(conn, pair, dryRun);
      results.push(result);
      console.log(`${pair.name}`);
      console.log(`  KEEP ${result.keep} (${result.keep_sku}) ← RETIRE ${result.retire} (${result.retire_sku})`);
      if (dryRun) {
        console.log(`  Refs to move: ${JSON.stringify(result.before.refs)}`);
        console.log(`  Combined invoices now: ${result.sale_invoices_combined}`);
      } else {
        console.log(`  Stock after rebuild: ${result.after.keep_stock}`);
        console.log(`  Invoices on keeper: ${result.after.sale_invoices} (qty ${result.after.sale_qty})`);
        console.log(`  Retire sale refs left: ${result.after.retire_sale_refs_left}`);
      }
      console.log('');
    }

    if (!dryRun) {
      await conn.commit();
      console.log('All merges committed.\n');
    }

    // Verify no duplicate names remain
    const [dupes] = await conn.execute(`
      SELECT LOWER(TRIM(name)) AS nk, COUNT(*) AS c
      FROM inventory_items
      WHERE deleted_at IS NULL AND scope_type = 'WAREHOUSE' AND scope_id = 2
      GROUP BY LOWER(TRIM(name))
      HAVING c > 1
    `);
    console.log(`Remaining duplicate names in WH/2: ${dupes.length}`);

    const fs = require('fs');
    const out = require('path').join(__dirname, 'duplicate-merge-result.json');
    fs.writeFileSync(
      out,
      JSON.stringify({ dryRun, merged_at: new Date().toISOString(), results, remaining_dupes: dupes }, null, 2)
    );
    console.log(`Saved: ${out}`);
  } catch (e) {
    if (!dryRun) await conn.rollback();
    console.error('FAILED:', e.message);
    process.exitCode = 1;
  } finally {
    conn.release();
    await pool.end();
  }
})();
