require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { pool } = require('../config/database');

const TARGETS = [
  { label: 'Felix Original Lamb 85g', target: 24, patterns: [/felix.*lamb.*85/i, /lamb.*85.*felix/i] },
  { label: 'Felix Pouch Original Chicken jelly 85g', target: 408, patterns: [/felix.*chicken.*jelly.*85/i, /felix.*pouch.*chicken/i] },
  { label: 'Felix Cat Pouch Original Salmon Jelly 85g', target: 168, patterns: [/felix.*salmon.*jelly.*85/i, /felix.*salmon/i] },
  { label: 'Gourmet pouch perle with Beef 85g', target: 52, patterns: [/gou?met.*beef.*85/i, /perle.*beef/i] },
  { label: 'Gourmet Pouch Perle With Chicken 85g', target: 104, patterns: [/gou?met.*chicken.*85/i, /perle.*chicken/i] },
  { label: 'Gourmet Pouch Perle With Duo Salmon&Saithe 85g', target: 0, patterns: [/gou?met.*salmon.*saithe/i, /duo.*salmon/i] },
  { label: 'Wanpy Meat Paste Duck&Pumpkin 90g', target: 0, patterns: [/wanpy.*duck.*pumpkin/i, /wanpy.*duck/i] },
  { label: 'Wanpy Meat Paste Chicken & Carrot 90g', target: 310, patterns: [/wanpy.*chicken.*carrot/i] },
];

(async () => {
  const [wh] = await pool.execute('SELECT id, name, code FROM warehouses ORDER BY id');
  console.log('WAREHOUSES:');
  wh.forEach((w) => console.log(`  ${w.id}: ${w.name} (${w.code || 'no code'})`));

  const [items] = await pool.execute(`
    SELECT id, name, sku, current_stock, scope_type, scope_id
    FROM inventory_items
    WHERE deleted_at IS NULL AND scope_type = 'WAREHOUSE'
      AND (
        LOWER(name) LIKE '%felix%'
        OR LOWER(name) LIKE '%gourmet%'
        OR LOWER(name) LIKE '%goumet%'
        OR LOWER(name) LIKE '%wanpy%'
      )
    ORDER BY scope_id, name
  `);

  console.log(`\nFound ${items.length} warehouse items matching Felix/Gourmet/Wanpy:\n`);
  for (const item of items) {
    const whName = wh.find((w) => String(w.id) === String(item.scope_id));
    console.log(JSON.stringify({ ...item, warehouse: whName?.name || item.scope_id }));
  }

  console.log('\n--- MATCH TO TARGETS ---\n');
  for (const t of TARGETS) {
    const matches = items.filter((item) => t.patterns.some((p) => p.test(item.name)));
    console.log(`${t.label} => target ${t.target}`);
    if (!matches.length) {
      console.log('  NOT FOUND');
    } else {
      matches.forEach((m) => {
        const whName = wh.find((w) => String(w.id) === String(m.scope_id));
        console.log(`  id=${m.id} stock=${m.current_stock} wh=${whName?.name} name=${m.name}`);
      });
    }
    console.log('');
  }

  await pool.end();
})().catch(async (e) => {
  console.error(e);
  await pool.end();
  process.exit(1);
});
