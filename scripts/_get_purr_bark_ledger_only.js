// Internal script: fetch ledger for customer "The Purr & Bark" (phone 03151334544).
process.env.DB_HOST = process.env.DB_HOST || 'h40.eu.core.hostnext.net';
process.env.DB_PORT = process.env.DB_PORT || '3306';
process.env.DB_USER = process.env.DB_USER || 'petzonep_test';
process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'kaimkhankhani@123';
process.env.DB_NAME = process.env.DB_NAME || 'petzonep_software';

const { pool } = require('../config/database');

async function main() {
  const [customers] = await pool.execute(
    `SELECT id, name, email, phone, address, city, state, zip_code, customer_type, credit_limit, current_balance, payment_terms, branch_id, warehouse_id, notes, status, created_at, updated_at
     FROM customers WHERE phone = ? ORDER BY id`,
    ['03151334544']
  );
  console.log('CUSTOMERS WITH PHONE 03151334544:', JSON.stringify(customers, null, 2));

  for (const c of customers) {
    const [ledgers] = await pool.execute(
      `SELECT id, scope_type, scope_id, party_type, party_id, balance, currency, status, account_name, account_type, description, created_at, updated_at
       FROM ledgers WHERE party_id = ? ORDER BY id`,
      [c.id]
    );
    console.log(`LEDGERS FOR CUSTOMER ${c.id} (${c.name}):`, JSON.stringify(ledgers, null, 2));

    for (const l of ledgers) {
      const [entries] = await pool.execute(
        `SELECT id, entry_type, reference_id, description, debit_amount, credit_amount, branch_id, created_by, created_at
         FROM ledger_entries WHERE branch_id = ? ORDER BY created_at DESC LIMIT 500`,
        [l.id]
      );
      console.log(`LEDGER ${l.id} (${l.account_name}) ENTRIES:`, JSON.stringify(entries, null, 2));
    }
  }
  await pool.end();
}

main().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
