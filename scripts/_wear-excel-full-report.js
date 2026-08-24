require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { pool } = require('../config/database');

const EXCEL_PATH = 'C:\\Users\\HP\\Downloads\\wear total iteam input.xlsx';
const DIFF_ONLY = process.argv.includes('--diff-only') || !process.argv.includes('--all');
const OUT_CSV = path.join(
  __dirname,
  DIFF_ONLY ? 'wear-excel-diff-report.csv' : 'wear-excel-full-report.csv'
);
const SCOPE_TYPE = 'WAREHOUSE';
const SCOPE_ID = '2';

/** Confirmed excel→DB id map (handles typos: kittan, uniary, mealty, past, chichen, etc.) */
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
  'whiskas meals meaty 1+ in gravy': 1917,
  'whiskas chef choice 1+ in gravy': 1925,
  'whiskas catch of the day 1+ in gravy': 1924,
  'whiskas ocean delight 1+ in jelly': 2782,
};

const TYPO_FIX = [
  [/kittan/g, 'kitten'],
  [/chichen/g, 'chicken'],
  [/uniary/g, 'urinary'],
  [/mealty/g, 'meaty'],
  [/past/g, 'paste'],
  [/ocea/g, 'ocean'],
  [/jeily/g, 'jelly'],
  [/gravyy/g, 'gravy'],
  [/felicia/g, 'felicia'],
];

