'use strict';

const { pool } = require('../../config/database');
const InvoiceNumberService = require('../../services/invoiceNumberService');

// @desc    Get invoice number statistics for a branch/warehouse
// @route   GET /api/sales/invoice-stats/:scopeType/:scopeId
// @access  Private (Admin, Cashier, Warehouse Keeper)
const getInvoiceStats = async (req, res, next) => {
  try {
    const { scopeType, scopeId } = req.params;
    
    // Validate scope type
    if (!['BRANCH', 'WAREHOUSE'].includes(scopeType.toUpperCase())) {
      return res.status(400).json({
        success: false,
        message: 'Invalid scope type. Must be BRANCH or WAREHOUSE'
      });
    }
    
    const stats = await InvoiceNumberService.getInvoiceStats(scopeType.toUpperCase(), scopeId);
    
    res.json({
      success: true,
      data: stats
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error getting invoice statistics',
      error: error.message
    });
  }
};

// @desc    Get salesperson-specific invoice statistics for warehouse
// @route   GET /api/sales/salesperson-stats/:warehouseId/:userId
// @access  Private (Admin, Warehouse Keeper)
const getSalespersonInvoiceStats = async (req, res, next) => {
  try {
    const { warehouseId, userId } = req.params;
    
    // Get warehouse code
    const [warehouses] = await pool.execute(
      'SELECT code FROM warehouses WHERE id = ? OR name = ?',
      [warehouseId, warehouseId]
    );
    
    if (warehouses.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Warehouse not found'
      });
    }
    
    const warehouseCode = warehouses[0].code;
    
    // Get salesperson username
    const [users] = await pool.execute(
      'SELECT username FROM users WHERE id = ?',
      [userId]
    );
    
    if (users.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }
    
    const username = users[0].username;
    const salespersonCode = username.substring(0, 3).toUpperCase();
    const prefix = `${warehouseCode}-${salespersonCode}`;
    
    // Get statistics
    const [statsRows] = await pool.execute(
      `SELECT 
        COUNT(*) as total_invoices,
        MIN(invoice_no) as first_invoice,
        MAX(invoice_no) as last_invoice,
        MIN(created_at) as first_date,
        MAX(created_at) as last_date,
        SUM(total) as total_sales_amount
      FROM sales 
      WHERE invoice_no LIKE ?`,
      [`${prefix}-%`]
    );
    
    const stats = statsRows[0];
    const nextNumber = (stats.total_invoices || 0) + 1;
    
    res.json({
      success: true,
      data: {
        warehouseCode,
        salespersonCode,
        salespersonName: username,
        prefix,
        totalInvoices: stats.total_invoices || 0,
        firstInvoice: stats.first_invoice,
        lastInvoice: stats.last_invoice,
        firstDate: stats.first_date,
        lastDate: stats.last_date,
        totalSalesAmount: parseFloat(stats.total_sales_amount) || 0,
        nextInvoiceNumber: `${prefix}-${nextNumber.toString().padStart(6, '0')}`
      }
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error getting salesperson invoice statistics',
      error: error.message
    });
  }
};

// @desc    Preview next invoice number for a branch/warehouse
// @route   GET /api/sales/next-invoice/:scopeType/:scopeId
// @access  Private (Admin, Cashier, Warehouse Keeper)
const getNextInvoiceNumber = async (req, res, next) => {
  try {
    const { scopeType, scopeId } = req.params;
    
    // Validate scope type
    if (!['BRANCH', 'WAREHOUSE'].includes(scopeType.toUpperCase())) {
      return res.status(400).json({
        success: false,
        message: 'Invalid scope type. Must be BRANCH or WAREHOUSE'
      });
    }
    
    const nextInvoiceNumber = await InvoiceNumberService.getNextInvoiceNumber(scopeType.toUpperCase(), scopeId);
    
    res.json({
      success: true,
      data: {
        nextInvoiceNumber
      }
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error getting next invoice number',
      error: error.message
    });
  }
};

module.exports = {
  getInvoiceStats,
  getSalespersonInvoiceStats,
  getNextInvoiceNumber,
};
