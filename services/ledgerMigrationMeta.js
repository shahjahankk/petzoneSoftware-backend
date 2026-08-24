/**
 * Single source flag: immutable ledger backfill completed (admin_settings).
 * Cached in-process to avoid a DB round-trip on every sale/ledger request.
 */
const KEY = 'ledger_migration_completed';

let cache = { value: null, at: 0 };
const TTL_MS = parseInt(process.env.LEDGER_MIGRATION_CACHE_MS || '30000', 10);

async function isLedgerMigrationComplete(conn) {
  const now = Date.now();
  if (cache.value !== null && now - cache.at < TTL_MS) {
    return cache.value;
  }
  const [rows] = await conn.execute(
    'SELECT setting_value FROM admin_settings WHERE setting_key = ? LIMIT 1',
    [KEY]
  );
  const v = rows[0]?.setting_value;
  const complete = v === '1' || v === 'true' || v === 'TRUE';
  cache = { value: complete, at: now };
  return complete;
}

function invalidateLedgerMigrationCache() {
  cache = { value: null, at: 0 };
}

async function markLedgerMigrationComplete(conn) {
  await conn.execute(
    `INSERT INTO admin_settings (setting_key, setting_value, description)
     VALUES (?, '1', 'Immutable customer ledger backfill completed — balances use customer_ledger_entries')
     ON DUPLICATE KEY UPDATE setting_value = '1', updated_at = CURRENT_TIMESTAMP`,
    [KEY]
  );
  cache = { value: true, at: Date.now() };
}

module.exports = {
  LEDGER_MIGRATION_KEY: KEY,
  isLedgerMigrationComplete,
  markLedgerMigrationComplete,
  invalidateLedgerMigrationCache,
};
