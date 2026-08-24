/**
 * Backfill clinic_service_id on historical sale_items that were sold as
 * inventory but are actually clinic services (by catalog name match).
 *
 * Also ensures common legacy names (e.g. "Clinic fees") exist in clinic_services.
 *
 * Does NOT clear inventory_item_id (preserves stock history).
 * Reports treat clinic_service_id / name-match as clinic revenue.
 *
 * Usage: node scripts/_backfill-clinic-sale-items.js
 */
require('dotenv').config();
const mysql = require('mysql2/promise');

const nameEq = (a, b) =>
  `CONVERT(LOWER(TRIM(${a})) USING utf8mb4) COLLATE utf8mb4_unicode_ci = CONVERT(LOWER(TRIM(${b})) USING utf8mb4) COLLATE utf8mb4_unicode_ci`;

async function ensureService(conn, { name, categoryName, defaultPrice = 0, code = null }) {
  const [existing] = await conn.execute(
    `SELECT id FROM clinic_services WHERE name = ? LIMIT 1`,
    [name]
  );
  if (existing.length) return existing[0].id;

  let categoryId = null;
  if (categoryName) {
    const [cats] = await conn.execute(
      `SELECT id FROM clinic_service_categories WHERE name = ? LIMIT 1`,
      [categoryName]
    );
    if (cats.length) {
      categoryId = cats[0].id;
    } else {
      const [insCat] = await conn.execute(
        `INSERT INTO clinic_service_categories (name, description, status, sort_order)
         VALUES (?, ?, 'ACTIVE', 0)`,
        [categoryName, `Auto-created for legacy clinic sales`]
      );
      categoryId = insCat.insertId;
    }
  }

  const [ins] = await conn.execute(
    `INSERT INTO clinic_services (category_id, name, default_price, code, status, sort_order)
     VALUES (?, ?, ?, ?, 'ACTIVE', 0)`,
    [categoryId, name, defaultPrice, code]
  );
  console.log(`Created clinic service "${name}" id=${ins.insertId}`);
  return ins.insertId;
}

(async () => {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT || 3306,
  });

  console.log('DB', process.env.DB_NAME);

  // Legacy inventory names that were used as clinic services
  await ensureService(conn, {
    name: 'Clinic fees',
    categoryName: 'Consultation',
    defaultPrice: 600,
    code: 'CLINIC-FEES',
  });
  await ensureService(conn, {
    name: 'Cat Shower',
    categoryName: 'Grooming',
    defaultPrice: 3000,
    code: 'CLINIC-CATSHOWER',
  });

  // Preview matches needing tag
  const [preview] = await conn.execute(
    `SELECT si.id, si.sale_id, si.name, si.inventory_item_id, si.clinic_service_id,
            cs.id AS match_id, cs.name AS match_name, s.invoice_no, s.scope_id, si.total
     FROM sale_items si
     INNER JOIN sales s ON s.id = si.sale_id
     INNER JOIN clinic_services cs ON ${nameEq('si.name', 'cs.name')}
     WHERE s.deleted_at IS NULL
       AND si.clinic_service_id IS NULL
     ORDER BY si.id`
  );
  console.log(`\nLines to tag: ${preview.length}`);
  console.table(preview.slice(0, 40));

  const [result] = await conn.execute(
    `UPDATE sale_items si
     INNER JOIN clinic_services cs ON ${nameEq('si.name', 'cs.name')}
     SET si.clinic_service_id = cs.id,
         si.sku = CASE
           WHEN si.sku IS NULL OR si.sku = '' OR UPPER(si.sku) NOT LIKE 'CLINIC-%'
             THEN CONCAT('CLINIC-', cs.id)
           ELSE si.sku
         END
     WHERE si.clinic_service_id IS NULL`
  );

  console.log(`\nUpdated rows: ${result.affectedRows}`);

  const [after] = await conn.execute(
    `SELECT COUNT(*) AS tagged FROM sale_items WHERE clinic_service_id IS NOT NULL`
  );
  console.log('Total sale_items with clinic_service_id:', after[0].tagged);

  const [byScope] = await conn.execute(
    `SELECT s.scope_id, COUNT(*) AS line_count, ROUND(SUM(si.total),2) AS revenue
     FROM sale_items si
     JOIN sales s ON s.id = si.sale_id
     WHERE si.clinic_service_id IS NOT NULL AND s.deleted_at IS NULL
     GROUP BY s.scope_id
     ORDER BY revenue DESC`
  );
  console.log('\nClinic-tagged revenue by scope:');
  console.table(byScope);

  await conn.end();
  console.log('\nDone.');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
