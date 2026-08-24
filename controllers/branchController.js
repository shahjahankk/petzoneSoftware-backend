const { validationResult } = require('express-validator');
const Branch = require('../models/Branch');
const AdminSettings = require('../models/AdminSettings');
const POS = require('../models/POS');
const BranchLedger = require('../models/BranchLedger');
const InventoryItem = require('../models/InventoryItem');
const Customer = require('../models/Customer');
const CreditDebitTransaction = require('../models/CreditDebitTransaction');
const { executeQuery, pool } = require('../config/database');
const { ledgerScopedQuantitySubquery } = require('../services/inventoryLedgerService');
const { remapBranchScopeName } = require('../services/branchScopeRemapService');
const { withBrandFields, normalizeBrand, parseSettings } = require('../utils/brandLogo');

// @desc    Get all branches
// @route   GET /api/branches
// @access  Private (Admin, Warehouse Keeper)
const getBranches = async (req, res, next) => {
  try {
    const { page = 1, limit = 10, search } = req.query;
    let whereConditions = [];
    let params = [];

    // Add search conditions
    if (search) {
      whereConditions.push('name LIKE ?');
      params.push(`%${search}%`);
    }

    const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';
    const offset = (parseInt(page) - 1) * parseInt(limit);

    // Get total count
    const countResult = await executeQuery(`
      SELECT COUNT(*) as total FROM branches ${whereClause}
    `, params);

    // Get branches with pagination
    const branches = await executeQuery(`
      SELECT * FROM branches
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `, [...params, parseInt(limit), parseInt(offset)]);

              // Transform field names to match frontend expectations
              const transformedBranches = branches.map(branch => {
                const settings = parseSettings(branch.settings);
                const brandFields = withBrandFields({ settings });
                return {
                  id: branch.id,
                  name: branch.name,
                  code: branch.code,
                  location: branch.location,
                  phone: branch.phone,
                  email: branch.email,
                  managerName: branch.manager_name,
                  managerPhone: branch.manager_phone,
                  managerEmail: branch.manager_email,
                  linkedWarehouseId: branch.linked_warehouse_id,
                  status: branch.status,
                  createdBy: branch.created_by,
                  updatedBy: branch.updated_by,
                  settings: { ...settings, brand: brandFields.brand },
                  brand: brandFields.brand,
                  logoUrl: brandFields.logoUrl,
                  created_at: branch.created_at,
                  updated_at: branch.updated_at
                };
              });

    res.json({
      success: true,
      count: transformedBranches.length,
      total: countResult[0].total,
      page: parseInt(page),
      pages: Math.ceil(countResult[0].total / parseInt(limit)),
      data: transformedBranches
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error retrieving branches',
      error: error.message
    });
  }
};

// @desc    Get single branch
// @route   GET /api/branches/:id
// @access  Private (Admin, Warehouse Keeper)
const getBranch = async (req, res, next) => {
  try {
    const { id } = req.params;

    const branch = await Branch.findById(parseInt(id));
    if (!branch) {
      return res.status(404).json({
        success: false,
        message: 'Branch not found'
      });
    }

    const brandFields = withBrandFields(branch);
    const settings = { ...(branch.settings || {}), brand: brandFields.brand };

    res.json({
      success: true,
      data: {
        ...branch,
        settings,
        brand: brandFields.brand,
        logoUrl: brandFields.logoUrl,
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error retrieving branch',
      error: error.message
    });
  }
};

// @desc    Create new branch
// @route   POST /api/branches
// @access  Private (Admin)
const createBranch = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation error',
        errors: errors.array()
      });
    }

    // Only admin can create branches
    if (req.user.role !== 'ADMIN') {
      return res.status(403).json({
        success: false,
        message: 'Only administrators can create branches'
      });
    }

    const {
      name,
      code,
      location,
      phone,
      email,
      managerName,
      managerPhone,
      managerEmail,
      linkedWarehouseId,
      status,
      settings,
      brand
    } = req.body;

    // Check if branch code already exists
    const existingBranch = await Branch.findByCode(code);
    if (existingBranch) {
      return res.status(400).json({
        success: false,
        message: 'Branch code already exists'
      });
    }

    const incomingSettings = parseSettings(settings);
    const resolvedBrand = normalizeBrand(brand || incomingSettings.brand);
    const mergedSettings = {
      allowInventoryEdit: true,
      allowCreditSales: true,
      allowDebitSales: true,
      requireShiftValidation: true,
      autoProvisionPOS: true,
      autoProvisionInventory: true,
      autoProvisionLedger: true,
      autoProvisionCustomers: true,
      ...incomingSettings,
      brand: resolvedBrand,
    };

    const branchData = {
      name,
      code,
      location,
      phone: phone || null,
      email: email || null,
      managerName: managerName || null,
      managerPhone: managerPhone || null,
      managerEmail: managerEmail || null,
      linkedWarehouseId: linkedWarehouseId || null,
      status: status || 'active',
      settings: JSON.stringify(mergedSettings),
      createdBy: req.user.id
    };

    const branch = await Branch.create(branchData);
    const brandFields = withBrandFields(branch);

    res.status(201).json({
      success: true,
      message: 'Branch created successfully',
      data: {
        ...branch,
        settings: { ...(branch.settings || {}), brand: brandFields.brand },
        brand: brandFields.brand,
        logoUrl: brandFields.logoUrl,
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error creating branch',
      error: error.message
    });
  }
};

