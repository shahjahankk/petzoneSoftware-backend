require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const XLSX = require('xlsx');
const { pool } = require('../config/database');

const EXCEL_PATH = 'C:\\Users\\HP\\Downloads\\wear total iteam input.xlsx';
const SCOPE_TYPE = 'WAREHOUSE';
const SCOPE_ID = '2';

// Manual overrides where auto-match is wrong or ambiguous (excel name lowercased)
const MANUAL_ITEM_ID = {
  'felicia urinary 2 kg': null, // not in DB
  'felicia digest 12 kg': 1616,
  'felicia kitten chicken12 kg': 1608,
  'felicia kitten lamb 12 kg': 1613,
  'jungle adult 15 kg': 1634,
  'jungle adult 1.5 kg': 1633,
  'jungle creamy treat chicken': 1638,
  'pawfect adult 10 kg': 2312,
  'pawfect kitten 500 g': 1576, // verify exists
  'whiskas chef choice 1+ in gravy': 1925,
  'whiskas catch of the day 1+ in gravy': 1924,
};

function normName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9+]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(s) {
  return normName(s).split(' ').filter((t) => t.length > 1);
}

function loadExcelRows() {
  const wb = XLSX.readFile(EXCEL_PATH);
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
  return rows
    .map((r, idx) => ({
      row: idx + 1,
      name: String(r['Iteam '] || r['Iteam'] || r['Item'] || '').trim(),
      qty: parseFloat(r.PCS ?? r.pcs ?? 0) || 0,
    }))
    .filter((r) => r.name);
}

function matchScore(excelName, dbName) {
  const a = normName(excelName);
  const b = normName(dbName);
  if (a === b) return 1000;
  if (b.includes(a) || a.includes(b)) return 900;
  const aNums = (excelName.match(/\d+/g) || []).map(String);
  const bNums = (dbName.match(/\d+/g) || []).map(String);
  if (aNums.length && !aNums.every((n) => bNums.includes(n))) return 0;
  const aTok = tokens(excelName);
  const bTok = tokens(dbName);
  if (!aTok.length || !bTok.length) return 0;
  let matched = 0;
  for (const t of aTok) {
    if (/^\d+$/.test(t)) {
      if (bTok.includes(t)) matched++;
      continue;
    }
    if (bTok.some((bt) => bt === t || bt.includes(t) || t.includes(bt))) matched++;
  }
  const ratio = matched / aTok.length;
  if (ratio < 0.55) return 0;
  return Math.round(ratio * 800);
}

function pickBest(excelName, items) {
  const manualKey = normName(excelName);
  if (manualKey in MANUAL_ITEM_ID) {
    const id = MANUAL_ITEM_ID[manualKey];
    if (id == null) return { status: 'NOT_IN_DB', match: null, score: 0, manual: true };
    const it = items.find((x) => x.id === id);
    return it
      ? { status: 'MATCHED', match: it, score: 9999, manual: true }
      : { status: 'NOT_FOUND', match: null, score: 0, manual: true };
  }
  const scored = items
    .map((it) => ({ it, score: matchScore(excelName, it.name) }))
    .filter((x) => x.score >= 500)
    .sort((a, b) => b.score - a.score);
  if (!scored.length) return { status: 'NOT_FOUND', match: null, score: 0 };
  if (scored.length > 1 && scored[0].score === scored[1].score) {
    return { status: 'AMBIGUOUS', matches: scored.slice(0, 3), score: scored[0].score };
  }
  return { status: 'MATCHED', match: scored[0].it, score: scored[0].score };
}

function nameSimilarity(a, b) {
  return matchScore(a, b);
}

async function ledgerBreakdown(itemId) {
  const [rows] = await pool.execute(
    `SELECT
       event_type,
       COALESCE(SUM(quantity_in), 0) AS qty_in,
       COALESCE(SUM(quantity_out), 0) AS qty_out,
       COUNT(*) AS events
     FROM inventory_ledger_entries
     WHERE inventory_item_id = ?
     GROUP BY event_type
     ORDER BY event_type`,
    [itemId]
  );
  const [total] = await pool.execute(
    `SELECT COALESCE(SUM(quantity_in - quantity_out), 0) AS ledger_stock
     FROM inventory_ledger_entries WHERE inventory_item_id = ?`,
    [itemId]
  );
  return { rows, ledgerStock: parseFloat(total[0].ledger_stock) || 0 };
}

