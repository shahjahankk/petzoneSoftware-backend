require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { pool } = require('../config/database');
const { removeSaleFromLedgers } = require('../services/saleLedgerSyncService');
const InventoryProjection = require('../services/inventoryProjectionService');

const TARGETS = (process.argv.find((a) => a.startsWith('--names='))?.slice(8) ||
  'guest test,nwst')
  .split(',')
  .map((n) => n.trim())
  .filter(Boolean);

const DELETED_BY = 1;
const DRY_RUN = !process.argv.includes('--delete');
``
function normalizeScope(v) {
  return String(v || '').toUpperCase();
}

function salesWhereSql() {
  const placeholders = TARGETS.map(() => 'LOWER(TRIM(s.customer_name)) = LOWER(TRIM(?))').join(' OR ');
  return { sql: `(${placeholders})`, params: TARGETS };
}

function ledgerWhereSql() {
  const placeholders = TARGETS.map(() => 'LOWER(TRIM(e.customer_name)) = LOWER(TRIM(?))').join(' OR ');
  return { sql: `(${placeholders})`, params: TARGETS };
}

function retailerWhereSql() {
  const placeholders = TARGETS.map(() => 'LOWER(TRIM(name)) = LOWER(TRIM(?))').join(' OR ');
  return { sql: `(${placeholders})`, params: TARGETS };
}

async function findRetailers() {
  const { sql, params } = retailerWhereSql();
  const [rows] = await pool.execute(
    `SELECT * FROM retailers WHERE deleted_at IS NULL AND ${sql}`,
    params
  );
  return rows;
}

async function findCustomers() {
  const { sql, params } = retailerWhereSql();
  const [rows] = await pool.execute(`SELECT * FROM customers WHERE ${sql}`, params);
  return rows;
}

async function findSales() {
  const { sql, params } = salesWhereSql();
  const [rows] = await pool.execute(
    `SELECT s.* FROM sales s
     WHERE s.deleted_at IS NULL AND ${sql}
     ORDER BY s.id ASC`,
    params
  );
  return rows;
}

async function countLedger() {
  const { sql, params } = ledgerWhereSql();
  const [rows] = await pool.execute(
    `SELECT COUNT(*) AS c FROM customer_ledger_entries e WHERE ${sql}`,
    params
  );
  return rows[0].c;
}

async function deleteParty(connection, customerName, retailerIds = []) {
  const [sales] = await connection.execute(
    `SELECT * FROM sales
     WHERE deleted_at IS NULL AND LOWER(TRIM(customer_name)) = LOWER(TRIM(?))
     ORDER BY id ASC`,
    [customerName]
  );

  for (const sale of sales) {
    const [saleItemRows] = await connection.execute(
      'SELECT * FROM sale_items WHERE sale_id = ?',
      [sale.id]
    );

    await removeSaleFromLedgers(connection, sale.id, sale);

    for (const row of saleItemRows) {
      if (!row.inventory_item_id) continue;
      const qty = parseFloat(row.quantity) || 0;
      if (qty <= 0) continue;
      const [scopeRows] = await connection.execute(
        'SELECT scope_type, scope_id FROM inventory_items WHERE id = ?',
        [row.inventory_item_id]
      );
      if (!scopeRows.length) continue;
      await InventoryProjection.applyEvent(connection, {
        event_type: 'RESTOCK',
        inventory_item_id: row.inventory_item_id,
        scope_type: normalizeScope(scopeRows[0].scope_type),
        scope_id: String(scopeRows[0].scope_id ?? ''),
        quantity_in: qty,
        quantity_out: 0,
        reference_type: 'sale_delete',
        reference_id: `${sale.id}:${row.id}`,
        created_by: DELETED_BY,
      });
    }

    await connection.execute('DELETE FROM sale_items WHERE sale_id = ?', [sale.id]);
    await connection.execute(
      `INSERT INTO trash (entity_type, entity_id, entity_data, deleted_by, deleted_at, expires_at, is_expired)
       VALUES ('sale', ?, ?, ?, NOW(), DATE_ADD(NOW(), INTERVAL 6 MONTH), 0)`,
      [sale.id, JSON.stringify(sale), DELETED_BY]
    );
    await connection.execute('UPDATE sales SET deleted_at = NOW() WHERE id = ?', [sale.id]);
    console.log(`  Deleted sale ${sale.id} ${sale.invoice_no} (${customerName})`);
  }

  const [ledgerDel] = await connection.execute(
    `DELETE FROM customer_ledger_entries
     WHERE LOWER(TRIM(customer_name)) = LOWER(TRIM(?))`,
    [customerName]
  );
  console.log(`  Ledger rows removed for "${customerName}": ${ledgerDel.affectedRows}`);

  for (const rid of retailerIds) {
    const [retailer] = await connection.execute(
      'SELECT * FROM retailers WHERE id = ? AND deleted_at IS NULL',
      [rid]
    );
    if (!retailer.length) continue;
    await connection.execute(
      `INSERT INTO trash (entity_type, entity_id, entity_data, deleted_by, deleted_at, expires_at, is_expired)
       VALUES ('retailer', ?, ?, ?, NOW(), DATE_ADD(NOW(), INTERVAL 6 MONTH), 0)`,
      [rid, JSON.stringify(retailer[0]), DELETED_BY]
    );
    await connection.execute(
      'UPDATE retailers SET status = "INACTIVE", deleted_at = NOW(), updated_at = NOW() WHERE id = ?',
      [rid]
    );
    console.log(`  Removed retailer ${rid} (${retailer[0].name})`);
  }

  const [custRows] = await connection.execute(
    'SELECT * FROM customers WHERE LOWER(TRIM(name)) = LOWER(TRIM(?))',
    [customerName]
  );
  for (const c of custRows) {
    await connection.execute(
      `INSERT INTO trash (entity_type, entity_id, entity_data, deleted_by, deleted_at, expires_at, is_expired)
       VALUES ('customer', ?, ?, ?, NOW(), DATE_ADD(NOW(), INTERVAL 6 MONTH), 0)`,
      [c.id, JSON.stringify(c), DELETED_BY]
    );
    await connection.execute('DELETE FROM customers WHERE id = ?', [c.id]);
    console.log(`  Deleted customer record ${c.id} (${c.name})`);
  }
}

