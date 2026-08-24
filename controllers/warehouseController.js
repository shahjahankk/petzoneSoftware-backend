const { validationResult } = require('express-validator');
const Warehouse = require('../models/Warehouse');
const AdminSettings = require('../models/AdminSettings');
const InventoryItem = require('../models/InventoryItem');
const { ledgerScopedQuantitySubquery } = require('../services/inventoryLedgerService');
const Customer = require('../models/Customer');
const CreditDebitTransaction = require('../models/CreditDebitTransaction');
const { executeQuery, pool } = require('../config/database');
const WarehouseInitializer = require('../services/warehouseInitializer');
const { remapWarehouseScopeName } = require('../services/branchScopeRemapService');
const { withBrandFields, normalizeBrand, parseSettings } = require('../utils/brandLogo');

// @desc    Get all warehouses
// @route   GET /api/warehouses
// @access  Private (Admin, Warehouse Keeper)
const getWarehouses = async (req, res, next) => {
  try {
    const { page = 1, limit = 10, search } = req.query;
    let whereConditions = [];
    let params = [];

    // Add role-based filtering
    if (req.user.role === 'WAREHOUSE_KEEPER') {
      // Check if this is for transfer purposes (allow seeing all warehouses)
      const { forTransfer } = req.query;
      if (!forTransfer) {
        // Warehouse keepers can only see their assigned warehouse for normal operations
        whereConditions.push('id = ?');
        params.push(req.user.warehouseId);
      }
      // If forTransfer=true, don't add any restrictions (show all warehouses)
    }

    // Add search conditions
    if (search) {
      whereConditions.push('name LIKE ? OR code LIKE ?');
      params.push(`%${search}%`, `%${search}%`);
    }

    const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';
    const offset = (parseInt(page) - 1) * parseInt(limit);

    // Get total count
    const countResult = await executeQuery(`
      SELECT COUNT(*) as total FROM warehouses ${whereClause}
    `, params);

    // Get warehouses with pagination
    const warehouses = await executeQuery(`
      SELECT * FROM warehouses 
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `, [...params, parseInt(limit), parseInt(offset)]);

    // Transform field names to match frontend expectations
    const transformedWarehouses = warehouses.map(warehouse => {
      const settings = parseSettings(warehouse.settings);
      const brandFields = withBrandFields({ settings });
      return {
        id: warehouse.id,
        name: warehouse.name,
        code: warehouse.code,
        location: warehouse.location,
        phone: warehouse.phone || null,
        branchId: warehouse.branch_id,
        capacity: warehouse.capacity || 1000,
        stock: warehouse.stock || 0,
        currentStock: warehouse.current_stock || 0,
        manager: warehouse.manager || 'Not Assigned',
        status: warehouse.status || 'active',
        settings: { ...settings, brand: brandFields.brand },
        brand: brandFields.brand,
        logoUrl: brandFields.logoUrl,
        createdAt: warehouse.created_at,
        updatedAt: warehouse.updated_at
      };
    });

    res.json({
      success: true,
      count: transformedWarehouses.length,
      total: countResult[0].total,
      page: parseInt(page),
      pages: Math.ceil(countResult[0].total / parseInt(limit)),
      data: transformedWarehouses
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error retrieving warehouses',
      error: error.message
    });
  }
};

// @desc    Get single warehouse
// @route   GET /api/warehouses/:id
// @access  Private (Admin, Warehouse Keeper)
const getWarehouse = async (req, res, next) => {
  try {
    const { id } = req.params;

    const warehouse = await Warehouse.findById(id);
    if (!warehouse) {
      return res.status(404).json({
        success: false,
        message: 'Warehouse not found'
      });
    }

    // Transform field names to match frontend expectations
    const brandFields = withBrandFields(warehouse);
    const settings = { ...(warehouse.settings || {}), brand: brandFields.brand };
    const transformedWarehouse = {
      id: warehouse.id,
      name: warehouse.name,
      code: warehouse.code,
      location: warehouse.location,
      phone: warehouse.phone || null,
      branchId: warehouse.branch_id,
      capacity: warehouse.capacity || 1000,
      stock: warehouse.stock || 0,
      currentStock: warehouse.current_stock || 0,
      manager: warehouse.manager || 'Not Assigned',
      status: warehouse.status || 'active',
      settings,
      brand: brandFields.brand,
      logoUrl: brandFields.logoUrl,
      createdAt: warehouse.created_at,
      updatedAt: warehouse.updated_at
    };

    res.json({
      success: true,
      data: transformedWarehouse
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error retrieving warehouse',
      error: error.message
    });
  }
};

