require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const XLSX = require('xlsx');
const { pool } = require('../config/database');

const EXCEL_PATH = 'C:\\Users\\HP\\Downloads\\wear total iteam input.xlsx';
const SCOPE_TYPE = 'WAREHOUSE';
const SCOPE_ID = '2';

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
  if (aNums.length) {
    const allPresent = aNums.every((n) => bNums.includes(n));
    if (!allPresent) return 0;
  }

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
  const scored = items
    .map((it) => ({ it, score: matchScore(excelName, it.name) }))
    .filter((x) => x.score >= 500)
    .sort((a, b) => b.score - a.score);

  if (!scored.length) return { status: 'NOT_FOUND', matches: [] };
  if (scored.length > 1 && scored[0].score === scored[1].score) {
    return { status: 'MULTIPLE', matches: scored.slice(0, 3).map((x) => x.it) };
  }
  return { status: 'MATCHED', match: scored[0].it, score: scored[0].score };
}

(async () => {
  const excelRows = loadExcelRows();
  const [items] = await pool.execute(
    `SELECT id, sku, name, current_stock
     FROM inventory_items
     WHERE deleted_at IS NULL AND scope_type = ? AND scope_id = ?
     ORDER BY name ASC`,
    [SCOPE_TYPE, SCOPE_ID]
  );

  const results = [];
  for (const row of excelRows) {
    const pick = pickBest(row.name, items);
    if (pick.status === 'MATCHED') {
      const dbQty = parseFloat(pick.match.current_stock) || 0;
      results.push({
        excelRow: row.row,
        excelName: row.name,
        excelQty: row.qty,
        itemId: pick.match.id,
        sku: pick.match.sku,
        dbName: pick.match.name,
        dbQty,
        diff: row.qty - dbQty,
        status: 'MATCHED',
        score: pick.score,
      });
    } else if (pick.status === 'MULTIPLE') {
      results.push({
        excelRow: row.row,
        excelName: row.name,
        excelQty: row.qty,
        status: 'MULTIPLE',
        dbName: pick.matches.map((m) => `${m.id}:${m.name}(${m.current_stock})`).join(' | '),
      });
    } else {
      results.push({
        excelRow: row.row,
        excelName: row.name,
        excelQty: row.qty,
        status: 'NOT_FOUND',
      });
    }
  }

  const matched = results.filter((r) => r.status === 'MATCHED');
  const same = matched.filter((r) => r.diff === 0);
  const different = matched.filter((r) => r.diff !== 0);

  console.log(`Excel items: ${excelRows.length}`);
  console.log(`Matched: ${matched.length} | Same qty: ${same.length} | Different: ${different.length}`);
  console.log(`Multiple: ${results.filter((r) => r.status === 'MULTIPLE').length}`);
  console.log(`Not found: ${results.filter((r) => r.status === 'NOT_FOUND').length}`);

  console.log('\n--- ALL MATCHED: EXCEL QTY vs DB QTY ---');
  console.log(
    ['Row', 'Excel', 'DB', 'Diff', 'SKU', 'Excel name', 'DB name'].map((h) => h.padEnd(12)).join('')
  );
  console.log('-'.repeat(120));
  for (const r of matched) {
    const mark = r.diff === 0 ? 'OK' : 'DIFF';
    console.log(
      [
        String(r.excelRow),
        String(r.excelQty),
        String(r.dbQty),
        String(r.diff),
        r.sku || '-',
        r.excelName.slice(0, 30),
        r.dbName.slice(0, 35),
        mark,
      ]
        .map((v, i) => String(v).padEnd(i === 5 || i === 6 ? 32 : 12))
        .join('')
    );
  }

  const notFound = results.filter((r) => r.status === 'NOT_FOUND');
  if (notFound.length) {
    console.log('\n--- NOT FOUND ---');
    notFound.forEach((r) => console.log(`  ${r.excelRow}. "${r.excelName}" excel=${r.excelQty}`));
  }

  const multi = results.filter((r) => r.status === 'MULTIPLE');
  if (multi.length) {
    console.log('\n--- AMBIGUOUS ---');
    multi.forEach((r) => console.log(`  ${r.excelRow}. "${r.excelName}" -> ${r.dbName}`));
  }

  await pool.end();
})().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch (_) {}
  process.exit(1);
});
