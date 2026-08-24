require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { pool } = require('../config/database');

(async () => {
  const id = 2408;
  const [sales] = await pool.execute(
    `SELECT ile.reference_id, ile.quantity_out, ile.created_at
     FROM inventory_ledger_entries ile
     WHERE ile.inventory_item_id = ? AND ile.event_type = 'SALE'`,
    [id]
  );
  console.log('Ledger SALE entries for 2408:');
  sales.forEach((s) => console.log(s));

  const [si] = await pool.execute(
    `SELECT si.*, s.id AS sale_id, s.deleted_at
     FROM sale_items si
     LEFT JOIN sales s ON s.id = si.sale_id
     WHERE si.inventory_item_id = ? OR si.product_name LIKE '%Felicia%Urinary%12%'`,
    [id]
  );
  console.log('\nSale items rows:', si.length);
  si.slice(0, 5).forEach((r) => console.log(r));

  const [opening] = await pool.execute(
    `SELECT * FROM inventory_ledger_entries WHERE inventory_item_id=? AND event_type='OPENING'`,
    [id]
  );
  console.log('\nOpening:', opening);

  const [adj] = await pool.execute(
    `SELECT * FROM inventory_ledger_entries WHERE inventory_item_id=? AND event_type='ADJUSTMENT' ORDER BY created_at`,
    [id]
  );
  console.log('\nAdjustments:');
  adj.forEach((a) =>
    console.log(a.created_at, a.reference_type, a.reference_id, 'in', a.quantity_in, 'out', a.quantity_out)
  );

  await pool.end();
})();
