require('dotenv').config();
const mysql = require('mysql2/promise');

async function main() {
  const qConfig = {
    host: process.env.QUEUE_DB_HOST || process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.QUEUE_DB_NAME || 'petzonep_queue-management',
  };

  const qConn = await mysql.createConnection(qConfig);
  console.log('Queue DB:', qConfig.database);

  try {
    await qConn.query(`
      ALTER TABLE qms_branches
      ADD COLUMN pos_branch_id INT UNSIGNED DEFAULT NULL,
      ADD KEY idx_pos_branch (pos_branch_id)
    `);
    console.log('Added pos_branch_id column');
  } catch (e) {
    if (e.code === 'ER_DUP_FIELDNAME') console.log('pos_branch_id already exists');
    else throw e;
  }

  const pConn = await mysql.createConnection({
    ...qConfig,
    database: process.env.DB_NAME || 'petzonep_software',
  });

  const [posBranches] = await pConn.query("SELECT id, name FROM branches WHERE status = 'ACTIVE' ORDER BY id");
  console.log('POS branches:', posBranches.length);

  for (const pb of posBranches) {
    const keyword = pb.name.split(' ').pop().toLowerCase();
    const [result] = await qConn.query(
      `UPDATE qms_branches SET pos_branch_id = ?
       WHERE pos_branch_id IS NULL AND (LOWER(name) LIKE ? OR LOWER(slug) LIKE ?)
       LIMIT 1`,
      [pb.id, `%${keyword}%`, `%${keyword}%`]
    );
    if (result.affectedRows) console.log(`Linked: POS #${pb.id} (${pb.name})`);
  }

  if (posBranches.length && !posBranches.some(() => false)) {
    const firstPos = posBranches[0];
    await qConn.query(
      'UPDATE qms_branches SET pos_branch_id = ? WHERE slug = ? AND pos_branch_id IS NULL LIMIT 1',
      [firstPos.id, 'main']
    );
  }

  const [linked] = await qConn.query('SELECT id, name, slug, pos_branch_id FROM qms_branches');
  console.log('\nQMS branches:');
  linked.forEach((b) => console.log(`  ${b.name} (${b.slug}) -> POS #${b.pos_branch_id || 'not linked'}`));

  await qConn.end();
  await pConn.end();
  console.log('Done');
}

main().catch((e) => { console.error(e.message); process.exit(1); });
