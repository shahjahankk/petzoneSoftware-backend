require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const fs = require('fs');
const path = require('path');
const { pool } = require('../config/database');

const DUPLICATE_GROUPS = [
  { name: 'Balls', ids: [1822, 2763] },
  { name: 'Royal Canin Gastrointestinal 400g', ids: [1539, 2753] },
  { name: 'Royal Canin Hair & Skin Care 2 KG', ids: [1535, 2759] },
  { name: 'Royal Canin Jelly Instintcive 85G', ids: [1543, 2755] },
  { name: 'Royal Canin jelly Sensitive pouch', ids: [2409, 2760] },
  { name: 'Royal Canin Maxi Adult 15 KG', ids: [1554, 2757] },
  { name: 'Royal Canin Maxi puppy 15 KG', ids: [1553, 2758] },
  { name: 'Royal Canin Maxi Starter  15 KG', ids: [1551, 2761] },
  { name: 'Royal Canin Persian Adult 10 KG', ids: [1569, 2750] },
  { name: 'Royal Canin Persian Adult 2 KG', ids: [1567, 2752] },
  { name: 'Royal Canin Persian Adult 4 KG', ids: [1568, 2751] },
  { name: 'Royal Canin Renal Liquid', ids: [1573, 2756] },
];

async function getItemMeta(id) {
  const [rows] = await pool.execute(
    `SELECT id, name, sku, current_stock, cost_price, selling_price, created_at, deleted_at
     FROM inventory_items WHERE id = ?`,
    [id]
  );
  return rows[0] || null;
}

async function usageByItemId(id) {
  const [saleItems] = await pool.execute(
    `SELECT
       COUNT(DISTINCT si.sale_id) AS invoice_count,
       COUNT(*) AS line_count,
       COALESCE(SUM(si.quantity), 0) AS qty_sold,
       MIN(s.created_at) AS first_sale,
       MAX(s.created_at) AS last_sale
     FROM sale_items si
     INNER JOIN sales s ON s.id = si.sale_id AND s.deleted_at IS NULL
     WHERE si.inventory_item_id = ?`,
    [id]
  );

  const [saleItemsAll] = await pool.execute(
    `SELECT COUNT(DISTINCT si.sale_id) AS invoice_count, COALESCE(SUM(si.quantity), 0) AS qty
     FROM sale_items si
     WHERE si.inventory_item_id = ?`,
    [id]
  );

  const [saleBySku] = await pool.execute(
    `SELECT ii.sku AS item_sku,
       COUNT(DISTINCT si.sale_id) AS invoice_count,
       COALESCE(SUM(si.quantity), 0) AS qty
     FROM inventory_items ii
     LEFT JOIN sale_items si ON si.sku = ii.sku
     LEFT JOIN sales s ON s.id = si.sale_id AND s.deleted_at IS NULL
     WHERE ii.id = ?
     GROUP BY ii.sku`,
    [id]
  );

  const [returns] = await pool.execute(
    `SELECT COUNT(*) AS line_count, COALESCE(SUM(sri.quantity), 0) AS qty
     FROM sales_return_items sri WHERE sri.inventory_item_id = ?`,
    [id]
  );

  const [po] = await pool.execute(
    `SELECT COUNT(DISTINCT poi.purchase_order_id) AS po_count,
       COALESCE(SUM(poi.quantity_received), 0) AS qty_received,
       COALESCE(SUM(poi.quantity_ordered), 0) AS qty_ordered
     FROM purchase_order_items poi
     INNER JOIN purchase_orders po ON po.id = poi.purchase_order_id AND po.deleted_at IS NULL
     WHERE poi.inventory_item_id = ?`,
    [id]
  );

  const [ledger] = await pool.execute(
    `SELECT event_type,
       COUNT(*) AS entries,
       COALESCE(SUM(quantity_in), 0) AS qty_in,
       COALESCE(SUM(quantity_out), 0) AS qty_out
     FROM inventory_ledger_entries
     WHERE inventory_item_id = ?
     GROUP BY event_type
     ORDER BY event_type`,
    [id]
  );

  const [transfers] = await pool.execute(
    `SELECT COUNT(*) AS line_count, COALESCE(SUM(quantity), 0) AS qty
     FROM transfer_items WHERE inventory_item_id = ?`,
    [id]
  );

  let held = [{ line_count: 0, qty: 0 }];
  try {
    [held] = await pool.execute(
      `SELECT COUNT(*) AS line_count, COALESCE(SUM(quantity), 0) AS qty
       FROM held_bill_items WHERE inventory_item_id = ?`,
      [id]
    );
  } catch (_) {
    /* table may not exist on this deployment */
  }

  const [sampleInvoices] = await pool.execute(
    `SELECT s.id AS sale_id, s.created_at, si.quantity, si.sku, si.name
     FROM sale_items si
     INNER JOIN sales s ON s.id = si.sale_id AND s.deleted_at IS NULL
     WHERE si.inventory_item_id = ?
     ORDER BY s.created_at DESC
     LIMIT 5`,
    [id]
  );

  const ledgerSummary = {};
  let ledgerNet = 0;
  for (const row of ledger) {
    ledgerSummary[row.event_type] = {
      entries: row.entries,
      in: parseFloat(row.qty_in),
      out: parseFloat(row.qty_out),
    };
    ledgerNet += parseFloat(row.qty_in) - parseFloat(row.qty_out);
  }

  const score =
    parseInt(saleItems[0].invoice_count, 10) * 1000 +
    parseFloat(saleItems[0].qty_sold) * 10 +
    parseFloat(po[0].qty_received) * 5 +
    parseFloat(returns[0].qty) * 3 +
    Math.abs(ledgerNet);

  return {
    sale_items_active: saleItems[0],
    sale_items_all: saleItemsAll[0],
    sale_by_sku_match: saleBySku[0],
    returns: returns[0],
    purchase_orders: po[0],
    transfers: transfers[0],
    held_bills: held[0],
    ledger: ledgerSummary,
    ledger_net: ledgerNet,
    sample_invoices: sampleInvoices,
    activity_score: score,
  };
}

