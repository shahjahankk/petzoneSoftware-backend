const Branch = require('../models/Branch');
const Warehouse = require('../models/Warehouse');

// Helper: check if user is admin - admin always bypasses permission checks
const isAdmin = (req) => req.user.role === 'ADMIN';

// Helper: get effective warehouse ID
const getWarehouseId = (req) => req.user.warehouseId;

// Helper: get effective branch ID
const getBranchId = (req) => req.user.branchId;


// ─────────────────────────────────────────────────────────────
// CASHIER INVENTORY PERMISSIONS (Branch)
// POST  → checks allow_cashier_inventory_add
// PUT/PATCH → checks allow_cashier_inventory_edit
// ─────────────────────────────────────────────────────────────
const checkCashierInventoryPermission = async (req, res, next) => {
  try {
    if (isAdmin(req)) return next();

    if (req.user.role === 'CASHIER') {
      const branch = await Branch.findById(getBranchId(req));

      if (!branch) {
        return res.status(404).json({ success: false, message: 'Branch not found' });
      }

      const isAddOperation = req.method === 'POST';

      if (isAddOperation) {
        if (!branch.allow_cashier_inventory_add) {
          return res.status(403).json({
            success: false,
            message: 'Cashiers are not allowed to add inventory in this branch'
          });
        }
      } else {
        if (!branch.allow_cashier_inventory_edit) {
          return res.status(403).json({
            success: false,
            message: 'Cashiers are not allowed to edit inventory in this branch'
          });
        }
      }
    }

    next();
  } catch (error) {
    next(error);
  }
};


// ─────────────────────────────────────────────────────────────
// WAREHOUSE KEEPER INVENTORY PERMISSIONS (Warehouse)
// POST  → checks allow_warehouse_inventory_add
// PUT/PATCH → checks allow_warehouse_inventory_edit
// ─────────────────────────────────────────────────────────────
const checkWarehouseKeeperInventoryPermission = async (req, res, next) => {
  try {
    if (isAdmin(req)) return next();

    if (req.user.role === 'CASHIER') {
      // Cashiers handled by checkCashierInventoryPermission
      return next();
    }

    if (req.user.role === 'WAREHOUSE_KEEPER') {
      let { scopeType, scopeId } = req.body;

      // If scope is missing on update, derive it from the existing inventory item
      if ((!scopeType || !scopeId) && req.params?.id) {
        try {
          const InventoryItem = require('../models/InventoryItem');
          const item = await InventoryItem.findById(req.params.id);
          if (item) {
            scopeType = item.scopeType;
            scopeId = item.scopeId;
            req.body.scopeType = scopeType;
            req.body.scopeId = scopeId;
          }
        } catch (err) {
        }
      }

      if (scopeType === 'WAREHOUSE') {
        if (parseInt(scopeId) !== parseInt(getWarehouseId(req))) {
          return res.status(403).json({
            success: false,
            message: 'Warehouse keepers can only add/edit inventory in their own warehouse'
          });
        }

        const warehouse = await Warehouse.findById(getWarehouseId(req));
        const isAddOperation = req.method === 'POST';

        if (isAddOperation) {
          if (warehouse && !warehouse.allow_warehouse_inventory_add) {
            return res.status(403).json({
              success: false,
              message: 'You do not have permission to add inventory in this warehouse'
            });
          }
        } else {
          if (warehouse && !warehouse.allow_warehouse_inventory_edit) {
            return res.status(403).json({
              success: false,
              message: 'You do not have permission to edit inventory in this warehouse'
            });
          }
        }

      } else if (scopeType === 'BRANCH') {
        return res.status(403).json({
          success: false,
          message: 'Warehouse keepers cannot add/edit inventory in branches'
        });
      } else if (!scopeType || !scopeId) {
        return res.status(400).json({
          success: false,
          message: 'Scope type and scope ID are required'
        });
      }
    }

    next();
  } catch (error) {
    next(error);
  }
};


