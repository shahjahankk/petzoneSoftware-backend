// Branch Settings Controller
const toBoolean = (value) => {
  if (value === null || value === undefined) return false;
  return Number(value) === 1;
};

// @desc    Get branch settings
// @route   GET /api/branches/:id/settings
// @access  Private (Admin, Cashier for own branch)
const getBranchSettings = async (req, res) => {
  try {
    const { id } = req.params;

    const Branch = require('../models/Branch');
    const branch = await Branch.findById(parseInt(id));

    if (!branch) {
      return res.status(404).json({ success: false, message: 'Branch not found' });
    }

    // ✅ ONLY read from DB columns — never touch branch.settings (corrupted legacy data)
    const settings = {
      allowCashierInventoryAdd:          toBoolean(branch.allow_cashier_inventory_add),
      allowCashierInventoryEdit:         toBoolean(branch.allow_cashier_inventory_edit),
      allowCashierSalesEdit:             toBoolean(branch.allow_cashier_sales_edit),
      allowCashierSalesDelete:           toBoolean(branch.allow_cashier_sales_delete),
      allowCashierReturns:               toBoolean(branch.allow_cashier_returns),
      allowCashierCustomers:             toBoolean(branch.allow_cashier_customers),
      allowCashierPOS:                   toBoolean(branch.allow_cashier_pos),
      allowCashierLedger:                toBoolean(branch.allow_cashier_ledger),
      openAccountSystem:                 toBoolean(branch.open_account_system),
      allowCashierCustomerEdit:          toBoolean(branch.allow_cashier_customer_edit),
      allowWhatsappLedger:               toBoolean(branch.allow_whatsapp_ledger),
      allowCompanyCreate:                toBoolean(branch.allow_company_create),
      allowCompanyEdit:                  toBoolean(branch.allow_company_edit),
      allowCompanyDelete:                toBoolean(branch.allow_company_delete),
      allowCompanyView:                  toBoolean(branch.allow_company_view),
      allowBranchTransfers:              toBoolean(branch.allow_branch_transfers),
      allowBranchToWarehouseTransfers:   toBoolean(branch.allow_branch_to_warehouse_transfers),
      allowBranchToBranchTransfers:      toBoolean(branch.allow_branch_to_branch_transfers),
      requireApprovalForBranchTransfers: toBoolean(branch.require_approval_for_branch_transfers),
      maxTransferAmount:                 Number(branch.max_transfer_amount) || 0,
    };

    res.json({
      success: true,
      data: { id: branch.id, name: branch.name, code: branch.code, settings }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error retrieving branch settings', error: error.message });
  }
};

// @desc    Update branch settings
// @route   PUT /api/branches/:id/settings
// @access  Private (Admin only)
const updateBranchSettings = async (req, res) => {
  try {
    const { id } = req.params;
    const { settings } = req.body;

    if (!settings || typeof settings !== 'object') {
      return res.status(400).json({ success: false, message: 'Settings object is required' });
    }

    const Branch = require('../models/Branch');
    const branch = await Branch.findById(parseInt(id));

    if (!branch) {
      return res.status(404).json({ success: false, message: 'Branch not found' });
    }

    // ✅ Write ONLY to DB columns — never touch branch.settings
    if (settings.allowCashierInventoryAdd          !== undefined) branch.allow_cashier_inventory_add            = settings.allowCashierInventoryAdd          ? 1 : 0;
    if (settings.allowCashierInventoryEdit         !== undefined) branch.allow_cashier_inventory_edit           = settings.allowCashierInventoryEdit         ? 1 : 0;
    if (settings.allowCashierSalesEdit             !== undefined) branch.allow_cashier_sales_edit               = settings.allowCashierSalesEdit             ? 1 : 0;
    if (settings.allowCashierSalesDelete           !== undefined) branch.allow_cashier_sales_delete             = settings.allowCashierSalesDelete           ? 1 : 0;
    if (settings.allowCashierReturns               !== undefined) branch.allow_cashier_returns                  = settings.allowCashierReturns               ? 1 : 0;
    if (settings.allowCashierCustomers             !== undefined) branch.allow_cashier_customers                = settings.allowCashierCustomers             ? 1 : 0;
    if (settings.allowCashierPOS                   !== undefined) branch.allow_cashier_pos                      = settings.allowCashierPOS                   ? 1 : 0;
    if (settings.allowCashierLedger                !== undefined) branch.allow_cashier_ledger                   = settings.allowCashierLedger                ? 1 : 0;
    if (settings.openAccountSystem                 !== undefined) branch.open_account_system                    = settings.openAccountSystem                 ? 1 : 0;
    if (settings.allowCashierCustomerEdit          !== undefined) branch.allow_cashier_customer_edit            = settings.allowCashierCustomerEdit          ? 1 : 0;
    if (settings.allowWhatsappLedger               !== undefined) branch.allow_whatsapp_ledger                  = settings.allowWhatsappLedger               ? 1 : 0;
    if (settings.allowCompanyCreate                !== undefined) branch.allow_company_create                   = settings.allowCompanyCreate                ? 1 : 0;
    if (settings.allowCompanyEdit                  !== undefined) branch.allow_company_edit                     = settings.allowCompanyEdit                  ? 1 : 0;
    if (settings.allowCompanyDelete                !== undefined) branch.allow_company_delete                   = settings.allowCompanyDelete                ? 1 : 0;
    if (settings.allowCompanyView                  !== undefined) branch.allow_company_view                     = settings.allowCompanyView                  ? 1 : 0;
    if (settings.allowBranchTransfers              !== undefined) branch.allow_branch_transfers                 = settings.allowBranchTransfers              ? 1 : 0;
    if (settings.allowBranchToWarehouseTransfers   !== undefined) branch.allow_branch_to_warehouse_transfers    = settings.allowBranchToWarehouseTransfers   ? 1 : 0;
    if (settings.allowBranchToBranchTransfers      !== undefined) branch.allow_branch_to_branch_transfers       = settings.allowBranchToBranchTransfers      ? 1 : 0;
    if (settings.requireApprovalForBranchTransfers !== undefined) branch.require_approval_for_branch_transfers  = settings.requireApprovalForBranchTransfers ? 1 : 0;
    if (settings.maxTransferAmount                 !== undefined) branch.max_transfer_amount                    = parseFloat(settings.maxTransferAmount) || 0;

    await branch.save();

    return getBranchSettings(req, res);
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error updating branch settings', error: error.message });
  }
};

module.exports = { getBranchSettings, updateBranchSettings };