(async () => {
  console.log('Targets:', TARGETS.join(', '));
  console.log(DRY_RUN ? 'DRY RUN' : 'DELETE MODE');

  const sales = await findSales();
  const retailers = await findRetailers();
  const customers = await findCustomers();
  const ledgerCount = await countLedger();

  console.log(`\nActive sales: ${sales.length}`);
  sales.forEach((s) => {
    console.log(`  ${s.id} ${s.invoice_no} name=${s.customer_name} total=${s.total} retailer=${s.retailer_id} phone=${s.customer_phone}`);
  });

  console.log(`\nRetailers: ${retailers.length}`);
  retailers.forEach((r) => console.log(`  ${r.id} ${r.name} phone=${r.phone} status=${r.status}`));

  console.log(`\nCustomers table: ${customers.length}`);
  customers.forEach((c) => console.log(`  ${c.id} ${c.name} phone=${c.phone}`));

  console.log(`\nLedger rows: ${ledgerCount}`);

  if (DRY_RUN && sales.length === 0 && retailers.length === 0 && customers.length === 0) {
    const [fuzzySales] = await pool.execute(
      `SELECT DISTINCT customer_name, customer_phone, COUNT(*) AS c
       FROM sales WHERE deleted_at IS NULL
         AND (LOWER(customer_name) LIKE '%guest%' OR LOWER(customer_name) LIKE '%nwst%' OR LOWER(customer_name) LIKE '%test%')
       GROUP BY customer_name, customer_phone`
    );
    if (fuzzySales.length) {
      console.log('\nFuzzy name matches in active sales:');
      fuzzySales.forEach((r) => console.log(`  "${r.customer_name}" phone=${r.customer_phone} sales=${r.c}`));
    }
  }

  const retailerIdsByName = new Map();
  for (const r of retailers) {
    const key = String(r.name || '').trim().toLowerCase();
    if (!retailerIdsByName.has(key)) retailerIdsByName.set(key, []);
    retailerIdsByName.get(key).push(r.id);
  }
  for (const s of sales) {
    if (s.retailer_id) {
      const key = String(s.customer_name || '').trim().toLowerCase();
      if (!retailerIdsByName.has(key)) retailerIdsByName.set(key, []);
      if (!retailerIdsByName.get(key).includes(s.retailer_id)) {
        retailerIdsByName.get(key).push(s.retailer_id);
      }
    }
  }

  if (DRY_RUN) {
    console.log('\nDry run complete. Re-run with --delete to remove.');
    await pool.end();
    return;
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    for (const name of TARGETS) {
      console.log(`\nSweeping "${name}"...`);
      const rids = retailerIdsByName.get(name.toLowerCase()) || [];
      await deleteParty(connection, name, rids);
    }
    await connection.commit();
    console.log('\nDone.');
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }

  const remainingSales = await findSales();
  const remainingLedger = await countLedger();
  const remainingRetailers = await findRetailers();
  console.log('\nRemaining — sales:', remainingSales.length, 'ledger:', remainingLedger, 'retailers:', remainingRetailers.length);

  await pool.end();
})().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch (_) {}
  process.exit(1);
});