function recommendKeep(a, b) {
  const aInv = parseInt(a.usage.sale_items_active.invoice_count, 10);
  const bInv = parseInt(b.usage.sale_items_active.invoice_count, 10);
  const aQty = parseFloat(a.usage.sale_items_active.qty_sold);
  const bQty = parseFloat(b.usage.sale_items_active.qty_sold);
  const aPo = parseFloat(a.usage.purchase_orders.qty_received);
  const bPo = parseFloat(b.usage.purchase_orders.qty_received);
  const aStock = parseFloat(a.meta.current_stock);
  const bStock = parseFloat(b.meta.current_stock);

  let keep = null;
  let mergeInto = null;
  let reason = '';

  if (aInv > 0 && bInv === 0) {
    keep = a;
    mergeInto = b;
    reason = 'Only A has active invoice lines';
  } else if (bInv > 0 && aInv === 0) {
    keep = b;
    mergeInto = a;
    reason = 'Only B has active invoice lines';
  } else if (aInv > bInv) {
    keep = a;
    mergeInto = b;
    reason = 'A has more invoices';
  } else if (bInv > aInv) {
    keep = b;
    mergeInto = a;
    reason = 'B has more invoices';
  } else if (aQty > bQty) {
    keep = a;
    mergeInto = b;
    reason = 'A sold more qty on invoices';
  } else if (bQty > aQty) {
    keep = b;
    mergeInto = a;
    reason = 'B sold more qty on invoices';
  } else if (aPo > 0 && bPo === 0 && bStock >= aStock) {
    keep = b;
    mergeInto = a;
    reason = 'B has PO stock; A only has legacy sales/negative stock';
  } else if (bPo > 0 && aPo === 0 && aStock >= bStock) {
    keep = a;
    mergeInto = b;
    reason = 'A has PO stock; B only has legacy sales/negative stock';
  } else if (aStock >= bStock) {
    keep = a;
    mergeInto = b;
    reason = 'Higher/equal current stock';
  } else {
    keep = b;
    mergeInto = a;
    reason = 'Higher current stock';
  }

  return { keep, mergeInto, reason };
}

