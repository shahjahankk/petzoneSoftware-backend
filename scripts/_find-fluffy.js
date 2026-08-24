require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { pool } = require('../config/database');

(async () => {
  const [rows] = await pool.execute(`
    SELECT id, name, sku, current_stock, scope_type, scope_id
    FROM inventory_items
    WHERE deleted_at IS NULL
      AND (name LIKE '%Fluffy%' OR name LIKE '%fluffy%')
    ORDER BY name
  `);
  rows.forEach((r) =>
    console.log(`${r.id} | ${r.name} | ${r.sku} | stock=${r.current_stock} | ${r.scope_type}/${r.scope_id}`)
  );
  await pool.end();
})();
