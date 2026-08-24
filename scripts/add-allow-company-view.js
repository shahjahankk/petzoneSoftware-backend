/**
 * Add branches.allow_company_view (eye-icon / company details for branch users).
 * Safe to re-run. Default 1 keeps current "view allowed" behaviour.
 * Usage: node scripts/add-allow-company-view.js
 */
require('dotenv').config();
const mysql = require('mysql2/promise');

(async () => {
  const c = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    connectTimeout: 30000,
  });
  await c.query('USE `' + process.env.DB_NAME + '`');

  const [cols] = await c.query(
    `SELECT 1 AS ok FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'branches' AND COLUMN_NAME = 'allow_company_view' LIMIT 1`,
    [process.env.DB_NAME]
  );

  if (cols.length) {
    console.log('OK  branches.allow_company_view already exists');
  } else {
    await c.query(
      `ALTER TABLE branches
       ADD COLUMN allow_company_view TINYINT(1) NOT NULL DEFAULT 1
       AFTER allow_company_delete`
    );
    console.log('ADD branches.allow_company_view TINYINT(1) NOT NULL DEFAULT 1');
  }

  await c.end();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