(async () => {
  const report = [];

  console.log('Duplicate usage analysis — invoices, POs, ledger\n');
  console.log(
    'Product'.padEnd(42),
    'ID'.padStart(5),
    'SKU'.padEnd(22),
    'Inv'.padStart(4),
    'Sold'.padStart(5),
    'PO'.padStart(4),
    'Stock'.padStart(6),
    'Ledger'.padStart(7)
  );
  console.log('-'.repeat(105));

  for (const group of DUPLICATE_GROUPS) {
    const items = [];
    for (const id of group.ids) {
      const meta = await getItemMeta(id);
      const usage = await usageByItemId(id);
      items.push({ id, meta, usage });
    }

    const [a, b] = items;
    const rec = recommendKeep(a, b);

    for (const item of items) {
      const u = item.usage;
      console.log(
        group.name.slice(0, 41).padEnd(42),
        String(item.id).padStart(5),
        (item.meta?.sku || '-').slice(0, 21).padEnd(22),
        String(u.sale_items_active.invoice_count).padStart(4),
        String(u.sale_items_active.qty_sold).padStart(5),
        String(u.purchase_orders.qty_received).padStart(4),
        String(item.meta?.current_stock ?? 0).padStart(6),
        String(u.ledger_net.toFixed(0)).padStart(7)
      );
    }

    console.log(
      `  → KEEP id=${rec.keep.id} sku=${rec.keep.meta.sku} | MERGE/retire id=${rec.mergeInto.id} sku=${rec.mergeInto.meta.sku}`
    );
    console.log(`     Reason: ${rec.reason}`);
    console.log('');

    report.push({
      product: group.name,
      items: items.map((item) => ({
        id: item.id,
        sku: item.meta?.sku,
        stock: parseFloat(item.meta?.current_stock ?? 0),
        invoices_active: parseInt(item.usage.sale_items_active.invoice_count, 10),
        qty_sold_active: parseFloat(item.usage.sale_items_active.qty_sold),
        invoices_all_including_deleted: parseInt(item.usage.sale_items_all.invoice_count, 10),
        po_received: parseFloat(item.usage.purchase_orders.qty_received),
        returns_qty: parseFloat(item.usage.returns.qty),
        transfers_qty: parseFloat(item.usage.transfers.qty),
        held_bills_qty: parseFloat(item.usage.held_bills.qty),
        ledger: item.usage.ledger,
        ledger_net: item.usage.ledger_net,
        sample_invoices: item.usage.sample_invoices,
        activity_score: item.usage.activity_score,
      })),
      recommendation: {
        keep_id: rec.keep.id,
        keep_sku: rec.keep.meta?.sku,
        retire_id: rec.mergeInto.id,
        retire_sku: rec.mergeInto.meta?.sku,
        reason: rec.reason,
      },
    });
  }

  const outJson = path.join(__dirname, 'duplicate-usage-report.json');
  const outTxt = path.join(__dirname, 'duplicate-usage-report.txt');
  fs.writeFileSync(outJson, JSON.stringify({ generated_at: new Date().toISOString(), report }, null, 2));

  let txt = 'DUPLICATE USAGE REPORT\n\n';
  for (const row of report) {
    txt += `${row.product}\n`;
    for (const item of row.items) {
      txt += `  id=${item.id} sku=${item.sku} stock=${item.stock}\n`;
      txt += `    Active invoices: ${item.invoices_active} (qty ${item.qty_sold_active})\n`;
      txt += `    PO received: ${item.po_received} | Returns: ${item.returns_qty} | Transfers: ${item.transfers_qty}\n`;
      txt += `    Ledger net: ${item.ledger_net}\n`;
      if (item.sample_invoices?.length) {
        txt += `    Recent invoices: ${item.sample_invoices.map((s) => `#${s.sale_id} qty=${s.quantity}`).join(', ')}\n`;
      }
    }
    txt += `  RECOMMENDATION: KEEP ${row.recommendation.keep_id} (${row.recommendation.keep_sku})\n`;
    txt += `                  RETIRE ${row.recommendation.retire_id} (${row.recommendation.retire_sku})\n`;
    txt += `                  ${row.recommendation.reason}\n\n`;
  }
  fs.writeFileSync(outTxt, txt);

  console.log(`Saved: ${outTxt}`);
  console.log(`Saved: ${outJson}`);

  await pool.end();
})().catch(async (e) => {
  console.error(e);
  try {
    await pool.end();
  } catch (_) {}
  process.exit(1);
});
