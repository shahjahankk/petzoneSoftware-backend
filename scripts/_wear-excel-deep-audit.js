require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { pool } = require('../config/database');

const EXCEL_PATH = 'C:\\Users\\HP\\Downloads\\wear total iteam input.xlsx';
const OUT_JSON = path.join(__dirname, 'wear-excel-deep-audit.json');
const OUT_TXT = path.join(__dirname, 'wear-excel-deep-audit.txt');
const SCOPE_TYPE = 'WAREHOUSE';
const SCOPE_ID = '2';

const CONFIRMED_ID_BY_EXCEL_NORM = {
  'felicia urinary 2 kg': 1619,
  'felicia digest 2 kg': 1615,
  'felicia urinary 12 kg': 2408,
  'felicia digest 12 kg': 1616,
  'felicia derma 2 kg': 1617,
  'felicia kitten chicken 2 kg': 1607,
  'felicia kitten lamb 2 kg': 1612,
  'felicia kitten chicken12 kg': 1608,
  'felicia kitten lamb 12 kg': 1613,
  'felicia pouch adult salmon 85 g': 1599,
  'felicia pouch kitten chicken 85g': 1597,
  'felicia pouch kitten lamb 85g': 1598,
  'felicia pouch adult chicken 85g': 1601,
  'jungle kitten 15 kg': 1629,
  'jungle kitten 1 5 kg': 1628,
  'jungle adult 15 kg': 1634,
  'jungle adult 1 5 kg': 1633,
  'jungle pouch kitten': 1636,
  'jungle pouch adult': 1637,
  'jungle pate kitten': 1644,
  'jungle pate adult': 1643,
  'jungle creamy treat chicken': 1638,
  'jungle creamy treat salmon': 1640,
  'jungle creamy treat tuna': 1639,
  'jungle meat past duck': 1642,
  'jungle meat past salmon': 1641,
  'pawfect kitten 1 kg': 1574,
  'pawfect kitten 500 g': 1576,
  'pawfect adult 1 kg': 1575,
  'pawfect adult 500 g': 1577,
  'pawfect adult 10 kg': 2312,
  'big paw 3 kg': 1579,
  'puppy paw 3 kg': 1578,
  'big paw high energy 20 kg': 1580,
  'whiskas poultry 2 12 in jelly': 2395,
  'whiskas poultry 1+ in gravy': 1919,
  'whiskas poultry 1+ in jelly': 1920,
  'whiskas fish 2 12 in jelly': 2396,
  'whiskas fish 1+ in jelly': 1916,
  'whiskas mixed menu 1+ in jelly': 1918,
  'whiskas mixed menu 2 12 in jelly': 1923,
  'whiskas meals mealty 1+ in gravy': 1917,
  'whiskas chef choice 1+ in gravy': 1925,
  'whiskas catch of the day 1+ in gravy': 1924,
  'whiskas ocean delight 1+ in jelly': 2782,
};

