/**
 * Sales, customer ledger, and several other tables store scope_id as the
 * branch/warehouse *name* (not numeric id). Renaming without remapping those
 * rows makes history disappear from UI filters (data is orphaned, not deleted).
 *
 * Inventory often uses numeric id — we only remap rows whose scope_id exactly
 * equals the old name string.
 */

const { pool } = require('../config/database');

/** @type {Array<{ table: string, scopeTypeCol?: string, scopeIdCol?: string }>} */
const NAME_SCOPED_TARGETS = [
  { table: 'sales' },
  { table: 'customer_ledger_entries' },
  { table: 'invoice_snapshots' },
  { table: 'ledgers' },
  { table: 'financial_vouchers' },
  { table: 'inventory_items' },
  { table: 'inventory_ledger_entries' },
  { table: 'stock_reports' },
  { table: 'shifts' },
  { table: 'pos' },
  { table: 'hardware_sessions' },
  { table: 'hardware_devices' },
  { table: 'billing' },
  { table: 'companies' },
  { table: 'purchase_orders' },
  { table: 'held_bills' },
  { table: 'retailers' },
];

async function tableExists(conn, tableName) {
  const [rows] = await conn.execute(
    `SELECT 1 AS ok
     FROM information_schema.tables
     WHERE table_schema = DATABASE() AND table_name = ?
     LIMIT 1`,
    [tableName]
  );
  return rows.length > 0;
}

async function columnExists(conn, tableName, columnName) {
  const [rows] = await conn.execute(
    `SELECT 1 AS ok
     FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?
     LIMIT 1`,
    [tableName, columnName]
  );
  return rows.length > 0;
}

/**
 * Some tables (e.g. ledgers) declare scope_id as INT. Comparing such a column to
 * a name string makes MySQL coerce the name to 0, which matches unrelated rows.
 * Only name-typed columns may be remapped.
 */
async function isTextColumn(conn, tableName, columnName) {
  const [rows] = await conn.execute(
    `SELECT DATA_TYPE
     FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?
     LIMIT 1`,
    [tableName, columnName]
  );
  const type = String(rows[0]?.DATA_TYPE || '').toLowerCase();
  return ['char', 'varchar', 'tinytext', 'text', 'mediumtext', 'longtext', 'enum'].includes(type);
}

/**
 * Remap scope_id from oldName → newName for a given scope type (BRANCH | WAREHOUSE).
 * @returns {Promise<{ remapped: Array<{ table: string, affected: number }>, scopeType: string, oldName: string, newName: string }>}
 */
async function remapScopeName(scopeType, oldName, newName, externalConn = null) {
  const normalizedType = String(scopeType || '').toUpperCase();
  if (normalizedType !== 'BRANCH' && normalizedType !== 'WAREHOUSE') {
    throw new Error(`Unsupported scope type for remap: ${scopeType}`);
  }

  const trimmedOld = oldName != null ? String(oldName).trim() : '';
  const trimmedNew = newName != null ? String(newName).trim() : '';

  if (!trimmedOld || !trimmedNew || trimmedOld === trimmedNew) {
    return { remapped: [], skipped: [], scopeType: normalizedType, oldName: trimmedOld, newName: trimmedNew };
  }

  const ownsConnection = !externalConn;
  const conn = externalConn || (await pool.getConnection());
  const remapped = [];
  const skipped = [];

  try {
    if (ownsConnection) await conn.beginTransaction();

    for (const target of NAME_SCOPED_TARGETS) {
      const table = target.table;
      if (!(await tableExists(conn, table))) continue;

      const scopeTypeCol = target.scopeTypeCol || 'scope_type';
      const scopeIdCol = target.scopeIdCol || 'scope_id';

      if (!(await columnExists(conn, table, scopeTypeCol))) continue;
      if (!(await columnExists(conn, table, scopeIdCol))) continue;
      if (!(await isTextColumn(conn, table, scopeIdCol))) {
        skipped.push({ table, column: scopeIdCol, reason: 'scope_id is not a name column' });
        continue;
      }

      const sql = `
        UPDATE \`${table}\`
        SET \`${scopeIdCol}\` = ?
        WHERE \`${scopeTypeCol}\` = ?
          AND \`${scopeIdCol}\` = ?
      `;
      const [result] = await conn.execute(sql, [trimmedNew, normalizedType, trimmedOld]);
      const affected = result.affectedRows || 0;
      if (affected > 0) {
        remapped.push({ table, affected });
      }
    }

    // Transfers may use from/to scope columns
    if (await tableExists(conn, 'transfers')) {
      const transferCols = [
        ['from_scope_type', 'from_scope_id'],
        ['to_scope_type', 'to_scope_id'],
        ['source_scope_type', 'source_scope_id'],
        ['destination_scope_type', 'destination_scope_id'],
      ];
      for (const [typeCol, idCol] of transferCols) {
        if (!(await columnExists(conn, 'transfers', typeCol))) continue;
        if (!(await columnExists(conn, 'transfers', idCol))) continue;
        if (!(await isTextColumn(conn, 'transfers', idCol))) {
          skipped.push({ table: 'transfers', column: idCol, reason: 'scope_id is not a name column' });
          continue;
        }
        const [result] = await conn.execute(
          `UPDATE transfers SET \`${idCol}\` = ? WHERE \`${typeCol}\` = ? AND \`${idCol}\` = ?`,
          [trimmedNew, normalizedType, trimmedOld]
        );
        if (result.affectedRows) {
          remapped.push({ table: `transfers.${idCol}`, affected: result.affectedRows });
        }
      }
    }

    if (ownsConnection) await conn.commit();
    return { remapped, skipped, scopeType: normalizedType, oldName: trimmedOld, newName: trimmedNew };
  } catch (error) {
    if (ownsConnection) {
      try { await conn.rollback(); } catch (_) { /* ignore */ }
    }
    throw error;
  } finally {
    if (ownsConnection) conn.release();
  }
}

async function remapBranchScopeName(oldName, newName, externalConn = null) {
  return remapScopeName('BRANCH', oldName, newName, externalConn);
}

async function remapWarehouseScopeName(oldName, newName, externalConn = null) {
  return remapScopeName('WAREHOUSE', oldName, newName, externalConn);
}

module.exports = {
  remapScopeName,
  remapBranchScopeName,
  remapWarehouseScopeName,
};
