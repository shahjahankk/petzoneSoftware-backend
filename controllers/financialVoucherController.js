const FinancialVoucher = require('../models/FinancialVoucher');
const { pool } = require('../config/database');
const PDFDocument = require('pdfkit');
const { format } = require('date-fns');
const trashService = require('../services/trashService');

// Get all financial vouchers with filters
const getFinancialVouchers = async (req, res) => {
  try {
    const {
      type, category, paymentMethod, scopeType, scopeId, status, userId,
      dateFrom, dateTo, search, page = 1, limit = 25
    } = req.query;

    const user = req.user;

    // Build filters object
    const filters = {};
    if (type) filters.type = type;
    if (category) filters.category = category;
    if (paymentMethod) filters.paymentMethod = paymentMethod;
    if (status) filters.status = status;
    if (userId) filters.userId = userId;
    if (dateFrom) filters.dateFrom = dateFrom;
    if (dateTo) filters.dateTo = dateTo;
    if (search) filters.search = search;

    // Role-based scope filtering
    if (user.role === 'CASHIER') {
      // Cashiers can only see vouchers for their branch
      filters.scopeType = 'BRANCH';
      filters.scopeId = String(user.branchId);
    } else if (user.role === 'WAREHOUSE_KEEPER') {
      // Warehouse keepers can only see vouchers for their warehouse
      filters.scopeType = 'WAREHOUSE';
      filters.scopeId = String(user.warehouseId);
    } else if (user.role === 'ADMIN') {
      // Admins can see all vouchers, but can filter by scope
      if (scopeType) filters.scopeType = scopeType;
      if (scopeId) filters.scopeId = scopeId;
    } else {
      return res.status(403).json({
        success: false,
        message: 'Insufficient permissions to view financial vouchers'
      });
    }

    // Add pagination
    const offset = (page - 1) * limit;
    filters.limit = parseInt(limit);
    filters.offset = offset;

    const vouchers = await FinancialVoucher.find(filters);

    // Get total count for pagination
    let countQuery = 'SELECT COUNT(*) as total FROM financial_vouchers WHERE deleted_at IS NULL';
    const countParams = [];

    if (type) {
      countQuery += ' AND type = ?';
      countParams.push(type);
    }
    if (category) {
      countQuery += ' AND category = ?';
      countParams.push(category);
    }
    if (paymentMethod) {
      countQuery += ' AND payment_method = ?';
      countParams.push(paymentMethod);
    }
    if (status) {
      countQuery += ' AND status = ?';
      countParams.push(status);
    }
    if (userId) {
      countQuery += ' AND user_id = ?';
      countParams.push(userId);
    }
    if (dateFrom) {
      countQuery += ' AND DATE(created_at) >= ?';
      countParams.push(dateFrom);
    }
    if (dateTo) {
      countQuery += ' AND DATE(created_at) <= ?';
      countParams.push(dateTo);
    }
    if (search) {
      countQuery += ' AND (voucher_no LIKE ? OR description LIKE ? OR reference LIKE ? OR user_name LIKE ?)';
      const searchPattern = `%${search}%`;
      countParams.push(searchPattern, searchPattern, searchPattern, searchPattern);
    }

    // Add role-based scope filtering to count query
    if (user.role === 'CASHIER') {
      countQuery += ' AND scope_type = ? AND scope_id = ?';
      countParams.push('BRANCH', String(user.branchId));
    } else if (user.role === 'WAREHOUSE_KEEPER') {
      countQuery += ' AND scope_type = ? AND scope_id = ?';
      countParams.push('WAREHOUSE', String(user.warehouseId));
    } else if (user.role === 'ADMIN') {
      if (scopeType) {
        countQuery += ' AND scope_type = ?';
        countParams.push(scopeType);
      }
      if (scopeId) {
        countQuery += ' AND scope_id = ?';
        countParams.push(scopeId);
      }
    }

    const [countResult] = await pool.execute(countQuery, countParams);
    const total = countResult[0].total;

    res.json({
      success: true,
      data: vouchers,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to fetch financial vouchers',
      error: error.message
    });
  }
};