function normName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/kittan/g, 'kitten')
    .replace(/uniary/g, 'urinary')
    .replace(/mealty/g, 'meaty')
    .replace(/past/g, 'paste')
    .replace(/[^a-z0-9+]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function loadExcelRows() {
  const wb = XLSX.readFile(EXCEL_PATH);
  return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' })
    .map((r, idx) => ({
      row: idx + 1,
      name: String(r['Iteam '] || r['Iteam'] || '').trim(),
      qty: parseFloat(r.PCS ?? 0) || 0,
    }))
    .filter((r) => r.name);
}

async function ledgerTotals(itemId) {
  const [rows] = await pool.execute(
    `SELECT event_type,
            COALESCE(SUM(quantity_in),0) AS in_q,
            COALESCE(SUM(quantity_out),0) AS out_q,
            COUNT(*) AS n
     FROM inventory_ledger_entries WHERE inventory_item_id=?
     GROUP BY event_type`,
    [itemId]
  );
  const t = {};
  for (const r of rows) t[r.event_type] = { in: +r.in_q, out: +r.out_q, n: r.n };
  const [sum] = await pool.execute(
    `SELECT COALESCE(SUM(quantity_in-quantity_out),0) AS ledger_stock FROM inventory_ledger_entries WHERE inventory_item_id=?`,
    [itemId]
  );
  return { byType: t, ledgerStock: +sum[0].ledger_stock };
}

async function saleItemsQty(itemId) {
  const [r] = await pool.execute(
    `SELECT COUNT(DISTINCT si.sale_id) AS invoices,
            COALESCE(SUM(si.quantity),0) AS qty
     FROM sale_items si
     INNER JOIN sales s ON s.id=si.sale_id AND s.deleted_at IS NULL
     WHERE si.inventory_item_id=?`,
    [itemId]
  );
  return { invoices: r[0].invoices, qty: +r[0].qty };
}

async function returnItemsQty(itemId) {
  try {
    const [r] = await pool.execute(
      `SELECT COUNT(DISTINCT sri.return_id) AS returns,
              COALESCE(SUM(sri.quantity),0) AS qty
       FROM sales_return_items sri
       INNER JOIN sales_returns sr ON sr.id=sri.return_id
       WHERE sri.inventory_item_id=?`,
      [itemId]
    );
    return { returns: r[0].returns, qty: +r[0].qty };
  } catch (_) {
    return { returns: 0, qty: 0 };
  }
}

async function poDetails(itemId) {
  const [rows] = await pool.execute(
    `SELECT poi.id, poi.purchase_order_id, po.order_number, po.status AS po_status,
            poi.quantity_ordered, poi.quantity_received,
            poi.inventory_item_id, poi.item_name
     FROM purchase_order_items poi
     INNER JOIN purchase_orders po ON po.id = poi.purchase_order_id
     WHERE poi.inventory_item_id = ?
     ORDER BY po.id`,
    [itemId]
  );
  let ordered = 0;
  let received = 0;
  const issues = [];
  const lines = [];
  for (const r of rows) {
    const o = +r.quantity_ordered || 0;
    const rc = +r.quantity_received || 0;
    ordered += o;
    received += rc;
    if (o !== rc) {
      issues.push(`PO ${r.order_number}: ordered ${o}, received ${rc} (pending ${o - rc})`);
    }
    if (!r.inventory_item_id) issues.push(`PO ${r.order_number} line ${r.id}: missing inventory_item_id`);
    lines.push({
      poId: r.purchase_order_id,
      orderNo: r.order_number,
      status: r.po_status,
      ordered: o,
      received: rc,
    });
  }
  return { lines, ordered, received, issues };
}

async function ledgerPurchaseQty(itemId) {
  const [r] = await pool.execute(
    `SELECT COALESCE(SUM(quantity_in),0) AS q FROM inventory_ledger_entries
     WHERE inventory_item_id=? AND event_type='PURCHASE'`,
    [itemId]
  );
  return +r[0].q;
}

async function reconcileAdjustment(itemId) {
  const [r] = await pool.execute(
    `SELECT COALESCE(SUM(quantity_out),0) AS out_q, COALESCE(SUM(quantity_in),0) AS in_q, COUNT(*) AS n
     FROM inventory_ledger_entries
     WHERE inventory_item_id=? AND event_type='ADJUSTMENT'
       AND reference_type LIKE '%reconcile%'`,
    [itemId]
  );
  return { out: +r[0].out_q, in: +r[0].in_q, n: r[0].n };
}

async function restockFromEdits(itemId) {
  const [r] = await pool.execute(
    `SELECT COALESCE(SUM(quantity_in),0) AS q, COUNT(*) AS n
     FROM inventory_ledger_entries
     WHERE inventory_item_id=? AND event_type='RESTOCK'
       AND (reference_type LIKE '%sale_edit%' OR reference_type LIKE '%sale_delete%')`,
    [itemId]
  );
  return { qty: +r[0].q, n: r[0].n };
}

function buildIssues(a) {
  const issues = [];
  const lt = a.ledger.byType;

  if (Math.abs(a.ledger.ledgerStock - a.dbQty) > 0.01) {
    issues.push(`LEDGER_CACHE_MISMATCH: ledger=${a.ledger.ledgerStock} cache=${a.dbQty}`);
  }

  const ledgerSold = lt.SALE?.out || 0;
  if (a.saleItems.qty > 0 && Math.abs(a.saleItems.qty - ledgerSold) > 1) {
    issues.push(
      `SALE_TRACKING: sale_items=${a.saleItems.qty} vs ledger SALE=${ledgerSold} (warehouse sales often ledger-only)`
    );
  }

  const ledgerRet = lt.RETURN?.in || 0;
  if (a.returns.qty > 0 && Math.abs(a.returns.qty - ledgerRet) > 0.01) {
    issues.push(`RETURN_MISMATCH: return_items=${a.returns.qty} vs ledger RETURN=${ledgerRet}`);
  }

  if (Math.abs(a.po.received - a.ledgerPurchase) > 0.01) {
    issues.push(`PO_LEDGER_MISMATCH: PO received=${a.po.received} vs ledger PURCHASE=${a.ledgerPurchase}`);
  }
  issues.push(...a.po.issues);

  if (a.reconcile.n > 0 && a.reconcile.out > 0) {
    issues.push(`MAY25_OPENING_WIPE: reconcile adjustment removed ${a.reconcile.out} units`);
  }

  const opening = lt.OPENING?.in || 0;
  const purchased = lt.PURCHASE?.in || 0;
  const sold = lt.SALE?.out || 0;
  const returned = lt.RETURN?.in || 0;
  const restock = lt.RESTOCK?.in || 0;
  const adjIn = lt.ADJUSTMENT?.in || 0;
  const adjOut = lt.ADJUSTMENT?.out || 0;

  a.calcStock =
    opening + purchased + returned + restock + adjIn - sold - adjOut;

  if (a.dbQty < 0) {
    issues.push(`OVERSOLD: sold ${sold} vs PO+opening inflow ${opening + purchased} (negative stock allowed)`);
  }

  if (a.diff > 0 && a.dbQty <= 0 && sold >= purchased + opening) {
    issues.push(`SOLD_OUT_IN_SYSTEM: all receipts sold; Excel still shows ${a.excelQty} — missing PO or unposted stock`);
  }

  if (a.diff > 100 && sold > purchased + opening && a.reconcile.out >= opening * 0.5) {
    issues.push(`HIGH_SALES_AFTER_OPENING_WIPE: heavy sales + opening cleared May-25`);
  }

  if (a.itemId === 2782) {
    issues.push(`LEGACY_SKU: ocean delight on duplicate WH-UNIT6 row, 0 PO, ${sold} sold`);
  }

  if (a.po.received === 0 && sold > 0 && opening === 0) {
    issues.push(`NO_PO_RECEIPTS: stock movement without PO receive (opening only or manual)`);
  }

  if (a.restockEdits.qty > 0) {
    issues.push(`SALE_EDITS: ${a.restockEdits.n} restock events (+${a.restockEdits.qty}) from sale edits/deletes`);
  }

  return issues;
}

function classifyRootCause(a) {
  if (a.issues.some((i) => i.startsWith('PO_LEDGER_MISMATCH'))) return 'PO data issue';
  if (a.issues.some((i) => i.startsWith('SOLD_OUT_IN_SYSTEM'))) return 'Fully sold in system; Excel has stock';
  if (a.issues.some((i) => i.startsWith('OVERSOLD'))) return 'Oversold vs PO receipts';
  if (a.issues.some((i) => i.startsWith('MAY25_OPENING_WIPE'))) return 'May-25 opening reconcile + sales';
  if (a.diff < 0 && a.excelQty === 0) return 'Excel zero but system has stock';
  if (a.diff > 0) return 'Physical count higher than system';
  return 'Count variance / sales vs Excel date';
}

(async () => {
  const excelRows = loadExcelRows();
  const [items] = await pool.execute(
    `SELECT id, sku, name, current_stock FROM inventory_items
     WHERE deleted_at IS NULL AND scope_type=? AND scope_id=?`,
    [SCOPE_TYPE, SCOPE_ID]
  );

  const audits = [];
  for (const ex of excelRows) {
    const key = normName(ex.name);
    const itemId = CONFIRMED_ID_BY_EXCEL_NORM[key];
    if (itemId == null) continue;
    const item = items.find((i) => i.id === itemId);
    if (!item) continue;
    const dbQty = +item.current_stock || 0;
    const diff = ex.qty - dbQty;
    if (diff === 0) continue;

    const ledger = await ledgerTotals(itemId);
    const saleItems = await saleItemsQty(itemId);
    const returns = await returnItemsQty(itemId);
    const po = await poDetails(itemId);
    const ledgerPurchase = await ledgerPurchaseQty(itemId);
    const reconcile = await reconcileAdjustment(itemId);
    const restockEdits = await restockFromEdits(itemId);

    const audit = {
      row: ex.row,
      excelName: ex.name,
      excelQty: ex.qty,
      itemId,
      sku: item.sku,
      dbName: item.name,
      dbQty,
      diff,
      ledger,
      saleItems,
      returns,
      po,
      ledgerPurchase,
      reconcile,
      restockEdits,
      calcStock: 0,
      issues: [],
      rootCause: '',
    };
    audit.issues = buildIssues(audit);
    audit.rootCause = classifyRootCause(audit);
    audits.push(audit);
  }

  audits.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));

  const lines = [];
  lines.push('WEAR EXCEL — DEEP AUDIT (37 diff items): PO + Sales + Returns + Issues');
  lines.push('='.repeat(100));

  const issueCounts = {};
  for (const a of audits) {
    lines.push('');
    lines.push(`Row ${a.row} | ${a.excelName}`);
    lines.push(`  DB: ${a.dbName} (${a.sku}) id=${a.itemId}`);
    lines.push(`  Excel ${a.excelQty} | DB ${a.dbQty} | Diff ${a.diff} | Root: ${a.rootCause}`);
    const lt = a.ledger.byType;
    lines.push(
      `  Ledger: opening +${lt.OPENING?.in || 0}, PO +${lt.PURCHASE?.in || 0}, sold -${lt.SALE?.out || 0}, returns +${lt.RETURN?.in || 0}, restock +${lt.RESTOCK?.in || 0}, adj -${lt.ADJUSTMENT?.out || 0}/+${lt.ADJUSTMENT?.in || 0} => ${a.ledger.ledgerStock}`
    );
    lines.push(
      `  sale_items: ${a.saleItems.qty} (${a.saleItems.invoices} inv) | return_items: ${a.returns.qty} (${a.returns.returns} ret)`
    );
    lines.push(
      `  PO lines: ${a.po.lines.length} | ordered ${a.po.ordered} | received ${a.po.received} | ledger PURCHASE ${a.ledgerPurchase}`
    );
    if (a.po.lines.length) {
      a.po.lines.forEach((p) => {
        const flag = p.ordered !== p.received ? ' **PARTIAL**' : '';
        lines.push(`    ${p.orderNo} [${p.status}] ord ${p.ordered} rcv ${p.received}${flag}`);
      });
    }
    lines.push('  Issues:');
    a.issues.forEach((i) => {
      lines.push(`    - ${i}`);
      const tag = i.split(':')[0];
      issueCounts[tag] = (issueCounts[tag] || 0) + 1;
    });
  }

  lines.push('');
  lines.push('='.repeat(100));
  lines.push('ISSUE TYPE SUMMARY (how many items affected)');
  Object.entries(issueCounts)
    .sort((a, b) => b[1] - a[1])
    .forEach(([k, v]) => lines.push(`  ${k}: ${v} items`));

  const rootCounts = {};
  audits.forEach((a) => { rootCounts[a.rootCause] = (rootCounts[a.rootCause] || 0) + 1; });
  lines.push('');
  lines.push('ROOT CAUSE SUMMARY');
  Object.entries(rootCounts)
    .sort((a, b) => b[1] - a[1])
    .forEach(([k, v]) => lines.push(`  ${k}: ${v}`));

  fs.writeFileSync(OUT_TXT, lines.join('\n'), 'utf8');
  fs.writeFileSync(OUT_JSON, JSON.stringify(audits, null, 2), 'utf8');

  console.log(lines.join('\n'));
  console.log(`\nSaved: ${OUT_TXT}`);
  console.log(`Saved: ${OUT_JSON}`);

  await pool.end();
})().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch (_) {}
  process.exit(1);
});