// ─────────────────────────────────────────────────────────────
// WAREHOUSE KEEPER - COMPANY PERMISSIONS (granular)
// ─────────────────────────────────────────────────────────────
const checkWarehouseKeeperCompanyCreatePermission = async (req, res, next) => {
  try {
    if (isAdmin(req)) return next();

    if (req.user.role === 'WAREHOUSE_KEEPER') {
      const warehouse = await Warehouse.findById(getWarehouseId(req));
      if (!warehouse) return res.status(404).json({ success: false, message: 'Warehouse not found' });
      if (!warehouse.allow_company_create) {
        return res.status(403).json({ success: false, message: 'You do not have permission to create companies in this warehouse' });
      }
    }

    next();
  } catch (error) { next(error); }
};

const checkWarehouseKeeperCompanyEditPermission = async (req, res, next) => {
  try {
    if (isAdmin(req)) return next();

    if (req.user.role === 'WAREHOUSE_KEEPER') {
      const warehouse = await Warehouse.findById(getWarehouseId(req));
      if (!warehouse) return res.status(404).json({ success: false, message: 'Warehouse not found' });
      if (!warehouse.allow_company_edit) {
        return res.status(403).json({ success: false, message: 'You do not have permission to edit companies in this warehouse' });
      }
    }

    next();
  } catch (error) { next(error); }
};

const checkWarehouseKeeperCompanyDeletePermission = async (req, res, next) => {
  try {
    if (isAdmin(req)) return next();

    if (req.user.role === 'WAREHOUSE_KEEPER') {
      const warehouse = await Warehouse.findById(getWarehouseId(req));
      if (!warehouse) return res.status(404).json({ success: false, message: 'Warehouse not found' });
      if (!warehouse.allow_company_delete) {
        return res.status(403).json({ success: false, message: 'You do not have permission to delete companies in this warehouse' });
      }
    }

    next();
  } catch (error) { next(error); }
};

// Combined warehouse company permission (factory)
const checkWarehouseKeeperCompanyPermission = (requiredPermission = 'create') => {
  return async (req, res, next) => {
    try {
      if (isAdmin(req)) return next();

      if (req.user.role === 'WAREHOUSE_KEEPER') {
        const warehouse = await Warehouse.findById(getWarehouseId(req));
        if (!warehouse) return res.status(404).json({ success: false, message: 'Warehouse not found' });

        const permissionMap = {
          'create': warehouse.allow_company_create,
          'edit':   warehouse.allow_company_edit,
          'delete': warehouse.allow_company_delete
        };

        if (!permissionMap[requiredPermission]) {
          return res.status(403).json({ success: false, message: `You do not have permission to ${requiredPermission} companies in this warehouse` });
        }
      }

      next();
    } catch (error) { next(error); }
  };
};


// ─────────────────────────────────────────────────────────────
// WAREHOUSE KEEPER - RETAILER PERMISSIONS (granular)
// ─────────────────────────────────────────────────────────────
const checkWarehouseKeeperRetailerCreatePermission = async (req, res, next) => {
  try {
    if (isAdmin(req)) return next();

    if (req.user.role === 'WAREHOUSE_KEEPER') {
      const warehouse = await Warehouse.findById(getWarehouseId(req));
      if (!warehouse) return res.status(404).json({ success: false, message: 'Warehouse not found' });
      if (!warehouse.allow_retailer_create) {
        return res.status(403).json({ success: false, message: 'You do not have permission to create retailers in this warehouse' });
      }
    }

    next();
  } catch (error) { next(error); }
};

const checkWarehouseKeeperRetailerEditPermission = async (req, res, next) => {
  try {
    if (isAdmin(req)) return next();

    if (req.user.role === 'WAREHOUSE_KEEPER') {
      const warehouse = await Warehouse.findById(getWarehouseId(req));
      if (!warehouse) return res.status(404).json({ success: false, message: 'Warehouse not found' });
      if (!warehouse.allow_retailer_edit) {
        return res.status(403).json({ success: false, message: 'You do not have permission to edit retailers in this warehouse' });
      }
    }

    next();
  } catch (error) { next(error); }
};

const checkWarehouseKeeperRetailerDeletePermission = async (req, res, next) => {
  try {
    if (isAdmin(req)) return next();

    if (req.user.role === 'WAREHOUSE_KEEPER') {
      const warehouse = await Warehouse.findById(getWarehouseId(req));
      if (!warehouse) return res.status(404).json({ success: false, message: 'Warehouse not found' });
      if (!warehouse.allow_retailer_delete) {
        return res.status(403).json({ success: false, message: 'You do not have permission to delete retailers in this warehouse' });
      }
    }

    next();
  } catch (error) { next(error); }
};

