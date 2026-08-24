require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { pool } = require('../config/database');
(async () => {
  const [r] = await pool.execute(
    `SELECT id, sku, name, current_stock FROM inventory_items
     WHERE deleted_at IS NULL AND scope_type='WAREHOUSE' AND scope_id='2'
       AND (LOWER(name) LIKE '%whiskas%' OR LOWER(name) LIKE '%felicia%' OR LOWER(name) LIKE '%jungle%' OR LOWER(name) LIKE '%pawfect%' OR LOWER(name) LIKE '%paw %')
     ORDER BY name`
  );
  console.log('count', r.length);
  r.forEach((x) => console.log(`${x.id}\t${x.sku}\t${x.current_stock}\t${x.name}`));
  await pool.end();
})();
