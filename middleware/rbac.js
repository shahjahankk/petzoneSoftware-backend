const rbac = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ 
        success: false, 
        message: 'Authentication required' 
      });
    }

    // Flatten the allowedRoles array in case it's nested
    const flatAllowedRoles = allowedRoles.flat();

    if (!flatAllowedRoles.includes(req.user.role)) {
      return res.status(403).json({ 
        success: false, 
        message: 'Insufficient permissions' 
      });
    }

    next();
  };
};

// Specific role middleware functions
const requireAdmin = rbac('ADMIN');
const requireWarehouseKeeper = rbac('WAREHOUSE_KEEPER', 'ADMIN');
const requireCashier = rbac('CASHIER', 'WAREHOUSE_KEEPER', 'ADMIN');

// Branch-specific access control
const requireBranchAccess = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ 
      success: false, 
      message: 'Authentication required' 
    });
  }

  // Admin has access to all branches
  if (req.user.role === 'ADMIN') {
    return next();
  }

  // Check if user has access to the requested branch
  const requestedBranchId = req.params.branchId || req.body.branchId;
  
  if (requestedBranchId && req.user.branchId && req.user.branchId.toString() !== requestedBranchId) {
    return res.status(403).json({ 
      success: false, 
      message: 'Access denied to this branch' 
    });
  }

  next();
};

// Warehouse-specific access control
const requireWarehouseAccess = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ 
      success: false, 
      message: 'Authentication required' 
    });
  }

  // Admin has access to all warehouses
  if (req.user.role === 'ADMIN') {
    return next();
  }

  // Check if user has access to the requested warehouse
  const requestedWarehouseId = req.params.warehouseId || req.body.warehouseId;
  
  if (requestedWarehouseId && req.user.warehouseId && req.user.warehouseId.toString() !== requestedWarehouseId) {
    return res.status(403).json({ 
      success: false, 
      message: 'Access denied to this warehouse' 
    });
  }

  next();
};

// Branch settings access control - allows cashiers to read their own branch settings
const requireBranchSettingsAccess = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ 
      success: false, 
      message: 'Authentication required' 
    });
  }

  // Admin has access to all branch settings
  if (req.user.role === 'ADMIN') {
    return next();
  }

  // Cashiers can only read their own branch settings
  if (req.user.role === 'CASHIER') {
    const requestedBranchId = req.params.id;
    
    if (requestedBranchId && req.user.branchId && req.user.branchId.toString() === requestedBranchId) {
      return next();
    } else {
      return res.status(403).json({ 
        success: false, 
        message: 'Access denied to this branch settings' 
      });
    }
  }

  // Warehouse keepers and other roles don't have access
  return res.status(403).json({ 
    success: false, 
    message: 'Insufficient permissions for branch settings' 
  });
};

// Warehouse settings access control - allows warehouse keepers to read their own warehouse settings
const requireWarehouseSettingsAccess = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ 
      success: false, 
      message: 'Authentication required' 
    });
  }

  // Admin has access to all warehouse settings
  if (req.user.role === 'ADMIN') {
    return next();
  }

  // Warehouse keepers can only read their own warehouse settings
  if (req.user.role === 'WAREHOUSE_KEEPER') {
    const requestedWarehouseId = req.params.id;
    
    if (requestedWarehouseId && req.user.warehouseId && req.user.warehouseId.toString() === requestedWarehouseId) {
      return next();
    } else {
      return res.status(403).json({ 
        success: false, 
        message: 'Access denied to this warehouse settings' 
      });
    }
  }

  // Cashiers and other roles don't have access
  return res.status(403).json({ 
    success: false, 
    message: 'Insufficient permissions for warehouse settings' 
  });
};

module.exports = {
  rbac,
  requireAdmin,
  requireWarehouseKeeper,
  requireCashier,
  requireBranchAccess,
  requireWarehouseAccess,
  requireBranchSettingsAccess,
  requireWarehouseSettingsAccess
};
