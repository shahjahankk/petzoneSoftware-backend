require('dotenv').config();
const { executeQuery, pool } = require('../config/database');

async function tableExists(table) {
  const rows = await executeQuery(
    `SELECT COUNT(*) AS c
     FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [table]
  );
  return Number(rows[0]?.c || 0) > 0;
}

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
  if (!(await tableExists('shift_cash_movements'))) {
    await executeQuery(`
      CREATE TABLE shift_cash_movements (
        id INT NOT NULL AUTO_INCREMENT,
        shift_session_id INT DEFAULT NULL,
        scope_type VARCHAR(20) NOT NULL,
        scope_id VARCHAR(255) NOT NULL,
        user_id INT DEFAULT NULL,
        direction VARCHAR(10) NOT NULL,
        amount DECIMAL(14,2) NOT NULL,
        reason VARCHAR(255) NOT NULL,
        reference VARCHAR(100) DEFAULT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'APPROVED',
        created_by INT DEFAULT NULL,
        approved_by INT DEFAULT NULL,
        approved_at DATETIME DEFAULT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        deleted_at DATETIME DEFAULT NULL,
        PRIMARY KEY (id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('Created shift_cash_movements');
  } else {
    console.log('shift_cash_movements already exists');
  }

  const movementIndexes = [
    ['idx_shift_cash_movements_session', 'shift_session_id'],
    ['idx_shift_cash_movements_scope', 'scope_type, scope_id, created_at'],
    ['idx_shift_cash_movements_status', 'status, deleted_at'],
  ];
  for (const [indexName, columns] of movementIndexes) {
    if (!(await indexExists('shift_cash_movements', indexName))) {
      await executeQuery(`CREATE INDEX ${indexName} ON shift_cash_movements (${columns})`);
      console.log(`Added ${indexName}`);
    }
  }

  if (!(await columnExists('sales_returns', 'refund_amount'))) {
    await executeQuery(`
      ALTER TABLE sales_returns
      ADD COLUMN refund_amount DECIMAL(14,2) NOT NULL DEFAULT 0 AFTER total_refund
    `);
    console.log('Added sales_returns.refund_amount');
  } else {
    console.log('sales_returns.refund_amount already exists');
  }

  await executeQuery(`
    UPDATE sales_returns sr
    SET refund_amount = COALESCE(
      (SELECT SUM(ri.refund_amount) FROM sales_return_items ri WHERE ri.return_id = sr.id),
      COALESCE(ABS((
        SELECT s.total
        FROM sales s
        WHERE s.invoice_no = sr.return_no AND s.total < 0
        ORDER BY s.id DESC
        LIMIT 1
      )), 0),
      0
    )
    WHERE sr.refund_amount IS NULL OR sr.refund_amount = 0
  `);

  await executeQuery(`
    UPDATE sales_returns
    SET total_refund = refund_amount
    WHERE refund_amount IS NOT NULL
      AND (total_refund IS NULL OR ABS(COALESCE(total_refund, 0) - refund_amount) > 0.01)
  `);

  const counts = await executeQuery(`
    SELECT
      (SELECT COUNT(*) FROM sales_returns) AS total_returns,
      (SELECT COUNT(*) FROM sales_returns WHERE refund_amount IS NULL OR refund_amount = 0) AS zero_refund_amounts,
      (SELECT COUNT(*) FROM shift_cash_movements) AS cash_movements
  `);
  console.log(
    `Returns: ${counts[0]?.total_returns || 0}, zero refund_amounts: ${counts[0]?.zero_refund_amounts || 0}, cash movements: ${counts[0]?.cash_movements || 0}`
  );
  console.log('Done.');
}

main()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error(err);
    try { await pool.end(); } catch (_) {}
    process.exit(1);
  });
