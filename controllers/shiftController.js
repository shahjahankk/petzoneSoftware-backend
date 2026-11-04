const { validationResult } = require('express-validator');
const Shift = require('../models/Shift');
const User = require('../models/User');
const Branch = require('../models/Branch');
const Sale = require('../models/Sale');
const { pool, sqliteDb, useSQLite, executeQuery } = require('../config/database');

// @desc    Get all shifts
// @route   GET /api/shifts
// @access  Private (Admin, Warehouse Keeper)
const getShifts = async (req, res, next) => {
  try {
    const { branchId, isActive } = req.query;
    let whereConditions = [];
    let params = [];
    
    if (branchId) {
      whereConditions.push('branch_id = ?');
      params.push(branchId);
    }
    
    if (isActive !== undefined) {
      whereConditions.push('is_active = ?');
      params.push(isActive === 'true' ? 1 : 0);
    }
    
    const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';
    
    const shifts = await executeQuery(`
      SELECT 
        s.*,
        b.name as branch_name,
        b.code as branch_code,
        b.location as branch_location,
        creator.username as created_by_username
      FROM shifts s
      LEFT JOIN branches b ON s.branch_id = b.id
      LEFT JOIN users creator ON s.created_by = creator.id
      ${whereClause}
      ORDER BY s.created_at DESC
    `, params);
    
    res.json({
      success: true,
      count: shifts.length,
      data: shifts
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error retrieving shifts',
      error: error.message
    });
  }
};

// @desc    Get single shift
// @route   GET /api/shifts/:id
// @access  Private (Admin, Warehouse Keeper)
const getShift = async (req, res, next) => {
  try {
    const { id } = req.params;
    
    const shift = await Shift.findById(id);
    if (!shift) {
      return res.status(404).json({
        success: false,
        message: 'Shift not found'
      });
    }
    
    res.json({
      success: true,
      data: shift
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error retrieving shift',
      error: error.message
    });
  }
};

// @desc    Create new shift
// @route   POST /api/shifts
// @access  Private (Admin, Warehouse Keeper)
const createShift = async (req, res, next) => {
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
      startTime,
      endTime,
      branchId,
      description,
      assignedUsers
    } = req.body;

    // Verify branch exists
    const branch = await Branch.findById(branchId);
    if (!branch) {
      return res.status(404).json({
        success: false,
        message: 'Branch not found'
      });
    }

    // Check for overlapping shifts
    const overlappingShifts = await executeQuery(`
      SELECT COUNT(*) as count 
      FROM shifts 
      WHERE branch_id = ? 
      AND is_active = 1
      AND (
        (start_time <= ? AND end_time > ?) OR
        (start_time < ? AND end_time >= ?) OR
        (start_time >= ? AND end_time <= ?)
      )
    `, [branchId, startTime, startTime, endTime, endTime, startTime, endTime]);

    if (overlappingShifts[0].count > 0) {
      return res.status(400).json({
        success: false,
        message: 'Shift time overlaps with existing active shift'
      });
    }

    const shiftData = {
      name,
      startTime,
      endTime,
      branchId,
      description,
      assignedUsers: assignedUsers ? JSON.stringify(assignedUsers) : null,
      createdBy: req.user.id
    };

    const shift = await Shift.create(shiftData);

    res.status(201).json({
      success: true,
      message: 'Shift created successfully',
      data: shift
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error creating shift',
      error: error.message
    });
  }
};

// @desc    Update shift
// @route   PUT /api/shifts/:id
// @access  Private (Admin, Warehouse Keeper)
const updateShift = async (req, res, next) => {
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

    const shift = await Shift.findById(id);
    if (!shift) {
      return res.status(404).json({
        success: false,
        message: 'Shift not found'
      });
    }

    // Check for overlapping shifts (excluding current shift)
    if (updateData.startTime || updateData.endTime) {
      const startTime = updateData.startTime || shift.startTime;
      const endTime = updateData.endTime || shift.endTime;

      const overlappingShifts = await executeQuery(`
        SELECT COUNT(*) as count 
        FROM shifts 
        WHERE branch_id = ? 
        AND id != ?
        AND is_active = 1
        AND (
          (start_time <= ? AND end_time > ?) OR
          (start_time < ? AND end_time >= ?) OR
          (start_time >= ? AND end_time <= ?)
        )
      `, [shift.branchId, id, startTime, startTime, endTime, endTime, startTime, endTime]);

      if (overlappingShifts[0].count > 0) {
        return res.status(400).json({
          success: false,
          message: 'Shift time overlaps with existing active shift'
        });
      }
    }

    // Convert assignedUsers to JSON if provided
    if (updateData.assignedUsers) {
      updateData.assignedUsers = JSON.stringify(updateData.assignedUsers);
    }

    const updatedShift = await Shift.update(id, updateData);

    res.json({
      success: true,
      message: 'Shift updated successfully',
      data: updatedShift
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error updating shift',
      error: error.message
    });
  }
};