// @desc    Create new warehouse
// @route   POST /api/warehouses
// @access  Private (Admin)
const createWarehouse = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation error',
        errors: errors.array()
      });
    }

    // Only admin can create warehouses
    if (req.user.role !== 'ADMIN') {
      return res.status(403).json({
        success: false,
        message: 'Only administrators can create warehouses'
      });
    }

    const {
      name,
      code,
      location,
      capacity,
      stock,
      manager,
      phone,
      status,
      linkedBranchId,
      settings,
      brand
    } = req.body;

    // Check if warehouse code already exists
    const existingWarehouse = await Warehouse.findByCode(code);
    if (existingWarehouse) {
      return res.status(400).json({
        success: false,
        message: 'Warehouse code already exists'
      });
    }

    const incomingSettings = parseSettings(settings);
    const resolvedBrand = normalizeBrand(brand || incomingSettings.brand);
    const mergedSettings = {
      autoProvisionInventory: true,
      autoProvisionCreditDebit: true,
      allowRetailerSales: true,
      requireApprovalForSales: false,
      independentOperation: true,
      allowInventoryEdit: true,
      allowCompanyAdd: true,
      allowReturns: true,
      autoProvisionLedger: true,
      autoProvisionCustomers: true,
      ...incomingSettings,
      brand: resolvedBrand,
    };

    const warehouseData = {
      name,
      code,
      location,
      branch_id: linkedBranchId || null,
      capacity: capacity || null,
      stock: stock || null,
      manager: manager || 'Not Assigned',
      phone: phone || null,
      status: status || 'active',
      settings: JSON.stringify(mergedSettings),
      created_by: req.user.id
    };

    const warehouse = await Warehouse.create(warehouseData);
    const brandFields = withBrandFields(warehouse);
    const warehouseResponse = {
      ...warehouse,
      settings: { ...(warehouse.settings || {}), brand: brandFields.brand },
      brand: brandFields.brand,
      logoUrl: brandFields.logoUrl,
    };

    // Initialize complete warehouse functionality automatically
    try {
      const initializer = new WarehouseInitializer(
        warehouse.id,
        name,
        req.user.id
      );
      
      const initResult = await initializer.initialize();

      res.status(201).json({
        success: true,
        message: 'Warehouse created and fully initialized with all functionality ready for warehouse keepers',
        data: warehouseResponse,
        initialization: initResult,
        readyFeatures: [
          'Dashboard Analytics',
          'Company Management (Suppliers)',
          'Retailer Management (Customers)',
          'Warehouse Billing System',
          'Warehouse Ledger with Chart of Accounts',
          'Sales Analytics & Reporting',
          'Returns Management',
          'Inventory Management',
          'Transfer Management',
          'Comprehensive Reports'
        ]
      });
    } catch (initError) {
      
      // Still return success for warehouse creation, but note initialization issue
      res.status(201).json({
        success: true,
        message: 'Warehouse created successfully, but some initialization steps failed',
        data: warehouseResponse,
        warning: 'Manual setup may be required for some features',
        initializationError: initError.message
      });
    }
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error creating warehouse',
      error: error.message
    });
  }
};