// @desc    Update branch
// @route   PUT /api/branches/:id
// @access  Private (Admin)
const updateBranch = async (req, res, next) => {
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
    const body = req.body || {};

    // Only admin can update branches
    if (req.user.role !== 'ADMIN') {
      return res.status(403).json({
        success: false,
        message: 'Only administrators can update branches'
      });
    }

    const branch = await Branch.findById(parseInt(id));
    if (!branch) {
      return res.status(404).json({
        success: false,
        message: 'Branch not found'
      });
    }

    // Check if branch code is being changed and if it already exists
    if (body.code && body.code !== branch.code) {
      const existingBranch = await Branch.findByCode(body.code);
      if (existingBranch) {
        return res.status(400).json({
          success: false,
          message: 'Branch code already exists'
        });
      }
    }

    // Build a clean payload — do NOT pre-stringify settings (Branch.update handles that once).
    // Nested form fields like settings.allowBranchTransfers arrive as body.settings.
    const existingSettings =
      branch.settings && typeof branch.settings === 'object' ? branch.settings : {};
    const incomingSettings =
      body.settings && typeof body.settings === 'object'
        ? body.settings
        : (typeof body.settings === 'string'
            ? (() => { try { return JSON.parse(body.settings); } catch { return {}; } })()
            : null);

    const updateData = {
      name: body.name,
      code: body.code,
      location: body.location,
      phone: body.phone !== undefined ? (body.phone || null) : undefined,
      email: body.email !== undefined ? (body.email || null) : undefined,
      managerName: body.managerName !== undefined ? (body.managerName || null) : undefined,
      managerPhone: body.managerPhone !== undefined ? (body.managerPhone || null) : undefined,
      managerEmail: body.managerEmail !== undefined ? (body.managerEmail || null) : undefined,
      linkedWarehouseId: body.linkedWarehouseId !== undefined
        ? (body.linkedWarehouseId === '' || body.linkedWarehouseId === null
            ? null
            : parseInt(body.linkedWarehouseId, 10))
        : undefined,
      status: body.status,
      updatedBy: req.user.id,
    };

    if (incomingSettings || body.brand !== undefined) {
      const merged = { ...existingSettings, ...(incomingSettings || {}) };
      if (body.brand !== undefined || merged.brand !== undefined) {
        merged.brand = normalizeBrand(body.brand !== undefined ? body.brand : merged.brand);
      }
      updateData.settings = merged;
    }

    // Remove undefined so Branch.update only touches provided fields
    Object.keys(updateData).forEach((key) => {
      if (updateData[key] === undefined) delete updateData[key];
    });

    const oldName = (branch.name || '').trim();
    const newName = updateData.name !== undefined ? String(updateData.name || '').trim() : oldName;
    const nameChanging = Boolean(newName && oldName && newName !== oldName);

    // If renaming: remap sales/ledger scope_id (stored as branch name) in the same transaction
    // so history does not "disappear" under the new name.
    let remapSummary = null;
    let updatedBranch;

    if (nameChanging) {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();

        // Update branch row first
        const dbUpdateData = {};
        if (updateData.name !== undefined) dbUpdateData.name = updateData.name;
        if (updateData.code !== undefined) dbUpdateData.code = updateData.code;
        if (updateData.location !== undefined) dbUpdateData.location = updateData.location;
        if (updateData.phone !== undefined) dbUpdateData.phone = updateData.phone;
        if (updateData.email !== undefined) dbUpdateData.email = updateData.email;
        if (updateData.managerName !== undefined) dbUpdateData.manager_name = updateData.managerName;
        if (updateData.managerPhone !== undefined) dbUpdateData.manager_phone = updateData.managerPhone;
        if (updateData.managerEmail !== undefined) dbUpdateData.manager_email = updateData.managerEmail;
        if (updateData.linkedWarehouseId !== undefined) dbUpdateData.linked_warehouse_id = updateData.linkedWarehouseId;
        if (updateData.status !== undefined) dbUpdateData.status = updateData.status;
        if (updateData.settings !== undefined) {
          dbUpdateData.settings = typeof updateData.settings === 'string'
            ? updateData.settings
            : JSON.stringify(updateData.settings);
        }
        if (updateData.updatedBy !== undefined) dbUpdateData.updated_by = updateData.updatedBy;
        dbUpdateData.updated_at = new Date();

        const setClauses = Object.keys(dbUpdateData).map((k) => `${k} = ?`);
        const params = Object.keys(dbUpdateData).map((k) => dbUpdateData[k]);
        params.push(parseInt(id, 10));

        const [upd] = await conn.execute(
          `UPDATE branches SET ${setClauses.join(', ')} WHERE id = ?`,
          params
        );
        if (!upd.affectedRows) {
          throw new Error('Branch not found');
        }

        remapSummary = await remapBranchScopeName(oldName, newName, conn);

        await conn.commit();
        updatedBranch = await Branch.findById(parseInt(id, 10));
      } catch (err) {
        try { await conn.rollback(); } catch (_) { /* ignore */ }
        throw err;
      } finally {
        conn.release();
      }
    } else {
      updatedBranch = await Branch.update(parseInt(id, 10), updateData);
    }

    const brandFields = withBrandFields(updatedBranch || {});

    res.json({
      success: true,
      message: nameChanging
        ? 'Branch updated successfully. Sales/ledger scope references were remapped to the new name.'
        : 'Branch updated successfully',
      data: {
        ...(updatedBranch || {}),
        settings: {
          ...parseSettings(updatedBranch?.settings),
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
      message: 'Error updating branch',
      error: error.message
    });
  }
};