// Get financial voucher by ID
const getFinancialVoucherById = async (req, res) => {
  try {
    const { id } = req.params;
    const voucher = await FinancialVoucher.findById(id);

    if (!voucher) {
      return res.status(404).json({
        success: false,
        message: 'Financial voucher not found'
      });
    }

    res.json({
      success: true,
      data: voucher
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to fetch financial voucher',
      error: error.message
    });
  }
};

// Create new financial voucher
const createFinancialVoucher = async (req, res) => {
  try {
    const {
      type, category, expenseCategory, paymentMethod, amount, description, reference,
      scopeType, scopeId, notes, priority, dueDate, attachmentUrl, items
    } = req.body;

    // Role-based validation
    const user = req.user;
    
    // Validate user permissions
    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'User not authenticated'
      });
    }

    // Determine scope based on user role
    let finalScopeType = scopeType;
    let finalScopeId = scopeId;

    if (user.role === 'CASHIER') {
      // Cashiers can only create vouchers for their branch
      if (!user.branchId) {
        return res.status(403).json({
          success: false,
          message: 'Cashier must be assigned to a branch'
        });
      }
      finalScopeType = 'BRANCH';
      finalScopeId = String(user.branchId);
    } else if (user.role === 'WAREHOUSE_KEEPER') {
      // Warehouse keepers can only create vouchers for their warehouse
      if (!user.warehouseId) {
        return res.status(403).json({
          success: false,
          message: 'Warehouse keeper must be assigned to a warehouse'
        });
      }
      finalScopeType = 'WAREHOUSE';
      finalScopeId = String(user.warehouseId);
    } else if (user.role === 'ADMIN') {
      // Admins can create vouchers for any scope
      if (!scopeType || !scopeId) {
        return res.status(400).json({
          success: false,
          message: 'Admin must specify scope type and scope ID'
        });
      }
    } else {
      return res.status(403).json({
        success: false,
        message: 'Insufficient permissions to create financial vouchers'
      });
    }

    // Validate required fields
    if (!type || !category || !amount) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: type, category, amount'
      });
    }

    // Validate amount
    if (parseFloat(amount) <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Amount must be greater than 0'
      });
    }

    // Generate voucher number
    const voucherNo = await FinancialVoucher.generateVoucherNo(type);

    // Direct post — no admin approval wait (counts in reports immediately)
    const status = 'APPROVED';

    // Create voucher data
    const voucherData = {
      voucherNo,
      type,
      category,
      expenseCategory: expenseCategory || 'OTHER',
      paymentMethod: paymentMethod || 'CASH',
      amount: parseFloat(amount),
      description: description || '',
      reference: reference || '',
      scopeType: finalScopeType,
      scopeId: finalScopeId,
      userId: user.id,
      userName: user.name || user.username,
      userRole: user.role,
      status,
      notes: notes || '',
      priority: priority || 'MEDIUM',
      dueDate: dueDate || null,
      attachmentUrl: attachmentUrl || null,
      approvedBy: user.id,
      approvalNotes: 'Auto-approved on create',
      rejectionReason: null
    };

    const voucher = await FinancialVoucher.create(voucherData);

    // Create voucher items if provided
    if (items && items.length > 0) {
      await FinancialVoucher.createVoucherItems(voucher.id, items);
    }

    // Record create + auto-approval in history
    try {
      await pool.execute(
        `INSERT INTO financial_voucher_approvals (
          voucher_id, action, performed_by, performed_by_name, performed_by_role, comments, created_at
        ) VALUES (?, 'APPROVED', ?, ?, ?, ?, NOW())`,
        [voucher.id, user.id, user.name || user.username, user.role, 'Voucher created and auto-approved']
      );
    } catch (histErr) {
      // History table optional — do not fail create
      console.warn('voucher approval history insert skipped:', histErr.message);
    }

    res.status(201).json({
      success: true,
      message: 'Financial voucher created and approved',
      data: voucher
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to create financial voucher',
      error: error.message
    });
  }
};

