// Warehouse Settings Controller
const toBoolean = (value) => {
  if (value === null || value === undefined) return false;
  return Number(value) === 1;
};

const safeParseSettings = (raw) => {
  if (!raw) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch (e) { return {}; }
  }
  return {};
};

const columnsToRemove = [
  'allowWarehouseInventoryAdd', 'allowWarehouseInventoryEdit',
  'allowWarehouseReturns', 'allowWarehouseCompanies', 'allowWarehouseDirectSales',
  'allowWarehouseSales', 'allowWarehouseSalesEdit', 'allowWarehouseSalesDelete',
  'allowWarehouseLedgerEdit', 'requireApprovalForTransfers', 'autoStockAlerts',
  'allowCompanyCreate', 'allowCompanyEdit', 'allowCompanyDelete',
  'allowRetailerCreate', 'allowRetailerEdit', 'allowRetailerDelete', 'allowRetailerCustomerEdit',
  'allowWhatsappLedger',
  'allowWarehouseTransfers', 'allowWarehouseToBranchTransfers', 'allowWarehouseToWarehouseTransfers',
  'requireApprovalForWarehouseTransfers', 'maxTransferAmount', 'autoApproveSmallTransfers',
  'smallTransferThreshold', 'allowWarehouseCompanyCRUD', 'allowWarehouseRetailerCRUD'
];

// @desc  GET /api/warehouses/:id/settings
const getWarehouseSettings = async (req, res) => {
  try {
    const { id } = req.params;
    const Warehouse = require('../models/Warehouse');
    const warehouse = await Warehouse.findById(parseInt(id));
    if (!warehouse) return res.status(404).json({ success: false, message: 'Warehouse not found' });

    const parsedJsonSettings = safeParseSettings(warehouse.settings);
    const cleanJsonSettings = { ...parsedJsonSettings };
    columnsToRemove.forEach(col => delete cleanJsonSettings[col]);

    const settings = {
      // Inventory
      allowWarehouseInventoryAdd:  toBoolean(warehouse.allow_warehouse_inventory_add),
      allowWarehouseInventoryEdit: toBoolean(warehouse.allow_warehouse_inventory_edit),
      // Operations
      allowWarehouseReturns:          toBoolean(warehouse.allow_warehouse_returns),
      allowWarehouseCompanies:        toBoolean(warehouse.allow_warehouse_companies),
      allowWarehouseDirectSales:      toBoolean(warehouse.allow_warehouse_direct_sales),
      allowWarehouseLedgerEdit:       toBoolean(warehouse.allow_warehouse_ledger_edit),
      requireApprovalForTransfers:    toBoolean(warehouse.require_approval_for_transfers),
      autoStockAlerts:                toBoolean(warehouse.auto_stock_alerts),
      // Sales
      allowWarehouseSalesEdit:   toBoolean(warehouse.allow_warehouse_sales_edit),
      allowWarehouseSalesDelete: toBoolean(warehouse.allow_warehouse_sales_delete),
      // Company
      allowCompanyCreate: toBoolean(warehouse.allow_company_create),
      allowCompanyEdit:   toBoolean(warehouse.allow_company_edit),
      allowCompanyDelete: toBoolean(warehouse.allow_company_delete),
      // Retailer
      allowRetailerCreate:       toBoolean(warehouse.allow_retailer_create),
      allowRetailerEdit:         toBoolean(warehouse.allow_retailer_edit),
      allowRetailerDelete:       toBoolean(warehouse.allow_retailer_delete),
      allowRetailerCustomerEdit: toBoolean(warehouse.allow_retailer_customer_edit),
      allowWhatsappLedger:       toBoolean(warehouse.allow_whatsapp_ledger),
      // Transfers
      allowWarehouseTransfers:              toBoolean(warehouse.allow_warehouse_transfers),
      allowWarehouseToBranchTransfers:      toBoolean(warehouse.allow_warehouse_to_branch_transfers),
      allowWarehouseToWarehouseTransfers:   toBoolean(warehouse.allow_warehouse_to_warehouse_transfers),
      requireApprovalForWarehouseTransfers: toBoolean(warehouse.require_approval_for_warehouse_transfers),
      maxTransferAmount:         Number(warehouse.max_transfer_amount) || 0,
      autoApproveSmallTransfers: toBoolean(warehouse.auto_approve_small_transfers),
      smallTransferThreshold:    Number(warehouse.small_transfer_threshold) || 0,
      // Extra JSON keys (non-column settings only)
      ...cleanJsonSettings
    };

    // Backward compat aggregates
    settings.allowWarehouseCompanyCRUD  = settings.allowCompanyCreate  && settings.allowCompanyEdit  && settings.allowCompanyDelete;
    settings.allowWarehouseRetailerCRUD = settings.allowRetailerCreate && settings.allowRetailerEdit && settings.allowRetailerDelete;

    res.json({ success: true, data: { id: warehouse.id, name: warehouse.name, code: warehouse.code, settings } });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error retrieving warehouse settings', error: error.message });
  }
};

