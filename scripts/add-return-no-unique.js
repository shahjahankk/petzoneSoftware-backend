require('dotenv').config();
const { pool } = require('../config/database');

// H5: sales_returns.return_no must be unique for the retry-based generator in
// models/SalesReturn.create to converge under concurrent inserts.
async function hasUniqueIndexOnColumn(table, column) {
  const [rows] = await pool.execute(
    `SELECT COUNT(*) AS c FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND table_name = ?
       AND column_name = ? AND non_unique = 0 AND seq_in_index = 1`,
    [table, column]
  );
  return Number(rows[0]?.c || 0) > 0;
}

async function main() {
  const [dupRows] = await pool.execute(
    `SELECT return_no, COUNT(*) AS c FROM sales_returns
     GROUP BY return_no HAVING COUNT(*) > 1 LIMIT 20`
  );
  if (dupRows.length) {
    console.warn('Duplicate return_no values found; cannot add UNIQUE index until resolved:');
    for (const r of dupRows) console.warn(`  ${r.return_no} x${r.c}`);
    await pool.end();
    process.exitCode = 2;
    return;
  }

  if (await hasUniqueIndexOnColumn('sales_returns', 'return_no')) {
    console.log('A unique index on sales_returns.return_no already exists.');
    await pool.end();
    return;
  }

  await pool.execute('ALTER TABLE sales_returns ADD UNIQUE KEY uq_sales_returns_return_no (return_no)');
  console.log('Added unique index uq_sales_returns_return_no.');
  await pool.end();
}

main().catch(async (error) => {
  console.error('sales_returns return_no unique index failed:', error.message);
  await pool.end();
  process.exitCode = 1;
});