require('dotenv').config();
const mysql = require('mysql2/promise');

(async () => {
  const c = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    connectTimeout: 20000,
  });
  await c.query('USE `' + process.env.DB_NAME + '`');

  const like = '%abdullah%';

  const [cust] = await c.query(
    `SELECT id, name, phone, branch_id, warehouse_id, status
     FROM customers WHERE name LIKE ?`,
    [like]
  );
  const [ret] = await c.query(
    `SELECT id, name, phone, warehouse_id, status
     FROM retailers WHERE name LIKE ?`,
    [like]
  );

  // Also check sales / ledger party names (walk-ins not in master tables)
  const [sales] = await c.query(
    `SELECT DISTINCT scope_type, scope_id, customer_name, customer_phone
     FROM sales
     WHERE deleted_at IS NULL AND customer_name LIKE ?
     ORDER BY scope_type, customer_name`,
    [like]
  );
  const [ledger] = await c.query(
    `SELECT DISTINCT scope_type, scope_id, customer_name, customer_phone, retailer_id
     FROM customer_ledger_entries
     WHERE customer_name LIKE ?
     ORDER BY scope_type, customer_name`,
    [like]
  );

  console.log('=== CUSTOMERS (name like Abdullah) ===');
  console.table(cust.length ? cust : [{ result: 'none' }]);
  console.log('=== RETAILERS (name like Abdullah) ===');
  console.table(ret.length ? ret : [{ result: 'none' }]);
  console.log('=== SALES parties (name like Abdullah) ===');
  console.table(sales.length ? sales : [{ result: 'none' }]);
  console.log('=== LEDGER parties (name like Abdullah) ===');
  console.table(ledger.length ? ledger : [{ result: 'none' }]);

  await c.end();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
