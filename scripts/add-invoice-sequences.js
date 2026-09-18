require('dotenv').config();
const { pool } = require('../config/database');

/**
 * H4: create the atomic invoice-number sequence table and seed it from the
 * highest existing number per prefix so newly generated numbers never collide
 * with historical invoices.
 *
 * Run once:  node scripts/add-invoice-sequences.js
 */

async function tableExists(name) {
  const [rows] = await pool.execute(
    `SELECT COUNT(*) AS c FROM information_schema.tables
      WHERE table_schema = DATABASE() AND table_name = ?`,
    [name]
  );
  return Number(rows[0]?.c || 0) > 0;
}

async function main() {
  if (!(await tableExists('invoice_sequences'))) {
    await pool.execute(`
      CREATE TABLE invoice_sequences (
        scope_key VARCHAR(191) NOT NULL,
        last_number BIGINT UNSIGNED NOT NULL DEFAULT 0,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (scope_key)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('Created table invoice_sequences.');
  } else {
    console.log('Table invoice_sequences already exists.');
  }

  const [rows] = await pool.query(
    `SELECT invoice_no FROM sales WHERE invoice_no IS NOT NULL AND invoice_no <> ''`
  );

  const maxima = new Map();
  const re = /^(.*)-(\d+)$/;
  for (const row of rows) {
    const m = String(row.invoice_no).match(re);
    if (!m) continue;
    const key = m[1];
    const n = Number(m[2]);
    if (!Number.isFinite(n)) continue;
    if (!maxima.has(key) || maxima.get(key) < n) maxima.set(key, n);
  }

  let seeded = 0;
  for (const [key, max] of maxima) {
    await pool.execute(
      `INSERT INTO invoice_sequences (scope_key, last_number) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE last_number = GREATEST(last_number, VALUES(last_number))`,
      [key, max]
    );
    seeded += 1;
  }

  console.log(`Seeded ${seeded} sequence keys from ${rows.length} existing invoices.`);
  const [sample] = await pool.query(
    'SELECT scope_key, last_number FROM invoice_sequences ORDER BY scope_key LIMIT 10'
  );
  console.log('Sample:', JSON.stringify(sample));
  await pool.end();
}

main().catch(async (error) => {
  console.error('invoice_sequences migration failed:', error.message);
  await pool.end();
  process.exitCode = 1;
});
