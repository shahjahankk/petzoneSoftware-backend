require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { pool } = require('../config/database');
const { getBatchItemSummaries } = require('../services/inventoryLedgerService');

(async () => {
  const id = 2408;
  const batch = await getBatchItemSummaries([id]);
  const L = batch.get(id);
  const [po] = await pool.execute(
    `SELECT SUM(poi.quantity_received) AS r FROM purchase_order_items poi
     INNER JOIN purchase_orders po ON po.id=poi.purchase_order_id AND po.status='COMPLETED'
     WHERE poi.inventory_item_id=?`,
    [id]
  );
  const [si] = await pool.execute(
    `SELECT SUM(si.quantity) AS q FROM sale_items si
     INNER JOIN sales s ON s.id=si.sale_id AND s.deleted_at IS NULL WHERE si.inventory_item_id=?`,
    [id]
  );
  const [ledgerSale] = await pool.execute(
    `SELECT SUM(quantity_out) AS q FROM inventory_ledger_entries WHERE inventory_item_id=? AND event_type='SALE'`,
    [id]
  );
  const [adj] = await pool.execute(
    `SELECT reference_type, SUM(quantity_in) i, SUM(quantity_out) o FROM inventory_ledger_entries
     WHERE inventory_item_id=? AND event_type='ADJUSTMENT' GROUP BY reference_type`,
    [id]
  );
  const [stock] = await pool.execute('SELECT current_stock, name FROM inventory_items WHERE id=?', [id]);

  console.log(stock[0].name);
  console.log('\nUI columns source:');
  console.log('  Purchased (PO table):', po[0].r);
  console.log('  Net Sold (sale_items):', si[0].q);
  console.log('  Current (ledger sum):', L.current_stock, '| cache:', stock[0].current_stock);

  console.log('\nFull ledger buckets:');
  console.log('  Opening:', L.opening);
  console.log('  PURCHASE (ledger):', L.purchased);
  console.log('  Sold (ledger):', L.sold);
  console.log('  Returned:', L.returned);
  console.log('  Restocked:', L.restocked);
  console.log('  Adjustments net:', L.adjustments);

  console.log('\nSimple math user expects: PO', po[0].r, '- sold', si[0].q, '=', (+po[0].r) - (+si[0].q));
  console.log('Actual ledger formula:');
  const computed =
    L.opening + L.purchased - L.sold + L.returned + L.restocked + L.adjustments;
  console.log(`  ${L.opening} + ${L.purchased} - ${L.sold} + ${L.returned} + ${L.restocked} + ${L.adjustments} = ${computed}`);

  console.log('\nAdjustments breakdown:');
  adj.forEach((a) => console.log(`  ${a.reference_type}: +${a.i} -${a.o}`));

  await pool.end();
})();