// Combined warehouse retailer permission (factory)
const checkWarehouseKeeperRetailerPermission = (requiredPermission = 'create') => {
  return async (req, res, next) => {
    try {
      if (isAdmin(req)) return next();

      if (req.user.role === 'WAREHOUSE_KEEPER') {
        const warehouse = await Warehouse.findById(getWarehouseId(req));
        if (!warehouse) return res.status(404).json({ success: false, message: 'Warehouse not found' });

        const permissionMap = {
          'create': warehouse.allow_retailer_create,
          'edit':   warehouse.allow_retailer_edit,
          'delete': warehouse.allow_retailer_delete
        };

        if (!permissionMap[requiredPermission]) {
          return res.status(403).json({ success: false, message: `You do not have permission to ${requiredPermission} retailers in this warehouse` });
        }
      }

      next();
    } catch (error) { next(error); }
  };
};


// ─────────────────────────────────────────────────────────────
// BRANCH (CASHIER) - COMPANY PERMISSIONS (granular)
// ─────────────────────────────────────────────────────────────
const checkBranchCompanyCreatePermission = async (req, res, next) => {
  try {
    if (isAdmin(req)) return next();

    if (req.user.role === 'CASHIER') {
      const branch = await Branch.findById(getBranchId(req));
      if (!branch) return res.status(404).json({ success: false, message: 'Branch not found' });
      if (!branch.allow_company_create) {
        return res.status(403).json({ success: false, message: 'You do not have permission to create companies in this branch' });
      }
    }

    next();
  } catch (error) { next(error); }
};

const checkBranchCompanyEditPermission = async (req, res, next) => {
  try {
    if (isAdmin(req)) return next();

    if (req.user.role === 'CASHIER') {
      const branch = await Branch.findById(getBranchId(req));
      if (!branch) return res.status(404).json({ success: false, message: 'Branch not found' });
      if (!branch.allow_company_edit) {
        return res.status(403).json({ success: false, message: 'You do not have permission to edit companies in this branch' });
      }
    }

    next();
  } catch (error) { next(error); }
};

const checkBranchCompanyDeletePermission = async (req, res, next) => {
  try {
    if (isAdmin(req)) return next();

    if (req.user.role === 'CASHIER') {
      const branch = await Branch.findById(getBranchId(req));
      if (!branch) return res.status(404).json({ success: false, message: 'Branch not found' });
      if (!branch.allow_company_delete) {
        return res.status(403).json({ success: false, message: 'You do not have permission to delete companies in this branch' });
      }
    }

    next();
  } catch (error) { next(error); }
};

const checkBranchCompanyViewPermission = async (req, res, next) => {
  try {
    if (isAdmin(req)) return next();

    if (req.user.role === 'CASHIER') {
      const branch = await Branch.findById(getBranchId(req));
      if (!branch) return res.status(404).json({ success: false, message: 'Branch not found' });
      if (!branch.allow_company_view) {
        return res.status(403).json({ success: false, message: 'You do not have permission to view company details in this branch' });
      }
    }

    next();
  } catch (error) { next(error); }
};

// Combined branch company permission (factory)
const checkBranchCompanyPermission = (requiredPermission = 'create') => {
  return async (req, res, next) => {
    try {
      if (isAdmin(req)) return next();

      if (req.user.role === 'CASHIER') {
        const branch = await Branch.findById(getBranchId(req));
        if (!branch) return res.status(404).json({ success: false, message: 'Branch not found' });

        const permissionMap = {
          'create': branch.allow_company_create,
          'edit':   branch.allow_company_edit,
          'delete': branch.allow_company_delete,
          'view':   branch.allow_company_view
        };

        if (!permissionMap[requiredPermission]) {
          return res.status(403).json({ success: false, message: `You do not have permission to ${requiredPermission} companies in this branch` });
        }
      }

      next();
    } catch (error) { next(error); }
  };
};