// @desc    Update warehouse
// @route   PUT /api/warehouses/:id
// @access  Private (Admin)
const updateWarehouse = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation error',
        errors: errors.array()
      });
    }

    const { id } = req.params;
    const updateData = { ...req.body };

    if (Object.prototype.hasOwnProperty.call(updateData, 'linkedBranchId')) {
      const lb = updateData.linkedBranchId;
      updateData.branchId = lb === '' || lb === null || lb === undefined ? null : lb;
      delete updateData.linkedBranchId;
    }

    // Only admin can update warehouses
    if (req.user.role !== 'ADMIN') {
      return res.status(403).json({
        success: false,
        message: 'Only administrators can update warehouses'
      });
    }

    const warehouse = await Warehouse.findById(id);
    if (!warehouse) {
      return res.status(404).json({
        success: false,
        message: 'Warehouse not found'
      });
    }

    // Check if warehouse code is being changed and if it already exists
    if (updateData.code && updateData.code !== warehouse.code) {
      const existingWarehouse = await Warehouse.findByCode(updateData.code);
      if (existingWarehouse) {
        return res.status(400).json({
          success: false,
          message: 'Warehouse code already exists'
        });
      }
    }

    // Do NOT pre-stringify settings — Warehouse.update handles JSON once
    if (typeof updateData.settings === 'string') {
      try {
        updateData.settings = JSON.parse(updateData.settings);
      } catch (_) {
        // leave as-is; Warehouse.update will stringify
      }
    }

    const existingSettings = parseSettings(warehouse.settings);
    if (updateData.settings || updateData.brand !== undefined) {
      const incoming = updateData.settings && typeof updateData.settings === 'object'
        ? updateData.settings
        : {};
      const merged = { ...existingSettings, ...incoming };
      merged.brand = normalizeBrand(
        updateData.brand !== undefined ? updateData.brand : merged.brand
      );
      updateData.settings = merged;
    }
    delete updateData.brand;

    updateData.updatedBy = req.user.id;

    const oldName = (warehouse.name || '').trim();
    const newName = updateData.name !== undefined ? String(updateData.name || '').trim() : oldName;
    const nameChanging = Boolean(newName && oldName && newName !== oldName);

    let remapSummary = null;
    let updatedWarehouse;

    if (nameChanging) {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();

        // Apply warehouse field updates on this connection
        const dbUpdateData = {};
        if (updateData.name !== undefined) dbUpdateData.name = updateData.name;
        if (updateData.code !== undefined) dbUpdateData.code = updateData.code;
        if (updateData.location !== undefined) dbUpdateData.location = updateData.location;
        if (updateData.branchId !== undefined) dbUpdateData.branch_id = updateData.branchId;
        if (updateData.capacity !== undefined) dbUpdateData.capacity = updateData.capacity;
        if (updateData.stock !== undefined) dbUpdateData.stock = updateData.stock;
        if (updateData.phone !== undefined) dbUpdateData.phone = updateData.phone;
        if (updateData.manager !== undefined) dbUpdateData.manager = updateData.manager;
        if (updateData.status !== undefined) dbUpdateData.status = updateData.status;
        if (updateData.settings !== undefined) {
          dbUpdateData.settings = typeof updateData.settings === 'string'
            ? updateData.settings
            : JSON.stringify(updateData.settings);
        }
        if (updateData.updatedBy !== undefined) dbUpdateData.updated_by = updateData.updatedBy;
        dbUpdateData.updated_at = new Date();

        // Pass through known permission columns if provided
        const permissionFields = [
          'allow_warehouse_inventory_add', 'allow_warehouse_inventory_edit',
          'allow_warehouse_returns', 'allow_warehouse_companies',
          'allow_warehouse_direct_sales', 'allow_warehouse_ledger_edit',
          'require_approval_for_transfers', 'auto_stock_alerts',
          'allow_warehouse_company_crud',
          'allow_warehouse_sales_edit', 'allow_warehouse_sales_delete',
          'allow_company_create', 'allow_company_edit', 'allow_company_delete',
          'allow_retailer_create', 'allow_retailer_edit', 'allow_retailer_delete',
          'allow_retailer_customer_edit', 'allow_whatsapp_ledger',
          'allow_warehouse_transfers', 'allow_warehouse_to_branch_transfers',
          'allow_warehouse_to_warehouse_transfers',
          'require_approval_for_warehouse_transfers',
          'max_transfer_amount', 'auto_approve_small_transfers', 'small_transfer_threshold'
        ];
        permissionFields.forEach((field) => {
          if (updateData[field] !== undefined) dbUpdateData[field] = updateData[field];
        });

        const setClauses = Object.keys(dbUpdateData).map((k) => `${k} = ?`);
        const params = Object.keys(dbUpdateData).map((k) => dbUpdateData[k]);
        params.push(id);

        const [upd] = await conn.execute(
          `UPDATE warehouses SET ${setClauses.join(', ')} WHERE id = ?`,
          params
        );
        if (!upd.affectedRows) {
          throw new Error('Warehouse not found');
        }

        remapSummary = await remapWarehouseScopeName(oldName, newName, conn);

        await conn.commit();
        updatedWarehouse = await Warehouse.findById(id);
      } catch (err) {
        try { await conn.rollback(); } catch (_) { /* ignore */ }
        throw err;
      } finally {
        conn.release();
      }
    } else {
      updatedWarehouse = await Warehouse.update(id, updateData);
    }

    const brandFields = withBrandFields(updatedWarehouse || {});

    res.json({
      success: true,
      message: nameChanging
        ? 'Warehouse updated successfully. Sales/ledger scope references were remapped to the new name.'
        : 'Warehouse updated successfully',
      data: {
        ...(updatedWarehouse || {}),
        settings: {
          ...parseSettings(updatedWarehouse?.settings),
          brand: brandFields.brand,
        },
        brand: brandFields.brand,
        logoUrl: brandFields.logoUrl,
      },
      scopeRemap: remapSummary,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error updating warehouse',
      error: error.message
    });
  }
};