// Update financial voucher
const updateFinancialVoucher = async (req, res) => {
  try {
    const { id } = req.params;
    const updateData = req.body;

    const voucher = await FinancialVoucher.findById(id);
    if (!voucher) {
      return res.status(404).json({
        success: false,
        message: 'Financial voucher not found'
      });
    }

    const updatedVoucher = await voucher.update(updateData);

    res.json({
      success: true,
      message: 'Financial voucher updated successfully',
      data: updatedVoucher
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to update financial voucher',
      error: error.message
    });
  }
};

// Approve financial voucher
const approveFinancialVoucher = async (req, res) => {
  try {
    const { id } = req.params;
    const { notes } = req.body;
    const user = req.user;

    // Only admins can approve vouchers
    if (user.role !== 'ADMIN') {
      return res.status(403).json({
        success: false,
        message: 'Only administrators can approve financial vouchers'
      });
    }

    const voucher = await FinancialVoucher.findById(id);
    if (!voucher) {
      return res.status(404).json({
        success: false,
        message: 'Financial voucher not found'
      });
    }

    // Check if voucher is already processed
    if (voucher.status !== 'PENDING') {
      return res.status(400).json({
        success: false,
        message: `Voucher is already ${voucher.status.toLowerCase()}`
      });
    }

    // Check scope permissions for admin
    if (user.role === 'ADMIN') {
      // Admin can approve any voucher, but let's log the scope for audit
    }

    const approvedVoucher = await voucher.approve(user.id, notes);

    res.json({
      success: true,
      message: 'Financial voucher approved successfully',
      data: approvedVoucher
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to approve financial voucher',
      error: error.message
    });
  }
};

// Reject financial voucher
const rejectFinancialVoucher = async (req, res) => {
  try {
    const { id } = req.params;
    const { notes, rejectionReason } = req.body;
    const user = req.user;

    // Only admins can reject vouchers
    if (user.role !== 'ADMIN') {
      return res.status(403).json({
        success: false,
        message: 'Only administrators can reject financial vouchers'
      });
    }

    const voucher = await FinancialVoucher.findById(id);
    if (!voucher) {
      return res.status(404).json({
        success: false,
        message: 'Financial voucher not found'
      });
    }

    // Check if voucher is already processed
    if (voucher.status !== 'PENDING') {
      return res.status(400).json({
        success: false,
        message: `Voucher is already ${voucher.status.toLowerCase()}`
      });
    }

    // Validate rejection reason
    if (!rejectionReason) {
      return res.status(400).json({
        success: false,
        message: 'Rejection reason is required'
      });
    }

    // Check scope permissions for admin
    if (user.role === 'ADMIN') {
      // Admin can reject any voucher, but let's log the scope for audit
    }

    const rejectedVoucher = await voucher.reject(user.id, rejectionReason, notes);

    res.json({
      success: true,
      message: 'Financial voucher rejected successfully',
      data: rejectedVoucher
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to reject financial voucher',
      error: error.message
    });
  }
};

// Delete financial voucher
const deleteFinancialVoucher = async (req, res) => {
  try {
    const { id } = req.params;

    const voucher = await FinancialVoucher.findById(id);
    if (!voucher) {
      return res.status(404).json({
        success: false,
        message: 'Financial voucher not found'
      });
    }

    await trashService.softDelete('financial_voucher', id, req.user.id);

    res.json({
      success: true,
      message: 'Moved to trash'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to delete financial voucher',
      error: error.message
    });
  }
};

// Get financial summary
const getFinancialSummary = async (req, res) => {
  try {
    const { dateFrom, dateTo, scopeType, scopeId } = req.query;

    const filters = {};
    if (dateFrom) filters.dateFrom = dateFrom;
    if (dateTo) filters.dateTo = dateTo;
    if (scopeType) filters.scopeType = scopeType;
    if (scopeId) filters.scopeId = scopeId;

    const summary = await FinancialVoucher.getFinancialSummary(filters);

    res.json({
      success: true,
      data: summary
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to fetch financial summary',
      error: error.message
    });
  }
};

