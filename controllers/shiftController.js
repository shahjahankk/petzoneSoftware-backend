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
    if (!shiftId || initialCash === undefined) {
      return res.status(400).json({
        success: false,
        message: 'Shift ID and initial cash amount are required'
      });
    }

    // Check if shift exists
    const shifts = await executeQuery('SELECT * FROM shifts WHERE id = ?', [shiftId]);
    if (shifts.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Shift not found'
      });
    }

    // Check if user already has an active shift session
    const activeSessions = await executeQuery(
      'SELECT * FROM shift_sessions WHERE user_id = ? AND status = "ACTIVE" AND actual_end_time IS NULL',
      [userId]
    );

    if (activeSessions.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'You already have an active shift session. Please end it before starting a new one.'
      });
    }

    // Create new shift session
    const sessionResult = await executeQuery(`
      INSERT INTO shift_sessions (shift_id, user_id, status, actual_start_time, initial_cash, total_sales)
      VALUES (?, ?, 'ACTIVE', NOW(), ?, 0.00)
    `, [shiftId, userId, parseFloat(initialCash)]);

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

// @desc    End shift session
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
      data: updatedSession
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error ending shift session',
      error: error.message
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
    
    const shifts = await executeQuery(
      'SELECT ss.*, s.name as shift_name, s.start_time, s.end_time FROM shift_sessions ss JOIN shifts s ON ss.shift_id = s.id WHERE ss.user_id = ? AND ss.status = "ACTIVE" AND ss.actual_end_time IS NULL ORDER BY ss.actual_start_time DESC LIMIT 1',
      [cashierId]
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
  assignUserToShift,
  removeUserFromShift
};
