/**
 * Warehouse ledger RBAC — scope_id on ledgers may be numeric warehouse id or warehouse name.
 */

function warehouseScopeMatchesUser(user, scopeId) {
  if (!user) return false;
  if (user.role === 'ADMIN') return true;
  if (user.role !== 'WAREHOUSE_KEEPER') return false;

  const target = String(scopeId ?? '').trim();
  if (!target) return false;

  if (user.warehouseId != null && String(user.warehouseId) === target) return true;
  if (user.warehouseName && String(user.warehouseName).trim() === target) return true;

  return false;
}

function enforceWarehouseLedgerTarget(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ success: false, message: 'Authentication required' });
  }
  if (req.user.role === 'ADMIN') return next();

  const warehouseTarget =
    req.params.warehouseId || req.body?.warehouse_id || req.body?.warehouseId;

  if (warehouseTarget == null || warehouseTarget === '') {
    return res.status(400).json({ success: false, message: 'Warehouse id is required' });
  }

  if (!warehouseScopeMatchesUser(req.user, warehouseTarget)) {
    return res.status(403).json({ success: false, message: 'Access denied to this warehouse' });
  }

  return next();
}

module.exports = {
  warehouseScopeMatchesUser,
  enforceWarehouseLedgerTarget,
};
