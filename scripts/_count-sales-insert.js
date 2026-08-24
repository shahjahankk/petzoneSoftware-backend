require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { pool } = require('../config/database');

const whSql = `(?, 'WAREHOUSE', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'COMPLETED', ?, ?, ?, ?, ?, ?, ?, ?)`;
const whCols = `user_id, scope_type, scope_id, invoice_no, subtotal, tax, discount, total, payment_method, payment_type, payment_status, payment_amount, credit_amount, old_balance, running_balance, status, customer_info, customer_name, customer_phone, notes, retailer_id, sale_date, created_at, updated_at`;

console.log('columns:', whCols.split(',').length);
console.log('placeholders:', (whSql.match(/\?/g) || []).length);
console.log('params expected:', 22);

(async () => {
  // Dry-run with NULL transaction rollback — validate SQL shape only
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute(
      `INSERT INTO sales (${whCols}) VALUES ${whSql}`,
      [
        10, 'Unit 6 Warehouse', 'TEST-SQL-CHECK', 20000, 0, 0, 20000,
        'FULLY_CREDIT', 'FULLY_CREDIT', 'PENDING', 0, 20000, 0, 0,
        JSON.stringify({ test: true }), 'SQL Check', '000', 'diag', 33,
        null, '2026-06-25 12:00:00', '2026-06-25 12:00:00',
      ]
    );
    await conn.rollback();
    console.log('INSERT SQL shape: OK (rolled back)');
  } catch (e) {
    await conn.rollback();
    console.error('INSERT failed:', e.message);
    process.exitCode = 1;
  } finally {
    conn.release();
    await pool.end();
  }
})();
