/**
 * Fix wear-excel inventory diffs:
 * 1) Complete pending POs that were never received (PO-WH-202605-0008, PO-WH-202606-0003)
 * 2) ADJUSTMENT each of the 37 diff items to Excel physical count (ledger-safe)
 *
 * Usage: node scripts/_fix-wear-excel-inventory.js          # dry run
 *        node scripts/_fix-wear-excel-inventory.js --fix   # apply
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { pool } = require('../config/database');
const PurchaseOrder = require('../models/PurchaseOrder').PurchaseOrder;
const PurchaseOrderItem = require('../models/PurchaseOrder').PurchaseOrderItem;
const { updateInventoryFromPurchaseOrder } = require('../controllers/purchaseOrderController');
const InventoryProjection = require('../services/inventoryProjectionService');

const EXCEL_PATH = 'C:\\Users\\HP\\Downloads\\wear total iteam input.xlsx';
const APPLY = process.argv.includes('--fix');
const CREATED_BY = 1;
const PO_NUMBERS = ['PO-WH-202605-0008', 'PO-WH-202606-0003'];
const ADJ_REF_PREFIX = 'wear_excel_stock_fix:v1';

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
  'jungle meat paste duck': 1642,
  'jungle meat paste salmon': 1641,
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

const WEAR_ITEM_IDS = new Set(Object.values(CONFIRMED_ID_BY_EXCEL_NORM).filter(Boolean));

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

function excelLookupKey(name) {
  const key = normName(name);
  if (CONFIRMED_ID_BY_EXCEL_NORM[key] != null) return key;
  const alt = key.replace(/meaty/g, 'mealty');
  if (CONFIRMED_ID_BY_EXCEL_NORM[alt] != null) return alt;
  return key;
}

function loadExcelTargets() {
  const wb = XLSX.readFile(EXCEL_PATH);
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
  const targets = [];
  rows.forEach((r, idx) => {
    const name = String(r['Iteam '] || r['Iteam'] || '').trim();
    if (!name) return;
    const key = excelLookupKey(name);
    const itemId = CONFIRMED_ID_BY_EXCEL_NORM[key];
    if (!itemId) {
      console.warn('No map for excel row', idx + 1, name, 'key=', key);
      return;
    }
    const qty = parseFloat(r.PCS ?? 0) || 0;
    targets.push({ row: idx + 1, name, itemId, excelQty: qty });
  });
  return targets;
}

async function getStock(itemId) {
  const [r] = await pool.execute('SELECT id, sku, name, current_stock FROM inventory_items WHERE id=?', [itemId]);
  return r[0] ? { ...r[0], current_stock: parseFloat(r[0].current_stock) || 0 } : null;
}

async function completePendingPo(orderNumber) {
  const [poRows] = await pool.execute(
    'SELECT id, order_number, status FROM purchase_orders WHERE order_number=?',
    [orderNumber]
  );
  if (!poRows.length) return { orderNumber, skipped: 'PO not found' };
  const po = poRows[0];
  if (po.status === 'COMPLETED') return { orderNumber, skipped: 'already COMPLETED' };
  if (po.status !== 'PENDING') return { orderNumber, skipped: `status=${po.status}` };

  const [pendingLines] = await pool.execute(
    `SELECT poi.id, poi.inventory_item_id, poi.item_name, poi.quantity_ordered, poi.quantity_received
     FROM purchase_order_items poi WHERE poi.purchase_order_id=? AND poi.quantity_received < poi.quantity_ordered`,
    [po.id]
  );

  const plan = pendingLines.map((l) => ({
    poiId: l.id,
    itemId: l.inventory_item_id,
    name: l.item_name,
    add: (+l.quantity_ordered || 0) - (+l.quantity_received || 0),
    wear: WEAR_ITEM_IDS.has(l.inventory_item_id),
  }));

  if (!APPLY) {
    return { orderNumber, poId: po.id, action: 'would COMPLETE', lines: plan };
  }

  await PurchaseOrder.updateStatus(po.id, 'COMPLETED', new Date().toISOString().split('T')[0]);
  const orderItems = await PurchaseOrderItem.findByOrderId(po.id);
  for (const item of orderItems) {
    if (!item.quantityReceived || item.quantityReceived === 0) {
      await pool.execute(
        'UPDATE purchase_order_items SET quantity_received = ? WHERE id = ?',
        [item.quantityOrdered, item.id]
      );
    }
  }
  await updateInventoryFromPurchaseOrder(po.id);
  return { orderNumber, poId: po.id, action: 'COMPLETED', lines: plan };
}

async function adjustToExcel(targets) {
  const results = [];
  for (const t of targets) {
    const item = await getStock(t.itemId);
    if (!item) {
      results.push({ ...t, error: 'item not found' });
      continue;
    }
    const before = item.current_stock;
    const delta = t.excelQty - before;
    if (Math.abs(delta) < 0.001) {
      results.push({ ...t, sku: item.sku, dbName: item.name, before, after: before, delta: 0, action: 'OK' });
      continue;
    }

    if (!APPLY) {
      results.push({
        ...t,
        sku: item.sku,
        dbName: item.name,
        before,
        after: t.excelQty,
        delta,
        action: delta > 0 ? `ADJUST +${delta}` : `ADJUST -${Math.abs(delta)}`,
      });
      continue;
    }

    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [scopeRows] = await connection.execute(
        'SELECT scope_type, scope_id FROM inventory_items WHERE id=?',
        [t.itemId]
      );
      const scope = scopeRows[0];
      const refId = `${ADJ_REF_PREFIX}:${t.itemId}`;
      const params =
        delta > 0
          ? {
              event_type: 'ADJUSTMENT',
              inventory_item_id: t.itemId,
              scope_type: String(scope.scope_type).toUpperCase(),
              scope_id: String(scope.scope_id ?? ''),
              quantity_in: delta,
              quantity_out: 0,
              reference_type: 'wear_excel_reconcile',
              reference_id: refId,
              created_by: CREATED_BY,
            }
          : {
              event_type: 'ADJUSTMENT',
              inventory_item_id: t.itemId,
              scope_type: String(scope.scope_type).toUpperCase(),
              scope_id: String(scope.scope_id ?? ''),
              quantity_in: 0,
              quantity_out: Math.abs(delta),
              reference_type: 'wear_excel_reconcile',
              reference_id: refId,
              created_by: CREATED_BY,
            };
      await InventoryProjection.applyEvent(connection, params);
      await connection.commit();
    } catch (e) {
      await connection.rollback();
      results.push({ ...t, error: e.message, before });
      continue;
    } finally {
      connection.release();
    }

    const afterRow = await getStock(t.itemId);
    results.push({
      ...t,
      sku: item.sku,
      dbName: item.name,
      before,
      after: afterRow.current_stock,
      delta,
      action: 'ADJUSTED',
    });
  }
  return results;
}

(async () => {
  console.log(APPLY ? '*** APPLY MODE ***' : 'DRY RUN (use --fix to apply)');
  const targets = loadExcelTargets();
  const diffTargets = [];
  for (const t of targets) {
    const item = await getStock(t.itemId);
    if (!item) continue;
    if (item.current_stock !== t.excelQty) diffTargets.push({ ...t, before: item.current_stock });
  }
  console.log(`Excel wear items: ${targets.length}, need fix: ${diffTargets.length}`);

  console.log('\n--- Step 1: Complete pending POs ---');
  const poResults = [];
  for (const num of PO_NUMBERS) {
    const r = await completePendingPo(num);
    poResults.push(r);
    console.log(JSON.stringify(r, null, 2));
  }

  console.log('\n--- Step 2: Adjust stock to Excel (37 diff items) ---');
  const adjustResults = await adjustToExcel(
    targets.map((t) => ({ ...t, before: undefined }))
  );

  const remaining = adjustResults.filter((r) => r.after !== undefined && r.after !== r.excelQty);
  const fixed = adjustResults.filter((r) => r.after === r.excelQty || r.action === 'OK' || r.action === 'ADJUSTED');

  console.log('\n--- FINAL REPORT ---');
  console.log(['Row', 'Item', 'Excel', 'Before', 'After', 'Action'].join(' | '));
  console.log('-'.repeat(90));
  for (const r of adjustResults.sort((a, b) => a.itemId - b.itemId)) {
    console.log(
      [
        r.name?.slice(0, 28),
        r.excelQty,
        r.before ?? '-',
        r.after ?? '-',
        r.action || r.error || '',
      ].join(' | ')
    );
  }

  const outPath = path.join(__dirname, 'wear-excel-fix-result.json');
  fs.writeFileSync(
    outPath,
    JSON.stringify({ apply: APPLY, poResults, adjustResults, remaining }, null, 2),
    'utf8'
  );
  console.log(`\nSaved: ${outPath}`);
  console.log(`Matched Excel after fix: ${fixed.length}/${adjustResults.length}`);
  if (remaining.length) console.log(`Still off: ${remaining.length}`);

  await pool.end();
})().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch (_) {}
  process.exit(1);
});