// @desc    Delete shift
// @route   DELETE /api/shifts/:id
// @access  Private (Admin)
const deleteShift = async (req, res, next) => {
  try {
    const { id } = req.params;

    // Only admin can delete shifts
    if (req.user.role !== 'ADMIN') {
      return res.status(403).json({
        success: false,
        message: 'Only administrators can delete shifts'
      });
    }

    const shift = await Shift.findById(id);
    if (!shift) {
      return res.status(404).json({
        success: false,
        message: 'Shift not found'
      });
    }

    // Check if shift has associated sales
    const salesCount = await executeQuery(
      'SELECT COUNT(*) as count FROM sales WHERE shift_id = ?',
      [id]
    );

    if (salesCount[0].count > 0) {
      return res.status(400).json({
        success: false,
        message: 'Cannot delete shift with associated sales'
      });
    }

    await Shift.delete(id);

    res.json({
      success: true,
      message: 'Shift deleted successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error deleting shift',
      error: error.message
    });
  }
};

// @desc    Start shift session
// @route   POST /api/shifts/start-session
// @access  Private (Admin, Warehouse Keeper, Cashier)
const startShift = async (req, res, next) => {
  try {
    const { shiftId, initialCash } = req.body;
    const userId = req.user.id;

    // Validate required fields
    if (initialCash === undefined || initialCash === null || initialCash === '') {
      return res.status(400).json({
        success: false,
        message: 'Initial cash amount is required'
      });
    }

    // Resolve the actual shift row. The POS frontend sends placeholder values
    // such as 'shift-branch' / 'shift-warehouse', so we must not rely on the
    // client-supplied id existing in the shifts table.
    const scopeType = req.user.warehouseId ? 'WAREHOUSE' : 'BRANCH';
    const scopeId = req.user.warehouseId || req.user.branchId;

    let shift = null;

    if (shiftId !== undefined && shiftId !== null && shiftId !== '') {
      const byId = await executeQuery('SELECT * FROM shifts WHERE id = ?', [shiftId]);
      if (byId.length > 0) shift = byId[0];
    }

    if (!shift) {
      const byUser = await executeQuery(`
        SELECT * FROM shifts
        WHERE user_id = ?
        ORDER BY is_active DESC, created_at DESC
        LIMIT 1
      `, [userId]);
      if (byUser.length > 0) shift = byUser[0];
    }

    if (!shift && scopeId) {
      const byScope = await executeQuery(`
        SELECT * FROM shifts
        WHERE scope_type = ? AND scope_id = ?
        ORDER BY is_active DESC, created_at DESC
        LIMIT 1
      `, [scopeType, scopeId]);
      if (byScope.length > 0) shift = byScope[0];
    }

    // Still nothing? Create a shift for this user's assignment so a session
    // can always be started for a valid cashier/warehouse keeper.
    if (!shift && req.user.shift) {
      let scopeName = '';
      if (scopeType === 'BRANCH' && scopeId) {
        const branch = await executeQuery('SELECT name FROM branches WHERE id = ?', [scopeId]);
        scopeName = branch[0]?.name || '';
      } else if (scopeType === 'WAREHOUSE' && scopeId) {
        const warehouse = await executeQuery('SELECT name FROM warehouses WHERE id = ?', [scopeId]);
        scopeName = warehouse[0]?.name || '';
      }

      const shiftName = scopeName
        ? `${req.user.shift} Shift - ${scopeName}`
        : `${req.user.shift} Shift`;
      const startTime = req.user.shift === 'MORNING' ? '08:00:00' : req.user.shift === 'AFTERNOON' ? '12:00:00' : '20:00:00';
      const endTime = req.user.shift === 'MORNING' ? '16:00:00' : req.user.shift === 'AFTERNOON' ? '20:00:00' : '08:00:00';

      const created = await executeQuery(`
        INSERT INTO shifts (name, start_time, end_time, scope_type, scope_id, user_id, is_active, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?, NOW(), NOW())
      `, [shiftName, startTime, endTime, scopeType, scopeId || null, userId, userId]);

      const rows = await executeQuery('SELECT * FROM shifts WHERE id = ?', [created.insertId]);
      shift = rows[0];
    }

    if (!shift) {
      return res.status(404).json({
        success: false,
        message: 'No shift is assigned to this user. Ask an admin to assign a shift.'
      });
    }

    const resolvedShiftId = shift.id;

    // Check if user already has an active shift session
    const activeSessions = await executeQuery(
      'SELECT * FROM shift_sessions WHERE user_id = ? AND status = "ACTIVE" AND actual_end_time IS NULL',
      [userId]
    );

    // If user already has an active shift session, resume it (same-day continue)
    if (activeSessions.length > 0) {
      const [existingSession] = await executeQuery(`
        SELECT ss.*, s.name as shift_name, s.start_time, s.end_time 
        FROM shift_sessions ss 
        JOIN shifts s ON ss.shift_id = s.id 
        WHERE ss.id = ?
      `, [activeSessions[0].id]);

      return res.json({
        success: true,
        message: 'Resumed existing shift session',
        data: existingSession,
        resumed: true,
      });
    }

    // Create new shift session
    const sessionResult = await executeQuery(`
      INSERT INTO shift_sessions (shift_id, user_id, status, actual_start_time, initial_cash, total_sales)
      VALUES (?, ?, 'ACTIVE', NOW(), ?, 0.00)
    `, [resolvedShiftId, userId, parseFloat(initialCash)]);

    const sessionId = sessionResult.insertId;

    // Get the created session with shift details
    const [newSession] = await executeQuery(`
      SELECT ss.*, s.name as shift_name, s.start_time, s.end_time 
      FROM shift_sessions ss 
      JOIN shifts s ON ss.shift_id = s.id 
      WHERE ss.id = ?
    `, [sessionId]);

    res.json({
      success: true,
      message: 'Shift session started successfully',
      data: newSession
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error starting shift session',
      error: error.message
    });
  }
};