// @desc    Update branch settings only
// @route   PUT /api/branches/:id/settings
// @access  Private (Admin)
const updateBranchSettings = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { settings } = req.body;

    // Only admin can update branch settings
    if (req.user.role !== 'ADMIN') {
      return res.status(403).json({
        success: false,
        message: 'Only administrators can update branch settings'
      });
    }

    // Validate settings object
    if (!settings || typeof settings !== 'object') {
      return res.status(400).json({
        success: false,
        message: 'Settings object is required'
      });
    }

    // Check if branch exists using direct database query
    const { executeQuery } = require('../config/database');
    const [branchRows] = await executeQuery('SELECT id FROM branches WHERE id = ?', [parseInt(id)]);
    
    if (branchRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Branch not found'
      });
    }

    // Update only the settings field using direct database query
    await executeQuery('UPDATE branches SET settings = ? WHERE id = ?', [JSON.stringify(settings), parseInt(id)]);

    // Fetch the updated branch to return complete data
    let updatedBranch;
    try {
      const [updatedRows] = await executeQuery('SELECT * FROM branches WHERE id = ?', [parseInt(id)]);
      if (updatedRows.length > 0) {
        const branch = updatedRows[0];
        updatedBranch = {
          id: branch.id,
          name: branch.name,
          code: branch.code,
          location: branch.location,
          address: branch.address,
          phone: branch.phone,
          email: branch.email,
          managerName: branch.manager_name,
          managerPhone: branch.manager_phone,
          managerEmail: branch.manager_email,
          linkedWarehouseId: branch.linked_warehouse_id,
          status: branch.status,
          createdBy: branch.created_by,
          updatedBy: branch.updated_by,
          settings: branch.settings ? (typeof branch.settings === 'string' ? JSON.parse(branch.settings) : branch.settings) : {},
          created_at: branch.created_at,
          updated_at: branch.updated_at
        };
      } else {
        // Fallback if we can't fetch the updated branch
        updatedBranch = {
          id: parseInt(id),
          settings: settings
        };
      }
    } catch (findError) {
      // If we can't fetch the updated branch, return success with the updated settings
      updatedBranch = {
        id: parseInt(id),
        settings: settings
      };
    }

    res.json({
      success: true,
      message: 'Branch settings updated successfully',
      data: updatedBranch
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error updating branch settings',
      error: error.message
    });
  }
};