// @desc  PUT /api/warehouses/:id/settings
const updateWarehouseSettings = async (req, res) => {
  try {
    const { id } = req.params;
    const { settings } = req.body;
    if (!settings || typeof settings !== 'object')
      return res.status(400).json({ success: false, message: 'Settings object is required' });

    const Warehouse = require('../models/Warehouse');
    const warehouse = await Warehouse.findById(parseInt(id));
    if (!warehouse) return res.status(404).json({ success: false, message: 'Warehouse not found' });

    // Map camelCase → DB columns
    if (settings.allowWarehouseInventoryAdd  !== undefined) warehouse.allow_warehouse_inventory_add  = settings.allowWarehouseInventoryAdd  ? 1 : 0;
    if (settings.allowWarehouseInventoryEdit !== undefined) warehouse.allow_warehouse_inventory_edit = settings.allowWarehouseInventoryEdit ? 1 : 0;
    if (settings.allowWarehouseReturns       !== undefined) warehouse.allow_warehouse_returns        = settings.allowWarehouseReturns       ? 1 : 0;
    if (settings.allowWarehouseCompanies     !== undefined) warehouse.allow_warehouse_companies      = settings.allowWarehouseCompanies     ? 1 : 0;
    if (settings.allowWarehouseDirectSales   !== undefined) warehouse.allow_warehouse_direct_sales   = settings.allowWarehouseDirectSales   ? 1 : 0;
    if (settings.allowWarehouseLedgerEdit    !== undefined) warehouse.allow_warehouse_ledger_edit    = settings.allowWarehouseLedgerEdit    ? 1 : 0;
    if (settings.requireApprovalForTransfers !== undefined) warehouse.require_approval_for_transfers  = settings.requireApprovalForTransfers ? 1 : 0;
    if (settings.autoStockAlerts             !== undefined) warehouse.auto_stock_alerts              = settings.autoStockAlerts             ? 1 : 0;
    if (settings.allowWarehouseSalesEdit     !== undefined) warehouse.allow_warehouse_sales_edit     = settings.allowWarehouseSalesEdit     ? 1 : 0;
    if (settings.allowWarehouseSalesDelete   !== undefined) warehouse.allow_warehouse_sales_delete   = settings.allowWarehouseSalesDelete   ? 1 : 0;
    // Company
    if (settings.allowCompanyCreate !== undefined) warehouse.allow_company_create = settings.allowCompanyCreate ? 1 : 0;
    if (settings.allowCompanyEdit   !== undefined) warehouse.allow_company_edit   = settings.allowCompanyEdit   ? 1 : 0;
    if (settings.allowCompanyDelete !== undefined) warehouse.allow_company_delete = settings.allowCompanyDelete ? 1 : 0;
    // Retailer
    if (settings.allowRetailerCreate       !== undefined) warehouse.allow_retailer_create        = settings.allowRetailerCreate        ? 1 : 0;
    if (settings.allowRetailerEdit         !== undefined) warehouse.allow_retailer_edit          = settings.allowRetailerEdit          ? 1 : 0;
    if (settings.allowRetailerDelete       !== undefined) warehouse.allow_retailer_delete        = settings.allowRetailerDelete        ? 1 : 0;
    if (settings.allowRetailerCustomerEdit !== undefined) warehouse.allow_retailer_customer_edit = settings.allowRetailerCustomerEdit   ? 1 : 0;
    if (settings.allowWhatsappLedger       !== undefined) warehouse.allow_whatsapp_ledger        = settings.allowWhatsappLedger        ? 1 : 0;
    // Transfers
    if (settings.allowWarehouseTransfers              !== undefined) warehouse.allow_warehouse_transfers               = settings.allowWarehouseTransfers              ? 1 : 0;
    if (settings.allowWarehouseToBranchTransfers      !== undefined) warehouse.allow_warehouse_to_branch_transfers     = settings.allowWarehouseToBranchTransfers      ? 1 : 0;
    if (settings.allowWarehouseToWarehouseTransfers   !== undefined) warehouse.allow_warehouse_to_warehouse_transfers  = settings.allowWarehouseToWarehouseTransfers   ? 1 : 0;
    if (settings.requireApprovalForWarehouseTransfers !== undefined) warehouse.require_approval_for_warehouse_transfers = settings.requireApprovalForWarehouseTransfers ? 1 : 0;
    if (settings.maxTransferAmount         !== undefined) warehouse.max_transfer_amount          = parseFloat(settings.maxTransferAmount) || 0;
    if (settings.autoApproveSmallTransfers !== undefined) warehouse.auto_approve_small_transfers  = settings.autoApproveSmallTransfers    ? 1 : 0;
    if (settings.smallTransferThreshold    !== undefined) warehouse.small_transfer_threshold     = parseFloat(settings.smallTransferThreshold) || 0;

    const currentJsonSettings = { ...safeParseSettings(warehouse.settings) };
    columnsToRemove.forEach(col => delete currentJsonSettings[col]);
    const newJsonSettings = { ...settings };
    columnsToRemove.forEach(col => delete newJsonSettings[col]);
    warehouse.settings = { ...currentJsonSettings, ...newJsonSettings };

    await warehouse.save();
    return getWarehouseSettings(req, res);
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error updating warehouse settings', error: error.message });
  }
};

module.exports = { getWarehouseSettings, updateWarehouseSettings };