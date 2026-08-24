require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { pool } = require('../config/database');
const { getBatchItemSummaries } = require('../services/inventoryLedgerService');

(async () => {
  const [items] = await pool.execute(`
    SELECT i.id, i.name, i.current_stock
    FROM inventory_items i
    WHERE i.deleted_at IS NULL AND i.scope_type = 'WAREHOUSE'
  `);
  const ids = items.map((i) => i.id);
  const batch = await getBatchItemSummaries(ids);

  const [flowRows] = await pool.execute(`
    SELECT i.id AS inventory_item_id,
      COALESCE(pur.total_purchased, 0) AS total_purchased,
      COALESCE(sol.total_sold, 0) AS total_sold,
      COALESCE(ret.total_returned, 0) AS total_returned
    FROM inventory_items i
    LEFT JOIN (
      SELECT poi.inventory_item_id, SUM(COALESCE(poi.quantity_received, 0)) AS total_purchased
      FROM purchase_order_items poi
      INNER JOIN purchase_orders po ON po.id = poi.purchase_order_id
      WHERE po.deleted_at IS NULL AND po.status = 'COMPLETED'
      GROUP BY poi.inventory_item_id
    ) pur ON pur.inventory_item_id = i.id
    LEFT JOIN (
      SELECT si.inventory_item_id, SUM(COALESCE(si.quantity, 0)) AS total_sold
      FROM sale_items si
      INNER JOIN sales s ON s.id = si.sale_id
      WHERE s.deleted_at IS NULL
      GROUP BY si.inventory_item_id
    ) sol ON sol.inventory_item_id = i.id
    LEFT JOIN (
      SELECT sri.inventory_item_id, SUM(COALESCE(sri.quantity, 0)) AS total_returned
      FROM sales_return_items sri
      GROUP BY sri.inventory_item_id
    ) ret ON ret.inventory_item_id = i.id
    WHERE i.deleted_at IS NULL AND i.scope_type = 'WAREHOUSE'
  `);
  const flowMap = new Map(flowRows.map((r) => [r.inventory_item_id, r]));

  let simpleMismatch = 0;
  let ledgerVsSimple = 0;
  let soldMismatch = 0;
  const examples = [];

  for (const item of items) {
    const L = batch.get(item.id);
    const F = flowMap.get(item.id) || {};
    const po = parseFloat(F.total_purchased) || 0;
    const grossSold = parseFloat(F.total_sold) || 0;
    const returned = parseFloat(F.total_returned) || 0;
    const netSold = Math.max(0, grossSold - returned);
    const current = L ? parseFloat(L.current_stock) : parseFloat(item.current_stock);
    const opening = L ? parseFloat(L.opening) : 0;
    const adj = L ? parseFloat(L.adjustments) : 0;
    const ledgerSold = L ? parseFloat(L.sold) : 0;
    const simpleExpected = po - netSold;

    if (Math.abs(current - simpleExpected) > 0.01 && (po > 0 || netSold > 0)) {
      simpleMismatch++;
      if (examples.length < 8) {
        examples.push({
          id: item.id,
          name: item.name.slice(0, 45),
          po,
          netSold,
          current,
          opening,
          adj,
          ledgerSold,
          grossSold,
        });
      }
    }

    if (Math.abs(ledgerSold - grossSold) > 0.01 && ledgerSold > 0) soldMismatch++;

    const computed =
      opening + po - grossSold + returned + (L?.restocked || 0) + adj;
    if (L && Math.abs(current - computed) > 0.01) ledgerVsSimple++;
  }

  console.log('Warehouse items:', items.length);
  console.log('Items where Current != PO - NetSold (UI naive formula):', simpleMismatch);
  console.log('Items where ledger sold != sale_items sold:', soldMismatch);
  console.log('Items where ledger current != bucket formula:', ledgerVsSimple);
  console.log('\nExample mismatches (PO, NetSold, Current, Opening, Adj, LedgerSold, SaleItemsSold):');
  examples.forEach((e) => console.log(JSON.stringify(e)));

  await pool.end();
})();