// @desc    Delete branch
// @route   DELETE /api/branches/:id
// @access  Private (Admin)
const deleteBranch = async (req, res, next) => {
  try {
    const { id } = req.params;

    // Only admin can delete branches
    if (req.user.role !== 'ADMIN') {
      return res.status(403).json({
        success: false,
        message: 'Only administrators can delete branches'
      });
    }

    const branch = await Branch.findById(parseInt(id));
    if (!branch) {
      return res.status(404).json({
        success: false,
        message: 'Branch not found'
      });
    }

    // Check if branch has associated data
    const [inventoryCount] = await pool.execute(
      'SELECT COUNT(*) as count FROM inventory_items WHERE scope_type = ? AND scope_id = ?',
      ['BRANCH', id]
    );

    const [salesCount] = await pool.execute(
      'SELECT COUNT(*) as count FROM sales WHERE scope_type = ? AND scope_id = ?',
      ['BRANCH', id]
    );

    if (inventoryCount[0].count > 0 || salesCount[0].count > 0) {
      return res.status(400).json({
        success: false,
        message: 'Cannot delete branch with associated inventory or sales data'
      });
    }

    const trashService = require('../services/trashService');
    await trashService.softDelete('branch', parseInt(id), req.user.id);

    res.json({
      success: true,
      message: 'Branch moved to trash successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error deleting branch',
      error: error.message
    });
  }
};

