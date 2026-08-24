const { validationResult } = require('express-validator');
const Sale = require('../models/Sale');
const Company = require('../models/Company');
const InventoryItem = require('../models/InventoryItem');
const HardwareDevice = require('../models/HardwareDevice');
const HardwareSession = require('../models/HardwareSession');
const BranchLedger = require('../models/BranchLedger');
const Branch = require('../models/Branch');
const Warehouse = require('../models/Warehouse');
const Billing = require('../models/Billing');
const { pool } = require('../config/database');

// @desc    Generate bill/invoice from warehouse
// @route   POST /api/billing/generate
// @access  Private (Admin, Warehouse Keeper)
const generateBill = async (req, res, next) => {
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
      companyId, 
      items, 
      warehouseId, 
      branchId, 
      paymentMethod = 'CASH',
      notes = '',
      printReceipt = true 
    } = req.body;

    // Validate company exists
    const company = await Company.findById(companyId);
    if (!company) {
      return res.status(404).json({
        success: false,
        message: 'Company not found'
      });
    }

    // Validate warehouse exists
    const warehouse = await Warehouse.findById(warehouseId);
    if (!warehouse) {
      return res.status(404).json({
        success: false,
        message: 'Warehouse not found'
      });
    }

    // Validate branch exists
    const branch = await Branch.findById(branchId);
    if (!branch) {
      return res.status(404).json({
        success: false,
        message: 'Branch not found'
      });
    }

    // Validate inventory items and calculate totals
    let subtotal = 0;
    let totalTax = 0;
    const validatedItems = [];

    for (const item of items) {
      const inventoryItem = await InventoryItem.findById(item.itemId);
      
      if (!inventoryItem) {
        return res.status(404).json({
          success: false,
          message: `Inventory item with ID ${item.itemId} not found`
        });
      }

      // Check if item belongs to warehouse or branch (for cross-branch visibility)
      if (inventoryItem.scopeType === 'WAREHOUSE' && inventoryItem.scopeId.toString() !== warehouseId) {
        return res.status(403).json({
          success: false,
          message: `Item ${inventoryItem.name} does not belong to this warehouse`
        });
      }

      if (inventoryItem.scopeType === 'BRANCH' && inventoryItem.scopeId.toString() !== branchId) {
        // Check if cross-branch visibility is enabled
        if (!branch.settings.openAccount) {
          return res.status(403).json({
            success: false,
            message: `Item ${inventoryItem.name} does not belong to this branch`
          });
        }
      }

      // Check quantity availability
      if (inventoryItem.quantity < item.quantity) {
        return res.status(400).json({
          success: false,
          message: `Insufficient quantity for ${inventoryItem.name}. Available: ${inventoryItem.quantity}, Requested: ${item.quantity}`
        });
      }

      const itemTotal = inventoryItem.salePrice * item.quantity;
      const itemTax = itemTotal * 0.1; // 10% tax rate

      validatedItems.push({
        itemId: inventoryItem._id,
        sku: inventoryItem.sku,
        name: inventoryItem.name,
        quantity: item.quantity,
        unitPrice: inventoryItem.salePrice,
        total: itemTotal,
        tax: itemTax
      });

      subtotal += itemTotal;
      totalTax += itemTax;
    }

    const total = subtotal + totalTax;

    // Create sale record
    const sale = await Sale.create({
      branchId,
      warehouseId,
      companyId,
      cashierId: req.user._id,
      items: validatedItems,
      subtotal,
      tax: totalTax,
      discount: 0,
      total,
      paymentMethod,
      status: 'COMPLETED',
      notes,
      saleType: 'WAREHOUSE_BILL',
      createdAt: new Date()
    });

    // Stock: use MySQL Sale / warehouse sale flows with inventory_ledger_entries (this Mongo-style
    // inventory bump is removed — it was not implemented on SQL InventoryItem and is not the source of truth).

    // Update branch ledger
    const currentYear = new Date().getFullYear();
    let ledger = await BranchLedger.findOne({ branchId, fiscalYear: currentYear });
    
    if (!ledger) {
      ledger = await BranchLedger.create({
        branchId,
        fiscalYear: currentYear,
        invoicePrefix: `INV-${branch.code}`,
        returnPrefix: `RET-${branch.code}`
      });
    }

    const invoiceNumber = `${ledger.invoicePrefix}-${String(ledger.nextInvoiceNumber || 1).padStart(6, '0')}`;
    
    await BranchLedger.findByIdAndUpdate(ledger._id, {
      $inc: { nextInvoiceNumber: 1 }
    });

    // Update sale with invoice number
    await Sale.findByIdAndUpdate(sale._id, { invoiceNumber });

    // Print receipt if requested
    let printSession = null;
    if (printReceipt) {
      const printer = await HardwareDevice.findOne({
        scopeType: 'WAREHOUSE',
        scopeId: warehouseId,
        type: 'RECEIPT_PRINTER',
        status: 'ONLINE'
      });

      if (printer) {
        const receiptData = generateReceiptData(sale, company, branch, warehouse, invoiceNumber);
        
        printSession = await HardwareSession.createSession(
          req.user._id,
          'WAREHOUSE',
          warehouseId,
          printer.terminalId,
          printer.deviceId,
          'PRINT',
          {
            saleId: sale._id,
            printPayload: receiptData,
            printFormat: printer.settings.printerType
          }
        );
      }
    }

    res.status(201).json({
      success: true,
      message: 'Bill generated successfully',
      data: {
        sale,
        invoiceNumber,
        printSession: printSession ? {
          sessionId: printSession.sessionId,
          status: printSession.status
        } : null
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Print invoice/receipt
// @route   POST /api/billing/:saleId/print
// @access  Private (Admin, Warehouse Keeper)
const printInvoice = async (req, res, next) => {
  try {
    const { saleId } = req.params;
    const { printerId } = req.body;

    const sale = await Sale.findById(saleId);

    if (!sale) {
      return res.status(404).json({
        success: false,
        message: 'Sale not found'
      });
    }

    let branch = null;
    let warehouse = null;
    if (sale.scopeType === 'BRANCH' && sale.scopeId) {
      const [rows] = await pool.execute(
        'SELECT name, code, location FROM branches WHERE name = ? LIMIT 1',
        [sale.scopeId]
      );
      branch = rows[0] || { name: sale.scopeId };
    }
    if (sale.scopeType === 'WAREHOUSE' && sale.scopeId) {
      const [rows] = await pool.execute(
        'SELECT name, code, location FROM warehouses WHERE name = ? LIMIT 1',
        [sale.scopeId]
      );
      warehouse = rows[0] || { name: sale.scopeId };
    }

    let printer;
    if (printerId) {
      printer = await HardwareDevice.findById(printerId);
    } else if (sale.scopeType === 'WAREHOUSE' && sale.scopeId) {
      printer = await HardwareDevice.findOne({
        scopeType: 'WAREHOUSE',
        scopeId: sale.scopeId,
        type: 'RECEIPT_PRINTER',
        status: 'ONLINE'
      });
    }

    if (!printer) {
      return res.status(404).json({
        success: false,
        message: 'No printer available or printer is offline'
      });
    }

    const receiptData = generateReceiptData(
      sale,
      null,
      branch,
      warehouse,
      sale.invoiceNo || sale.invoice_no
    );

    const printSession = await HardwareSession.createSession(
      req.user.id,
      sale.scopeType || 'WAREHOUSE',
      sale.scopeId,
      printer.terminalId,
      printer.deviceId,
      'PRINT',
      {
        saleId: sale.id,
        printPayload: receiptData,
        printFormat: printer.settings?.printerType
      }
    );

    res.json({
      success: true,
      message: 'Print job initiated',
      data: {
        sessionId: printSession.sessionId,
        status: printSession.status,
        printer: {
          deviceId: printer.deviceId,
          name: printer.name
        }
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get billing history
// @route   GET /api/billing/history
// @access  Private (Admin, Warehouse Keeper)
const getBillingHistory = async (req, res, next) => {
  try {
    const { warehouseId, branchId, companyId, startDate, endDate, page = 1, limit = 10 } = req.query;
    
    // Simple query for MySQL - get all sales for now
    const sales = await Sale.find({}, { 
      limit: parseInt(limit), 
      offset: (parseInt(page) - 1) * parseInt(limit),
      orderBy: 'created_at DESC'
    });
    
    const total = await Sale.count({});
    
    res.json({
      success: true,
      count: sales.length,
      total,
      page: parseInt(page),
      pages: Math.ceil(total / limit),
      data: sales
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error retrieving billing history',
      error: error.message
    });
  }
};

// Helper function to generate receipt data
const generateReceiptData = (sale, company, branch, warehouse, invoiceNumber) => {
  const receipt = {
    header: {
      companyName: company.name,
      invoiceNumber,
      date: sale.createdAt.toLocaleDateString(),
      time: sale.createdAt.toLocaleTimeString(),
      branch: branch.name,
      warehouse: warehouse.name
    },
    items: sale.items.map(item => ({
      name: item.name,
      sku: item.sku,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      total: item.total
    })),
    totals: {
      subtotal: sale.subtotal,
      tax: sale.tax,
      total: sale.total
    },
    payment: {
      method: sale.paymentMethod,
      amount: sale.total
    },
    footer: {
      notes: sale.notes || '',
      cashier: sale.userId.username,
      thankYou: 'Thank you for your business!'
    }
  };

  return JSON.stringify(receipt);
};

// ===== CRUD OPERATIONS FOR BILLING RECORDS =====

// @desc    Get all billing records
// @route   GET /api/billing
// @access  Private (Admin, Manager, Cashier)
const getBillingRecords = async (req, res) => {
  try {
    const { 
      status, 
      clientName, 
      startDate, 
      endDate, 
      page = 1, 
      limit = 20 
    } = req.query;

    const conditions = {};
    if (status) conditions.status = status;
    if (clientName) conditions.clientName = clientName;
    if (startDate) conditions.startDate = startDate;
    if (endDate) conditions.endDate = endDate;

    // Add scope filtering based on user role
    if (req.user.role !== 'ADMIN') {
      conditions.scopeType = 'BRANCH';
      conditions.scopeId = req.user.branchId;
    }

    const options = {
      limit: parseInt(limit),
      offset: (parseInt(page) - 1) * parseInt(limit)
    };

    const billingRecords = await Billing.findAll(conditions, options);
    
    // Get total count for pagination
    const { pool } = require('../config/database');
    let countQuery = 'SELECT COUNT(*) as total FROM billing WHERE 1=1';
    const countParams = [];
    
    if (status) {
      countQuery += ' AND status = ?';
      countParams.push(status);
    }
    if (clientName) {
      countQuery += ' AND client_name LIKE ?';
      countParams.push(`%${clientName}%`);
    }
    if (startDate) {
      countQuery += ' AND due_date >= ?';
      countParams.push(startDate);
    }
    if (endDate) {
      countQuery += ' AND due_date <= ?';
      countParams.push(endDate);
    }
    if (req.user.role !== 'ADMIN') {
      countQuery += ' AND scope_type = ? AND scope_id = ?';
      countParams.push('BRANCH', req.user.branchId);
    }

    const [countResult] = await pool.execute(countQuery, countParams);
    const total = countResult[0].total;

    // Transform data for frontend
    const transformedRecords = billingRecords.map(record => ({
      id: record.id,
      invoiceNumber: record.invoiceNumber,
      clientName: record.clientName,
      clientEmail: record.clientEmail,
      clientPhone: record.clientPhone,
      clientAddress: record.clientAddress,
      amount: parseFloat(record.amount),
      tax: parseFloat(record.tax || 0),
      discount: parseFloat(record.discount || 0),
      total: parseFloat(record.total),
      dueDate: record.dueDate,
      service: record.service,
      description: record.description,
      status: record.status,
      paymentMethod: record.paymentMethod,
      paymentDate: record.paymentDate,
      notes: record.notes,
      scopeType: record.scopeType,
      scopeId: record.scopeId,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt
    }));

    res.status(200).json({
      success: true,
      data: transformedRecords,
      pagination: {
        current: parseInt(page),
        pages: Math.ceil(total / limit),
        total
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error retrieving billing records',
      error: error.message
    });
  }
};

// @desc    Create billing record
// @route   POST /api/billing
// @access  Private (Admin, Manager, Cashier)
const createBillingRecord = async (req, res) => {
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
      invoiceNumber,
      clientName,
      clientEmail,
      clientPhone,
      clientAddress,
      amount = 0,
      tax = 0,
      discount = 0,
      dueDate,
      service,
      description,
      status = 'pending',
      paymentMethod,
      paymentDate,
      notes
    } = req.body;

    // Normalize status to lowercase
    const normalizedStatus = status ? status.toLowerCase() : 'pending';

    // Calculate total
    const total = parseFloat(amount) + parseFloat(tax) - parseFloat(discount);

    // Generate invoice number if not provided
    let finalInvoiceNumber = invoiceNumber;
    if (!finalInvoiceNumber) {
      const timestamp = Date.now();
      finalInvoiceNumber = `INV-${timestamp}`;
    }

    const billingData = {
      invoiceNumber: finalInvoiceNumber,
      clientName,
      clientEmail,
      clientPhone,
      clientAddress,
      amount: parseFloat(amount),
      tax: parseFloat(tax),
      discount: parseFloat(discount),
      total,
      dueDate,
      service,
      description,
      status: normalizedStatus,
      paymentMethod,
      paymentDate,
      notes,
      scopeType: req.user.role === 'ADMIN' ? 'COMPANY' : 'BRANCH',
      scopeId: req.user.role === 'ADMIN' ? 1 : req.user.branchId,
      createdBy: req.user.id
    };

    const billingRecord = await Billing.create(billingData);

    res.status(201).json({
      success: true,
      message: 'Billing record created successfully',
      data: {
        id: billingRecord.id,
        invoiceNumber: billingRecord.invoiceNumber,
        clientName: billingRecord.clientName,
        clientEmail: billingRecord.clientEmail,
        clientPhone: billingRecord.clientPhone,
        clientAddress: billingRecord.clientAddress,
        amount: parseFloat(billingRecord.amount),
        tax: parseFloat(billingRecord.tax),
        discount: parseFloat(billingRecord.discount),
        total: parseFloat(billingRecord.total),
        dueDate: billingRecord.dueDate,
        service: billingRecord.service,
        description: billingRecord.description,
        status: billingRecord.status,
        paymentMethod: billingRecord.paymentMethod,
        paymentDate: billingRecord.paymentDate,
        notes: billingRecord.notes,
        scopeType: billingRecord.scopeType,
        scopeId: billingRecord.scopeId,
        createdAt: billingRecord.createdAt,
        updatedAt: billingRecord.updatedAt
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error creating billing record',
      error: error.message
    });
  }
};

// @desc    Update billing record
// @route   PUT /api/billing/:id
// @access  Private (Admin, Manager, Cashier)
const updateBillingRecord = async (req, res) => {
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

    // Check if billing record exists
    const existingRecord = await Billing.findById(id);
    if (!existingRecord) {
      return res.status(404).json({
        success: false,
        message: 'Billing record not found'
      });
    }

    // Check permissions
    if (req.user.role !== 'ADMIN') {
      if (existingRecord.scopeType !== 'BRANCH' || existingRecord.scopeId !== req.user.branchId) {
        return res.status(403).json({
          success: false,
          message: 'Access denied'
        });
      }
    }

    // Normalize status to lowercase
    if (updateData.status !== undefined && updateData.status !== null && updateData.status !== '') {
      updateData.status = updateData.status.toLowerCase();
    }

    // Calculate total if amount, tax, or discount changed
    if (updateData.amount !== undefined || updateData.tax !== undefined || updateData.discount !== undefined) {
      const amount = parseFloat(updateData.amount || existingRecord.amount);
      const tax = parseFloat(updateData.tax || existingRecord.tax || 0);
      const discount = parseFloat(updateData.discount || existingRecord.discount || 0);
      updateData.total = amount + tax - discount;
    }

    const result = await Billing.update(id, updateData);

    if (result.modifiedCount === 0) {
      return res.status(400).json({
        success: false,
        message: 'No changes made to billing record'
      });
    }

    // Get updated record
    const updatedRecord = await Billing.findById(id);

    res.status(200).json({
      success: true,
      message: 'Billing record updated successfully',
      data: {
        id: updatedRecord.id,
        invoiceNumber: updatedRecord.invoiceNumber,
        clientName: updatedRecord.clientName,
        clientEmail: updatedRecord.clientEmail,
        clientPhone: updatedRecord.clientPhone,
        clientAddress: updatedRecord.clientAddress,
        amount: parseFloat(updatedRecord.amount),
        tax: parseFloat(updatedRecord.tax),
        discount: parseFloat(updatedRecord.discount),
        total: parseFloat(updatedRecord.total),
        dueDate: updatedRecord.dueDate,
        service: updatedRecord.service,
        description: updatedRecord.description,
        status: updatedRecord.status,
        paymentMethod: updatedRecord.paymentMethod,
        paymentDate: updatedRecord.paymentDate,
        notes: updatedRecord.notes,
        scopeType: updatedRecord.scopeType,
        scopeId: updatedRecord.scopeId,
        createdAt: updatedRecord.createdAt,
        updatedAt: updatedRecord.updatedAt
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error updating billing record',
      error: error.message
    });
  }
};

// @desc    Delete billing record
// @route   DELETE /api/billing/:id
// @access  Private (Admin, Manager)
const deleteBillingRecord = async (req, res) => {
  try {
    const { id } = req.params;

    // Check if billing record exists
    const existingRecord = await Billing.findById(id);
    if (!existingRecord) {
      return res.status(404).json({
        success: false,
        message: 'Billing record not found'
      });
    }

    // Check permissions
    if (req.user.role !== 'ADMIN') {
      if (existingRecord.scopeType !== 'BRANCH' || existingRecord.scopeId !== req.user.branchId) {
        return res.status(403).json({
          success: false,
          message: 'Access denied'
        });
      }
    }

    const trashService = require('../services/trashService');
    await trashService.softDelete('billing', parseInt(id), req.user.id);

    res.status(200).json({
      success: true,
      message: 'Billing record moved to trash successfully',
      data: { id: parseInt(id) }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error deleting billing record',
      error: error.message
    });
  }
};

module.exports = {
  generateBill,
  printInvoice,
  getBillingHistory,
  getBillingRecords,
  createBillingRecord,
  updateBillingRecord,
  deleteBillingRecord
};

