const { validationResult } = require('express-validator');
const Customer = require('../models/Customer');
const CreditDebitTransaction = require('../models/CreditDebitTransaction');
const { pool } = require('../config/database');
const trashService = require('../services/trashService');

// ─────────────────────────────────────────────────────────────
// Helper: resolve numeric branch_id / warehouse_id
// Accepts either a numeric ID or a name string.
// ─────────────────────────────────────────────────────────────
const resolveScopeIds = async (scopeType, scopeId) => {
  let resolvedBranchId    = null;
  let resolvedWarehouseId = null;

  if (!scopeType || !scopeId) return { resolvedBranchId, resolvedWarehouseId };

  const isNumeric = (v) => /^\d+$/.test(String(v));

  if (String(scopeType).toUpperCase() === 'BRANCH') {
    if (isNumeric(scopeId)) {
      resolvedBranchId = parseInt(scopeId);
    } else {
      const [rows] = await pool.execute('SELECT id FROM branches WHERE name = ? LIMIT 1', [scopeId]);
      resolvedBranchId = rows[0]?.id || null;
    }
  } else if (String(scopeType).toUpperCase() === 'WAREHOUSE') {
    if (isNumeric(scopeId)) {
      resolvedWarehouseId = parseInt(scopeId);
    } else {
      const [rows] = await pool.execute('SELECT id FROM warehouses WHERE name = ? LIMIT 1', [scopeId]);
      resolvedWarehouseId = rows[0]?.id || null;
    }
  }

  return { resolvedBranchId, resolvedWarehouseId };
};

// ─────────────────────────────────────────────────────────────
// Helper: check if a customer with the same phone already exists
// in the SAME scope (branch or warehouse).
// excludeId: pass current customer id on update to avoid
//            flagging the record against itself.
// ─────────────────────────────────────────────────────────────
const findDuplicateInScope = async (phone, resolvedBranchId, resolvedWarehouseId, excludeId = null) => {
  if (!phone || phone.trim().length === 0) return null;

  let query, params;

  if (resolvedBranchId) {
    query  = 'SELECT id, name, phone FROM customers WHERE phone = ? AND branch_id = ?';
    params = [phone.trim(), resolvedBranchId];
  } else if (resolvedWarehouseId) {
    query  = 'SELECT id, name, phone FROM customers WHERE phone = ? AND warehouse_id = ?';
    params = [phone.trim(), resolvedWarehouseId];
  } else {
    // No scope resolved — phone must be globally unique (safety fallback)
    query  = 'SELECT id, name, phone FROM customers WHERE phone = ?';
    params = [phone.trim()];
  }

  if (excludeId) {
    query  += ' AND id != ?';
    params.push(parseInt(excludeId));
  }

  query += ' LIMIT 1';

  const [rows] = await pool.execute(query, params);
  return rows[0] || null;
};