// @desc    Get branch statistics
// @route   GET /api/branches/:id/stats
// @access  Private (Admin, Warehouse Keeper)
const getBranchStats = async (req, res, next) => {
  try {
    const { id } = req.params;

    const branch = await Branch.findById(id);
    if (!branch) {
      return res.status(404).json({
        success: false,
        message: 'Branch not found'
      });
    }

    // Get inventory count
    const [inventoryCount] = await pool.execute(
      'SELECT COUNT(*) as count FROM inventory_items WHERE scope_type = ? AND scope_id = ?',
      ['BRANCH', id]
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
    `, ['BRANCH', id]);

    // Get users count
    const [usersCount] = await pool.execute(
      'SELECT COUNT(*) as count FROM users WHERE branch_id = ?',
      [id]
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
    `, ['BRANCH', id]);

    res.json({
      success: true,
      data: {
        branch,
        inventoryCount: inventoryCount[0].count,
        salesStats: salesStats[0],
        usersCount: usersCount[0].count,
        recentSales
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error retrieving branch statistics',
      error: error.message
    });
  }
};

// @desc    Get branch inventory
// @route   GET /api/branches/:id/inventory
// @access  Private (Admin, Warehouse Keeper)
const getBranchInventory = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { category, lowStock } = req.query;

    const branch = await Branch.findById(id);
    if (!branch) {
      return res.status(404).json({
        success: false,
        message: 'Branch not found'
      });
    }

    let whereConditions = ['i.scope_type = ? AND i.scope_id = ?'];
    let params = ['BRANCH', id];

    if (category) {
      whereConditions.push('i.category = ?');
      params.push(category);
    }

    const LQb = ledgerScopedQuantitySubquery();
    if (lowStock === 'true') {
      whereConditions.push('COALESCE(l.ledger_qty, 0) <= i.min_stock_level');
    }

    const whereClause = whereConditions.join(' AND ');

    const [inventoryItems] = await pool.execute(
      `
      SELECT i.*, COALESCE(l.ledger_qty, 0) AS ledger_stock
      FROM inventory_items i
      LEFT JOIN ${LQb} l ON l.inventory_item_id = i.id
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
      message: 'Error retrieving branch inventory',
      error: error.message
    });
  }
};

// @desc    Get branch sales
// @route   GET /api/branches/:id/sales
// @access  Private (Admin, Warehouse Keeper)
const getBranchSales = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { startDate, endDate, paymentMethod } = req.query;

    const branch = await Branch.findById(id);
    if (!branch) {
      return res.status(404).json({
        success: false,
        message: 'Branch not found'
      });
    }

    let whereConditions = ['scope_type = ? AND scope_id = ?'];
    let params = ['BRANCH', id];

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
      message: 'Error retrieving branch sales',
      error: error.message
    });
  }
};

// @desc    List BRANCH scope_id values on sales that do not match any current branch name
// @route   GET /api/branches/orphaned-scopes
// @access  Private (Admin)
const listOrphanedBranchScopes = async (req, res) => {
  try {
    if (req.user.role !== 'ADMIN') {
      return res.status(403).json({ success: false, message: 'Admin only' });
    }

    const rows = await executeQuery(`
      SELECT s.scope_id AS oldName, COUNT(*) AS salesCount
      FROM sales s
      LEFT JOIN branches b
        ON b.name = s.scope_id
      WHERE s.scope_type = 'BRANCH'
        AND s.deleted_at IS NULL
        AND s.scope_id IS NOT NULL
        AND TRIM(s.scope_id) <> ''
        AND b.id IS NULL
      GROUP BY s.scope_id
      ORDER BY salesCount DESC
    `);

    const branches = await executeQuery(`SELECT id, name, code FROM branches ORDER BY id`);

    res.json({
      success: true,
      message: 'Orphaned BRANCH scope names (present on sales, but no matching branch name)',
      data: {
        orphans: rows,
        currentBranches: branches,
        howToFix: 'POST /api/branches/remap-scope with { "oldName": "<orphan oldName>", "branchId": <current branch id> }',
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error listing orphaned branch scopes',
      error: error.message,
    });
  }
};

// @desc    Repair orphaned sales/ledger after a branch was renamed without remapping
// @route   POST /api/branches/remap-scope
// @access  Private (Admin)
const repairBranchScopeName = async (req, res) => {
  try {
    if (req.user.role !== 'ADMIN') {
      return res.status(403).json({
        success: false,
        message: 'Only administrators can remap branch scope names'
      });
    }

    const oldName = (req.body?.oldName || '').trim();
    let newName = (req.body?.newName || '').trim();
    const branchId = req.body?.branchId != null ? parseInt(req.body.branchId, 10) : null;

    if (!oldName) {
      return res.status(400).json({
        success: false,
        message: 'oldName is required (the previous branch name still stored on sales/ledger rows)'
      });
    }

    if (!newName && branchId) {
      const branch = await Branch.findById(branchId);
      if (!branch) {
        return res.status(404).json({ success: false, message: 'Branch not found' });
      }
      newName = (branch.name || '').trim();
    }

    if (!newName) {
      return res.status(400).json({
        success: false,
        message: 'newName or branchId is required'
      });
    }

    const summary = await remapBranchScopeName(oldName, newName);

    res.json({
      success: true,
      message: `Remapped BRANCH scope_id from "${oldName}" to "${newName}"`,
      data: summary,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error remapping branch scope name',
      error: error.message,
    });
  }
};

module.exports = {
  getBranches,
  getBranch,
  createBranch,
  updateBranch,
  updateBranchSettings,
  deleteBranch,
  getBranchStats,
  getBranchInventory,
  getBranchSales,
  listOrphanedBranchScopes,
  repairBranchScopeName,
};