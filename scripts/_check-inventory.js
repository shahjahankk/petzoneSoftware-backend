require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { pool } = require('../config/database');

(async () => {
  const [tables] = await pool.execute("SHOW TABLES LIKE 'inventory%'");
  const tableNames = tables.map((t) => Object.values(t)[0]);
  console.log('Inventory tables:', tableNames.join(', '));

  const [counts] = await pool.execute(`
    SELECT
      COUNT(*) AS total_items,
      SUM(CASE WHEN deleted_at IS NULL THEN 1 ELSE 0 END) AS active_items,
      SUM(CASE WHEN deleted_at IS NOT NULL THEN 1 ELSE 0 END) AS deleted_items,
      SUM(CASE WHEN deleted_at IS NULL AND current_stock <= 0 THEN 1 ELSE 0 END) AS zero_or_negative_stock,
      SUM(CASE WHEN deleted_at IS NULL AND current_stock > 0 THEN 1 ELSE 0 END) AS in_stock
    FROM inventory_items
  `);
  console.log('\ninventory_items summary:');
  console.log(counts[0]);

  const [byScope] = await pool.execute(`
    SELECT scope_type, scope_id,
      COUNT(*) AS items,
      SUM(CASE WHEN deleted_at IS NULL THEN 1 ELSE 0 END) AS active,
      ROUND(SUM(CASE WHEN deleted_at IS NULL THEN current_stock ELSE 0 END), 2) AS total_stock
    FROM inventory_items
    GROUP BY scope_type, scope_id
    ORDER BY scope_type, scope_id
  `);
  console.log('\nBy scope:');
  byScope.forEach((r) => console.log(`  ${r.scope_type}/${r.scope_id}: active=${r.active} total_stock=${r.total_stock}`));

  const [dupes] = await pool.execute(`
    SELECT LOWER(TRIM(name)) AS name_key, scope_type, scope_id, COUNT(*) AS c
    FROM inventory_items
    WHERE deleted_at IS NULL
    GROUP BY LOWER(TRIM(name)), scope_type, scope_id
    HAVING c > 1
    ORDER BY c DESC, name_key
    LIMIT 15
  `);
  console.log(`\nDuplicate names (active, top 15): ${dupes.length}`);
  dupes.forEach((r) => console.log(`  "${r.name_key}" ${r.scope_type}/${r.scope_id} x${r.c}`));

  const [sample] = await pool.execute(`
    SELECT id, name, sku, scope_type, scope_id, current_stock, selling_price, deleted_at
    FROM inventory_items
    WHERE deleted_at IS NULL
    ORDER BY updated_at DESC
    LIMIT 10
  `);
  console.log('\nLatest 10 active items:');
  sample.forEach((r) => {
    console.log(`  ${r.id} ${r.sku || '-'} | ${r.name} | stock=${r.current_stock} | ${r.scope_type}/${r.scope_id}`);
  });

  const [ledgerCount] = await pool.execute('SELECT COUNT(*) AS c FROM inventory_ledger_entries');
  console.log('\ninventory_ledger_entries rows:', ledgerCount[0].c);

  await pool.end();
})().catch(async (e) => {
  console.error(e.message);
  try { await pool.end(); } catch (_) {}
  process.exit(1);
});
