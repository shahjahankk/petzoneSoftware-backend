require('dotenv').config();
const mysql = require('mysql2/promise');

(async () => {
  const c = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    connectTimeout: 20000,
  });
  await c.query('USE `' + process.env.DB_NAME + '`');

  const like = '%abdullah%';

  const [tables] = await c.query(
    `SELECT TABLE_NAME FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = ?
       AND (TABLE_NAME LIKE '%trash%' OR TABLE_NAME LIKE '%delete%' OR TABLE_NAME LIKE '%deleted%')
     ORDER BY TABLE_NAME`,
    [process.env.DB_NAME]
  );
  console.log('=== DELETE / TRASH TABLES ===');
  console.table(tables);

  // Soft-deleted customers / retailers
  const [custDel] = await c.query(
    `SELECT id, name, phone, branch_id, warehouse_id, status, deleted_at
     FROM customers WHERE name LIKE ? AND deleted_at IS NOT NULL`,
    [like]
  );
  const [retDel] = await c.query(
    `SELECT id, name, phone, warehouse_id, status, deleted_at
     FROM retailers WHERE name LIKE ? AND deleted_at IS NOT NULL`,
    [like]
  );
  console.log('=== SOFT-DELETED CUSTOMERS (Abdullah) ===');
  console.table(custDel.length ? custDel : [{ result: 'none' }]);
  console.log('=== SOFT-DELETED RETAILERS (Abdullah) ===');
  console.table(retDel.length ? retDel : [{ result: 'none' }]);

  // trash table — entity_data is JSON
  const [trash] = await c.query(
    `SELECT id, entity_type, entity_id, deleted_by, deleted_at, expires_at, is_expired,
            entity_data
     FROM trash
     WHERE LOWER(entity_data) LIKE ?
        OR LOWER(CONCAT(entity_type, ' ', entity_id)) LIKE ?`,
    [like, like]
  );

  console.log('=== TRASH rows matching Abdullah ===');
  if (!trash.length) {
    console.table([{ result: 'none' }]);
  } else {
    console.table(
      trash.map((r) => {
        let name = null;
        try {
          const d = typeof r.entity_data === 'string' ? JSON.parse(r.entity_data) : r.entity_data;
          name = d?.name || d?.customer_name || d?.retailer_name || null;
        } catch (_) {}
        return {
          id: r.id,
          entity_type: r.entity_type,
          entity_id: r.entity_id,
          name,
          deleted_by: r.deleted_by,
          deleted_at: r.deleted_at,
          expires_at: r.expires_at,
          is_expired: r.is_expired,
        };
      })
    );
  }

  // Also list any trash customer/retailer regardless of name, in case spelling differs
  const [trashParties] = await c.query(
    `SELECT id, entity_type, entity_id, deleted_at, is_expired, entity_data
     FROM trash
     WHERE entity_type IN ('customer', 'customers', 'retailer', 'retailers', 'CUSTOMER', 'RETAILER')
     ORDER BY deleted_at DESC
     LIMIT 50`
  );
  console.log('=== Recent trash customer/retailer entries (any name) ===');
  if (!trashParties.length) {
    console.table([{ result: 'none' }]);
  } else {
    console.table(
      trashParties.map((r) => {
        let name = null;
        try {
          const d = typeof r.entity_data === 'string' ? JSON.parse(r.entity_data) : r.entity_data;
          name = d?.name || d?.customer_name || null;
        } catch (_) {}
        return {
          id: r.id,
          entity_type: r.entity_type,
          entity_id: r.entity_id,
          name,
          deleted_at: r.deleted_at,
          is_expired: r.is_expired,
        };
      })
    );
  }

  await c.end();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