// Get daily financial summary
const getDailySummary = async (req, res) => {
  try {
    const { dateFrom, dateTo, scopeType, scopeId } = req.query;

    const filters = {};
    if (dateFrom) filters.dateFrom = dateFrom;
    if (dateTo) filters.dateTo = dateTo;
    if (scopeType) filters.scopeType = scopeType;
    if (scopeId) filters.scopeId = scopeId;

    const summary = await FinancialVoucher.getDailySummary(filters);

    res.json({
      success: true,
      data: summary
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to fetch daily summary',
      error: error.message
    });
  }
};

// Get payment method summary
const getPaymentMethodSummary = async (req, res) => {
  try {
    const { dateFrom, dateTo, scopeType, scopeId } = req.query;

    const filters = {};
    if (dateFrom) filters.dateFrom = dateFrom;
    if (dateTo) filters.dateTo = dateTo;
    if (scopeType) filters.scopeType = scopeType;
    if (scopeId) filters.scopeId = scopeId;

    const summary = await FinancialVoucher.getPaymentMethodSummary(filters);

    res.json({
      success: true,
      data: summary
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to fetch payment method summary',
      error: error.message
    });
  }
};

// Get financial accounts and balances
const getFinancialAccounts = async (req, res) => {
  try {
    const { scopeType, scopeId } = req.query;

    let query = 'SELECT * FROM financial_accounts WHERE is_active = TRUE';
    const params = [];

    if (scopeType) {
      query += ' AND scope_type = ?';
      params.push(scopeType);
    }

    if (scopeId) {
      query += ' AND scope_id = ?';
      params.push(scopeId);
    }

    query += ' ORDER BY scope_type, scope_id, account_type';

    const [accounts] = await pool.execute(query, params);

    res.json({
      success: true,
      data: accounts
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to fetch financial accounts',
      error: error.message
    });
  }
};

// Update financial account balance
const updateAccountBalance = async (req, res) => {
  try {
    const { id } = req.params;
    const { balance } = req.body;

    if (balance === undefined || balance === null) {
      return res.status(400).json({
        success: false,
        message: 'Balance is required'
      });
    }

    await pool.execute(
      'UPDATE financial_accounts SET current_balance = ?, last_updated = NOW() WHERE id = ?',
      [parseFloat(balance), id]
    );

    const [updatedAccount] = await pool.execute(
      'SELECT * FROM financial_accounts WHERE id = ?',
      [id]
    );

    res.json({
      success: true,
      message: 'Account balance updated successfully',
      data: updatedAccount[0]
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to update account balance',
      error: error.message
    });
  }
};

// Create financial account
const createFinancialAccount = async (req, res) => {
  try {
    const {
      accountName, accountType, scopeType, scopeId, initialBalance = 0
    } = req.body;

    if (!accountName || !accountType || !scopeType || !scopeId) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: accountName, accountType, scopeType, scopeId'
      });
    }

    const [result] = await pool.execute(
      `INSERT INTO financial_accounts (account_name, account_type, scope_type, scope_id, current_balance, created_at)
       VALUES (?, ?, ?, ?, ?, NOW())`,
      [accountName, accountType, scopeType, scopeId, parseFloat(initialBalance)]
    );

    const [newAccount] = await pool.execute(
      'SELECT * FROM financial_accounts WHERE id = ?',
      [result.insertId]
    );

    res.status(201).json({
      success: true,
      message: 'Financial account created successfully',
      data: newAccount[0]
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to create financial account',
      error: error.message
    });
  }
};

