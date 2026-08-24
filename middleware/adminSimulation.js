/**
 * Admin scope simulation.
 *
 * The frontend stores the admin's selected branch/warehouse in sessionStorage and
 * sends it on every request as x-simulate-scope-type / x-simulate-scope-id.
 *
 * Endpoints read scope in three different ways: req.user.branchId/warehouseId,
 * req.query.scopeType/scopeId, and req.body.scopeType/scopeId (the last one is
 * enforced by express-validator, which returns 400 when it is missing). So the
 * simulated scope is applied to all three, otherwise creating anything while
 * simulating fails validation.
 *
 * Routes that manage the scopes themselves must stay unscoped.
 */

const SCOPE_AGNOSTIC_PREFIXES = [
  '/auth',
  '/admin',
  '/trash',
  '/branches',
  '/warehouses',
  '/dashboard',
];

const isScopeAgnostic = (path) =>
  SCOPE_AGNOSTIC_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`)
  );

const hasScope = (target) =>
  Boolean(
    target &&
      target.scopeType != null &&
      String(target.scopeType).trim() !== '' &&
      target.scopeId != null &&
      String(target.scopeId).trim() !== ''
  );

const adminSimulation = (req, res, next) => {
  // If no user yet (auth hasn't run), skip
  if (!req.user || req.user.role !== 'ADMIN') return next();

  const rawType = req.headers['x-simulate-scope-type'];
  const rawId = req.headers['x-simulate-scope-id'];
  if (!rawType || !rawId) return next();

  const scopeType = String(rawType).trim().toUpperCase();
  const scopeId = parseInt(String(rawId).trim(), 10);
  if (!Number.isInteger(scopeId) || scopeId < 1) return next();
  if (scopeType !== 'BRANCH' && scopeType !== 'WAREHOUSE') return next();

  if (scopeType === 'WAREHOUSE') {
    req.user.warehouseId = scopeId;
    req.user.warehouse_id = scopeId;
    req.user.branchId = null;
    req.user.branch_id = null;
    req.user.simulatedRole = 'WAREHOUSE_KEEPER';
  } else {
    req.user.branchId = scopeId;
    req.user.branch_id = scopeId;
    req.user.warehouseId = null;
    req.user.warehouse_id = null;
    req.user.simulatedRole = 'CASHIER';
  }

  req.user.isSimulating = true;
  req.simulatedScope = { scopeType, scopeId };

  if (!isScopeAgnostic(req.path)) {
    // Explicit scope on the request always wins over the simulated one
    if (req.query && !hasScope(req.query)) {
      req.query.scopeType = scopeType;
      req.query.scopeId = String(scopeId);
    }
    if (req.body && typeof req.body === 'object' && !Array.isArray(req.body) && !hasScope(req.body)) {
      req.body.scopeType = scopeType;
      req.body.scopeId = String(scopeId);
    }
  }

  next();
};

module.exports = adminSimulation;
