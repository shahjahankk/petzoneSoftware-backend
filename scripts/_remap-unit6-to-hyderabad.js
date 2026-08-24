/**
 * Warehouse #2 was renamed "Unit 6 Warehouse" -> "Hyderabad Warehouse" without
 * remapping the name-keyed history rows, hiding 22 of its 23 customers.
 * Usage: node scripts/_remap-unit6-to-hyderabad.js
 */
require('dotenv').config();
const { pool } = require('../config/database');
const { remapWarehouseScopeName } = require('../services/branchScopeRemapService');

const OLD_NAME = 'Unit 6 Warehouse';
const NEW_NAME = 'Hyderabad Warehouse';

const partyCount = async (name) => {
  const [rows] = await pool.execute(
    `SELECT COUNT(DISTINCT CONCAT(IFNULL(customer_name,''),'|',IFNULL(customer_phone,''))) AS parties,
            COUNT(*) AS sales
     FROM sales WHERE scope_type='WAREHOUSE' AND scope_id = ? AND deleted_at IS NULL`,
    [name]
  );
  return rows[0];
};

(async () => {
  const [wh] = await pool.execute('SELECT id, name FROM warehouses WHERE name = ?', [NEW_NAME]);
  if (!wh.length) throw new Error(`Target warehouse "${NEW_NAME}" not found — aborting.`);
  console.log(`Target warehouse: #${wh[0].id} ${wh[0].name}`);

  console.log('\nBEFORE');
  console.log(`  ${OLD_NAME}:`, await partyCount(OLD_NAME));
  console.log(`  ${NEW_NAME}:`, await partyCount(NEW_NAME));

  const summary = await remapWarehouseScopeName(OLD_NAME, NEW_NAME);

  console.log('\nREMAPPED');
  console.table(summary.remapped);
  if (summary.skipped?.length) {
    console.log('SKIPPED (non-name scope_id columns)');
    console.table(summary.skipped);
  }

  console.log('\nAFTER');
  console.log(`  ${OLD_NAME}:`, await partyCount(OLD_NAME));
  console.log(`  ${NEW_NAME}:`, await partyCount(NEW_NAME));

  await pool.end();
})().catch(async (e) => {
  console.error('FAILED:', e.message);
  try { await pool.end(); } catch (_) { /* ignore */ }
  process.exit(1);
});
