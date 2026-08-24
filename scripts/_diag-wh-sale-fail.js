require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { pool } = require('../config/database');

(async () => {
  const [retailers] = await pool.execute(
    `SELECT id, name, phone, credit_limit, credit_balance, warehouse_id, status
     FROM retailers WHERE name LIKE '%Ahtesham%' OR phone LIKE '%3378319234%'`
  );
  console.log('Retailer:', JSON.stringify(retailers, null, 2));

  const [items] = await pool.execute(
    `SELECT id, name, sku, current_stock, scope_type, scope_id
     FROM inventory_items
     WHERE deleted_at IS NULL AND name LIKE '%Nourvet%Fish%Brown%1kg%'
     LIMIT 5`
  );
  console.log('\nItem:', JSON.stringify(items, null, 2));

  if (retailers[0]) {
    const r = retailers[0];
    const limit = parseFloat(r.credit_limit) || 0;
    const bal = parseFloat(r.credit_balance) || 0;
    const available = limit > 0 ? limit + bal : 'no limit check';
    console.log(`\nCredit check for 20000 sale: limit=${limit} balance=${bal} available=${available}`);
    if (limit > 0 && 20000 > limit + bal) {
      console.log('>>> WOULD FAIL: Credit amount exceeds available credit limit');
    }
  }

  const [keepers] = await pool.execute(
    `SELECT id, username, role, warehouse_id FROM users WHERE role = 'WAREHOUSE_KEEPER' OR warehouse_id = 2`
  );
  console.log('\nWarehouse keepers:', JSON.stringify(keepers, null, 2));

  await pool.end();
})().catch(async (e) => {
  console.error('DB error:', e.code, e.message);
  await pool.end();
  process.exit(1);
});
