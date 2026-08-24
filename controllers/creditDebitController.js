const { validationResult } = require('express-validator');
const CreditDebitTransaction = require('../models/CreditDebitTransaction');
const Customer = require('../models/Customer');

// @desc    Create credit/debit transaction
// @route   POST /api/credit-debit
// @access  Private (Cashier, Warehouse Keeper, Admin)
const createTransaction = async (req, res, next) => {
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
      customerId,
      transactionType,
      amount,
      description,
      referenceType,
      referenceId,
      paymentMethod,
      notes
    } = req.body;

    // Verify customer exists
    const customer = await Customer.findById(customerId);
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

    // Check credit limit for credit transactions
    if (transactionType === 'CREDIT') {
      const newBalance = customer.currentBalance + amount;
      if (newBalance > customer.creditLimit) {
        return res.status(400).json({
          success: false,
          message: `Credit limit exceeded. Current balance: ${customer.currentBalance}, Credit limit: ${customer.creditLimit}, New balance would be: ${newBalance}`
        });
      }
    }

    // Check sufficient balance for debit transactions
    if (transactionType === 'DEBIT') {
      if (customer.currentBalance < amount) {
        return res.status(400).json({
          success: false,
          message: `Insufficient balance. Current balance: ${customer.currentBalance}, Requested amount: ${amount}`
        });
      }
    }

    // Create transaction
    const transactionData = {
      customerId,
      transactionType,
      amount,
      description,
      referenceType,
      referenceId,
      branchId: req.user.branchId,
      warehouseId: req.user.warehouseId,
      userId: req.user.id,
      userRole: req.user.role,
      paymentMethod,
      notes
    };

    const transaction = await CreditDebitTransaction.create(transactionData);

    res.status(201).json({
      success: true,
      message: `${transactionType} transaction created successfully`,
      data: transaction
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get all credit/debit transactions
// @route   GET /api/credit-debit
// @access  Private (Cashier, Warehouse Keeper, Admin)
const getTransactions = async (req, res, next) => {
  try {
    const {
      customerId,
      transactionType,
      branchId,
      warehouseId,
      userId,
      userRole,
      status,
      startDate,
      endDate,
      search,
      page = 1,
      limit = 10
    } = req.query;

    const filters = {
      customerId,
      transactionType,
      branchId,
      warehouseId,
      userId,
      userRole,
      status,
      startDate,
      endDate,
      search,
      limit: parseInt(limit),
      offset: (parseInt(page) - 1) * parseInt(limit)
    };

    // If user is not admin, filter by their branch/warehouse
    if (req.user.role !== 'ADMIN') {
      if (req.user.branchId) filters.branchId = req.user.branchId;
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

// @desc    Get single transaction
// @route   GET /api/credit-debit/:id
// @access  Private (Cashier, Warehouse Keeper, Admin)
const getTransaction = async (req, res, next) => {
  try {
    const transaction = await CreditDebitTransaction.findById(req.params.id);

    if (!transaction) {
      return res.status(404).json({
        success: false,
        message: 'Transaction not found'
      });
    }

    // Check if user can access this transaction
    if (req.user.role !== 'ADMIN') {
      if (req.user.branchId && transaction.branchId !== req.user.branchId) {
        return res.status(403).json({
          success: false,
          message: 'Access denied to this transaction'
        });
      }
      if (req.user.warehouseId && transaction.warehouseId !== req.user.warehouseId) {
        return res.status(403).json({
          success: false,
          message: 'Access denied to this transaction'
        });
      }
    }

    res.json({
      success: true,
      data: transaction
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Update transaction
// @route   PUT /api/credit-debit/:id
// @access  Private (Admin only)
const updateTransaction = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation error',
        errors: errors.array()
      });
    }

    const transaction = await CreditDebitTransaction.findById(req.params.id);

    if (!transaction) {
      return res.status(404).json({
        success: false,
        message: 'Transaction not found'
      });
    }

    const updatedTransaction = await transaction.update(req.body);

    res.json({
      success: true,
      message: 'Transaction updated successfully',
      data: updatedTransaction
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Delete transaction
// @route   DELETE /api/credit-debit/:id
// @access  Private (Admin only)
const deleteTransaction = async (req, res, next) => {
  try {
    const transaction = await CreditDebitTransaction.findById(req.params.id);

    if (!transaction) {
      return res.status(404).json({
        success: false,
        message: 'Transaction not found'
      });
    }

    const trashService = require('../services/trashService');
    await trashService.softDelete('credit_debit_transaction', req.params.id, req.user.id);

    res.json({
      success: true,
      message: 'Transaction moved to trash successfully'
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get branch/warehouse summary
// @route   GET /api/credit-debit/summary
// @access  Private (Cashier, Warehouse Keeper, Admin)
const getSummary = async (req, res, next) => {
  try {
    const { startDate, endDate } = req.query;

    const filters = {
      startDate,
      endDate
    };

    // If user is not admin, filter by their branch/warehouse
    if (req.user.role !== 'ADMIN') {
      if (req.user.branchId) filters.branchId = req.user.branchId;
      if (req.user.warehouseId) filters.warehouseId = req.user.warehouseId;
    }

    const summary = await CreditDebitTransaction.getBranchWarehouseSummary(filters);

    res.json({
      success: true,
      data: summary
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get customer balance report
// @route   GET /api/credit-debit/customer-balances
// @access  Private (Cashier, Warehouse Keeper, Admin)
const getCustomerBalances = async (req, res, next) => {
  try {
    const {
      branchId,
      warehouseId,
      hasBalance,
      page = 1,
      limit = 10
    } = req.query;

    const filters = {
      status: 'ACTIVE',
      hasBalance: hasBalance === 'true',
      limit: parseInt(limit),
      offset: (parseInt(page) - 1) * parseInt(limit)
    };

    // If user is not admin, filter by their branch/warehouse
    if (req.user.role !== 'ADMIN') {
      if (req.user.branchId) filters.branchId = req.user.branchId;
      if (req.user.warehouseId) filters.warehouseId = req.user.warehouseId;
    } else {
      if (branchId) filters.branchId = branchId;
      if (warehouseId) filters.warehouseId = warehouseId;
    }

    const customers = await Customer.findAll(filters);

    // Get balance summary for each customer
    const customersWithBalances = await Promise.all(
      customers.map(async (customer) => {
        const balanceSummary = await CreditDebitTransaction.getCustomerBalanceSummary(customer.id);
        return {
          ...customer,
          balanceSummary
        };
      })
    );

    res.json({
      success: true,
      count: customersWithBalances.length,
      data: customersWithBalances
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  createTransaction,
  getTransactions,
  getTransaction,
  updateTransaction,
  deleteTransaction,
  getSummary,
  getCustomerBalances
};