// Get financial vouchers by scope (for admin role simulation)
const getFinancialVouchersByScope = async (req, res) => {
  try {
    const { scopeType, scopeId } = req.params;
    const {
      type, category, paymentMethod, status, userId,
      dateFrom, dateTo, search, page = 1, limit = 25
    } = req.query;

    const user = req.user;

    // Only admins can access this endpoint
    if (user.role !== 'ADMIN') {
      return res.status(403).json({
        success: false,
        message: 'Only administrators can access scope-based voucher queries'
      });
    }

    // Build filters object
    const filters = {
      scopeType,
      scopeId
    };
    
    if (type) filters.type = type;
    if (category) filters.category = category;
    if (paymentMethod) filters.paymentMethod = paymentMethod;
    if (status) filters.status = status;
    if (userId) filters.userId = userId;
    if (dateFrom) filters.dateFrom = dateFrom;
    if (dateTo) filters.dateTo = dateTo;
    if (search) filters.search = search;

    // Add pagination
    const offset = (page - 1) * limit;
    filters.limit = parseInt(limit);
    filters.offset = offset;

    const vouchers = await FinancialVoucher.find(filters);

    // Get total count for pagination
    let countQuery = 'SELECT COUNT(*) as total FROM financial_vouchers WHERE deleted_at IS NULL AND scope_type = ? AND scope_id = ?';
    const countParams = [scopeType, scopeId];

    if (type) {
      countQuery += ' AND type = ?';
      countParams.push(type);
    }
    if (category) {
      countQuery += ' AND category = ?';
      countParams.push(category);
    }
    if (paymentMethod) {
      countQuery += ' AND payment_method = ?';
      countParams.push(paymentMethod);
    }
    if (status) {
      countQuery += ' AND status = ?';
      countParams.push(status);
    }
    if (userId) {
      countQuery += ' AND user_id = ?';
      countParams.push(userId);
    }
    if (dateFrom) {
      countQuery += ' AND DATE(created_at) >= ?';
      countParams.push(dateFrom);
    }
    if (dateTo) {
      countQuery += ' AND DATE(created_at) <= ?';
      countParams.push(dateTo);
    }
    if (search) {
      countQuery += ' AND (voucher_no LIKE ? OR description LIKE ? OR reference LIKE ? OR user_name LIKE ?)';
      const searchPattern = `%${search}%`;
      countParams.push(searchPattern, searchPattern, searchPattern, searchPattern);
    }

    const [countResult] = await pool.execute(countQuery, countParams);
    const total = countResult[0].total;

    res.json({
      success: true,
      data: vouchers,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to fetch financial vouchers by scope',
      error: error.message
    });
  }
};

// Get voucher approval history
const getVoucherApprovalHistory = async (req, res) => {
  try {
    const { id } = req.params;
    const user = req.user;

    // Check if user has permission to view this voucher
    const voucher = await FinancialVoucher.findById(id);
    if (!voucher) {
      return res.status(404).json({
        success: false,
        message: 'Financial voucher not found'
      });
    }

    // Role-based access check
    if (user.role === 'CASHIER' && voucher.scopeType !== 'BRANCH' || 
        user.role === 'WAREHOUSE_KEEPER' && voucher.scopeType !== 'WAREHOUSE') {
      return res.status(403).json({
        success: false,
        message: 'Insufficient permissions to view this voucher'
      });
    }

    const approvalHistory = await FinancialVoucher.getApprovalHistory(id);

    res.json({
      success: true,
      data: approvalHistory
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to fetch voucher approval history',
      error: error.message
    });
  }
};

// Get voucher items
const getVoucherItems = async (req, res) => {
  try {
    const { id } = req.params;
    const user = req.user;

    // Check if user has permission to view this voucher
    const voucher = await FinancialVoucher.findById(id);
    if (!voucher) {
      return res.status(404).json({
        success: false,
        message: 'Financial voucher not found'
      });
    }

    // Role-based access check
    if (user.role === 'CASHIER' && voucher.scopeType !== 'BRANCH' || 
        user.role === 'WAREHOUSE_KEEPER' && voucher.scopeType !== 'WAREHOUSE') {
      return res.status(403).json({
        success: false,
        message: 'Insufficient permissions to view this voucher'
      });
    }

    const voucherItems = await FinancialVoucher.getVoucherItems(id);

    res.json({
      success: true,
      data: voucherItems
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to fetch voucher items',
      error: error.message
    });
  }
};

