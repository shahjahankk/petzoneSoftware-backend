const Branch = require('../models/Branch');
const Warehouse = require('../models/Warehouse');

// Helper: check if user is admin (simulating or not) - admin always bypasses permission checks
const isAdmin = (req) => req.user.role === 'ADMIN';

// Helper: get effective warehouse ID (works for both WAREHOUSE_KEEPER and simulating ADMIN)
const getWarehouseId = (req) => req.user.warehouseId;

// Helper: get effective branch ID (works for both CASHIER and simulating ADMIN)
const getBranchId = (req) => req.user.branchId;

// Middleware to check if cashiers can add inventory
// Middleware to check if cashiers can add/edit inventory
const checkCashierInventoryPermission = async (req, res, next) => {
  try {
    if (isAdmin(req)) {
      return next();
    }

    if (req.user.role === 'CASHIER') {
      const assignedBranchId = getBranchId(req);
      const branch = await Branch.findById(assignedBranchId);
      
      if (!branch) {
        return res.status(404).json({
          success: false,
          message: 'Branch not found'
        });
      }

      // POST = ADD, PUT/PATCH = EDIT — check the correct column
      const isAddOperation = req.method === 'POST';

      // A cashier may never create inventory in, or edit inventory belonging
      // to, a different branch even if the permission flag is enabled.
      if (isAddOperation) {
        if (
          req.body.scopeType !== 'BRANCH' ||
          parseInt(req.body.scopeId, 10) !== parseInt(assignedBranchId, 10)
        ) {
          return res.status(403).json({
            success: false,
            message: 'Cashiers can only add inventory in their assigned branch'
          });
        }
      } else if (req.params?.id) {
        const InventoryItem = require('../models/InventoryItem');
        const item = await InventoryItem.findById(req.params.id);
        if (
          item &&
          (item.scopeType !== 'BRANCH' ||
            parseInt(item.scopeId, 10) !== parseInt(assignedBranchId, 10))
        ) {
          return res.status(403).json({
            success: false,
            message: 'Cashiers can only edit inventory in their assigned branch'
          });
        }
      }

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
// UPDATED: Check if warehouse keepers can CREATE companies
const checkWarehouseKeeperCompanyCreatePermission = async (req, res, next) => {
  try {
    if (isAdmin(req)) {
      return next();
    }

    if (req.user.role === 'WAREHOUSE_KEEPER') {
      const warehouse = await Warehouse.findById(getWarehouseId(req));
      
      if (!warehouse) {
        return res.status(404).json({
          success: false,
          message: 'Warehouse not found'
        });
      }

      // Use the new granular company create permission
      if (!warehouse.allow_company_create) {
        return res.status(403).json({
          success: false,
          message: 'You do not have permission to create companies in this warehouse'
        });
      }
    }

    next();
  } catch (error) {
    next(error);
  }
};

// NEW: Check if warehouse keepers can EDIT companies
const checkWarehouseKeeperCompanyEditPermission = async (req, res, next) => {
  try {
    if (isAdmin(req)) {
      return next();
    }

    if (req.user.role === 'WAREHOUSE_KEEPER') {
      const warehouse = await Warehouse.findById(getWarehouseId(req));
      
      if (!warehouse) {
        return res.status(404).json({
          success: false,
          message: 'Warehouse not found'
        });
      }

      // Use the new granular company edit permission
      if (!warehouse.allow_company_edit) {
        return res.status(403).json({
          success: false,
          message: 'You do not have permission to edit companies in this warehouse'
        });
      }
    }

    next();
  } catch (error) {
    next(error);
  }
};

// NEW: Check if warehouse keepers can DELETE companies
const checkWarehouseKeeperCompanyDeletePermission = async (req, res, next) => {
  try {
    if (isAdmin(req)) {
      return next();
    }

    if (req.user.role === 'WAREHOUSE_KEEPER') {
      const warehouse = await Warehouse.findById(getWarehouseId(req));
      
      if (!warehouse) {
        return res.status(404).json({
          success: false,
          message: 'Warehouse not found'
        });
      }

      // Use the new granular company delete permission
      if (!warehouse.allow_company_delete) {
        return res.status(403).json({
          success: false,
          message: 'You do not have permission to delete companies in this warehouse'
        });
      }
    }

    next();
  } catch (error) {
    next(error);
  }
};

// NEW: Combined company permission middleware (for routes that need all/specific permissions)
const checkWarehouseKeeperCompanyPermission = (requiredPermission = 'create') => {
  return async (req, res, next) => {
    try {
      if (isAdmin(req)) {
        return next();
      }

      if (req.user.role === 'WAREHOUSE_KEEPER') {
        const warehouse = await Warehouse.findById(getWarehouseId(req));
        
        if (!warehouse) {
          return res.status(404).json({
            success: false,
            message: 'Warehouse not found'
          });
        }

        const permissionMap = {
          'create': warehouse.allow_company_create,
          'edit': warehouse.allow_company_edit,
          'delete': warehouse.allow_company_delete
        };

        if (!permissionMap[requiredPermission]) {
          return res.status(403).json({
            success: false,
            message: `You do not have permission to ${requiredPermission} companies in this warehouse`
          });
        }
      }

      next();
    } catch (error) {
      next(error);
    }
  };
};

// UPDATED: Check if warehouse keepers can create retailers
const checkWarehouseKeeperRetailerCreatePermission = async (req, res, next) => {
  try {
    if (isAdmin(req)) {
      return next();
    }

    if (req.user.role === 'WAREHOUSE_KEEPER') {
      const warehouse = await Warehouse.findById(getWarehouseId(req));
      
      if (!warehouse) {
        return res.status(404).json({
          success: false,
          message: 'Warehouse not found'
        });
      }

      // Use the new granular retailer create permission
      if (!warehouse.allow_retailer_create) {
        return res.status(403).json({
          success: false,
          message: 'You do not have permission to create retailers in this warehouse'
        });
      }
    }

    next();
  } catch (error) {
    next(error);
  }
};

// UPDATED: Check if warehouse keepers can edit retailers
const checkWarehouseKeeperRetailerEditPermission = async (req, res, next) => {
  try {
    if (isAdmin(req)) {
      return next();
    }

    if (req.user.role === 'WAREHOUSE_KEEPER') {
      const warehouse = await Warehouse.findById(getWarehouseId(req));
      
      if (!warehouse) {
        return res.status(404).json({
          success: false,
          message: 'Warehouse not found'
        });
      }

      // Use the new granular retailer edit permission
      if (!warehouse.allow_retailer_edit) {
        return res.status(403).json({
          success: false,
          message: 'You do not have permission to edit retailers in this warehouse'
        });
      }
    }

    next();
  } catch (error) {
    next(error);
  }
};

// UPDATED: Check if warehouse keepers can delete retailers
const checkWarehouseKeeperRetailerDeletePermission = async (req, res, next) => {
  try {
    if (isAdmin(req)) {
      return next();
    }

    if (req.user.role === 'WAREHOUSE_KEEPER') {
      const warehouse = await Warehouse.findById(getWarehouseId(req));
      
      if (!warehouse) {
        return res.status(404).json({
          success: false,
          message: 'Warehouse not found'
        });
      }

      // Use the new granular retailer delete permission
      if (!warehouse.allow_retailer_delete) {
        return res.status(403).json({
          success: false,
          message: 'You do not have permission to delete retailers in this warehouse'
        });
      }
    }

    next();
  } catch (error) {
    next(error);
  }
};

// NEW: Combined retailer permission middleware
const checkWarehouseKeeperRetailerPermission = (requiredPermission = 'create') => {
  return async (req, res, next) => {
    try {
      if (isAdmin(req)) {
        return next();
      }

      if (req.user.role === 'WAREHOUSE_KEEPER') {
        const warehouse = await Warehouse.findById(getWarehouseId(req));
        
        if (!warehouse) {
          return res.status(404).json({
            success: false,
            message: 'Warehouse not found'
          });
        }

        const permissionMap = {
          'create': warehouse.allow_retailer_create,
          'edit': warehouse.allow_retailer_edit,
          'delete': warehouse.allow_retailer_delete
        };

        if (!permissionMap[requiredPermission]) {
          return res.status(403).json({
            success: false,
            message: `You do not have permission to ${requiredPermission} retailers in this warehouse`
          });
        }
      }

      next();
    } catch (error) {
      next(error);
    }
  };
};

// FIXED: Check if branch users (CASHIER) can create companies
const checkBranchCompanyCreatePermission = async (req, res, next) => {
  try {
    if (isAdmin(req)) {
      return next();
    }

    if (req.user.role === 'CASHIER') {
      const branch = await Branch.findById(getBranchId(req));
      
      if (!branch) {
        return res.status(404).json({
          success: false,
          message: 'Branch not found'
        });
      }

      // Use the new branch company create permission
      if (!branch.allow_company_create) {
        return res.status(403).json({
          success: false,
          message: 'You do not have permission to create companies in this branch'
        });
      }
    }

    next();
  } catch (error) {
    next(error);
  }
};

// FIXED: Check if branch users (CASHIER) can edit companies
const checkBranchCompanyEditPermission = async (req, res, next) => {
  try {
    if (isAdmin(req)) {
      return next();
    }

    if (req.user.role === 'CASHIER') {
      const branch = await Branch.findById(getBranchId(req));
      
      if (!branch) {
        return res.status(404).json({
          success: false,
          message: 'Branch not found'
        });
      }

      if (!branch.allow_company_edit) {
        return res.status(403).json({
          success: false,
          message: 'You do not have permission to edit companies in this branch'
        });
      }
    }

    next();
  } catch (error) {
    next(error);
  }
};

// FIXED: Check if branch users (CASHIER) can delete companies
const checkBranchCompanyDeletePermission = async (req, res, next) => {
  try {
    if (isAdmin(req)) {
      return next();
    }

    if (req.user.role === 'CASHIER') {
      const branch = await Branch.findById(getBranchId(req));
      
      if (!branch) {
        return res.status(404).json({
          success: false,
          message: 'Branch not found'
        });
      }

      if (!branch.allow_company_delete) {
        return res.status(403).json({
          success: false,
          message: 'You do not have permission to delete companies in this branch'
        });
      }
    }

    next();
  } catch (error) {
    next(error);
  }
};

const checkBranchCompanyViewPermission = async (req, res, next) => {
  try {
    if (isAdmin(req)) {
      return next();
    }

    if (req.user.role === 'CASHIER') {
      const branch = await Branch.findById(getBranchId(req));
      
      if (!branch) {
        return res.status(404).json({
          success: false,
          message: 'Branch not found'
        });
      }

      if (!branch.allow_company_view) {
        return res.status(403).json({
          success: false,
          message: 'You do not have permission to view company details in this branch'
        });
      }
    }

    next();
  } catch (error) {
    next(error);
  }
};

// FIXED: Combined branch company permission middleware
const checkBranchCompanyPermission = (requiredPermission = 'create') => {
  return async (req, res, next) => {
    try {
      if (isAdmin(req)) {
        return next();
      }

      if (req.user.role === 'CASHIER') {
        const branch = await Branch.findById(getBranchId(req));
        
        if (!branch) {
          return res.status(404).json({
            success: false,
            message: 'Branch not found'
          });
        }

        const permissionMap = {
          'create': branch.allow_company_create,
          'edit': branch.allow_company_edit,
          'delete': branch.allow_company_delete,
          'view': branch.allow_company_view
        };

        if (!permissionMap[requiredPermission]) {
          return res.status(403).json({
            success: false,
            message: `You do not have permission to ${requiredPermission} companies in this branch`
          });
        }
      }

      next();
    } catch (error) {
      next(error);
    }
  };
};

// UPDATED: Check if warehouse keepers can add inventory
const checkWarehouseKeeperInventoryPermission = async (req, res, next) => {
  try {
    if (isAdmin(req)) {
      return next();
    }

    if (req.user.role === 'CASHIER') {
      // Cashiers are handled by checkCashierInventoryPermission
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
            // attach for downstream handlers
            req.body.scopeType = scopeType;
            req.body.scopeId = scopeId;
          }
        } catch (err) {
          // If lookup fails, fall through to validation below
        }
      }

      // Warehouse keepers can only manage inventory in their own warehouse
      if (scopeType === 'WAREHOUSE') {
        if (parseInt(scopeId) !== parseInt(getWarehouseId(req))) {
          return res.status(403).json({
            success: false,
            message: 'Warehouse keepers can only add/edit inventory in their own warehouse'
          });
        }
        
        // POST uses the add permission; PUT/PATCH uses edit permission.
        const warehouse = await Warehouse.findById(getWarehouseId(req));
        const isAddOperation = req.method === 'POST';
        const allowed = isAddOperation
          ? warehouse?.allow_warehouse_inventory_add
          : warehouse?.allow_warehouse_inventory_edit;
        if (warehouse && !allowed) {
          return res.status(403).json({
            success: false,
            message: isAddOperation
              ? 'You do not have permission to add inventory in this warehouse'
              : 'You do not have permission to edit inventory in this warehouse'
          });
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

// UPDATED: Check return permissions
const checkReturnPermission = async (req, res, next) => {
  try {
    if (isAdmin(req)) {
      return next();
    }

    if (req.user.role === 'CASHIER') {
      const branch = await Branch.findById(getBranchId(req));
      
      if (!branch) {
        return res.status(404).json({
          success: false,
          message: 'Branch not found'
        });
      }
      
      // Use direct column instead of settings
      if (!branch.allow_cashier_returns) {
        return res.status(403).json({
          success: false,
          message: 'Cashiers are not allowed to process returns in this branch'
        });
      }
    }

    if (req.user.role === 'WAREHOUSE_KEEPER') {
      const warehouse = await Warehouse.findById(getWarehouseId(req));
      
      if (!warehouse) {
        return res.status(404).json({
          success: false,
          message: 'Warehouse not found'
        });
      }

      // Use direct column instead of settings
      if (!warehouse.allow_warehouse_returns) {
        return res.status(403).json({
          success: false,
          message: 'Warehouse keepers are not allowed to process returns in this warehouse'
        });
      }
    }

    next();
  } catch (error) {
    next(error);
  }
};

// Check if cashiers can edit customer info (granted per branch by admin)
const checkCashierCustomerEditPermission = async (req, res, next) => {
  try {
    if (isAdmin(req)) {
      return next();
    }

    if (req.user.role === 'CASHIER') {
      const branch = await Branch.findById(getBranchId(req));

      if (!branch) {
        return res.status(404).json({
          success: false,
          message: 'Branch not found'
        });
      }

      if (!branch.allow_cashier_customer_edit) {
        return res.status(403).json({
          success: false,
          message: 'You do not have permission to edit customer info in this branch'
        });
      }
    }

    next();
  } catch (error) {
    next(error);
  }
};

// Check if warehouse keepers can edit retailer/customer info (granted per warehouse by admin)
const checkWarehouseKeeperCustomerEditPermission = async (req, res, next) => {
  try {
    if (isAdmin(req)) {
      return next();
    }

    if (req.user.role === 'WAREHOUSE_KEEPER') {
      const warehouse = await Warehouse.findById(getWarehouseId(req));

      if (!warehouse) {
        return res.status(404).json({
          success: false,
          message: 'Warehouse not found'
        });
      }

      if (!warehouse.allow_retailer_customer_edit) {
        return res.status(403).json({
          success: false,
          message: 'You do not have permission to edit customer info in this warehouse'
        });
      }
    }

    next();
  } catch (error) {
    next(error);
  }
};

// UPDATED: Check cross-branch visibility
const checkCrossBranchVisibility = async (req, res, next) => {
  try {
    if (isAdmin(req)) {
      return next();
    }

    const branch = await Branch.findById(getBranchId(req));
    
    if (!branch) {
      return res.status(404).json({
        success: false,
        message: 'Branch not found'
      });
    }

    // Accept either the column flag or legacy settings.openAccount
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
  } catch (error) {
    next(error);
  }
};

module.exports = {
  // Cashier permissions
  checkCashierInventoryPermission,
  
  // Warehouse keeper inventory permissions
  checkWarehouseKeeperInventoryPermission,
  
  // Warehouse keeper company permissions (granular)
  checkWarehouseKeeperCompanyCreatePermission,
  checkWarehouseKeeperCompanyEditPermission,
  checkWarehouseKeeperCompanyDeletePermission,
  checkWarehouseKeeperCompanyPermission, // Combined version
  
  // Warehouse keeper retailer permissions (granular)
  checkWarehouseKeeperRetailerCreatePermission,
  checkWarehouseKeeperRetailerEditPermission,
  checkWarehouseKeeperRetailerDeletePermission,
  checkWarehouseKeeperRetailerPermission, // Combined version
  
  // Branch company permissions (for CASHIER)
  checkBranchCompanyCreatePermission,
  checkBranchCompanyEditPermission,
  checkBranchCompanyDeletePermission,
  checkBranchCompanyViewPermission,
  checkBranchCompanyPermission, // Combined version
  
  // Customer info edit permissions
  checkCashierCustomerEditPermission,
  checkWarehouseKeeperCustomerEditPermission,

  // Other permissions
  checkReturnPermission,
  checkCrossBranchVisibility
};