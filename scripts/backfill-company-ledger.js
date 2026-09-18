require('dotenv').config();
const { pool } = require('../config/database');
const { ensureSchema, addEntry } = require('../services/companyLedgerService');

async function main() {
  await ensureSchema();
  const [orders] = await pool.execute(`
    SELECT id, order_number, supplier_id, scope_type, scope_id, order_date, total_amount
    FROM purchase_orders
    WHERE supplier_id IS NOT NULL AND deleted_at IS NULL
    ORDER BY id
  `);

  let imported = 0;
  for (const order of orders) {
    const [result] = await pool.execute(`
      SELECT id FROM company_ledger_entries
      WHERE reference_type = 'PURCHASE_ORDER' AND reference_id = ? AND entry_type = 'PURCHASE'
      LIMIT 1
    `, [String(order.id)]);
    if (result.length) continue;

    await addEntry({
      companyId: order.supplier_id,
      scopeType: order.scope_type,
      scopeId: order.scope_id,
      entryType: 'PURCHASE',
      referenceType: 'PURCHASE_ORDER',
      referenceId: String(order.id),
      debitAmount: Number(order.total_amount) || 0,
      description: `Purchase ${order.order_number}`,
      entryDate: order.order_date,
      createdBy: null
    });
    imported += 1;
  }

  console.log(`Company ledger backfill complete: ${imported} purchase orders imported, ${orders.length - imported} already present.`);
  await pool.end();
}

main().catch(async (error) => {
  console.error('Company ledger backfill failed:', error.message);
  await pool.end();
  process.exitCode = 1;
});