// @desc    Delete warehouse
// @route   DELETE /api/warehouses/:id
// @access  Private (Admin)
const deleteWarehouse = async (req, res, next) => {
  try {
    const { id } = req.params;

    // Only admin can delete warehouses
    if (req.user.role !== 'ADMIN') {
      return res.status(403).json({
        success: false,
        message: 'Only administrators can delete warehouses'
      });
    }

    const warehouse = await Warehouse.findById(id);
    if (!warehouse) {
      return res.status(404).json({
        success: false,
        message: 'Warehouse not found'
      });
    }

    // Check if warehouse has associated data
    const [inventoryCount] = await pool.execute(
      'SELECT COUNT(*) as count FROM inventory_items WHERE scope_type = ? AND scope_id = ?',
      ['WAREHOUSE', id]
    );

    const [salesCount] = await pool.execute(
      'SELECT COUNT(*) as count FROM sales WHERE scope_type = ? AND scope_id = ?',
      ['WAREHOUSE', id]
    );

    if (inventoryCount[0].count > 0 || salesCount[0].count > 0) {
      return res.status(400).json({
        success: false,
        message: 'Cannot delete warehouse with associated inventory or sales data'
      });
    }

    const trashService = require('../services/trashService');
    await trashService.softDelete('warehouse', id, req.user.id);

    res.json({
      success: true,
      message: 'Warehouse moved to trash successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error deleting warehouse',
      error: error.message
    });
  }
};

// @desc    Get warehouse statistics
// @route   GET /api/warehouses/:id/stats
// @access  Private (Admin, Warehouse Keeper)
const getWarehouseStats = async (req, res, next) => {
  try {
    const { id } = req.params;

    const warehouse = await Warehouse.findById(id);
    if (!warehouse) {
      return res.status(404).json({
        success: false,
        message: 'Warehouse not found'
      });
    }

    // Get inventory count
    const [inventoryCount] = await pool.execute(
      'SELECT COUNT(*) as count FROM inventory_items WHERE scope_type = ? AND scope_id = ?',
      ['WAREHOUSE', id]
    );

    // Get sales count and total
    const [salesStats] = await pool.execute(`
      SELECT 
        COUNT(*) as count,
        SUM(total) as totalSales,
        SUM(subtotal) as totalSubtotal,
        SUM(tax) as totalTax,
        SUM(discount) as totalDiscount
      FROM sales 
      WHERE scope_type = ? AND scope_id = ?
    `, ['WAREHOUSE', id]);

    // Get users count
    const [usersCount] = await pool.execute(
      'SELECT COUNT(*) as count FROM users WHERE warehouse_id = ?',
      [id]
    );

    const LQ = ledgerScopedQuantitySubquery();
    const [lowStockCount] = await pool.execute(
      `SELECT COUNT(*) as count FROM inventory_items i
       LEFT JOIN ${LQ} l ON l.inventory_item_id = i.id
       WHERE i.scope_type = ? AND i.scope_id = ?
         AND COALESCE(l.ledger_qty, 0) <= i.min_stock_level`,
      ['WAREHOUSE', id]
    );

    // Get recent sales
    const [recentSales] = await pool.execute(`
      SELECT 
        s.*,
        u.username
      FROM sales s
      LEFT JOIN users u ON s.user_id = u.id
      WHERE s.scope_type = ? AND s.scope_id = ?
      ORDER BY s.created_at DESC
      LIMIT 5
    `, ['WAREHOUSE', id]);

    res.json({
      success: true,
      data: {
        warehouse,
        inventoryCount: inventoryCount[0].count,
        salesStats: salesStats[0],
        usersCount: usersCount[0].count,
        lowStockCount: lowStockCount[0].count,
        recentSales
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error retrieving warehouse statistics',
      error: error.message
    });
  }
};

// @desc    Get warehouse inventory
// @route   GET /api/warehouses/:id/inventory
// @access  Private (Admin, Warehouse Keeper)
const getWarehouseInventory = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { category, lowStock } = req.query;

    const warehouse = await Warehouse.findById(id);
    if (!warehouse) {
      return res.status(404).json({
        success: false,
        message: 'Warehouse not found'
      });
    }

    let whereConditions = ['i.scope_type = ? AND i.scope_id = ?'];
    let params = ['WAREHOUSE', id];

    if (category) {
      whereConditions.push('i.category = ?');
      params.push(category);
    }

    const LQf = ledgerScopedQuantitySubquery();
    if (lowStock === 'true') {
      whereConditions.push('COALESCE(l.ledger_qty, 0) <= i.min_stock_level');
    }

    const whereClause = whereConditions.join(' AND ');

    const [inventoryItems] = await pool.execute(
      `
      SELECT i.*, COALESCE(l.ledger_qty, 0) AS ledger_stock
      FROM inventory_items i
      LEFT JOIN ${LQf} l ON l.inventory_item_id = i.id
      WHERE ${whereClause}
      ORDER BY i.created_at DESC
    `,
      params
    );

    res.json({
      success: true,
      count: inventoryItems.length,
      data: inventoryItems
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error retrieving warehouse inventory',
      error: error.message
    });
  }
};