async function salesSummary(itemId) {
  const [rows] = await pool.execute(
    `SELECT
       COUNT(DISTINCT s.id) AS sale_count,
       COALESCE(SUM(si.quantity), 0) AS qty_sold
     FROM sale_items si
     INNER JOIN sales s ON s.id = si.sale_id AND s.deleted_at IS NULL
     WHERE si.inventory_item_id = ?
       AND s.scope_type = ? AND s.scope_id = ?`,
    [itemId, SCOPE_TYPE, SCOPE_ID]
  );
  return rows[0];
}

async function returnsSummary(itemId) {
  try {
    const [rows] = await pool.execute(
      `SELECT
         COUNT(DISTINCT sr.id) AS return_count,
         COALESCE(SUM(sri.quantity), 0) AS qty_returned
       FROM sales_return_items sri
       INNER JOIN sales_returns sr ON sr.id = sri.return_id
       WHERE sri.inventory_item_id = ?`,
      [itemId]
    );
    return rows[0];
  } catch (_) {
    return { return_count: 0, qty_returned: 0 };
  }
}

async function purchaseSummary(itemId) {
  const [rows] = await pool.execute(
    `SELECT
       COUNT(DISTINCT poi.purchase_order_id) AS po_count,
       COALESCE(SUM(poi.quantity_ordered), 0) AS qty_ordered,
       COALESCE(SUM(poi.quantity_received), 0) AS qty_received
     FROM purchase_order_items poi
     INNER JOIN purchase_orders po ON po.id = poi.purchase_order_id
     WHERE poi.inventory_item_id = ?`,
    [itemId]
  );
  return rows[0];
}

async function recentLedger(itemId, limit = 8) {
  const [rows] = await pool.execute(
    `SELECT event_type, quantity_in, quantity_out, reference_type, reference_id, entry_date, created_at
     FROM inventory_ledger_entries
     WHERE inventory_item_id = ?
     ORDER BY created_at DESC, id DESC
     LIMIT ?`,
    [itemId, limit]
  );
  return rows;
}

