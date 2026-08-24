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

  const tables = [
    'companies', 'categories', 'inventory_categories', 'salespeople', 'users',
    'branches', 'warehouses', 'pos', 'hardware_devices', 'billing',
    'credit_debit_transactions', 'ledgers', 'ledger_entries',
    'clinic_services', 'clinic_service_categories', 'transfers',
    'customers', 'retailers', 'inventory_items', 'sales', 'purchase_orders',
    'financial_vouchers', 'trash',
  ];

  for (const t of tables) {
    const [exists] = await c.query(
      `SELECT 1 AS ok FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME=? LIMIT 1`,
      [process.env.DB_NAME, t]
    );
    if (!exists.length) {
      console.log(`${t}: TABLE MISSING`);
      continue;
    }
    const [cols] = await c.query(
      `SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND COLUMN_NAME='deleted_at'`,
      [process.env.DB_NAME, t]
    );
    console.log(`${t}: ${cols.length ? 'HAS deleted_at' : 'MISSING deleted_at'}`);
  }

  // Discover actual category / clinic table names
  const [catLike] = await c.query(
    `SELECT TABLE_NAME FROM information_schema.TABLES
     WHERE TABLE_SCHEMA=? AND (TABLE_NAME LIKE '%categor%' OR TABLE_NAME LIKE '%clinic%' OR TABLE_NAME LIKE '%credit%' OR TABLE_NAME LIKE '%billing%' OR TABLE_NAME LIKE '%hardware%' OR TABLE_NAME LIKE '%pos%')
     ORDER BY TABLE_NAME`,
    [process.env.DB_NAME]
  );
  console.log('\nRelated tables:');
  console.table(catLike);

  await c.end();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
