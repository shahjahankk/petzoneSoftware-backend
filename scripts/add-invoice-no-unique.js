require('dotenv').config();
const { pool } = require('../config/database');

/**
 * H11: enforce uniqueness of active invoice numbers at the DB level.
 *
 * sales.invoice_no currently only has a non-unique index, so a generation race
 * could write duplicates. Historical soft-deleted rows may legitimately repeat
 * an invoice number, so we index a generated column that is NULL when the row is
 * soft-deleted (MySQL/MariaDB unique indexes allow multiple NULLs).
 *
 * Run once:  node scripts/add-invoice-no-unique.js
 */

async function columnExists(table, column) {
  const [rows] = await pool.execute(
    `SELECT COUNT(*) AS c FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    [table, column]
  );
  return Number(rows[0]?.c || 0) > 0;
}

async function indexExists(table, index) {
  const [rows] = await pool.execute(
    `SELECT COUNT(*) AS c FROM information_schema.statistics
      WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?`,
    [table, index]
  );
  return Number(rows[0]?.c || 0) > 0;
}

async function main() {
  const [dups] = await pool.query(
    `SELECT invoice_no, COUNT(*) AS c FROM sales
      WHERE deleted_at IS NULL GROUP BY invoice_no HAVING c > 1 LIMIT 10`
  );
  if (dups.length) {
    console.warn('Active duplicate invoice_no values found; resolve before adding UNIQUE index:');
    console.warn(JSON.stringify(dups));
    await pool.end();
    process.exitCode = 1;
    return;
  }

  if (!(await columnExists('sales', 'invoice_no_active'))) {
    await pool.execute(`
      ALTER TABLE sales
        ADD COLUMN invoice_no_active VARCHAR(100)
          GENERATED ALWAYS AS (IF(deleted_at IS NULL, invoice_no, NULL)) STORED
    `);
    console.log('Added generated column sales.invoice_no_active.');
  } else {
    console.log('Column sales.invoice_no_active already exists.');
  }

  if (!(await indexExists('sales', 'uq_sales_invoice_no_active'))) {
    await pool.execute(
      'ALTER TABLE sales ADD UNIQUE KEY uq_sales_invoice_no_active (invoice_no_active)'
    );
    console.log('Added unique index uq_sales_invoice_no_active.');
  } else {
    console.log('Unique index uq_sales_invoice_no_active already exists.');
  }

  await pool.end();
}

main().catch(async (error) => {
  console.error('sales.invoice_no unique migration failed:', error.message);
  await pool.end();
  process.exitCode = 1;
});