function normName(s) {
  let x = String(s || '').toLowerCase();
  for (const [re, rep] of TYPO_FIX) x = x.replace(re, rep);
  return x
    .replace(/[^a-z0-9+]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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
  if (b.includes(a) || a.includes(b)) return 920;
  const aNums = (a.match(/\d+/g) || []);
  const bNums = (b.match(/\d+/g) || []);
  if (aNums.length && !aNums.every((n) => bNums.includes(n))) return 0;
  const aTok = a.split(' ').filter((t) => t.length > 1);
  const bTok = b.split(' ').filter((t) => t.length > 1);
  let hit = 0;
  for (const t of aTok) {
    if (/^\d+$/.test(t)) {
      if (bTok.includes(t)) hit++;
    } else if (bTok.some((bt) => bt === t || bt.startsWith(t) || t.startsWith(bt))) hit++;
  }
  const ratio = hit / Math.max(aTok.length, 1);
  return ratio >= 0.6 ? Math.round(ratio * 850) : 0;
}

function resolveMatch(excelName, items) {
  const key = normName(excelName);
  if (CONFIRMED_ID_BY_EXCEL_NORM[key] != null) {
    const it = items.find((x) => x.id === CONFIRMED_ID_BY_EXCEL_NORM[key]);
    if (it) {
      return {
        item: it,
        matchType: 'CONFIRMED',
        score: 9999,
        note: key.includes('ocean') ? 'Only DB row is legacy SKU WH-UNIT6… (duplicate naming)' : '',
      };
    }
  }
  const scored = items
    .map((it) => ({ it, score: matchScore(excelName, it.name) }))
    .filter((x) => x.score >= 550)
    .sort((a, b) => b.score - a.score);
  if (!scored.length) return { item: null, matchType: 'NOT_FOUND', score: 0, note: 'No product in DB' };
  if (scored.length > 1 && scored[0].score - scored[1].score < 80) {
    return {
      item: scored[0].it,
      matchType: 'REVIEW',
      score: scored[0].score,
      note: `Ambiguous: also ${scored[1].it.name.slice(0, 40)}…`,
    };
  }
  const top = scored[0];
  return {
    item: top.it,
    matchType: top.score >= 850 ? 'AUTO' : 'REVIEW',
    score: top.score,
    note: top.score < 850 ? 'Low name similarity — verify match' : '',
  };
}

async function getMovements(itemId) {
  const [rows] = await pool.execute(
    `SELECT event_type,
            COALESCE(SUM(quantity_in),0) AS in_qty,
            COALESCE(SUM(quantity_out),0) AS out_qty
     FROM inventory_ledger_entries WHERE inventory_item_id = ?
     GROUP BY event_type`,
    [itemId]
  );
  const m = {};
  for (const r of rows) m[r.event_type] = { in: parseFloat(r.in_qty), out: parseFloat(r.out_qty) };
  const [tot] = await pool.execute(
    `SELECT COALESCE(SUM(quantity_in-quantity_out),0) AS ledger_stock FROM inventory_ledger_entries WHERE inventory_item_id=?`,
    [itemId]
  );
  const [po] = await pool.execute(
    `SELECT COALESCE(SUM(quantity_received),0) AS received, COUNT(DISTINCT purchase_order_id) AS po_count
     FROM purchase_order_items WHERE inventory_item_id=?`,
    [itemId]
  );
  return {
    opening: m.OPENING?.in || 0,
    purchased: m.PURCHASE?.in || 0,
    sold: m.SALE?.out || 0,
    returned: m.RETURN?.in || 0,
    restocked: m.RESTOCK?.in || 0,
    adjIn: m.ADJUSTMENT?.in || 0,
    adjOut: m.ADJUSTMENT?.out || 0,
    ledgerStock: parseFloat(tot[0].ledger_stock) || 0,
    poReceived: parseFloat(po[0].received) || 0,
    poCount: po[0].po_count || 0,
  };
}

function buildReason(row) {
  if (!row.itemId) return 'Product not found in database';
  if (row.matchType === 'REVIEW') return `Match needs review: ${row.matchNote || 'similar names in DB'}`;
  if (row.diff === 0) return 'Excel count matches system stock';

  const parts = [];
  if (row.matchNote) parts.push(row.matchNote);
  if (row.sold > 0) parts.push(`${row.sold} sold on POS`);
  if (row.poReceived > 0) parts.push(`${row.poReceived} received on ${row.poCount} PO(s)`);
  if (row.opening > 0 && row.adjOut >= row.opening * 0.9) {
    parts.push(`Opening ${row.opening} was cleared by May-25 inventory reconcile adjustment`);
  }
  if (row.dbQty < 0) parts.push('Oversold vs receipts (negative stock allowed)');
  if (row.diff > 0 && row.dbQty <= 0) {
    parts.push('Excel shows stock but system is zero/sold out — unrecorded receipt or count date mismatch');
  } else if (row.diff > 0) {
    parts.push('Physical count higher than system — possible unrecorded stock or under-counted sales');
  } else if (row.diff < 0) {
    parts.push('System shows more than Excel — possible over-count in system or Excel under-count');
  }
  return parts.filter(Boolean).join('; ') || 'Count variance';
}

function csvEscape(v) {
  const s = String(v ?? '');
  return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
}

(async () => {
  const excelRows = loadExcelRows();
  const [items] = await pool.execute(
    `SELECT id, sku, name, current_stock FROM inventory_items
     WHERE deleted_at IS NULL AND scope_type=? AND scope_id=?`,
    [SCOPE_TYPE, SCOPE_ID]
  );

  const report = [];
  for (const ex of excelRows) {
    const { item, matchType, score, note } = resolveMatch(ex.name, items);
    let mov = {
      opening: 0, purchased: 0, sold: 0, returned: 0, restocked: 0,
      adjIn: 0, adjOut: 0, ledgerStock: 0, poReceived: 0, poCount: 0,
    };
    if (item) mov = await getMovements(item.id);
    const dbQty = item ? parseFloat(item.current_stock) || 0 : null;
    const diff = item ? ex.qty - dbQty : null;

    report.push({
      row: ex.row,
      excelName: ex.name,
      excelQty: ex.qty,
      matchType,
      matchScore: score,
      itemId: item?.id ?? '',
      sku: item?.sku ?? '',
      dbName: item?.name ?? '',
      dbQty,
      diff,
      opening: mov.opening,
      poReceived: mov.poReceived,
      poCount: mov.poCount,
      sold: mov.sold,
      returned: mov.returned,
      restocked: mov.restocked,
      adjOut: mov.adjOut,
      ledgerStock: mov.ledgerStock,
      matchNote: note,
      status: !item ? 'NOT_IN_DB' : diff === 0 ? 'OK' : 'QTY_DIFF',
    });
  }

  for (const r of report) r.reason = buildReason(r);

  const ok = report.filter((r) => r.status === 'OK');
  const diff = report.filter((r) => r.status === 'QTY_DIFF');
  const notInDb = report.filter((r) => r.status === 'NOT_IN_DB');
  const output = DIFF_ONLY ? [...diff, ...notInDb] : report;

  const headers = [
    'Row', 'Excel Item', 'Excel Qty', 'Match', 'Score', 'SKU', 'DB Item', 'DB Qty', 'Diff',
    'Opening', 'PO Rcvd', 'POs', 'Sold', 'Returns', 'Restock', 'Adj Out', 'Ledger', 'Status', 'Reason',
  ];

  const lines = [headers.join(',')];
  for (const r of output) {
    lines.push(
      [
        r.row, r.excelName, r.excelQty, r.matchType, r.matchScore, r.sku, r.dbName, r.dbQty, r.diff,
        r.opening, r.poReceived, r.poCount, r.sold, r.returned, r.restocked, r.adjOut, r.ledgerStock,
        r.status, r.reason,
      ].map(csvEscape).join(',')
    );
  }
  fs.writeFileSync(OUT_CSV, lines.join('\n'), 'utf8');

  const review = output.filter((r) => r.matchType === 'REVIEW');
  const sortedDiff = [...output].sort((a, b) => Math.abs(b.diff ?? 0) - Math.abs(a.diff ?? 0));

  console.log('='.repeat(100));
  console.log(
    DIFF_ONLY
      ? `WEAR EXCEL DIFF REPORT — ${output.length} items with quantity difference (excluded ${ok.length} OK matches)`
      : `WEAR EXCEL FULL REPORT — ${report.length} items`
  );
  console.log(`CSV saved: ${OUT_CSV}`);
  console.log('='.repeat(100));

  console.log(
    ['#', 'Excel Qty', 'DB Qty', 'Diff', 'Sold', 'PO Rcvd', 'SKU', 'Excel → DB'].join(' | ')
  );
  console.log('-'.repeat(120));
  for (const r of sortedDiff) {
    const dbLabel = r.dbName ? r.dbName.slice(0, 36) : '—';
    console.log(
      [
        String(r.row).padStart(2),
        String(r.excelQty).padStart(5),
        String(r.dbQty ?? '—').padStart(5),
        String(r.diff ?? '—').padStart(5),
        String(r.sold).padStart(5),
        String(r.poReceived).padStart(5),
        (r.sku || '—').padEnd(10),
        `${r.excelName.slice(0, 26)} → ${dbLabel}`,
      ].join(' | ')
    );
  }

  console.log('\n### DETAIL — why each diff');
  for (const r of sortedDiff) {
    console.log(`\n${r.row}. ${r.excelName}`);
    console.log(`   DB: ${r.dbName} (${r.sku})`);
    console.log(`   Excel ${r.excelQty} | DB ${r.dbQty} | Diff ${r.diff} | Match: ${r.matchType}`);
    console.log(`   Movements: opening ${r.opening}, PO +${r.poReceived}, sold -${r.sold}, returns +${r.returned}, adj out -${r.adjOut}`);
    console.log(`   Why: ${r.reason}`);
  }

  if (review.length) {
    console.log('\n### VERIFY MATCH');
    review.forEach((r) => console.log(`  ${r.row}. ${r.excelName} → ${r.dbName} (${r.matchNote})`));
  }

  if (DIFF_ONLY && ok.length) {
    console.log(`\n(Excluded ${ok.length} OK rows: ${ok.map((r) => r.row).join(', ')})`);
  }

  await pool.end();
})().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch (_) {}
  process.exit(1);
});
