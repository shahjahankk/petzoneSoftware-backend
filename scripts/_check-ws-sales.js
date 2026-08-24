require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { pool } = require('../config/database');

(async () => {
  const [tables] = await pool.execute("SHOW TABLES LIKE '%sale%'");
  console.log(
    'Tables:',
    tables.map((t) => Object.values(t)[0])
  );

  for (const tbl of ['warehouse_sales', 'warehouse_sale_items']) {
    try {
      const [r] = await pool.execute(`SELECT COUNT(*) c FROM ${tbl}`);
      console.log(tbl, 'count', r[0].c);
    } catch (e) {
      console.log(tbl, 'N/A');
    }
  }

  const [ws] = await pool.execute(
    `SELECT id, deleted_at FROM warehouse_sales WHERE id IN (390,394,398,402,407,412) LIMIT 10`
  );
  console.log('warehouse_sales rows:', ws);

  const [allSi] = await pool.execute(
    `SELECT SUM(si.quantity) q FROM sale_items si WHERE si.inventory_item_id = 2408`
  );
  console.log('sale_items total for 2408 (incl deleted sales):', allSi[0].q);

  const [allSi2] = await pool.execute(
    `SELECT SUM(si.quantity) q FROM sale_items si
     INNER JOIN sales s ON s.id = si.sale_id
     WHERE si.inventory_item_id = 2408`
  );
  console.log('sale_items with any sales join:', allSi2[0].q);

  await pool.end();
})();