// @desc    End shift session with closing summary
// @route   POST /api/shifts/end-session
// @access  Private (Admin, Warehouse Keeper, Cashier)
const endShift = async (req, res, next) => {
  try {
    const { sessionId, finalCash } = req.body;
    const userId = req.user.id;

    // Validate required fields
    if (!sessionId || finalCash === undefined) {
      return res.status(400).json({
        success: false,
        message: 'Session ID and final cash amount are required'
      });
    }

    // Check if shift session exists and is active
    const sessions = await executeQuery(
      'SELECT * FROM shift_sessions WHERE id = ? AND user_id = ? AND status = "ACTIVE" AND actual_end_time IS NULL',
      [sessionId, userId]
    );

    if (sessions.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Active shift session not found'
      });
    }

    const session = sessions[0];
    const startTime = session.actual_start_time;
    const endTime = new Date();

    // ─── Closing summary: sales for this cashier during the session period ───

    // Sales header totals (product + clinic combined)
    const [salesSummary] = await executeQuery(`
      SELECT 
        COUNT(*) AS bill_count,
        COALESCE(SUM(s.total), 0) AS total_sales,
        COALESCE(SUM(s.subtotal), 0) AS total_subtotal,
        COALESCE(SUM(s.tax), 0) AS total_tax,
        COALESCE(SUM(s.discount), 0) AS total_discount,
        COALESCE(SUM(CASE WHEN s.payment_method = 'CASH' THEN s.total ELSE 0 END), 0) AS cash_sales,
        COALESCE(SUM(CASE WHEN s.payment_method = 'CARD' THEN s.total ELSE 0 END), 0) AS card_sales,
        COALESCE(SUM(CASE WHEN s.payment_method = 'MOBILE_PAYMENT' THEN s.total ELSE 0 END), 0) AS mobile_sales,
        COALESCE(SUM(CASE WHEN s.payment_method = 'FULLY_CREDIT' THEN s.total ELSE 0 END), 0) AS credit_sales,
        COALESCE(SUM(CASE WHEN s.payment_type = 'OUTSTANDING_SETTLEMENT' THEN s.payment_amount ELSE 0 END), 0) AS settlements
      FROM sales s
      WHERE s.user_id = ?
        AND s.status = 'COMPLETED'
        AND s.deleted_at IS NULL
        AND s.created_at BETWEEN ? AND ?
    `, [userId, startTime, endTime]);

    // Product / inventory line sales (non-clinic items)
    const [productSales] = await executeQuery(`
      SELECT COALESCE(SUM(si.total), 0) AS product_sales
      FROM sale_items si
      INNER JOIN sales s ON si.sale_id = s.id
      WHERE s.user_id = ?
        AND s.status = 'COMPLETED'
        AND s.deleted_at IS NULL
        AND si.inventory_item_id IS NOT NULL
        AND s.created_at BETWEEN ? AND ?
    `, [userId, startTime, endTime]);

    // Clinic service line sales
    const [clinicSales] = await executeQuery(`
      SELECT COALESCE(SUM(si.total), 0) AS clinic_sales
      FROM sale_items si
      INNER JOIN sales s ON si.sale_id = s.id
      WHERE s.user_id = ?
        AND s.status = 'COMPLETED'
        AND s.deleted_at IS NULL
        AND si.clinic_service_id IS NOT NULL
        AND s.created_at BETWEEN ? AND ?
    `, [userId, startTime, endTime]);

    const summary = salesSummary[0];
    const closingSummary = {
      bill_count: Number(summary.bill_count) || 0,
      total_sales: Number(summary.total_sales) || 0,
      total_subtotal: Number(summary.total_subtotal) || 0,
      total_tax: Number(summary.total_tax) || 0,
      total_discount: Number(summary.total_discount) || 0,
      product_sales: Number(productSales[0]?.product_sales) || 0,
      clinic_sales: Number(clinicSales[0]?.clinic_sales) || 0,
      cash_sales: Number(summary.cash_sales) || 0,
      card_sales: Number(summary.card_sales) || 0,
      mobile_sales: Number(summary.mobile_sales) || 0,
      credit_sales: Number(summary.credit_sales) || 0,
      settlements: Number(summary.settlements) || 0,
    };

    // End the shift session
    await executeQuery(`
      UPDATE shift_sessions 
      SET status = 'ENDED', actual_end_time = NOW(), final_cash = ?
      WHERE id = ?
    `, [parseFloat(finalCash), sessionId]);

    // Get the updated session with shift details
    const [updatedSession] = await executeQuery(`
      SELECT ss.*, s.name as shift_name, s.start_time, s.end_time 
      FROM shift_sessions ss 
      JOIN shifts s ON ss.shift_id = s.id 
      WHERE ss.id = ?
    `, [sessionId]);

    res.json({
      success: true,
      message: 'Shift session ended successfully',
      data: {
        ...updatedSession,
        closing_summary: closingSummary,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error ending shift session',
      error: error.message,
    });
  }
};

