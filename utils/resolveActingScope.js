'use strict';

const { pool } = require('../config/database');

/**
 * Resolve sales/ledger scope_id string (branch or warehouse NAME) from scopeType + id/name.
 */
async function resolveScopeName(connection, scopeType, scopeId) {
  if (!scopeType || scopeId == null || scopeId === '') return null;

  const st = String(scopeType).toUpperCase();
  const sid = String(scopeId);
  const isNumeric = /^\d+$/.test(sid);

  if (st === 'BRANCH') {
    const [rows] = await connection.execute(
      isNumeric
        ? 'SELECT name FROM branches WHERE id = ? LIMIT 1'
        : 'SELECT name FROM branches WHERE name = ? LIMIT 1',
      [isNumeric ? parseInt(sid, 10) : sid]
    );
    return rows[0]?.name || null;
  }

  if (st === 'WAREHOUSE') {
    const [rows] = await connection.execute(
      isNumeric
        ? 'SELECT name FROM warehouses WHERE id = ? LIMIT 1'
        : 'SELECT name FROM warehouses WHERE name = ? LIMIT 1',
      [isNumeric ? parseInt(sid, 10) : sid]
    );
    return rows[0]?.name || null;
  }

  return null;
}

/**
 * Resolve the acting POS/ledger scope for the current user.
 * - Cashier / warehouse keeper: always locked to their assigned scope.
 * - Admin: uses optional query/body scopeType + scopeId when provided (POS admin mode).
 */
async function resolveActingScope(req, queryScope = {}) {
  const user = req.user || {};
  const userBranchId = user.branch_id || user.branchId;
  const userWarehouseId = user.warehouse_id || user.warehouseId;

  let scopeType = null;
  let scopeId = null;
  let scopeName = null;

  if (user.role === 'CASHIER') {
    scopeType = 'BRANCH';
    scopeId = userBranchId || null;
    scopeName = user.branchName || null;
    if (!scopeName && userBranchId) {
      scopeName = await resolveScopeName(pool, 'BRANCH', userBranchId);
    }
  } else if (user.role === 'WAREHOUSE_KEEPER') {
    scopeType = 'WAREHOUSE';
    scopeId = userWarehouseId || null;
    scopeName = user.warehouseName || null;
    if (!scopeName && userWarehouseId) {
      scopeName = await resolveScopeName(pool, 'WAREHOUSE', userWarehouseId);
    }
  } else if (user.role === 'ADMIN') {
    // Explicit query/body scope wins; otherwise fall back to the simulated scope
    // the admin picked in the simulation panel (sent as x-simulate-scope-* headers).
    const simulated = req.simulatedScope || {};
    const rawType = queryScope.scopeType || simulated.scopeType || null;
    const rawId =
      queryScope.scopeId != null && queryScope.scopeId !== ''
        ? queryScope.scopeId
        : simulated.scopeId;

    const qType = rawType ? String(rawType).toUpperCase() : null;
    if (qType && rawId != null && rawId !== '') {
      scopeType = qType;
      scopeId = /^\d+$/.test(String(rawId)) ? parseInt(rawId, 10) : rawId;
      scopeName = await resolveScopeName(pool, qType, rawId);
    }
  }

  return { scopeType, scopeId, scopeName };
}

module.exports = {
  resolveScopeName,
  resolveActingScope,
};
