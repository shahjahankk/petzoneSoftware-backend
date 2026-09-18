require('dotenv').config();
const { pool } = require('../config/database');

// DB-backed idempotency store (shared across server instances).
// PENDING  = a request claimed this key and is mid-flight
// COMPLETED = finished request; response_body is replayed on retry
// FAILED   = request errored; a retry may reclaim the key
const createTableSql = `
  CREATE TABLE IF NOT EXISTS idempotency_keys (
    idkey VARCHAR(128) NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'PENDING',
    response_body LONGTEXT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    expires_at DATETIME NULL,
    PRIMARY KEY (idkey),
    KEY idx_idempotency_keys_status_expires (status, expires_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`;

async function main() {
  await pool.execute(createTableSql);
  const [rows] = await pool.query("SHOW TABLES LIKE 'idempotency_keys'");
  if (rows.length) {
    const [idx] = await pool.execute(
      `SELECT COUNT(*) AS c FROM information_schema.statistics
       WHERE table_schema = DATABASE() AND table_name = 'idempotency_keys' AND index_name = 'idx_idempotency_keys_status_expires'`
    );
    if (Number(idx[0]?.c || 0) === 0) {
      await pool.execute(
        'CREATE INDEX idx_idempotency_keys_status_expires ON idempotency_keys (status, expires_at)'
      );
    }
  }
  console.log('idempotency_keys table ready.');
  await pool.end();
}

main().catch(async (error) => {
  console.error('idempotency_keys setup failed:', error.message);
  await pool.end();
  process.exitCode = 1;
});