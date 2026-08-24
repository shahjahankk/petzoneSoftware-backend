require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { pool } = require('../config/database');
(async () => {
  const [r] = await pool.execute(
    `SELECT id, sku, name, current_stock FROM inventory_items
     WHERE deleted_at IS NULL AND scope_type='WAREHOUSE' AND scope_id='2'
       AND LOWER(name) LIKE '%ocean%delight%' ORDER BY name`
  );
  r.forEach((x) => console.log(x.id, x.sku, x.current_stock, x.name));
  await pool.end();
})();
