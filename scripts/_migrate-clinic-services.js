require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { pool } = require('../config/database');

(async () => {
  const fix = process.argv.includes('--fix');
  console.log(fix ? '*** APPLY clinic services schema ***' : '*** DRY RUN ***\n');

  const statements = [
    `CREATE TABLE IF NOT EXISTS clinic_service_categories (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      description VARCHAR(500) NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
      sort_order INT NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_clinic_cat_name (name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS clinic_services (
      id INT AUTO_INCREMENT PRIMARY KEY,
      category_id INT NULL,
      name VARCHAR(200) NOT NULL,
      description VARCHAR(500) NULL,
      default_price DECIMAL(12,2) NOT NULL DEFAULT 0,
      code VARCHAR(50) NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
      sort_order INT NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_clinic_svc_cat (category_id),
      KEY idx_clinic_svc_status (status),
      CONSTRAINT fk_clinic_svc_cat FOREIGN KEY (category_id)
        REFERENCES clinic_service_categories(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  ];

  for (const sql of statements) {
    console.log(sql.split('\n')[0] + '...');
    if (fix) await pool.execute(sql);
  }

  const [cols] = await pool.execute(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sale_items' AND COLUMN_NAME = 'clinic_service_id'`
  );
  if (!cols.length) {
    const alter =
      'ALTER TABLE sale_items ADD COLUMN clinic_service_id INT NULL AFTER inventory_item_id';
    console.log(alter);
    if (fix) await pool.execute(alter);
  } else {
    console.log('sale_items.clinic_service_id already exists');
  }

  if (fix) {
    const [catCount] = await pool.execute('SELECT COUNT(*) AS c FROM clinic_service_categories');
    if (parseInt(catCount[0].c, 10) === 0) {
      await pool.execute(
        `INSERT INTO clinic_service_categories (name, description, status, sort_order) VALUES
         ('Grooming', 'Pet grooming services', 'ACTIVE', 1),
         ('Consultation', 'Vet / clinic consultation', 'ACTIVE', 2)`
      );
      const [cats] = await pool.execute('SELECT id, name FROM clinic_service_categories');
      const grooming = cats.find((c) => c.name === 'Grooming');
      const consult = cats.find((c) => c.name === 'Consultation');
      if (grooming) {
        await pool.execute(
          `INSERT INTO clinic_services (category_id, name, default_price, code, status, sort_order) VALUES
           (?, 'Nail Trimming', 500, 'CLINIC-TRIM', 'ACTIVE', 1),
           (?, 'Full Grooming', 2500, 'CLINIC-GROOM', 'ACTIVE', 2)`,
          [grooming.id, grooming.id]
        );
      }
      if (consult) {
        await pool.execute(
          `INSERT INTO clinic_services (category_id, name, default_price, code, status, sort_order) VALUES
           (?, 'General Consultancy', 1500, 'CLINIC-CONSULT', 'ACTIVE', 1)`,
          [consult.id]
        );
      }
      console.log('Seeded sample clinic categories/services');
    }
  }

  console.log('\nDone.');
  await pool.end();
})().catch(async (e) => {
  console.error(e.message);
  try {
    await pool.end();
  } catch (_) {}
  process.exit(1);
});
