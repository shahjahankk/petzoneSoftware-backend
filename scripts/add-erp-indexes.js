require('dotenv').config();
const { pool } = require('../config/database');

const indexes = [
  ['sales', 'idx_sales_scope_created', '(scope_type, scope_id, created_at)'],
  ['sales', 'idx_sales_payment_type_created', '(payment_type, created_at)'],
  ['purchase_orders', 'idx_purchase_orders_supplier_scope', '(supplier_id, scope_type, scope_id)'],
  ['purchase_orders', 'idx_purchase_orders_order_date', '(order_date, id)'],
  ['purchase_order_items', 'idx_purchase_order_items_order', '(purchase_order_id, id)'],
  ['customer_ledger_entries', 'idx_customer_ledger_party_scope', '(customer_id, retailer_id, scope_type, scope_id, entry_date)'],
  ['customer_ledger_entries', 'idx_customer_ledger_reference', '(ref_type, ref_id)'],
  ['inventory_ledger_entries', 'idx_inventory_ledger_item_date', '(inventory_item_id, created_at)'],
  ['inventory_ledger_entries', 'idx_inventory_ledger_scope_date', '(scope_type, scope_id, created_at)'],
  ['financial_vouchers', 'idx_financial_vouchers_scope_date', '(scope_type, scope_id, voucher_date)']
];

async function indexExists(tableName, indexName) {
  const [rows] = await pool.execute(`
    SELECT COUNT(*) AS c FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?
  `, [tableName, indexName]);
  return Number(rows[0]?.c || 0) > 0;
}

async function main() {
  let created = 0;
  for (const [tableName, indexName, columns] of indexes) {
    if (await indexExists(tableName, indexName)) continue;
    try {
      await pool.execute(`CREATE INDEX ${indexName} ON ${tableName} ${columns}`);
      created += 1;
      console.log(`Created ${tableName}.${indexName}`);
    } catch (error) {
      if (error.code === 'ER_NO_SUCH_TABLE' || error.code === 'ER_BAD_FIELD_ERROR') {
        console.warn(`Skipped ${tableName}.${indexName}: ${error.message}`);
      } else {
        throw error;
      }
    }
  }
  console.log(`ERP index setup complete: ${created} indexes created.`);
  await pool.end();
}

main().catch(async (error) => {
  console.error('ERP index setup failed:', error.message);
  await pool.end();
  process.exitCode = 1;
});
