/**
 * Add Refund / Exchange fields and exchange item lines.
 *
 * Usage: node scripts/add-refund-exchange-fields.js
 * Safe to re-run. Existing returns remain type = REFUND.
 */
require('dotenv').config();
const { executeQuery, pool } = require('../config/database');

async function columnExists(table, column) {
  const rows = await executeQuery(
    `SELECT COUNT(*) AS c
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column]
  );
  return Number(rows[0]?.c || 0) > 0;
}

async function indexExists(table, indexName) {
  const rows = await executeQuery(
    `SELECT COUNT(*) AS c
     FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
    [table, indexName]
  );
  return Number(rows[0]?.c || 0) > 0;
}

async function main() {
  const returnColumns = [
    ['type', "VARCHAR(20) NOT NULL DEFAULT 'REFUND'"],
    ['refund_method', 'VARCHAR(30) DEFAULT NULL'],
    ['replacement_sale_id', 'INT DEFAULT NULL'],
    ['replacement_total', 'DECIMAL(14,2) DEFAULT NULL'],
    ['price_difference', 'DECIMAL(14,2) DEFAULT NULL'],
  ];

  for (const [column, definition] of returnColumns) {
    if (await columnExists('sales_returns', column)) {
      console.log(`sales_returns.${column} already exists`);
      continue;
    }
    await executeQuery(`ALTER TABLE sales_returns ADD COLUMN ${column} ${definition}`);
    console.log(`Added sales_returns.${column}`);
  }

  await executeQuery(`
    CREATE TABLE IF NOT EXISTS sales_exchange_items (
      id INT NOT NULL AUTO_INCREMENT,
      return_id INT NOT NULL,
      inventory_item_id INT DEFAULT NULL,
      item_name VARCHAR(255) NOT NULL,
      sku VARCHAR(100) DEFAULT NULL,
      barcode VARCHAR(100) DEFAULT NULL,
      category VARCHAR(100) DEFAULT NULL,
      quantity DECIMAL(12,3) NOT NULL,
      unit_price DECIMAL(12,2) NOT NULL DEFAULT 0,
      line_total DECIMAL(12,2) NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  console.log('sales_exchange_items ready');

  if (!(await indexExists('sales_exchange_items', 'idx_exchange_items_return'))) {
    await executeQuery('CREATE INDEX idx_exchange_items_return ON sales_exchange_items (return_id)');
    console.log('Added idx_exchange_items_return');
  }

  const [counts] = await executeQuery(
    `SELECT
       (SELECT COUNT(*) FROM sales_returns WHERE type IS NULL OR type = '') AS missing_type,
       (SELECT COUNT(*) FROM sales_returns) AS total_returns`
  );
  await executeQuery("UPDATE sales_returns SET type = 'REFUND' WHERE type IS NULL OR type = ''");
  console.log(`Return rows: ${counts[0]?.total_returns || 0}, normalized type: ${counts[0]?.missing_type || 0}`);
  console.log('Done.');
}

main()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error(err);
    try { await pool.end(); } catch (_) { /* ignore */ }
    process.exit(1);
  });