// @desc    Get user's recent shift sessions
// @route   GET /api/shifts/recent-sessions
// @access  Private (Cashier)
const getRecentShiftSessions = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { limit = 5 } = req.query;
    
    const sessions = await executeQuery(`
      SELECT 
        ss.*,
        s.name as shift_name,
        s.start_time as scheduled_start,
        s.end_time as scheduled_end
      FROM shift_sessions ss
      JOIN shifts s ON ss.shift_id = s.id
      WHERE ss.user_id = ?
      ORDER BY ss.actual_start_time DESC
      LIMIT ?
    `, [userId, parseInt(limit)]);
    
    res.json({
      success: true,
      count: sessions.length,
      data: sessions
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error fetching recent shift sessions'
    });
  }
};

// @desc    Get shift statistics
// @route   GET /api/shifts/:id/stats
// @access  Private (Admin, Warehouse Keeper, Cashier)
const getShiftStats = async (req, res, next) => {
  try {
    const { id } = req.params;

    const shift = await Shift.findById(id);
    if (!shift) {
      return res.status(404).json({
        success: false,
        message: 'Shift not found'
      });
    }

    // Get sales count and total for this shift
    const salesStats = await executeQuery(`
      SELECT 
        COUNT(*) as count,
        SUM(total) as totalSales,
        SUM(subtotal) as totalSubtotal,
        SUM(tax) as totalTax,
        SUM(discount) as totalDiscount
      FROM sales 
      WHERE shift_id = ?
    `, [id]);

    // Get assigned users
    const assignedUsers = shift.assignedUsers ? JSON.parse(shift.assignedUsers) : [];
    const userIds = assignedUsers.map(user => user.userId);

    let users = [];
    if (userIds.length > 0) {
      const usersData = await executeQuery(`
        SELECT id, username, email, role 
        FROM users 
        WHERE id IN (${userIds.map(() => '?').join(',')})
      `, userIds);
      users = usersData;
    }

    res.json({
      success: true,
      data: {
        shift,
        salesStats: salesStats[0],
        assignedUsers: users
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error retrieving shift statistics',
      error: error.message
    });
  }
};

// @desc    Get current active shift
// @route   GET /api/shifts/current
// @access  Private (Admin, Warehouse Keeper, Cashier)
const getCurrentShift = async (req, res, next) => {
  try {
    const { branchId } = req.query;


    let whereConditions = [];
    let params = [];

    // Check for active shifts first, if none found, get any shifts
    if (branchId) {
      whereConditions.push('branch_id = ?');
      params.push(branchId);
    } else if (req.user.branchId) {
      whereConditions.push('branch_id = ?');
      params.push(req.user.branchId);
    } else {
    }

    // Try active shifts first
    let activeWhereConditions = ['is_active = 1', ...whereConditions];
    let activeParams = [...params];

    // Try active shifts first
    let activeWhereClause = activeWhereConditions.join(' AND ');

    let shifts = await executeQuery(`
      SELECT 
        s.*,
        b.name as branch_name,
        b.code as branch_code,
        b.location as branch_location
      FROM shifts s
      LEFT JOIN branches b ON s.branch_id = b.id
      WHERE ${activeWhereClause}
      ORDER BY s.created_at DESC
      LIMIT 1
    `, activeParams);


    // If no active shifts, try any shifts
    if (shifts.length === 0) {
      let anyWhereClause = whereConditions.length > 0 ? whereConditions.join(' AND ') : '1=1';

      shifts = await executeQuery(`
        SELECT 
          s.*,
          b.name as branch_name,
          b.code as branch_code,
          b.location as branch_location
        FROM shifts s
        LEFT JOIN branches b ON s.branch_id = b.id
        WHERE ${anyWhereClause}
        ORDER BY s.created_at DESC
        LIMIT 1
      `, params);

    }

    if (shifts.length === 0) {
      return res.json({
        success: true,
        data: null,
        message: 'No shifts found'
      });
    }

    res.json({
      success: true,
      data: shifts[0]
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error retrieving current shift',
      error: error.message
    });
  }
};

// @desc    Validate POS access for current user
// @route   GET /api/shifts/validate-pos-access
// @access  Private
const validatePOSAccess = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const userRole = req.user.role;
    
    // Check if user has an active shift session
    const activeShiftSessions = await executeQuery(
      'SELECT ss.*, s.name as shift_name, s.start_time, s.end_time FROM shift_sessions ss JOIN shifts s ON ss.shift_id = s.id WHERE ss.user_id = ? AND ss.status = "ACTIVE" AND ss.actual_end_time IS NULL',
      [userId]
    );
    
    if (activeShiftSessions.length === 0) {
      return res.json({
        success: true,
        valid: false,
        message: 'No active shift session found. Please start a shift to access POS.'
      });
    }
    
    res.json({
      success: true,
      valid: true,
      message: 'POS access granted',
      shift: activeShiftSessions[0]
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error validating POS access',
      error: error.message
    });
  }
};

