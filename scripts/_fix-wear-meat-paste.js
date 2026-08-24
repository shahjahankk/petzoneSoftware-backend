require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { pool } = require('../config/database');
const InventoryProjection = require('../services/inventoryProjectionService');

const FIX = [
  { id: 1642, name: 'Jungle Meat Paste Duck', excel: 230 },
  { id: 1641, name: 'Jungle Meat Paste Salmon', excel: 220 },
];

(async () => {
  for (const f of FIX) {
    const [r] = await pool.execute('SELECT current_stock, scope_type, scope_id FROM inventory_items WHERE id=?', [f.id]);
    const before = +r[0].current_stock;
    const delta = f.excel - before;
    console.log(f.name, 'before', before, 'excel', f.excel, 'delta', delta);
    if (Math.abs(delta) < 0.001) continue;
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await InventoryProjection.applyEvent(conn, {
        event_type: 'ADJUSTMENT',
        inventory_item_id: f.id,
        scope_type: String(r[0].scope_type).toUpperCase(),
        scope_id: String(r[0].scope_id ?? ''),
        quantity_in: delta > 0 ? delta : 0,
        quantity_out: delta < 0 ? Math.abs(delta) : 0,
        reference_type: 'wear_excel_reconcile',
        reference_id: `wear_excel_stock_fix:v1:${f.id}`,
        created_by: 1,
      });
      await conn.commit();
    } finally {
      conn.release();
    }
    const [a] = await pool.execute('SELECT current_stock FROM inventory_items WHERE id=?', [f.id]);
    console.log('  after', a[0].current_stock);
  }
  await pool.end();
})();
