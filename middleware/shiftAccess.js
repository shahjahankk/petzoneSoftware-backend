const Shift = require('../models/Shift');

// Middleware to check if user has assigned shifts (for audit tracking)
const requireShiftAccess = async (req, res, next) => {
  try {
    const user = req.user;
    
    // Admin users have unrestricted access
    if (user.role === 'ADMIN') {
      return next();
    }

    // Check if user has any assigned shifts (for audit tracking)
    const shifts = await Shift.findShiftsForUser(user.id || user._id);
    
    if (shifts.length === 0) {
      return res.status(403).json({
        success: false,
        message: 'No shifts assigned to user'
      });
    }

    // Use the first active shift for audit tracking (no time restrictions)
    const activeShift = shifts.find(shift => shift.isActive) || shifts[0];
    
    if (activeShift) {
      req.currentShift = activeShift;
    }

    next();
  } catch (error) {
    next(error);
  }
};

// Middleware to validate shift access for sales operations (for audit tracking)
const requireShiftAccessForSales = async (req, res, next) => {
  try {
    const user = req.user;
    
    // Admin users have unrestricted access
    if (user.role === 'ADMIN') {
      return next();
    }

    // For CASHIER users, allow access even without shifts for testing purposes
    // TODO: Implement proper shift management system
    if (user.role === 'CASHIER') {
      return next();
    }

    // Check if user has any assigned shifts (for audit tracking)
    const shifts = await Shift.findShiftsForUser(user.id || user._id);
    
    if (shifts.length === 0) {
      return res.status(403).json({
        success: false,
        message: 'No shifts assigned to user'
      });
    }

    // Use the first active shift for audit tracking (no time restrictions)
    const activeShift = shifts.find(shift => shift.isActive) || shifts[0];
    
    if (activeShift) {
      req.currentShift = activeShift;
    }

    // Add current shift ID to request body for sales creation
    if (req.method === 'POST' && req.body && req.currentShift) {
      req.body.shiftId = req.currentShift.id;
    }

    next();
  } catch (error) {
    next(error);
  }
};

// Middleware to check if user can access specific branch based on shift
const requireShiftAccessForBranch = async (req, res, next) => {
  try {
    const user = req.user;
    const branchId = req.params.branchId || req.body.branchId;
    
    // Admin users have unrestricted access
    if (user.role === 'ADMIN') {
      return next();
    }

    if (!branchId) {
      return res.status(400).json({
        success: false,
        message: 'Branch ID is required'
      });
    }

    // Check if user has shifts assigned to this branch
    const shifts = await Shift.find({
      branchId,
      'assignedUsers.userId': user.id || user._id,
      isActive: true
    });

    if (shifts.length === 0) {
      return res.status(403).json({
        success: false,
        message: 'No shifts assigned to user for this branch'
      });
    }

    // Check if current time falls within any assigned shift for this branch
    const currentShift = shifts.find(shift => shift.isCurrentTimeInShift());
    
    if (!currentShift) {
      return res.status(403).json({
        success: false,
        message: 'Access denied: Current time is outside assigned shift hours for this branch'
      });
    }

    req.currentShift = currentShift;
    next();
  } catch (error) {
    next(error);
  }
};

// Middleware to validate shift access for inventory operations
const requireShiftAccessForInventory = async (req, res, next) => {
  try {
    const user = req.user;
    
    // Admin users have unrestricted access
    if (user.role === 'ADMIN') {
      return next();
    }

    // For CASHIER users, allow access even without shifts for testing purposes
    // TODO: Implement proper shift management system
    if (user.role === 'CASHIER') {
      return next();
    }

    // Check if user has any assigned shifts (for audit tracking)
    const shifts = await Shift.findShiftsForUser(user.id || user._id);
    
    if (shifts.length === 0) {
      return res.status(403).json({
        success: false,
        message: 'No shifts assigned to user'
      });
    }

    // Use the first active shift for audit tracking (no time restrictions)
    const activeShift = shifts.find(shift => shift.isActive) || shifts[0];
    
    if (activeShift) {
      req.currentShift = activeShift;
    }

    next();
  } catch (error) {
    next(error);
  }
};

module.exports = {
  requireShiftAccess,
  requireShiftAccessForSales,
  requireShiftAccessForBranch,
  requireShiftAccessForInventory
};

