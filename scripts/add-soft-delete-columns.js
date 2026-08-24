/**
 * Add deleted_at to all tables that should soft-delete into trash.
 * Safe to re-run (skips columns that already exist).
 * Usage: node scripts/add-soft-delete-columns.js
 */
require('dotenv').config();
const mysql = require('mysql2/promise');

const TABLES = [
  'companies',
  'inventory_categories',
  'salespeople',
  'users',
  'branches',
  'warehouses',
  'pos',
  'hardware_devices',
  'billing',
  'credit_debit_transactions',
  'ledgers',
  'ledger_entries',
  'clinic_services',
  'clinic_service_categories',
];

(async () => {
  const c = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    multipleStatements: true,
    connectTimeout: 30000,
  });
  await c.query('USE `' + process.env.DB_NAME + '`');

  for (const table of TABLES) {
    const [exists] = await c.query(
      `SELECT 1 AS ok FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? LIMIT 1`,
      [process.env.DB_NAME, table]
    );
    if (!exists.length) {
      console.log(`SKIP ${table} (table missing)`);
      continue;
    }
    const [cols] = await c.query(
      `SELECT 1 AS ok FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = 'deleted_at' LIMIT 1`,
      [process.env.DB_NAME, table]
    );
    if (cols.length) {
      console.log(`OK   ${table} already has deleted_at`);
      continue;
    }
    await c.query(
      `ALTER TABLE \`${table}\` ADD COLUMN deleted_at DATETIME NULL DEFAULT NULL`
    );
    console.log(`ADD  ${table}.deleted_at`);
  }

  await c.end();
  console.log('Done.');
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
