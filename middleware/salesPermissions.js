const Branch = require('../models/Branch');

const checkCashierSalesPermission = async (req, res, next) => {
  try {
    if (req.user.role === 'ADMIN') {
      return next();
    }

    if (req.user.role === 'CASHIER') {
      if (!req.user.branchId) {
        return res.status(403).json({
          success: false,
          message: 'Cashier must be assigned to a branch to perform this action'
        });
      }

      const branch = await Branch.findById(req.user.branchId);

      if (!branch) {
        return res.status(404).json({
          success: false,
          message: 'Branch not found'
        });
      }

      // ✅ Read directly from DB columns (never touch branch.settings)
      // POST = create sale → check allow_cashier_pos
      // PUT  = edit sale   → check allow_cashier_sales_edit
      // DELETE = delete    → check allow_cashier_sales_delete

      if (req.method === 'POST') {
        if (!Boolean(branch.allow_cashier_pos)) {
          return res.status(403).json({
            success: false,
            message: 'Cashiers are not allowed to create sales in this branch.'
          });
        }
      } else if (req.method === 'PUT' || req.method === 'PATCH') {
        if (!Boolean(branch.allow_cashier_sales_edit)) {
          return res.status(403).json({
            success: false,
            message: 'Cashiers are not allowed to edit sales in this branch.'
          });
        }
      } else if (req.method === 'DELETE') {
        if (!Boolean(branch.allow_cashier_sales_delete)) {
          return res.status(403).json({
            success: false,
            message: 'Cashiers are not allowed to delete sales in this branch.'
          });
        }
      }
    }

    next();
  } catch (error) {
    next(error);
  }
};

module.exports = {
  checkCashierSalesPermission
};