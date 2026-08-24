const { validationResult } = require('express-validator');
const POS = require('../models/POS');
const Branch = require('../models/Branch');
const InventoryItem = require('../models/InventoryItem');
const Sale = require('../models/Sale');
const { pool } = require('../config/database');
const { ledgerScopedQuantitySubquery } = require('../services/inventoryLedgerService');
// @desc    Get all POS terminals for a branch
// @route   GET /api/pos/branch/:branchId
// @access  Private (Admin, Warehouse Keeper, Cashier)
const getBranchPOS = async (req, res, next) => {
  try {
    const { branchId } = req.params;
    
    const [posTerminals] = await pool.execute(`
      SELECT 
        p.*,
        b.name as branch_name,
        b.code as branch_code,
        b.location as branch_location
      FROM pos p
      LEFT JOIN branches b ON p.scope_id = b.id AND p.scope_type = 'BRANCH'
      WHERE p.scope_id = ? AND p.scope_type = 'BRANCH'
      ORDER BY p.created_at DESC
    `, [branchId]);
    
    res.json({
      success: true,
      count: posTerminals.length,
      data: posTerminals
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error retrieving POS terminals',
      error: error.message
    });
  }
};

// @desc    Get all POS terminals
// @route   GET /api/pos
// @access  Private (Admin, Warehouse Keeper, Cashier)
const getAllPOS = async (req, res, next) => {
  try {
    const [posTerminals] = await pool.execute(`
      SELECT 
        p.*,
        b.name as branch_name,
        b.code as branch_code,
        b.location as branch_location,
        w.name as warehouse_name,
        w.code as warehouse_code,
        w.location as warehouse_location
      FROM pos p
      LEFT JOIN branches b ON p.scope_id = b.id AND p.scope_type = 'BRANCH'
      LEFT JOIN warehouses w ON p.scope_id = w.id AND p.scope_type = 'WAREHOUSE'
      ORDER BY p.created_at DESC
    `);
    
    res.json({
      success: true,
      count: posTerminals.length,
      data: posTerminals
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error retrieving POS terminals',
      error: error.message
    });
  }
};

// @desc    Get single POS terminal
// @route   GET /api/pos/:id
// @access  Private (Admin, Warehouse Keeper, Cashier)
const getPOS = async (req, res, next) => {
  try {
    const { id } = req.params;
    
    const pos = await POS.findById(id);
    if (!pos) {
      return res.status(404).json({
        success: false,
        message: 'POS terminal not found'
      });
    }
    
    res.json({
      success: true,
      data: pos
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error retrieving POS terminal',
      error: error.message
    });
  }
};

// @desc    Create new POS terminal
// @route   POST /api/pos
// @access  Private (Admin, Warehouse Keeper)
const createPOS = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation error',
        errors: errors.array()
      });
    }

    const {
      name,
      terminalId,
      branchId,
      location,
      hardwareConfig,
      settings
    } = req.body;

    // Check if terminal ID already exists
    const existingPOS = await POS.findByTerminalId(terminalId);
    if (existingPOS) {
      return res.status(400).json({
        success: false,
        message: 'Terminal ID already exists'
      });
    }

    // Verify branch exists
    const branch = await Branch.findById(branchId);
    if (!branch) {
      return res.status(404).json({
        success: false,
        message: 'Branch not found'
      });
    }

    const posData = {
      name,
      terminalId,
      branchId,
      location,
      hardwareConfig: hardwareConfig ? JSON.stringify(hardwareConfig) : null,
      settings: settings ? JSON.stringify(settings) : null,
      createdBy: req.user.id
    };

    const pos = await POS.create(posData);

    res.status(201).json({
      success: true,
      message: 'POS terminal created successfully',
      data: pos
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error creating POS terminal',
      error: error.message
    });
  }
};

// @desc    Update POS terminal
// @route   PUT /api/pos/:id
// @access  Private (Admin, Warehouse Keeper)
const updatePOS = async (req, res, next) => {
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
    const updateData = req.body;

    const pos = await POS.findById(id);
    if (!pos) {
      return res.status(404).json({
        success: false,
        message: 'POS terminal not found'
      });
    }

    // Check if terminal ID is being changed and if it already exists
    if (updateData.terminalId && updateData.terminalId !== pos.terminalId) {
      const existingPOS = await POS.findByTerminalId(updateData.terminalId);
      if (existingPOS) {
        return res.status(400).json({
          success: false,
          message: 'Terminal ID already exists'
        });
      }
    }

    // Convert JSON fields if provided
    if (updateData.hardwareConfig) {
      updateData.hardwareConfig = JSON.stringify(updateData.hardwareConfig);
    }
    if (updateData.settings) {
      updateData.settings = JSON.stringify(updateData.settings);
    }

    const updatedPOS = await POS.update(id, updateData);

    res.json({
      success: true,
      message: 'POS terminal updated successfully',
      data: updatedPOS
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error updating POS terminal',
      error: error.message
    });
  }
};