(async () => {
  const excelRows = loadExcelRows();
  const [items] = await pool.execute(
    `SELECT id, sku, name, current_stock, created_at
     FROM inventory_items
     WHERE deleted_at IS NULL AND scope_type = ? AND scope_id = ?
     ORDER BY name`,
    [SCOPE_TYPE, SCOPE_ID]
  );
  const itemById = new Map(items.map((i) => [i.id, i]));

  // verify manual pawfect kitten 500g id
  const paw500 = items.filter((i) => normName(i.name).includes('pawfect') && normName(i.name).includes('500'));
  if (paw500.length === 1) MANUAL_ITEM_ID['pawfect kitten 500 g'] = paw500[0].id;
  else if (paw500.length) console.log('Note: pawfect 500g candidates:', paw500.map((x) => `${x.id}:${x.name}`));

  const mapped = [];
  for (const row of excelRows) {
    const pick = pickBest(row.name, items);
    let entry = {
      excelRow: row.row,
      excelName: row.name,
      excelQty: row.qty,
      pickStatus: pick.status,
      matchScore: pick.score || 0,
      manual: !!pick.manual,
    };

    if (pick.status === 'MATCHED') {
      const m = pick.match;
      const sim = nameSimilarity(row.name, m.name);
      entry = {
        ...entry,
        itemId: m.id,
        sku: m.sku,
        dbName: m.name,
        dbQty: parseFloat(m.current_stock) || 0,
        diff: row.qty - (parseFloat(m.current_stock) || 0),
        nameSim: sim,
        suspectWrongMatch: sim < 700 && !pick.manual,
      };
    } else if (pick.status === 'AMBIGUOUS') {
      entry.ambiguous = pick.matches.map((x) => `${x.it.id}:${x.it.name}(${x.it.current_stock})`);
    }
    mapped.push(entry);
  }

  const withDiff = mapped.filter((m) => m.itemId && m.diff !== 0);
  const wrongMatch = mapped.filter((m) => m.suspectWrongMatch);
  const ambiguous = mapped.filter((m) => m.pickStatus === 'AMBIGUOUS');
  const notInDb = mapped.filter((m) => m.pickStatus === 'NOT_IN_DB' || m.pickStatus === 'NOT_FOUND');

  console.log('='.repeat(90));
  console.log('WEAR EXCEL AUDIT — quantity differences & root cause');
  console.log('='.repeat(90));
  console.log(`Items with qty diff: ${withDiff.length}`);
  console.log(`Suspected wrong auto-match: ${wrongMatch.length}`);
  console.log(`Still ambiguous: ${ambiguous.length}`);
  console.log(`Not in DB: ${notInDb.length}`);

  if (wrongMatch.length) {
    console.log('\n### LIKELY WRONG PRODUCT MATCH (name similarity low)');
    for (const m of wrongMatch) {
      console.log(`  Row ${m.excelRow}: "${m.excelName}" -> "${m.dbName}" (score ${m.nameSim})`);
      console.log(`    Excel ${m.excelQty} vs DB ${m.dbQty} — diff may be meaningless until rematched`);
    }
  }

  if (ambiguous.length) {
    console.log('\n### AMBIGUOUS — need manual item pick');
    ambiguous.forEach((m) => console.log(`  Row ${m.excelRow}: "${m.excelName}" -> ${m.ambiguous?.join(' | ')}`));
  }

  if (notInDb.length) {
    console.log('\n### NOT IN DATABASE');
    notInDb.forEach((m) => console.log(`  Row ${m.excelRow}: "${m.excelName}" excel=${m.excelQty}`));
  }

  console.log('\n### QUANTITY DIFFERENCES — ledger / sales / returns / PO breakdown');
  console.log('-'.repeat(90));

  for (const m of withDiff.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff))) {
    const tag = m.suspectWrongMatch ? '[WRONG MATCH?]' : m.manual ? '[manual map]' : '';
    console.log(`\nRow ${m.excelRow} ${tag}`);
    console.log(`  Excel: "${m.excelName}" qty=${m.excelQty}`);
    console.log(`  DB:    id=${m.itemId} sku=${m.sku} "${m.dbName}" stock=${m.dbQty} diff=${m.diff}`);

    const { rows: lb, ledgerStock } = await ledgerBreakdown(m.itemId);
    const sales = await salesSummary(m.itemId);
    const returns = await returnsSummary(m.itemId);
    const po = await purchaseSummary(m.itemId);
    const recent = await recentLedger(m.itemId, 6);

    console.log(`  Ledger calc stock: ${ledgerStock} (cache current_stock: ${m.dbQty})`);
    console.log('  Ledger by type:', lb.map((r) => `${r.event_type}+${r.qty_in}/-${r.qty_out}(${r.events})`).join(', ') || 'none');
    console.log(`  Sales: ${sales.sale_count} invoices, ${sales.qty_sold} units sold`);
    console.log(`  Returns: ${returns.return_count} returns, ${returns.qty_returned} units back`);
    console.log(`  POs: ${po.po_count} orders, ordered=${po.qty_ordered}, received=${po.qty_received}`);

    const opening = lb.find((r) => r.event_type === 'OPENING');
    const purchased = lb.find((r) => r.event_type === 'PURCHASE');
    const sold = lb.find((r) => r.event_type === 'SALE');
    const ret = lb.find((r) => r.event_type === 'RETURN');
    const adjIn = lb.find((r) => r.event_type === 'ADJUSTMENT');

    const reasons = [];
    if (m.suspectWrongMatch) reasons.push('Excel row may be linked to wrong DB product');
    if (parseFloat(sales.qty_sold) > 0) reasons.push(`${sales.qty_sold} sold via POS`);
    if (parseFloat(returns.qty_returned) > 0) reasons.push(`${returns.qty_returned} returned`);
    if (parseFloat(po.qty_received) > 0 && m.diff > 0) reasons.push(`Only ${po.qty_received} received on PO vs excel ${m.excelQty}`);
    if (m.dbQty < 0) reasons.push('Negative stock — oversold vs receipts');
    if (opening && parseFloat(opening.qty_in) > 0 && m.diff > 0) {
      reasons.push(`Opening stock was ${opening.qty_in}, excel expects ${m.excelQty}`);
    }
    if (!reasons.length) reasons.push('Physical count (excel) differs from system movements');

    console.log(`  Likely why: ${reasons.join('; ')}`);
    console.log('  Recent ledger:');
    recent.forEach((r) => {
      console.log(
        `    ${String(r.created_at).slice(0, 10)} ${r.event_type} +${r.quantity_in}/-${r.quantity_out} ref=${r.reference_type}:${r.reference_id}`
      );
    });
  }

  await pool.end();
})().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch (_) {}
  process.exit(1);
});
