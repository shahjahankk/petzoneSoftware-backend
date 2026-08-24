require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { pool } = require('../config/database');

const SAMPLE_ITEMS = [
  { id: 1916, label: 'Whiskas fish 1+ jelly' },
  { id: 1575, label: 'Pawfect Adult 1 kg' },
  { id: 1642, label: 'Jungle meat paste Duck' },
];

(async () => {
  console.log('=== INVENTORY AUDIT TRAIL (proof in database) ===\n');

  for (const { id, label } of SAMPLE_ITEMS) {
    const [item] = await pool.execute(
      'SELECT id, sku, name, current_stock FROM inventory_items WHERE id=?',
      [id]
    );
    console.log(`--- ${label} (${item[0].sku}) stock=${item[0].current_stock} ---`);

    const [ledger] = await pool.execute(
      `SELECT id, event_type, quantity_in, quantity_out, reference_type, reference_id,
              entry_date, created_at, created_by
       FROM inventory_ledger_entries
       WHERE inventory_item_id=?
       ORDER BY created_at DESC, id DESC
       LIMIT 12`,
      [id]
    );
    console.log('Recent ledger entries (newest first):');
    ledger.forEach((e) => {
      const net = (+e.quantity_in || 0) - (+e.quantity_out || 0);
      console.log(
        `  ${String(e.created_at).slice(0, 19)} | ${e.event_type.padEnd(10)} | ${net >= 0 ? '+' : ''}${net} | ref=${e.reference_type}:${e.reference_id}`
      );
    });

    const [wearAdj] = await pool.execute(
      `SELECT * FROM inventory_ledger_entries
       WHERE inventory_item_id=? AND reference_type='wear_excel_reconcile'
       ORDER BY created_at DESC LIMIT 1`,
      [id]
    );
    if (wearAdj.length) {
      const a = wearAdj[0];
      console.log(`  >> EXCEL FIX: ${a.created_at} ADJUST +${a.quantity_in}/-${a.quantity_out} ref=${a.reference_id}`);
    }

    const [pos] = await pool.execute(
      `SELECT po.order_number, po.status, po.order_date, poi.quantity_ordered, poi.quantity_received, poi.id AS poi_id
       FROM purchase_order_items poi
       INNER JOIN purchase_orders po ON po.id = poi.purchase_order_id
       WHERE poi.inventory_item_id=?
       ORDER BY po.id DESC LIMIT 5`,
      [id]
    );
    if (pos.length) {
      console.log('Purchase orders:');
      pos.forEach((p) =>
        console.log(`  ${p.order_number} [${p.status}] date=${String(p.order_date).slice(0, 10)} ordered=${p.quantity_ordered} received=${p.quantity_received} (poi ${p.poi_id})`)
      );
    }

    const [sales] = await pool.execute(
      `SELECT s.id, s.invoice_no, s.sale_date, s.created_at, si.quantity, s.customer_name
       FROM sale_items si
       INNER JOIN sales s ON s.id=si.sale_id AND s.deleted_at IS NULL
       WHERE si.inventory_item_id=?
       ORDER BY s.created_at DESC LIMIT 5`,
      [id]
    );
    console.log(`Sales (sale_items table, last ${sales.length}):`);
    sales.forEach((s) =>
      console.log(`  ${s.invoice_no} sale_id=${s.id} date=${String(s.sale_date || s.created_at).slice(0, 10)} qty=${s.quantity} customer=${s.customer_name || '-'}`)
    );

    const [ledgerSales] = await pool.execute(
      `SELECT reference_id, quantity_out, created_at
       FROM inventory_ledger_entries
       WHERE inventory_item_id=? AND event_type='SALE'
       ORDER BY created_at DESC LIMIT 3`,
      [id]
    );
    console.log('Ledger SALE refs (warehouse path, last 3):');
    ledgerSales.forEach((s) =>
      console.log(`  ${String(s.created_at).slice(0, 19)} qty=-${s.quantity_out} ref=${s.reference_id}`)
    );
    console.log('');
  }

  const [adjCount] = await pool.execute(
    `SELECT COUNT(*) AS c FROM inventory_ledger_entries WHERE reference_type='wear_excel_reconcile'`
  );
  const [poCompleted] = await pool.execute(
    `SELECT order_number, status, actual_delivery, updated_at FROM purchase_orders
     WHERE order_number IN ('PO-WH-202605-0008','PO-WH-202606-0003')`
  );
  console.log('=== SUMMARY ===');
  console.log(`Excel reconcile adjustments in ledger: ${adjCount[0].c} rows`);
  console.log('Completed POs from fix:');
  poCompleted.forEach((p) =>
    console.log(`  ${p.order_number} status=${p.status} delivery=${p.actual_delivery} updated=${p.updated_at}`)
  );
  console.log('\nProof location: table inventory_ledger_entries (immutable event log)');
  console.log('Each row: event_type, qty in/out, reference_type, reference_id, created_at, created_by');

  await pool.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