// @desc    Delete POS terminal
// @route   DELETE /api/pos/:id
// @access  Private (Admin)
const deletePOS = async (req, res, next) => {
  try {
    const { id } = req.params;

    // Only admin can delete POS terminals
    if (req.user.role !== 'ADMIN') {
      return res.status(403).json({
        success: false,
        message: 'Only administrators can delete POS terminals'
      });
    }

    const pos = await POS.findById(id);
    if (!pos) {
      return res.status(404).json({
        success: false,
        message: 'POS terminal not found'
      });
    }

    // Check if POS has associated sales
    const [salesCount] = await pool.execute(
      'SELECT COUNT(*) as count FROM sales WHERE pos_terminal_id = ?',
      [id]
    );

    if (salesCount[0].count > 0) {
      return res.status(400).json({
        success: false,
        message: 'Cannot delete POS terminal with associated sales'
      });
    }

    const trashService = require('../services/trashService');
    await trashService.softDelete('pos', id, req.user.id);

    res.json({
      success: true,
      message: 'POS terminal moved to trash successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error deleting POS terminal',
      error: error.message
    });
  }
};

// @desc    Get POS terminal status
// @route   GET /api/pos/:id/status
// @access  Private (Admin, Warehouse Keeper, Cashier)
const getPOSStatus = async (req, res, next) => {
  try {
    const { id } = req.params;

    const pos = await POS.findById(id);
    if (!pos) {
      return res.status(404).json({
        success: false,
        message: 'POS terminal not found'
      });
    }

    // Get recent sales count
    const [recentSalesCount] = await pool.execute(`
      SELECT COUNT(*) as count 
      FROM sales 
      WHERE pos_terminal_id = ? 
      AND created_at >= DATE_SUB(NOW(), INTERVAL 1 HOUR)
    `, [id]);

    // Get today's sales total
    const [todaySales] = await pool.execute(`
      SELECT 
        COUNT(*) as count,
        SUM(total) as total
      FROM sales 
      WHERE pos_terminal_id = ? 
      AND DATE(created_at) = CURDATE()
    `, [id]);

    res.json({
      success: true,
      data: {
        pos,
        status: pos.status || 'OFFLINE',
        recentSalesCount: recentSalesCount[0].count,
        todaySales: todaySales[0]
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error retrieving POS status',
      error: error.message
    });
  }
};

// @desc    Update POS terminal status
// @route   PUT /api/pos/:id/status
// @access  Private (Admin, Warehouse Keeper, Cashier)
const updatePOSStatus = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const pos = await POS.findById(id);
    if (!pos) {
      return res.status(404).json({
        success: false,
        message: 'POS terminal not found'
      });
    }

    const validStatuses = ['ONLINE', 'OFFLINE', 'MAINTENANCE', 'ERROR'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid status. Must be one of: ONLINE, OFFLINE, MAINTENANCE, ERROR'
      });
    }

    const updatedPOS = await POS.update(id, { status });

    res.json({
      success: true,
      message: 'POS status updated successfully',
      data: updatedPOS
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error updating POS status',
      error: error.message
    });
  }
};

// @desc    Get POS terminal sales
// @route   GET /api/pos/:id/sales
// @access  Private (Admin, Warehouse Keeper, Cashier)
const getPOSSales = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { startDate, endDate, paymentMethod } = req.query;

    const pos = await POS.findById(id);
    if (!pos) {
      return res.status(404).json({
        success: false,
        message: 'POS terminal not found'
      });
    }

    let whereConditions = ['pos_terminal_id = ?'];
    let params = [id];

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
      message: 'Error retrieving POS sales',
      error: error.message
    });
  }
};

// @desc    Get POS terminal inventory
// @route   GET /api/pos/:id/inventory
// @access  Private (Admin, Warehouse Keeper, Cashier)
const getPOSInventory = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { category, lowStock } = req.query;

    const pos = await POS.findById(id);
    if (!pos) {
      return res.status(404).json({
        success: false,
        message: 'POS terminal not found'
      });
    }

    let whereConditions = ['i.scope_type = ? AND i.scope_id = ?'];
    let params = ['BRANCH', pos.branchId];

    if (category) {
      whereConditions.push('i.category = ?');
      params.push(category);
    }

    const LQp = ledgerScopedQuantitySubquery();
    if (lowStock === 'true') {
      whereConditions.push('COALESCE(l.ledger_qty, 0) <= i.min_stock_level');
    }

    const whereClause = whereConditions.join(' AND ');

    const [inventoryItems] = await pool.execute(
      `
      SELECT i.*, COALESCE(l.ledger_qty, 0) AS ledger_stock
      FROM inventory_items i
      LEFT JOIN ${LQp} l ON l.inventory_item_id = i.id
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
      message: 'Error retrieving POS inventory',
      error: error.message
    });
  }
};

module.exports = {
  getBranchPOS,
  getAllPOS,
  getPOS,
  createPOS,
  updatePOS,
  deletePOS,
  getPOSStatus,
  updatePOSStatus,
  getPOSSales,
  getPOSInventory
};