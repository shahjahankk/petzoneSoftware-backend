require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { pool } = require('../config/database');

(async () => {
  const terms = [
    'urinary',
    'digest chicken 12',
    'kitten dry chicken 1-12 12',
    'catch of the day',
    'jungle adult dry chicken fish 15',
    'jungle creamy treat chic',
  ];
  for (const t of terms) {
    const [r] = await pool.execute(
      `SELECT id, sku, name, current_stock FROM inventory_items
       WHERE deleted_at IS NULL AND scope_type='WAREHOUSE' AND scope_id='2'
         AND LOWER(name) LIKE ? ORDER BY name`,
      [`%${t}%`]
    );
    console.log(`\n"${t}" (${r.length})`);
    r.forEach((x) => console.log(`  ${x.id} ${x.sku} stock=${x.current_stock} | ${x.name}`));
  }
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