// @desc    Create new customer
// @route   POST /api/customers
// @access  Private (Cashier, Warehouse Keeper, Admin)
const createCustomer = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation error',
        errors: errors.array()
      });
    }

    const { name, phone, scopeType, scopeId, branchId, warehouseId } = req.body;

    // ── 1. Resolve scope IDs ─────────────────────────────────────────────────
    // Priority: role-based > scopeType/scopeId > direct branchId/warehouseId
    let resolvedBranchId    = branchId    ? parseInt(branchId)    : null;
    let resolvedWarehouseId = warehouseId ? parseInt(warehouseId) : null;

    // If scopeType+scopeId provided, resolve them
    if (scopeType && scopeId) {
      const resolved = await resolveScopeIds(scopeType, scopeId);
      if (resolved.resolvedBranchId    !== null) resolvedBranchId    = resolved.resolvedBranchId;
      if (resolved.resolvedWarehouseId !== null) resolvedWarehouseId = resolved.resolvedWarehouseId;
    }

    // Role-based scope enforcement always wins (locks non-admins to their scope)
    if (req.user.role === 'CASHIER') {
      resolvedBranchId    = req.user.branchId ? parseInt(req.user.branchId) : resolvedBranchId;
      resolvedWarehouseId = null;
    } else if (req.user.role === 'WAREHOUSE_KEEPER') {
      resolvedWarehouseId = req.user.warehouseId ? parseInt(req.user.warehouseId) : resolvedWarehouseId;
      resolvedBranchId    = null;
    }

    // ── 2. Validate scope ────────────────────────────────────────────────────
    if (!resolvedBranchId && !resolvedWarehouseId) {
      return res.status(400).json({
        success: false,
        message: 'A branch or warehouse must be specified for the customer'
      });
    }

    // ── 3. Duplicate check: same phone in same scope ─────────────────────────
    if (phone && phone.trim().length > 0) {
      const duplicate = await findDuplicateInScope(phone, resolvedBranchId, resolvedWarehouseId);
      if (duplicate) {
        return res.status(409).json({
          success: false,
          message: `A customer with phone "${phone.trim()}" already exists in this ${resolvedBranchId ? 'branch' : 'warehouse'}.`,
          existingCustomer: {
            id:    duplicate.id,
            name:  duplicate.name,
            phone: duplicate.phone
          }
        });
      }
    }

    // ── 4. Create customer via model (keep existing Customer.create logic) ───
    // Inject the resolved scope IDs so the model uses them
    const customerData = {
      ...req.body,
      branchId:    resolvedBranchId,
      warehouseId: resolvedWarehouseId
    };

    const customer = await Customer.create(customerData);

    res.status(201).json({
      success: true,
      message: 'Customer created successfully',
      data: customer
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get all customers
// @route   GET /api/customers
// @access  Private (Cashier, Warehouse Keeper, Admin)
const getCustomers = async (req, res, next) => {
  try {
    const {
      status = 'ACTIVE',
      customerType,
      search,
      hasBalance,
      page = 1,
      limit = 10,
      scopeType,
      scopeId,
    } = req.query;

    const filters = {
      status,
      customerType,
      search,
      hasBalance: hasBalance === 'true',
      limit: parseInt(limit),
      offset: (parseInt(page) - 1) * parseInt(limit)
    };

    const userBranchId = req.user.branch_id || req.user.branchId;
    const userWarehouseId = req.user.warehouse_id || req.user.warehouseId;

    // Lock non-admins to their branch/warehouse; admin POS passes scopeType/scopeId
    if (req.user.role !== 'ADMIN') {
      if (userBranchId) filters.branchId = userBranchId;
      if (userWarehouseId) filters.warehouseId = userWarehouseId;
    } else if (scopeType && scopeId) {
      const resolved = await resolveScopeIds(scopeType, scopeId);
      if (resolved.resolvedBranchId != null) filters.branchId = resolved.resolvedBranchId;
      if (resolved.resolvedWarehouseId != null) filters.warehouseId = resolved.resolvedWarehouseId;
    }

    const customers = await Customer.findAll(filters);

    res.json({
      success: true,
      count: customers.length,
      data: customers
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get single customer
// @route   GET /api/customers/:id
// @access  Private (Cashier, Warehouse Keeper, Admin)
const getCustomer = async (req, res, next) => {
  try {
    const customer = await Customer.findById(req.params.id);

    if (!customer) {
      return res.status(404).json({
        success: false,
        message: 'Customer not found'
      });
    }

    // Check if user can access this customer
    if (req.user.role !== 'ADMIN') {
      if (req.user.branchId && customer.branchId !== req.user.branchId) {
        return res.status(403).json({
          success: false,
          message: 'Access denied to this customer'
        });
      }
      if (req.user.warehouseId && customer.warehouseId !== req.user.warehouseId) {
        return res.status(403).json({
          success: false,
          message: 'Access denied to this customer'
        });
      }
    }

    // Get customer transaction summary
    const balanceSummary = await CreditDebitTransaction.getCustomerBalanceSummary(customer.id);

    res.json({
      success: true,
      data: {
        ...customer,
        balanceSummary
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Update customer
// @route   PUT /api/customers/:id
// @access  Private (Admin only)
const updateCustomer = async (req, res, next) => {
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
    const { phone, scopeType, scopeId, branchId, warehouseId } = req.body;

    // ── 1. Verify customer exists ────────────────────────────────────────────
    const customer = await Customer.findById(id);
    if (!customer) {
      return res.status(404).json({
        success: false,
        message: 'Customer not found'
      });
    }

    // ── 2. Resolve scope IDs (keep existing if not changing scope) ───────────
    let resolvedBranchId    = customer.branchId;
    let resolvedWarehouseId = customer.warehouseId;

    if (branchId    !== undefined) resolvedBranchId    = branchId    ? parseInt(branchId)    : null;
    if (warehouseId !== undefined) resolvedWarehouseId = warehouseId ? parseInt(warehouseId) : null;

    if (scopeType && scopeId) {
      const resolved = await resolveScopeIds(scopeType, scopeId);
      if (resolved.resolvedBranchId    !== null) resolvedBranchId    = resolved.resolvedBranchId;
      if (resolved.resolvedWarehouseId !== null) resolvedWarehouseId = resolved.resolvedWarehouseId;
    }

    // Role-based enforcement
    if (req.user.role === 'CASHIER') {
      resolvedBranchId    = req.user.branchId ? parseInt(req.user.branchId) : resolvedBranchId;
      resolvedWarehouseId = null;
    } else if (req.user.role === 'WAREHOUSE_KEEPER') {
      resolvedWarehouseId = req.user.warehouseId ? parseInt(req.user.warehouseId) : resolvedWarehouseId;
      resolvedBranchId    = null;
    }

    // ── 3. Duplicate phone check (exclude self) ──────────────────────────────
    const newPhone = phone !== undefined ? phone?.trim() : customer.phone;
    if (newPhone && newPhone.length > 0) {
      const duplicate = await findDuplicateInScope(
        newPhone,
        resolvedBranchId,
        resolvedWarehouseId,
        parseInt(id) // exclude current record
      );
      if (duplicate) {
        return res.status(409).json({
          success: false,
          message: `Another customer with phone "${newPhone}" already exists in this ${resolvedBranchId ? 'branch' : 'warehouse'}.`,
          existingCustomer: {
            id:    duplicate.id,
            name:  duplicate.name,
            phone: duplicate.phone
          }
        });
      }
    }

    // ── 4. Update via model (keep existing Customer model logic) ─────────────
    const updateData = {
      ...req.body,
      branchId:    resolvedBranchId,
      warehouseId: resolvedWarehouseId
    };

    const updatedCustomer = await customer.update(updateData);

    // ── 5. Cascade: update customer_name / customer_phone in sales records ───
    const cascadeFields = [];
    const cascadeValues = [];
    if (req.body.name  !== undefined) { cascadeFields.push('customer_name = ?');  cascadeValues.push(req.body.name); }
    if (req.body.phone !== undefined) { cascadeFields.push('customer_phone = ?'); cascadeValues.push(req.body.phone?.trim()); }
    if (cascadeFields.length > 0) {
      cascadeValues.push(customer.id);
      await pool.execute(
        `UPDATE sales SET ${cascadeFields.join(', ')} WHERE customer_id = ?`,
        cascadeValues
      );
    }

    res.json({
      success: true,
      message: 'Customer updated successfully',
      data: updatedCustomer
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Delete customer
// @route   DELETE /api/customers/:id
// @access  Private (Admin only)
const deleteCustomer = async (req, res, next) => {
  try {
    const customer = await Customer.findById(req.params.id);

    if (!customer) {
      return res.status(404).json({
        success: false,
        message: 'Customer not found'
      });
    }

    await trashService.softDelete('customer', req.params.id, req.user.id);

    res.json({
      success: true,
      message: 'Moved to trash'
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get customer transactions
// @route   GET /api/customers/:id/transactions
// @access  Private (Cashier, Warehouse Keeper, Admin)
const getCustomerTransactions = async (req, res, next) => {
  try {
    const {
      transactionType,
      startDate,
      endDate,
      page = 1,
      limit = 10
    } = req.query;

    const filters = {
      customerId: req.params.id,
      transactionType,
      startDate,
      endDate,
      limit: parseInt(limit),
      offset: (parseInt(page) - 1) * parseInt(limit)
    };

    // If user is not admin, filter by their branch/warehouse
    if (req.user.role !== 'ADMIN') {
      if (req.user.branchId)    filters.branchId    = req.user.branchId;
      if (req.user.warehouseId) filters.warehouseId = req.user.warehouseId;
    }

    const transactions = await CreditDebitTransaction.findAll(filters);

    res.json({
      success: true,
      count: transactions.length,
      data: transactions
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  createCustomer,
  getCustomers,
  getCustomer,
  updateCustomer,
  deleteCustomer,
  getCustomerTransactions
};