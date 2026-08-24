/**
 * Export Unit 6 Warehouse (Hyderabad / HYDWH) inventory to Excel
 * for Latifabad upload: no prices, empty current_stock, no SKU.
 */
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const mysql = require('mysql2/promise');
const XLSX = require('xlsx');

(async () => {
  const WAREHOUSE_ID = 2; // Unit 6 Warehouse / HYDWH
  const outName = 'unit6-warehouse-inventory-for-latifabad-v2.xlsx';
  const outPath = path.join(__dirname, '..', '..', outName);
  const oldPath = path.join(__dirname, '..', '..', 'unit6-warehouse-inventory-for-latifabad.xlsx');

  try {
    if (fs.existsSync(oldPath)) {
      fs.unlinkSync(oldPath);
      console.log('Deleted old file:', oldPath);
    }
  } catch (e) {
    console.log('Could not delete old file (close it in Excel):', e.code || e.message);
  }

  const c = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });

  const [[wh]] = await c.query(
    'SELECT id, name, code FROM warehouses WHERE id = ?',
    [WAREHOUSE_ID]
  );
  if (!wh) throw new Error('Warehouse not found');

  const [rows] = await c.query(
    `SELECT
       name,
       barcode,
       category,
       description,
       unit,
       min_stock_level,
       max_stock_level
     FROM inventory_items
     WHERE scope_type = 'WAREHOUSE'
       AND scope_id IN (?, ?)
       AND (deleted_at IS NULL OR deleted_at = '0000-00-00 00:00:00')
     ORDER BY category ASC, name ASC`,
    [String(WAREHOUSE_ID), WAREHOUSE_ID]
  );

  await c.end();

  // Import-friendly: no prices, no SKU (auto-assigned), empty current_stock
  const exportRows = rows.map((r) => ({
    name: r.name || '',
    barcode: r.barcode || '',
    category: r.category || 'General',
    description: r.description || '',
    current_stock: '',
    unit: r.unit || 'pcs',
    min_stock_level: Number(r.min_stock_level) || 0,
    max_stock_level: Number(r.max_stock_level) || 0,
  }));

  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.json_to_sheet(exportRows);
  worksheet['!cols'] = [
    { wch: 40 }, // name
    { wch: 18 }, // barcode
    { wch: 18 }, // category
    { wch: 35 }, // description
    { wch: 14 }, // current_stock (empty)
    { wch: 8 }, // unit
    { wch: 14 }, // min
    { wch: 14 }, // max
  ];
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Inventory');
  XLSX.writeFile(workbook, outPath);

  const withBarcode = exportRows.filter((r) => r.barcode).length;
  console.log(`Warehouse: ${wh.name} (${wh.code}) #${wh.id}`);
  console.log(`Items exported: ${exportRows.length}`);
  console.log(`With barcode: ${withBarcode}`);
  console.log(`current_stock: empty | sku: removed`);
  console.log(`Saved: ${outPath}`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
