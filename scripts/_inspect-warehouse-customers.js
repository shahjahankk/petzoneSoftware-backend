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

  // Mirrors GET /api/customer-ledger/customers for warehouse keeper Dawood (warehouse_id = 2)
  const [rows] = await c.query(
    `SELECT s.customer_name, s.customer_phone,
            COUNT(*) AS total_transactions,
            (SELECT COALESCE(SUM(e.debit - e.credit), 0)
               FROM customer_ledger_entries e
              WHERE e.scope_type = s.scope_type AND e.scope_id = s.scope_id
                AND LOWER(TRIM(IFNULL(e.customer_name,''))) = LOWER(TRIM(IFNULL(s.customer_name,'')))
                AND TRIM(IFNULL(e.customer_phone,'')) <=> TRIM(IFNULL(s.customer_phone,''))
            ) AS current_balance
       FROM sales s
      WHERE s.scope_type = 'WAREHOUSE' AND s.scope_id = 'Hyderabad Warehouse' AND s.deleted_at IS NULL
      GROUP BY s.customer_name, s.customer_phone
      ORDER BY total_transactions DESC`
  );
  console.log(`\n=== WAREHOUSE LEDGER CUSTOMER LIST (${rows.length} customers) ===`);
  console.table(rows);

  const total = rows.reduce((s, r) => s + Number(r.current_balance || 0), 0);
  console.log('Sum of customer balances:', total.toFixed(2));

  const [orphans] = await c.query(
    `SELECT scope_type, scope_id, COUNT(*) AS cnt
       FROM customer_ledger_entries
      GROUP BY scope_type, scope_id`
  );
  console.log('\n=== LEDGER ENTRIES BY SCOPE (no stragglers expected) ===');
  console.table(orphans);

  await c.end();
})().catch((e) => {
  console.error(e.code || '', e.message);
  process.exit(1);
});