// @desc    Get active shift for cashier
// @route   GET /api/shifts/active/:cashierId
// @access  Private
const getActiveShift = async (req, res, next) => {
  try {
    const { cashierId } = req.params;

    // Accept either a numeric user id or a username/email (reports use names).
    let resolvedUserId = cashierId;
    if (cashierId && !/^\d+$/.test(String(cashierId))) {
      const users = await executeQuery(
        'SELECT id FROM users WHERE username = ? OR email = ? LIMIT 1',
        [cashierId, cashierId]
      );
      if (users.length === 0) {
        return res.json({
          success: true,
          data: null,
          message: 'No active shift session found'
        });
      }
      resolvedUserId = users[0].id;
    }
    
    const shifts = await executeQuery(
      'SELECT ss.*, s.name as shift_name, s.start_time, s.end_time FROM shift_sessions ss JOIN shifts s ON ss.shift_id = s.id WHERE ss.user_id = ? AND ss.status = "ACTIVE" AND ss.actual_end_time IS NULL ORDER BY ss.actual_start_time DESC LIMIT 1',
      [resolvedUserId]
    );
    
    if (shifts.length === 0) {
      return res.json({
        success: true,
        data: null,
        message: 'No active shift session found'
      });
    }
    
    res.json({
      success: true,
      data: shifts[0]
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error retrieving active shift',
      error: error.message
    });
  }
};

