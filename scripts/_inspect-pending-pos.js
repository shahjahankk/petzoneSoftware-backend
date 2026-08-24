require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { pool } = require('../config/database');

const PO_NUMBERS = ['PO-WH-202605-0008', 'PO-WH-202606-0003'];
const WEAR_IDS = new Set([
  1619,1615,2408,1616,1617,1607,1612,1608,1613,1599,1597,1598,1601,
  1629,1628,1634,1633,1636,1637,1644,1643,1638,1640,1639,1642,1641,
  1574,1576,1575,1577,2312,1579,1578,1580,2395,1919,1920,2396,1916,1918,1923,1917,1925,1924,2782,
]);

(async () => {
  for (const num of PO_NUMBERS) {
    const [po] = await pool.execute('SELECT id, order_number, status FROM purchase_orders WHERE order_number=?', [num]);
    if (!po.length) { console.log('Missing', num); continue; }
    const id = po[0].id;
    const [lines] = await pool.execute(
      `SELECT poi.id, poi.inventory_item_id, poi.item_name, poi.quantity_ordered, poi.quantity_received
       FROM purchase_order_items poi WHERE poi.purchase_order_id=? ORDER BY poi.id`,
      [id]
    );
    console.log(`\n${num} id=${id} status=${po[0].status} lines=${lines.length}`);
    let wear = 0, other = 0;
    lines.forEach((l) => {
      const tag = WEAR_IDS.has(l.inventory_item_id) ? 'WEAR' : 'OTHER';
      if (tag === 'WEAR') wear++; else other++;
      if (l.quantity_received < l.quantity_ordered) {
        console.log(`  [${tag}] poi=${l.id} inv=${l.inventory_item_id} ord=${l.quantity_ordered} rcv=${l.quantity_received} ${l.item_name?.slice(0,50)}`);
      }
    });
    console.log(`  wear lines: ${wear}, other lines: ${other}`);
  }
  await pool.end();
})();
