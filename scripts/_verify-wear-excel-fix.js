require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const XLSX = require('xlsx');
const { pool } = require('../config/database');

const EXCEL_PATH = 'C:\\Users\\HP\\Downloads\\wear total iteam input.xlsx';
const CONFIRMED = {
  'felicia urinary 2 kg': 1619,'felicia digest 2 kg': 1615,'felicia urinary 12 kg': 2408,'felicia digest 12 kg': 1616,
  'felicia derma 2 kg': 1617,'felicia kitten chicken 2 kg': 1607,'felicia kitten lamb 2 kg': 1612,'felicia kitten chicken12 kg': 1608,
  'felicia kitten lamb 12 kg': 1613,'felicia pouch adult salmon 85 g': 1599,'felicia pouch kitten chicken 85g': 1597,
  'felicia pouch kitten lamb 85g': 1598,'felicia pouch adult chicken 85g': 1601,'jungle kitten 15 kg': 1629,'jungle kitten 1 5 kg': 1628,
  'jungle adult 15 kg': 1634,'jungle adult 1 5 kg': 1633,'jungle pouch kitten': 1636,'jungle pouch adult': 1637,'jungle pate kitten': 1644,
  'jungle pate adult': 1643,'jungle creamy treat chicken': 1638,'jungle creamy treat salmon': 1640,'jungle creamy treat tuna': 1639,
  'jungle meat past duck': 1642,'jungle meat past salmon': 1641,'jungle meat paste duck': 1642,'jungle meat paste salmon': 1641,
  'pawfect kitten 1 kg': 1574,'pawfect kitten 500 g': 1576,'pawfect adult 1 kg': 1575,'pawfect adult 500 g': 1577,'pawfect adult 10 kg': 2312,
  'big paw 3 kg': 1579,'puppy paw 3 kg': 1578,'big paw high energy 20 kg': 1580,'whiskas poultry 2 12 in jelly': 2395,
  'whiskas poultry 1+ in gravy': 1919,'whiskas poultry 1+ in jelly': 1920,'whiskas fish 2 12 in jelly': 2396,'whiskas fish 1+ in jelly': 1916,
  'whiskas mixed menu 1+ in jelly': 1918,'whiskas mixed menu 2 12 in jelly': 1923,'whiskas meals mealty 1+ in gravy': 1917,
  'whiskas meals meaty 1+ in gravy': 1917,'whiskas chef choice 1+ in gravy': 1925,'whiskas catch of the day 1+ in gravy': 1924,
  'whiskas ocean delight 1+ in jelly': 2782,
};

function norm(s) {
  return String(s||'').toLowerCase().replace(/kittan/g,'kitten').replace(/uniary/g,'urinary').replace(/mealty/g,'meaty')
    .replace(/past/g,'paste').replace(/[^a-z0-9+]/g,' ').replace(/\s+/g,' ').trim();
}
function key(name) {
  const k = norm(name);
  return CONFIRMED[k] != null ? k : k.replace(/meaty/g,'mealty');
}

(async () => {
  const wb = XLSX.readFile(EXCEL_PATH);
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
  let ok = 0, bad = 0;
  console.log('VERIFY all excel items vs DB stock\n');
  for (let i = 0; i < rows.length; i++) {
    const name = String(rows[i]['Iteam ']||'').trim();
    if (!name) continue;
    const k = key(name);
    const id = CONFIRMED[k];
    const excel = parseFloat(rows[i].PCS)||0;
    if (!id) { console.log('NO MAP', i+1, name); bad++; continue; }
    const [r] = await pool.execute('SELECT sku, current_stock FROM inventory_items WHERE id=?', [id]);
    const db = +r[0].current_stock;
    const match = db === excel;
    if (match) ok++; else { bad++; console.log(`DIFF row ${i+1} ${name.slice(0,30)} excel=${excel} db=${db} sku=${r[0].sku}`); }
  }
  console.log(`\nOK: ${ok} | Still diff: ${bad} | Total: ${ok+bad}`);
  const [pos] = await pool.execute(
    `SELECT order_number, status FROM purchase_orders WHERE order_number IN ('PO-WH-202605-0008','PO-WH-202606-0003')`
  );
  console.log('\nPO status:', pos);
  await pool.end();
})();