// @desc    Assign user to shift
// @route   POST /api/shifts/:id/assign-user
// @access  Private (Admin, Warehouse Keeper)
const assignUserToShift = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { userId, assignedBy } = req.body;
    
    // Check if shift exists
    const shifts = await executeQuery('SELECT * FROM shifts WHERE id = ?', [id]);
    if (shifts.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Shift not found'
      });
    }
    
    // Check if user exists
    const users = await executeQuery('SELECT * FROM users WHERE id = ?', [userId]);
    if (users.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }
    
    // Assign user to shift (this would need a shift_assignments table)
    // For now, just return success
    res.json({
      success: true,
      message: 'User assigned to shift successfully',
      data: { shiftId: id, userId, assignedBy }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error assigning user to shift',
      error: error.message
    });
  }
};

// @desc    Remove user from shift
// @route   DELETE /api/shifts/:id/assign-user/:userId
// @access  Private (Admin, Warehouse Keeper)
const removeUserFromShift = async (req, res, next) => {
  try {
    const { id, userId } = req.params;
    
    // Check if shift exists
    const shifts = await executeQuery('SELECT * FROM shifts WHERE id = ?', [id]);
    if (shifts.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Shift not found'
      });
    }
    
    // Remove user from shift (this would need a shift_assignments table)
    // For now, just return success
    res.json({
      success: true,
      message: 'User removed from shift successfully',
      data: { shiftId: id, userId }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error removing user from shift',
      error: error.message
    });
  }
};

