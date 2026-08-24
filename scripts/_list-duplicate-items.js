require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const fs = require('fs');
const path = require('path');
const { pool } = require('../config/database');

(async () => {
  const scopeFilter = process.argv.includes('--all-scopes') ? '' : "AND i.scope_type = 'WAREHOUSE'";

  const [groups] = await pool.execute(`
    SELECT
      LOWER(TRIM(i.name)) AS name_key,
      MIN(i.name) AS sample_name,
      i.scope_type,
      i.scope_id,
      COUNT(*) AS duplicate_count
    FROM inventory_items i
    WHERE i.deleted_at IS NULL
      ${scopeFilter}
    GROUP BY LOWER(TRIM(i.name)), i.scope_type, i.scope_id
    HAVING duplicate_count > 1
    ORDER BY duplicate_count DESC, sample_name
  `);

  const rows = [];
  for (const g of groups) {
    const [items] = await pool.execute(
      `SELECT id, name, sku, current_stock, cost_price, selling_price,
              scope_type, scope_id, supplier_name, purchase_date, created_at
       FROM inventory_items
       WHERE deleted_at IS NULL
         AND LOWER(TRIM(name)) = ?
         AND scope_type = ?
         AND scope_id = ?
       ORDER BY id`,
      [g.name_key, g.scope_type, g.scope_id]
    );

    for (const item of items) {
      const [po] = await pool.execute(
        `SELECT COALESCE(SUM(poi.quantity_received), 0) AS purchased
         FROM purchase_order_items poi
         INNER JOIN purchase_orders po ON po.id = poi.purchase_order_id
           AND po.deleted_at IS NULL AND po.status = 'COMPLETED'
         WHERE poi.inventory_item_id = ?`,
        [item.id]
      );
      const [sold] = await pool.execute(
        `SELECT COALESCE(SUM(quantity_out), 0) AS sold
         FROM inventory_ledger_entries
         WHERE inventory_item_id = ? AND event_type = 'SALE'`,
        [item.id]
      );
      const [ledger] = await pool.execute(
        `SELECT COALESCE(SUM(quantity_in - quantity_out), 0) AS ledger_stock
         FROM inventory_ledger_entries
         WHERE inventory_item_id = ?`,
        [item.id]
      );

      rows.push({
        name: item.name,
        name_key: g.name_key,
        duplicate_count: g.duplicate_count,
        id: item.id,
        sku: item.sku,
        current_stock: parseFloat(item.current_stock),
        ledger_stock: parseFloat(ledger[0].ledger_stock),
        purchased: parseFloat(po[0].purchased),
        sold: parseFloat(sold[0].sold),
        cost_price: parseFloat(item.cost_price),
        selling_price: parseFloat(item.selling_price),
        scope: `${item.scope_type}/${item.scope_id}`,
        supplier: item.supplier_name,
        purchase_date: item.purchase_date,
        created_at: item.created_at,
      });
    }
  }

  const outJson = path.join(__dirname, 'duplicate-items-report.json');
  const outTxt = path.join(__dirname, 'duplicate-items-report.txt');

  const summary = {
    generated_at: new Date().toISOString(),
    duplicate_name_groups: groups.length,
    duplicate_item_rows: rows.length,
    scope: scopeFilter ? 'WAREHOUSE only' : 'all scopes',
    groups: groups.map((g) => ({
      name: g.sample_name,
      scope: `${g.scope_type}/${g.scope_id}`,
      count: g.duplicate_count,
      ids: rows.filter((r) => r.name_key === g.name_key && r.scope === `${g.scope_type}/${g.scope_id}`).map((r) => r.id),
    })),
    items: rows,
  };

  fs.writeFileSync(outJson, JSON.stringify(summary, null, 2));

  let txt = `Duplicate inventory items (${groups.length} name groups, ${rows.length} rows)\n`;
  txt += `Generated: ${summary.generated_at}\n\n`;
  for (const g of groups) {
    const groupRows = rows.filter(
      (r) => r.name_key === g.name_key && r.scope === `${g.scope_type}/${g.scope_id}`
    );
    txt += `${g.sample_name} [${g.scope_type}/${g.scope_id}] x${g.duplicate_count}\n`;
    for (const r of groupRows) {
      txt += `  id=${r.id} sku=${r.sku || '-'} stock=${r.current_stock} ledger=${r.ledger_stock} po=${r.purchased} sold=${r.sold}\n`;
    }
    txt += '\n';
  }
  fs.writeFileSync(outTxt, txt);

  console.log(`Duplicate name groups: ${groups.length}`);
  console.log(`Total duplicate rows: ${rows.length}`);
  console.log(`Report: ${outTxt}`);
  console.log(`JSON:   ${outJson}\n`);

  groups.slice(0, 20).forEach((g) => {
    const ids = rows
      .filter((r) => r.name_key === g.name_key && r.scope === `${g.scope_type}/${g.scope_id}`)
      .map((r) => `${r.id}(${r.current_stock})`)
      .join(', ');
    console.log(`  "${g.sample_name}" ${g.scope_type}/${g.scope_id} x${g.duplicate_count} → ids: ${ids}`);
  });
  if (groups.length > 20) console.log(`  ... and ${groups.length - 20} more groups`);

  await pool.end();
})().catch(async (e) => {
  console.error(e.message);
  try {
    await pool.end();
  } catch (_) {}
  process.exit(1);
});