// Generate PDF Report for Financial Vouchers
const generateVoucherReport = async (req, res) => {
  try {
    const { type, scope, scopeId, date, month, year } = req.body;
    const user = req.user;

    // Build query based on report type
    let query = `
      SELECT fv.*, 
        u.name as created_by_name,
        fv.user_name,
        b.name as branch_name,
        w.name as warehouse_name
      FROM financial_vouchers fv
      LEFT JOIN users u ON fv.user_id = u.id
      LEFT JOIN branches b ON fv.scope_type = 'BRANCH' AND fv.scope_id = b.id
      LEFT JOIN warehouses w ON fv.scope_type = 'WAREHOUSE' AND fv.scope_id = w.id
      WHERE fv.deleted_at IS NULL
    `;

    const params = [];

    // Role-based filtering
    if (user.role === 'CASHIER') {
      query += ` AND fv.scope_type = 'BRANCH' AND fv.scope_id = ?`;
      params.push(user.branchId);
    } else if (user.role === 'WAREHOUSE_KEEPER') {
      query += ` AND fv.scope_type = 'WAREHOUSE' AND fv.scope_id = ?`;
      params.push(user.warehouseId);
    } else if (user.role === 'ADMIN') {
      // Admin can filter by scope
      if (scope && scope !== 'all') {
        query += ` AND fv.scope_type = ?`;
        params.push(scope.toUpperCase());
        if (scopeId) {
          query += ` AND fv.scope_id = ?`;
          params.push(scopeId);
        }
      }
    }

    // Date filtering based on report type
    if (type === 'daily' && date) {
      const reportDate = new Date(date);
      const startOfDay = format(reportDate, 'yyyy-MM-dd 00:00:00');
      const endOfDay = format(reportDate, 'yyyy-MM-dd 23:59:59');
      query += ` AND fv.created_at BETWEEN ? AND ?`;
      params.push(startOfDay, endOfDay);
    } else if (type === 'monthly' && month && year) {
      query += ` AND MONTH(fv.created_at) = ? AND YEAR(fv.created_at) = ?`;
      params.push(month, year);
    }

    query += ` ORDER BY fv.created_at DESC`;

    const [vouchers] = await pool.execute(query, params);

    // Calculate totals
    const totals = {
      income: 0,
      expense: 0,
      transfer: 0,
      approved: 0,
      pending: 0,
      rejected: 0,
      count: vouchers.length
    };

    vouchers.forEach(v => {
      if (v.type === 'INCOME') totals.income += parseFloat(v.amount);
      if (v.type === 'EXPENSE') totals.expense += parseFloat(v.amount);
      if (v.type === 'TRANSFER') totals.transfer += parseFloat(v.amount);
      if (v.status === 'APPROVED') totals.approved += parseFloat(v.amount);
      if (v.status === 'PENDING') totals.pending += parseFloat(v.amount);
      if (v.status === 'REJECTED') totals.rejected += parseFloat(v.amount);
    });

    // Generate PDF
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    
    // Set response headers
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=financial-vouchers-${type}-${Date.now()}.pdf`);
    
    // Pipe PDF to response
    doc.pipe(res);

    // Add title
    doc.fontSize(20).font('Helvetica-Bold').text('Financial Vouchers Report', { align: 'center' });
    doc.moveDown();

    // Add report details
    doc.fontSize(12).font('Helvetica');
    doc.text(`Report Type: ${type.toUpperCase()}`, { continued: false });
    if (type === 'daily' && date) {
      doc.text(`Date: ${format(new Date(date), 'dd MMM yyyy')}`, { continued: false });
    } else if (type === 'monthly' && month && year) {
      doc.text(`Period: ${new Date(year, month - 1).toLocaleString('default', { month: 'long' })} ${year}`, { continued: false });
    }
    if (scope && scope !== 'all') {
      doc.text(`Scope: ${scope.toUpperCase()}${scopeId ? ` (ID: ${scopeId})` : ''}`, { continued: false });
    }
    doc.text(`Generated: ${format(new Date(), 'dd MMM yyyy HH:mm')}`, { continued: false });
    doc.text(`Generated By: ${user.name || user.username}`, { continued: false });
    doc.moveDown();

    // Add summary section
    doc.fontSize(14).font('Helvetica-Bold').text('Summary', { underline: true });
    doc.moveDown(0.5);
    doc.fontSize(11).font('Helvetica');
    doc.text(`Total Vouchers: ${totals.count}`);
    doc.text(`Total Income: PKR ${totals.income.toFixed(2)}`);
    doc.text(`Total Expense: PKR ${totals.expense.toFixed(2)}`);
    doc.text(`Total Transfer: PKR ${totals.transfer.toFixed(2)}`);
    doc.text(`Net Amount: PKR ${(totals.income - totals.expense).toFixed(2)}`);
    doc.moveDown();
    doc.text(`Approved: PKR ${totals.approved.toFixed(2)}`);
    doc.text(`Pending: PKR ${totals.pending.toFixed(2)}`);
    doc.text(`Rejected: PKR ${totals.rejected.toFixed(2)}`);
    doc.moveDown(2);

    // Add vouchers table
    doc.fontSize(14).font('Helvetica-Bold').text('Voucher Details', { underline: true });
    doc.moveDown();

    // Table headers
    const tableTop = doc.y;
    const colWidths = [60, 80, 70, 60, 80, 60, 70];
    const headers = ['Date', 'Voucher #', 'Type', 'Amount', 'Scope', 'Status', 'Created By'];
    
    doc.fontSize(9).font('Helvetica-Bold');
    headers.forEach((header, i) => {
      const x = 50 + colWidths.slice(0, i).reduce((a, b) => a + b, 0);
      doc.text(header, x, tableTop, { width: colWidths[i], align: 'left' });
    });

    doc.moveDown(0.5);
    let y = doc.y;

    // Draw header line
    doc.moveTo(50, y).lineTo(545, y).stroke();
    doc.moveDown(0.3);
    y = doc.y;

    // Table rows
    doc.fontSize(8).font('Helvetica');
    vouchers.forEach((voucher, index) => {
      if (y > 700) {
        doc.addPage();
        y = 50;
      }

      const row = [
        format(new Date(voucher.created_at), 'dd/MM/yy'),
        voucher.voucher_no,
        voucher.type,
        `PKR ${parseFloat(voucher.amount).toFixed(2)}`,
        `${voucher.scope_type} ${voucher.branch_name || voucher.warehouse_name || voucher.scope_id}`,
        voucher.status,
        voucher.user_name || voucher.created_by_name || 'N/A'
      ];

      row.forEach((cell, i) => {
        const x = 50 + colWidths.slice(0, i).reduce((a, b) => a + b, 0);
        doc.text(cell, x, y, { width: colWidths[i], align: 'left' });
      });

      y += 20;
      doc.moveDown(0.5);
    });

    // Add footer
    doc.fontSize(8).font('Helvetica-Oblique');
    doc.text(`Page ${doc.bufferedPageRange().count}`, 50, 750, { align: 'center' });

    // Finalize PDF
    doc.end();

  } catch (error) {
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        message: 'Failed to generate report',
        error: error.message
      });
    }
  }
};

module.exports = {
  getFinancialVouchers,
  getFinancialVoucherById,
  createFinancialVoucher,
  updateFinancialVoucher,
  approveFinancialVoucher,
  rejectFinancialVoucher,
  deleteFinancialVoucher,
  getFinancialVouchersByScope,
  getVoucherApprovalHistory,
  getVoucherItems,
  getFinancialSummary,
  getDailySummary,
  getPaymentMethodSummary,
  getFinancialAccounts,
  updateAccountBalance,
  createFinancialAccount,
  generateVoucherReport
};
