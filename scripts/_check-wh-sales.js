require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { pool } = require('../config/database');

(async () => {
  const [sales] = await pool.execute(`
    SELECT id, invoice_no, scope_type, scope_id, total, created_at
    FROM sales WHERE scope_type = 'WAREHOUSE' AND (deleted_at IS NULL OR deleted_at = '0000-00-00 00:00:00')
    ORDER BY id DESC LIMIT 5
  `);
  console.log('Recent warehouse sales:');
  sales.forEach((s) => console.log(`  ${s.invoice_no} scope_id=${s.scope_id} total=${s.total}`));

  const [scopeMismatch] = await pool.execute(`
    SELECT s.id, s.invoice_no, s.scope_id AS sale_scope, ii.id AS item_id, ii.name, ii.scope_id AS item_scope
    FROM sales s
    JOIN sale_items si ON si.sale_id = s.id
    JOIN inventory_items ii ON ii.id = si.inventory_item_id
    WHERE s.scope_type = 'WAREHOUSE'
      AND ii.scope_type = 'WAREHOUSE'
      AND s.scope_id != CAST(ii.scope_id AS CHAR)
      AND (s.deleted_at IS NULL OR s.deleted_at = '0000-00-00 00:00:00')
    ORDER BY s.id DESC LIMIT 10
  `);
  console.log(`\nSales where scope_id is numeric id vs warehouse name mismatch: ${scopeMismatch.length} (sample)`);
  scopeMismatch.slice(0, 3).forEach((r) => console.log(`  ${r.invoice_no}: sale_scope="${r.sale_scope}" item_scope="${r.item_scope}"`));

  const [nameMismatch] = await pool.execute(`
    SELECT s.id, s.invoice_no, s.scope_id AS sale_scope, w.name AS wh_name, w.id AS wh_id
    FROM sales s
    LEFT JOIN warehouses w ON w.name = s.scope_id OR CAST(w.id AS CHAR) = s.scope_id
    WHERE s.scope_type = 'WAREHOUSE'
    ORDER BY s.id DESC LIMIT 5
  `);
  console.log('\nScope id resolution:');
  nameMismatch.forEach((r) => console.log(`  ${r.invoice_no}: scope_id="${r.sale_scope}" -> wh ${r.wh_id} ${r.wh_name}`));

  await pool.end();
})().catch(async (e) => {
  console.error(e);
  await pool.end();
  process.exit(1);
});