// @desc    Shift cash report — opening/closing cash per session
// @route   GET /api/shifts/sessions
// @access  Private (Admin, Warehouse Keeper, Cashier — own sessions)
const getShiftSessionsReport = async (req, res, next) => {
  try {
    const { dateFrom, dateTo, userId, status, branchId, warehouseId, limit } = req.query;

    const emptyTotals = {
      sessions: 0,
      initial_cash: 0,
      cash_sales: 0,
      total_sales: 0,
      final_cash: 0,
      expected_cash: 0,
      cash_difference: 0,
    };

    // Cashiers may only see their own sessions; admins/keepers may filter by
    // user id, username or email.
    let effectiveUserId = userId;
    if (req.user.role === 'CASHIER') {
      effectiveUserId = req.user.id;
    } else if (userId && !/^\d+$/.test(String(userId))) {
      const users = await executeQuery(
        'SELECT id FROM users WHERE username = ? OR email = ? LIMIT 1',
        [userId, userId]
      );
      if (users.length === 0) {
        return res.json({ success: true, count: 0, data: [], totals: emptyTotals });
      }
      effectiveUserId = users[0].id;
    }

    const where = [];
    const params = [];

    if (dateFrom) {
      where.push('ss.actual_start_time >= ?');
      params.push(`${dateFrom} 00:00:00`);
    }
    if (dateTo) {
      where.push('ss.actual_start_time <= ?');
      params.push(`${dateTo} 23:59:59`);
    }
    if (effectiveUserId) {
      where.push('ss.user_id = ?');
      params.push(effectiveUserId);
    }
    if (status && status !== 'all') {
      where.push('ss.status = ?');
      params.push(status);
    }
    if (branchId) {
      where.push("s.scope_type = 'BRANCH' AND s.scope_id = ?");
      params.push(branchId);
    }
    if (warehouseId) {
      where.push("s.scope_type = 'WAREHOUSE' AND s.scope_id = ?");
      params.push(warehouseId);
    }

    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const parsedLimit = parseInt(limit, 10);
    const limitNum = Math.min(Math.max(Number.isFinite(parsedLimit) ? parsedLimit : 500, 1), 2000);

    const sessions = await executeQuery(`
      SELECT
        ss.id,
        ss.shift_id,
        ss.user_id,
        ss.status,
        ss.actual_start_time,
        ss.actual_end_time,
        ss.initial_cash,
        ss.final_cash,
        s.name AS shift_name,
        s.start_time,
        s.end_time,
        s.scope_type,
        s.scope_id,
        u.username AS cashier_name,
        u.role,
        b.name AS branch_name,
        w.name AS warehouse_name
      FROM shift_sessions ss
      JOIN shifts s ON ss.shift_id = s.id
      LEFT JOIN users u ON ss.user_id = u.id
      LEFT JOIN branches b ON s.scope_type = 'BRANCH' AND s.scope_id = b.id
      LEFT JOIN warehouses w ON s.scope_type = 'WAREHOUSE' AND s.scope_id = w.id
      ${whereClause}
      ORDER BY ss.actual_start_time DESC
      LIMIT ${limitNum}
    `, params);

    if (sessions.length === 0) {
      return res.json({
        success: true,
        count: 0,
        data: [],
        totals: {
          sessions: 0,
          initial_cash: 0,
          cash_sales: 0,
          total_sales: 0,
          final_cash: 0,
          expected_cash: 0,
          cash_difference: 0,
        },
      });
    }

    const ids = sessions.map((session) => session.id);
    const placeholders = ids.map(() => '?').join(',');
    const salesRows = await executeQuery(`
      SELECT
        ss.id AS session_id,
        COUNT(s.id) AS bill_count,
        COALESCE(SUM(s.total), 0) AS total_sales,
        COALESCE(SUM(CASE WHEN s.payment_method = 'CASH' THEN s.total ELSE 0 END), 0) AS cash_sales,
        COALESCE(SUM(CASE WHEN s.payment_method = 'CARD' THEN s.total ELSE 0 END), 0) AS card_sales,
        COALESCE(SUM(CASE WHEN s.payment_method = 'MOBILE_PAYMENT' THEN s.total ELSE 0 END), 0) AS mobile_sales,
        COALESCE(SUM(CASE WHEN s.payment_method = 'FULLY_CREDIT' THEN s.total ELSE 0 END), 0) AS credit_sales
      FROM shift_sessions ss
      LEFT JOIN sales s
        ON s.user_id = ss.user_id
       AND s.status = 'COMPLETED'
       AND s.deleted_at IS NULL
       AND s.created_at >= ss.actual_start_time
       AND s.created_at <= COALESCE(ss.actual_end_time, NOW())
      WHERE ss.id IN (${placeholders})
      GROUP BY ss.id
    `, ids);

    const salesBySession = {};
    salesRows.forEach((row) => {
      salesBySession[String(row.session_id)] = row;
    });

    const data = sessions.map((session) => {
      const agg = salesBySession[String(session.id)] || {};
      const initialCash = Number(session.initial_cash) || 0;
      const cashSales = Number(agg.cash_sales) || 0;
      const finalCash = session.final_cash === null || session.final_cash === undefined
        ? null
        : Number(session.final_cash);
      const expectedCash = initialCash + cashSales;

      return {
        ...session,
        initial_cash: initialCash,
        final_cash: finalCash,
        bill_count: Number(agg.bill_count) || 0,
        total_sales: Number(agg.total_sales) || 0,
        cash_sales: cashSales,
        card_sales: Number(agg.card_sales) || 0,
        mobile_sales: Number(agg.mobile_sales) || 0,
        credit_sales: Number(agg.credit_sales) || 0,
        expected_cash: expectedCash,
        cash_difference: finalCash === null ? null : finalCash - expectedCash,
      };
    });

    const totals = data.reduce((acc, row) => {
      acc.sessions += 1;
      acc.initial_cash += row.initial_cash;
      acc.cash_sales += row.cash_sales;
      acc.total_sales += row.total_sales;
      acc.final_cash += row.final_cash || 0;
      acc.expected_cash += row.expected_cash;
      acc.cash_difference += row.cash_difference || 0;
      return acc;
    }, {
      sessions: 0,
      initial_cash: 0,
      cash_sales: 0,
      total_sales: 0,
      final_cash: 0,
      expected_cash: 0,
      cash_difference: 0,
    });

    res.json({
      success: true,
      count: data.length,
      data,
      totals,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error generating shift cash report',
      error: error.message,
    });
  }
};

module.exports = {
  getShifts,
  getShift,
  createShift,
  updateShift,
  deleteShift,
  startShift,
  endShift,
  getShiftStats,
  getCurrentShift,
  validatePOSAccess,
  getActiveShift,
  getRecentShiftSessions,
  getShiftSessionsReport,
  assignUserToShift,
  removeUserFromShift
};
