require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { pool } = require('../config/database');
const WarehouseSale = require('../models/WarehouseSale');

(async () => {
  const [keepers] = await pool.execute(
    `SELECT id, username, warehouse_id FROM users WHERE role = 'WAREHOUSE_KEEPER' AND warehouse_id = 2 LIMIT 1`
  );
  const keeperId = keepers[0]?.id;
  if (!keeperId) throw new Error('No warehouse keeper found for warehouse 2');
  console.log('Using keeper:', keepers[0]);

  const saleData = {
    retailerId: 33,
    warehouseKeeperId: keeperId,
    items: [{
      itemId: 1584,
      inventoryItemId: 1584,
      sku: 'WH055',
      name: 'Nourvet  Gold wild Fish & Brown Rice 1kg',
      quantity: 20,
      unitPrice: 1000,
      discount: 0,
      totalPrice: 20000,
    }],
    subtotal: 20000,
    taxAmount: 0,
    discountAmount: 0,
    billAmount: 20000,
    totalWithOutstanding: 20000,
    paymentMethod: 'FULLY_CREDIT',
    paymentType: 'FULLY_CREDIT',
    paymentStatus: 'PENDING',
    paymentAmount: 0,
    creditAmount: 20000,
    scopeWarehouseId: 2,
    customerInfo: { id: 33, name: 'Dr Ahtesham MPK', phone: '03378319234' },
    notes: 'diag test',
    saleDate: null,
    outstandingPayments: [],
  };

  console.log('Creating test warehouse sale (will rollback if you want - this COMMITS!)...');
  const result = await WarehouseSale.create(saleData, 'Dr Ahtesham MPK', 'FULLY_CREDIT', null);
  console.log('SUCCESS:', result?.invoiceNumber || result?.invoice_number || result);
  await pool.end();
  process.exit(0);
})().catch(async (e) => {
  console.error('FAILED:', e.message);
  console.error(e.stack);
  try { await pool.end(); } catch (_) {}
  process.exit(1);
});