// ─────────────────────────────────────────────────────────────
// RETURN PERMISSIONS
// ─────────────────────────────────────────────────────────────
const checkReturnPermission = async (req, res, next) => {
  try {
    if (isAdmin(req)) return next();

    if (req.user.role === 'CASHIER') {
      const branch = await Branch.findById(getBranchId(req));
      if (!branch) return res.status(404).json({ success: false, message: 'Branch not found' });
      if (!branch.allow_cashier_returns) {
        return res.status(403).json({ success: false, message: 'Cashiers are not allowed to process returns in this branch' });
      }
    }

    if (req.user.role === 'WAREHOUSE_KEEPER') {
      const warehouse = await Warehouse.findById(getWarehouseId(req));
      if (!warehouse) return res.status(404).json({ success: false, message: 'Warehouse not found' });
      if (!warehouse.allow_warehouse_returns) {
        return res.status(403).json({ success: false, message: 'Warehouse keepers are not allowed to process returns in this warehouse' });
      }
    }

    next();
  } catch (error) { next(error); }
};


// ─────────────────────────────────────────────────────────────
// CUSTOMER EDIT PERMISSIONS
// ─────────────────────────────────────────────────────────────
const checkCashierCustomerEditPermission = async (req, res, next) => {
  try {
    if (isAdmin(req)) return next();

    if (req.user.role === 'CASHIER') {
      const branch = await Branch.findById(getBranchId(req));
      if (!branch) return res.status(404).json({ success: false, message: 'Branch not found' });
      if (!branch.allow_cashier_customer_edit) {
        return res.status(403).json({ success: false, message: 'You do not have permission to edit customer info in this branch' });
      }
    }

    next();
  } catch (error) { next(error); }
};

const checkWarehouseKeeperCustomerEditPermission = async (req, res, next) => {
  try {
    if (isAdmin(req)) return next();

    if (req.user.role === 'WAREHOUSE_KEEPER') {
      const warehouse = await Warehouse.findById(getWarehouseId(req));
      if (!warehouse) return res.status(404).json({ success: false, message: 'Warehouse not found' });
      if (!warehouse.allow_retailer_customer_edit) {
        return res.status(403).json({ success: false, message: 'You do not have permission to edit customer info in this warehouse' });
      }
    }

    next();
  } catch (error) { next(error); }
};


// ─────────────────────────────────────────────────────────────
// CROSS-BRANCH VISIBILITY
// ─────────────────────────────────────────────────────────────
const checkCrossBranchVisibility = async (req, res, next) => {
  try {
    if (isAdmin(req)) return next();

    const branch = await Branch.findById(getBranchId(req));
    if (!branch) return res.status(404).json({ success: false, message: 'Branch not found' });

    const settingsOpenAccount = !!(branch.settings && (
      branch.settings.openAccount === true ||
      branch.settings.openAccount === 1 ||
      branch.settings.openAccount === 'true'
    ));
    const columnOpenAccount = !!(
      branch.open_account_system === 1 ||
      branch.open_account_system === true ||
      branch.openAccountSystem === true
    );

    if (!columnOpenAccount && !settingsOpenAccount) {
      return res.status(403).json({
        success: false,
        message: 'Cross-branch inventory is disabled for your branch. Ask an admin to enable Open Account / cross-branch visibility.'
      });
    }

    next();
  } catch (error) { next(error); }
};


module.exports = {
  // Cashier inventory
  checkCashierInventoryPermission,

  // Warehouse keeper inventory
  checkWarehouseKeeperInventoryPermission,

  // Warehouse keeper company permissions (granular)
  checkWarehouseKeeperCompanyCreatePermission,
  checkWarehouseKeeperCompanyEditPermission,
  checkWarehouseKeeperCompanyDeletePermission,
  checkWarehouseKeeperCompanyPermission,

  // Warehouse keeper retailer permissions (granular)
  checkWarehouseKeeperRetailerCreatePermission,
  checkWarehouseKeeperRetailerEditPermission,
  checkWarehouseKeeperRetailerDeletePermission,
  checkWarehouseKeeperRetailerPermission,

  // Branch company permissions (for CASHIER)
  checkBranchCompanyCreatePermission,
  checkBranchCompanyEditPermission,
  checkBranchCompanyDeletePermission,
  checkBranchCompanyViewPermission,
  checkBranchCompanyPermission,

  // Customer edit permissions
  checkCashierCustomerEditPermission,
  checkWarehouseKeeperCustomerEditPermission,

  // Other
  checkReturnPermission,
  checkCrossBranchVisibility
};