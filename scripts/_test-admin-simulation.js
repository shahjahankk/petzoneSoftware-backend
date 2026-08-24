/**
 * Verifies admin scope simulation injects scope into user/query/body.
 * Usage: node scripts/_test-admin-simulation.js
 */
const adminSimulation = require('../middleware/adminSimulation');

const run = (label, req, assert) => {
  adminSimulation(req, {}, () => {});
  const result = assert(req);
  console.log(`${result ? 'PASS' : 'FAIL'}  ${label}`);
  if (!result) {
    console.log('   user :', { branchId: req.user.branchId, warehouseId: req.user.warehouseId });
    console.log('   query:', req.query);
    console.log('   body :', req.body);
  }
  return result;
};

const simHeaders = (type, id) => ({
  'x-simulate-scope-type': type,
  'x-simulate-scope-id': String(id),
});

let ok = true;

ok &= run(
  'warehouse simulation injects scope into body (was 400 on create)',
  {
    user: { role: 'ADMIN', branchId: null, warehouseId: null },
    headers: simHeaders('WAREHOUSE', 2),
    path: '/inventory',
    query: {},
    body: { name: 'Test Item', category: 'Food' },
  },
  (req) =>
    req.body.scopeType === 'WAREHOUSE' &&
    req.body.scopeId === '2' &&
    req.query.scopeType === 'WAREHOUSE' &&
    req.user.warehouseId === 2 &&
    req.user.branchId === null
);

ok &= run(
  'branch simulation sets branch and clears warehouse',
  {
    user: { role: 'ADMIN', branchId: null, warehouseId: 9 },
    headers: simHeaders('branch', 1),
    path: '/customers',
    query: {},
    body: {},
  },
  (req) =>
    req.body.scopeType === 'BRANCH' &&
    req.user.branchId === 1 &&
    req.user.warehouseId === null &&
    req.simulatedScope.scopeType === 'BRANCH'
);

ok &= run(
  'explicit scope in body is not overwritten',
  {
    user: { role: 'ADMIN' },
    headers: simHeaders('WAREHOUSE', 2),
    path: '/inventory',
    query: {},
    body: { scopeType: 'BRANCH', scopeId: '1' },
  },
  (req) => req.body.scopeType === 'BRANCH' && req.body.scopeId === '1'
);

ok &= run(
  'scope-agnostic routes are left alone (warehouse list stays global)',
  {
    user: { role: 'ADMIN' },
    headers: simHeaders('WAREHOUSE', 2),
    path: '/warehouses',
    query: {},
    body: {},
  },
  (req) => req.query.scopeType === undefined && req.body.scopeType === undefined
);

ok &= run(
  'non-admin user is untouched',
  {
    user: { role: 'CASHIER', branchId: 1 },
    headers: simHeaders('WAREHOUSE', 2),
    path: '/inventory',
    query: {},
    body: {},
  },
  (req) => req.body.scopeType === undefined && req.user.branchId === 1
);

ok &= run(
  'garbage header is ignored',
  {
    user: { role: 'ADMIN', branchId: null, warehouseId: null },
    headers: simHeaders('BRANCH', 'abc'),
    path: '/inventory',
    query: {},
    body: {},
  },
  (req) => req.body.scopeType === undefined && req.user.branchId === null
);

console.log(ok ? '\nAll checks passed' : '\nSome checks failed');
process.exit(ok ? 0 : 1);