// @desc    Get warehouse sales
// @route   GET /api/warehouses/:id/sales
// @access  Private (Admin, Warehouse Keeper)
const getWarehouseSales = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { startDate, endDate, paymentMethod } = req.query;

    const warehouse = await Warehouse.findById(id);
    if (!warehouse) {
      return res.status(404).json({
        success: false,
        message: 'Warehouse not found'
      });
    }

    let whereConditions = ['scope_type = ? AND scope_id = ?'];
    let params = ['WAREHOUSE', id];

    if (startDate) {
      whereConditions.push('created_at >= ?');
      params.push(startDate);
    }

    if (endDate) {
      whereConditions.push('created_at <= ?');
      params.push(endDate);
    }

    if (paymentMethod) {
      whereConditions.push('payment_method = ?');
      params.push(paymentMethod);
    }

    const whereClause = whereConditions.join(' AND ');

    const [sales] = await pool.execute(`
      SELECT 
        s.*,
        u.username,
        u.email
      FROM sales s
      LEFT JOIN users u ON s.user_id = u.id
      WHERE ${whereClause}
      ORDER BY s.created_at DESC
    `, params);

    res.json({
      success: true,
      count: sales.length,
      data: sales
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error retrieving warehouse sales',
      error: error.message
    });
  }
};

// @desc    Repair orphaned sales/ledger after a warehouse was renamed without remapping
// @route   POST /api/warehouses/remap-scope
// @access  Private (Admin)
// Body: { oldName: "Old WH Name", newName?: "New Name", warehouseId?: 1 }
const repairWarehouseScopeName = async (req, res) => {
  try {
    if (req.user.role !== 'ADMIN') {
      return res.status(403).json({
        success: false,
        message: 'Only administrators can remap warehouse scope names'
      });
    }

    const oldName = (req.body?.oldName || '').trim();
    let newName = (req.body?.newName || '').trim();
    const warehouseId = req.body?.warehouseId != null ? parseInt(req.body.warehouseId, 10) : null;

    if (!oldName) {
      return res.status(400).json({
        success: false,
        message: 'oldName is required (the previous warehouse name still stored on sales/ledger rows)'
      });
    }

    if (!newName && warehouseId) {
      const warehouse = await Warehouse.findById(warehouseId);
      if (!warehouse) {
        return res.status(404).json({ success: false, message: 'Warehouse not found' });
      }
      newName = (warehouse.name || '').trim();
    }

    if (!newName) {
      return res.status(400).json({
        success: false,
        message: 'newName or warehouseId is required'
      });
    }

    const summary = await remapWarehouseScopeName(oldName, newName);

    res.json({
      success: true,
      message: `Remapped WAREHOUSE scope_id from "${oldName}" to "${newName}"`,
      data: summary,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error remapping warehouse scope name',
      error: error.message,
    });
  }
};

module.exports = {
  getWarehouses,
  getWarehouse,
  createWarehouse,
  updateWarehouse,
  deleteWarehouse,
  getWarehouseStats,
  getWarehouseInventory,
  getWarehouseSales,
  repairWarehouseScopeName,
};