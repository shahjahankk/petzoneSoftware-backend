require('dotenv').config();
const { remapBranchScopeName } = require('../services/branchScopeRemapService');
const mysql = require('mysql2/promise');

async function countScope(conn, scopeId) {
  const [sales] = await conn.query(
    `SELECT COUNT(*) AS c FROM sales WHERE deleted_at IS NULL AND scope_type='BRANCH' AND scope_id=?`,
    [scopeId]
  );
  let ledger = 0;
  try {
    const [rows] = await conn.query(
      `SELECT COUNT(*) AS c FROM customer_ledger_entries WHERE scope_type='BRANCH' AND scope_id=?`,
      [scopeId]
    );
    ledger = rows[0].c;
  } catch (_) {}
  return { sales: sales[0].c, ledger };
}

(async () => {
  const TARGET = 'PetFamily Animal Hospital';
  const SOURCES = [
    'Pet Family Animal Hospital',
    'Pet Family Qasimabad',
  ];

  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });

  const [branchRows] = await conn.query(
    'SELECT id, name, code FROM branches WHERE name = ? LIMIT 1',
    [TARGET]
  );
  if (!branchRows.length) {
    throw new Error(`Target branch "${TARGET}" not found`);
  }
  console.log('Target:', branchRows[0]);

  // Also show any related orphan scopes
  const [related] = await conn.query(`
    SELECT scope_id, COUNT(*) AS cnt
    FROM sales
    WHERE deleted_at IS NULL AND scope_type='BRANCH'
      AND (
        LOWER(scope_id) LIKE '%pet%family%'
        OR LOWER(scope_id) LIKE '%qasimabad%'
        OR LOWER(scope_id) LIKE '%petfamily%'
      )
    GROUP BY scope_id
    ORDER BY cnt DESC
  `);
  console.log('\nRelated sales scopes:');
  console.table(related);

  console.log('\n=== BEFORE ===');
  for (const name of [...SOURCES, TARGET]) {
    const c = await countScope(conn, name);
    console.log(`${name}: sales=${c.sales}, ledger=${c.ledger}`);
  }

  for (const oldName of SOURCES) {
    const before = await countScope(conn, oldName);
    if (before.sales === 0 && before.ledger === 0) {
      console.log(`\nSkip "${oldName}" (already empty)`);
      continue;
    }
    console.log(`\nRemapping "${oldName}" -> "${TARGET}" ...`);
    const summary = await remapBranchScopeName(oldName, TARGET);
    console.log(JSON.stringify(summary, null, 2));
  }

  console.log('\n=== AFTER ===');
  for (const name of [...SOURCES, TARGET]) {
    const c = await countScope(conn, name);
    console.log(`${name}: sales=${c.sales}, ledger=${c.ledger}`);
  }

  await conn.end();
  console.log('\nDone.');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
