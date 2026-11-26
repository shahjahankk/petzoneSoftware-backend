
const { validationResult } = require('express-validator');
const Sale = require('../../models/Sale');
const SalesReturn = require('../../models/SalesReturn');
const { pool } = require('../../config/database');
const {
  createReturnTransaction,
  createAdjustmentTransaction,
} = require('../../middleware/stockTracking');
const LedgerService = require('../../services/ledgerService');
const InventoryProjection = require('../../services/inventoryProjectionService');
const { normalizeScope } = require('../../services/inventoryLedgerService');
const CustomerLedgerEntries = require('../../services/customerLedgerEntriesService');
const { isLedgerMigrationComplete } = require('../../services/ledgerMigrationMeta');
const { validateAndNormalizeReturnItems } = require('../../services/sales/returnValidationService');
const { createSalesReturnCore } = require('../../services/sales/salesReturnCoreService');
const {
  createExchangeReplacementSale,
  finalizeExchangeReturn,
} = require('../../services/sales/salesExchangeService');

// @desc    Create sales return
// @route   POST /api/sales/returns
// @access  Private (Admin, Cashier)
const createSalesReturn = async (req, res, next) => {
  try {
    
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation error',
        errors: errors.array()
      });
    }

    const { saleId, items, reason, notes, type, refundMethod, exchangeItems } = req.body;

    // Validate original sale
    const originalSale = await Sale.findById(saleId);
    if (!originalSale) {
      return res.status(404).json({
        success: false,
        message: 'Original sale not found'
      });
    }
    
    
    // Get original sale items to get the actual unit prices from the sale
    const [originalSaleItems] = await pool.execute(
      'SELECT * FROM sale_items WHERE sale_id = ?',
      [saleId]
    );
    

    // Check permissions
    if (req.user.role !== 'ADMIN') {
      // For cashiers, get branch name if not already available
      let userBranchName = req.user.branchName;
      if (req.user.role === 'CASHIER' && !userBranchName && req.user.branchId) {
        const [branches] = await pool.execute('SELECT name FROM branches WHERE id = ?', [req.user.branchId]);
        userBranchName = branches[0]?.name || null;
      }
      
      if (req.user.role === 'CASHIER' && 
          (originalSale.scopeType !== 'BRANCH' || originalSale.scopeId !== userBranchName)) {
        return res.status(403).json({
          success: false,
          message: 'Access denied'
        });
      }
      
      // For warehouse keepers, get warehouse name if not already available
      let userWarehouseName = req.user.warehouseName;
      if (req.user.role === 'WAREHOUSE_KEEPER' && !userWarehouseName && req.user.warehouseId) {
        const [warehouses] = await pool.execute('SELECT name FROM warehouses WHERE id = ?', [req.user.warehouseId]);
        userWarehouseName = warehouses[0]?.name || null;
      }
      
      if (req.user.role === 'WAREHOUSE_KEEPER' && 
          (originalSale.scopeType !== 'WAREHOUSE' || originalSale.scopeId !== userWarehouseName)) {
        return res.status(403).json({
          success: false,
          message: 'Access denied'
        });
      }
    }

    let totalRefund;
    let itemsForProcessing;
    try {
      const validated = await validateAndNormalizeReturnItems(saleId, items, originalSaleItems, originalSale);
      totalRefund = validated.totalRefund;
      itemsForProcessing = validated.normalizedItems;
    } catch (validationErr) {
      return res.status(400).json({
        success: false,
        message: validationErr.message || 'Invalid return items',
      });
    }

    // Enrich items with product details (including cost prices for ledger)
    // IMPORTANT: Use unit price from original sale item, not current inventory price
    // CRITICAL: Always use inventory_item_id from original sale item to avoid scope conflicts
    const enrichedItems = [];
    
    for (const item of (itemsForProcessing || [])) {
      // Find matching original sale item by inventory_item_id or item name
      let originalSaleItem = null;
      if (item.inventoryItemId) {
        originalSaleItem = originalSaleItems.find(si => 
          si.inventory_item_id === item.inventoryItemId || 
          si.inventory_item_id === parseInt(item.inventoryItemId)
        );
      } else if (item.productName) {
        const nameKey = String(item.productName).trim().toLowerCase();
        originalSaleItem = originalSaleItems.find((si) => {
          const label = String(si.item_name || si.name || '').trim().toLowerCase();
          return label === nameKey;
        });
      }
      
      // CRITICAL FIX: Always use inventory_item_id from original sale item to ensure correct scope
      // This prevents conflicts when same SKU/name exists in multiple branches
      // IMPORTANT: originalSaleItem.inventory_item_id might be NULL for manual items in the original sale
      const correctInventoryItemId = originalSaleItem?.inventory_item_id ?? item.inventoryItemId ?? null;
      
      
      // Get unit price from original sale item if found, otherwise use refundAmount / quantity
      let unitPrice = 0;
      if (originalSaleItem) {
        unitPrice = parseFloat(originalSaleItem.unit_price) || 0;
      } else if (item.refundAmount && item.quantity) {
        // Fallback: calculate from refund amount
        unitPrice = parseFloat(item.refundAmount) / parseFloat(item.quantity);
      } else {
        unitPrice = parseFloat(item.unitPrice) || 0;
      }
      
      // Handle manual items (no inventory validation needed)
      if (!correctInventoryItemId && !item.productName && !item.inventoryItemId) {
        enrichedItems.push({
          inventoryItemId: null, // Manual items don't have inventory ID
          itemName: item.name || item.itemName,
          sku: item.sku || `MANUAL-${Date.now()}`,
          barcode: item.barcode || null,
          category: item.category || null,
          quantity: item.quantity,
          originalQuantity: originalSaleItem ? parseFloat(originalSaleItem.quantity) : item.quantity,
          unitPrice: unitPrice, // Use original sale price or calculated
          costPrice: parseFloat(item.costPrice) || 0, // Add cost price for ledger
          refundAmount: item.refundAmount
        });
        continue;
      }
      
      // CRITICAL FIX: Always use inventory_item_id from original sale item
      // This ensures we update the correct inventory item in the correct scope
      if (correctInventoryItemId) {
        // Get the inventory item details using the ID from the original sale
        const [inventoryItems] = await pool.execute(
          'SELECT * FROM inventory_items WHERE id = ?',
          [correctInventoryItemId]
        );
        
        if (inventoryItems.length > 0) {
          const inventoryItem = inventoryItems[0];
          
          // Verify the inventory item belongs to the correct scope (for security)
          // Note: This is a warning, not an error, as the original sale might have been from a different scope
          if (inventoryItem.scope_type !== originalSale.scopeType || 
              String(inventoryItem.scope_id) !== String(originalSale.scopeId)) {
          }
          
          enrichedItems.push({
            inventoryItemId: inventoryItem.id,
            itemName: inventoryItem.name,
            sku: inventoryItem.sku,
            barcode: inventoryItem.barcode || null,
            category: inventoryItem.category || null,
            quantity: item.quantity,
            originalQuantity: originalSaleItem ? parseFloat(originalSaleItem.quantity) : item.quantity,
            unitPrice: unitPrice, // Use original sale price, not current inventory price
            costPrice: parseFloat(inventoryItem.cost_price) || 0, // Add cost price for ledger
            refundAmount: item.refundAmount
          });
          
        } else {
          return res.status(400).json({
            success: false,
            message: `Inventory item with ID ${correctInventoryItemId} from original sale not found`
          });
        }
      } else if (item.productName || originalSaleItem?.item_name) {
        // If no inventory_item_id found but we have a product name, try to find it in the correct scope
        // This handles cases where the original sale item was a manual item but the product now exists in inventory
        const searchName = item.productName || originalSaleItem?.item_name;
        
        // Try to find inventory item by name/SKU in the original sale's scope
        let scopeFilter = '';
        let scopeParams = [];
        
        if (originalSale.scopeType === 'BRANCH') {
          // Get branch ID or name
          const [branches] = await pool.execute(
            'SELECT id, name FROM branches WHERE id = ? OR name = ? LIMIT 1',
            [originalSale.scopeId, originalSale.scopeId]
          );
          if (branches.length > 0) {
            scopeFilter = 'AND (scope_type = ? AND (scope_id = ? OR scope_id = ?))';
            scopeParams = ['BRANCH', branches[0].id, branches[0].name];
          }
        } else if (originalSale.scopeType === 'WAREHOUSE') {
          const [warehouses] = await pool.execute(
            'SELECT id, name FROM warehouses WHERE id = ? OR name = ? LIMIT 1',
            [originalSale.scopeId, originalSale.scopeId]
          );
          if (warehouses.length > 0) {
            scopeFilter = 'AND (scope_type = ? AND (scope_id = ? OR scope_id = ?))';
            scopeParams = ['WAREHOUSE', warehouses[0].id, warehouses[0].name];
          }
        }
        
        const [inventoryItems] = await pool.execute(
          `SELECT * FROM inventory_items WHERE (name LIKE ? OR sku LIKE ?) ${scopeFilter} LIMIT 1`,
          [`%${searchName}%`, `%${searchName}%`, ...scopeParams]
        );
        
        if (inventoryItems.length > 0) {
          const inventoryItem = inventoryItems[0];
          
          enrichedItems.push({
            inventoryItemId: inventoryItem.id,
            itemName: inventoryItem.name,
            sku: inventoryItem.sku,
            barcode: inventoryItem.barcode || null,
            category: inventoryItem.category || null,
            quantity: item.quantity,
            originalQuantity: originalSaleItem ? parseFloat(originalSaleItem.quantity) : item.quantity,
            unitPrice: unitPrice,
            costPrice: parseFloat(inventoryItem.cost_price) || 0,
            refundAmount: item.refundAmount
          });
        } else {
          // If still not found, treat as manual item
          enrichedItems.push({
            inventoryItemId: null,
            itemName: searchName,
            sku: `MANUAL-${Date.now()}`,
            barcode: item.barcode || null,
            category: item.category || null,
            quantity: item.quantity,
            originalQuantity: originalSaleItem ? parseFloat(originalSaleItem.quantity) : item.quantity,
            unitPrice: unitPrice,
            costPrice: parseFloat(item.costPrice) || 0,
            refundAmount: item.refundAmount
          });
        }
      } else {
        // If no inventory_item_id found in original sale and not provided, treat as manual item
        enrichedItems.push({
          inventoryItemId: null,
          itemName: item.productName || item.name || item.itemName || 'Unknown Item',
          sku: `MANUAL-${Date.now()}`,
          barcode: item.barcode || null,
          category: item.category || null,
          quantity: item.quantity,
          originalQuantity: originalSaleItem ? parseFloat(originalSaleItem.quantity) : item.quantity,
          unitPrice: unitPrice, // Use original sale price or calculated
          costPrice: parseFloat(item.costPrice) || 0, // Add cost price for ledger
          refundAmount: item.refundAmount
        });
      }
    }
    

    // Check if sales_returns table exists
    try {
      const [tables] = await pool.execute("SHOW TABLES LIKE 'sales_returns'");
      
      if (tables.length === 0) {
        throw new Error('sales_returns table does not exist');
      }
    } catch (tableError) {
      throw new Error('Database table check failed');
    }

    // Create sales return
    
    const returnData = {
      originalSaleId: saleId,
      userId: req.user.id,
      reason,
      notes,
      totalRefund,
      items: enrichedItems,
      processedBy: req.user.id // Set processed_by to current user
    };

    const actingUserName = req.user.name || req.user.username || req.user.email || 'System';
    const actingUserRole = req.user.role || 'ADMIN';

    const returnScopeType = originalSale.scopeType || originalSale.scope_type || 'BRANCH';
    const returnScopeId = originalSale.scopeId || originalSale.scope_id || '';
    let returnCustomerInfo = originalSale.customerInfo || originalSale.customer_info || null;
    let returnCustomerName = originalSale.customerName || originalSale.customer_name || null;
    let returnCustomerPhone = originalSale.customerPhone || originalSale.customer_phone || null;

    if (!returnCustomerName && returnCustomerInfo) {
      try {
        const customerInfoObj = typeof returnCustomerInfo === 'string'
          ? JSON.parse(returnCustomerInfo)
          : returnCustomerInfo;
        if (customerInfoObj && typeof customerInfoObj === 'object') {
          returnCustomerName = returnCustomerName || customerInfoObj.name || customerInfoObj.customerName || null;
          returnCustomerPhone = returnCustomerPhone || customerInfoObj.phone || customerInfoObj.customerPhone || null;
        }
      } catch (e) {
      }
    }

    if (!returnCustomerName) {
      const [saleRows] = await pool.execute('SELECT customer_name, customer_phone FROM sales WHERE id = ?', [saleId]);
      if (saleRows.length > 0) {
        returnCustomerName = returnCustomerName || saleRows[0].customer_name || null;
        returnCustomerPhone = returnCustomerPhone || saleRows[0].customer_phone || null;
      }
    }

    const itemsWithInventory = enrichedItems.filter(
      (item) => item.inventoryItemId !== null && item.inventoryItemId !== undefined
    );
    const manualItems = enrichedItems.filter((item) => !item.inventoryItemId);
    if (manualItems.length > 0) {
    }

    const ledgerReturnData = {
      ...returnData,
      type: String(type || 'REFUND').toUpperCase(),
      refund_method: refundMethod || null,
      scope_type: returnScopeType,
      scope_id: returnScopeId,
      customer_name: returnCustomerName,
      customer_phone: returnCustomerPhone,
      customer_id: originalSale.customerId || originalSale.customer_id || null,
      retailer_id: originalSale.retailerId || originalSale.retailer_id || null,
    };

    if (!['REFUND', 'EXCHANGE'].includes(ledgerReturnData.type)) {
      throw Object.assign(new Error('Return type must be REFUND or EXCHANGE'), { statusCode: 400 });
    }
    if (ledgerReturnData.type === 'EXCHANGE') {
      if (!Array.isArray(exchangeItems) || !exchangeItems.length) {
        throw Object.assign(
          new Error('At least one replacement item is required for an exchange'),
          { statusCode: 400 }
        );
      }
      ledgerReturnData.refund_method = 'EXCHANGE';
    }

    let salesReturn;
    let exchangeResult = null;
    let returnSaleId = null;
    let previousRunningBalance = 0;
    let returnOldBalance = 0;
    let returnRunningBalance = 0;
    let coreTotalRefund = 0;

    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute('SELECT id FROM sales WHERE id = ? FOR UPDATE', [saleId]);
      const coreResult = await createSalesReturnCore({
        connection,
        requestItems: items,
        originalSale,
        originalSaleItems,
        returnData: ledgerReturnData,
        actor: req.user,
      });

      salesReturn = await SalesReturn.findById(Number(coreResult.salesReturn.id), connection);
      returnSaleId = coreResult.returnSale.id;
      previousRunningBalance = coreResult.previousRunningBalance;
      returnOldBalance = coreResult.returnOldBalance;
      coreTotalRefund = coreResult.totalRefund;

      if (ledgerReturnData.type === 'EXCHANGE') {
        exchangeResult = await createExchangeReplacementSale({
          connection,
          originalSale,
          returnData: ledgerReturnData,
          exchangeItems,
          actor: req.user,
          returnedTotal: coreResult.totalRefund,
          returnOldBalance: coreResult.returnOldBalance,
          postReturnBalanceFromCore: coreResult.legacyPostReturnBalance,
        });
        await finalizeExchangeReturn(connection, Number(salesReturn.id), exchangeResult);
      }

      const migrationDoneForBalance = await isLedgerMigrationComplete(connection);
      returnRunningBalance = migrationDoneForBalance
        ? await CustomerLedgerEntries.getCustomerBalance(connection, {
            scopeType: returnScopeType,
            scopeId: returnScopeId,
            retailerId: ledgerReturnData.retailer_id,
            customerName: returnCustomerName || '',
            customerPhone: returnCustomerPhone || '',
          })
        : Math.round(((coreResult.legacyPostReturnBalance ?? (returnOldBalance - coreResult.totalRefund)) +
            (exchangeResult?.replacementTotal || 0)) * 100) / 100;

      await connection.commit();
    } catch (returnTxnError) {
      await connection.rollback();
      throw returnTxnError;
    } finally {
      connection.release();
    }

    // Fetch the created return sale record to include in response
    let returnSaleRecord = null;
    try {
      const [returnSaleRows] = await pool.execute(`
        SELECT 
          id, invoice_no, customer_name, customer_phone, 
          old_balance, running_balance, payment_method, payment_type,
          subtotal, total, payment_amount, created_at
        FROM sales 
        WHERE invoice_no = ?
        ORDER BY id DESC
        LIMIT 1
      `, [salesReturn.returnNo]);
      
      if (returnSaleRows.length > 0) {
        returnSaleRecord = returnSaleRows[0];
      }
    } catch (fetchError) {
    }

    res.status(201).json({
      success: true,
      message: 'Sales return created successfully',
      data: {
        ...salesReturn,
        returnSaleRecord: returnSaleRecord ? {
          id: returnSaleRecord.id,
          invoice_no: returnSaleRecord.invoice_no,
          customer_name: returnSaleRecord.customer_name,
          customer_phone: returnSaleRecord.customer_phone,
          old_balance: returnSaleRecord.old_balance,
          running_balance: returnSaleRecord.running_balance,
          payment_method: returnSaleRecord.payment_method,
          payment_type: returnSaleRecord.payment_type,
          subtotal: returnSaleRecord.subtotal,
          total: returnSaleRecord.total,
          payment_amount: returnSaleRecord.payment_amount,
          created_at: returnSaleRecord.created_at
        } : null,
        exchange: exchangeResult ? {
          replacementSale: {
            id: exchangeResult.replacementSale.id,
            invoice_no: exchangeResult.replacementSale.invoice_no,
            total: exchangeResult.replacementSale.total,
            payment_method: exchangeResult.replacementSale.payment_method,
            payment_type: exchangeResult.replacementSale.payment_type,
          },
          replacementItems: exchangeResult.normalizedItems.map((item) => ({
            inventoryItemId: item.inventoryItemId,
            itemName: item.itemName,
            sku: item.sku,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            lineTotal: item.lineTotal,
          })),
          replacementTotal: exchangeResult.replacementTotal,
          priceDifference: exchangeResult.priceDifference,
        } : null
      },
      debug: {
        customerName: returnCustomerName,
        customerPhone: returnCustomerPhone,
        previousRunningBalance: previousRunningBalance,
        returnOldBalance: returnOldBalance,
        returnRunningBalance: returnRunningBalance,
        totalRefund: coreTotalRefund
      }
    });
  } catch (error) {
    console.error('[createSalesReturn] failed:', error && error.stack ? error.stack : error);
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || 'Error creating sales return',
      error: error.message,
      details: (process.env.NODE_ENV === 'development' || process.env.RETURN_ERROR_STACK === '1' || req.query.__stack === '1') ? {
        stack: error.stack,
        code: error.code,
        sqlMessage: error.sqlMessage
      } : undefined
    });
  }
};

// @desc    Get sales returns
// @route   GET /api/sales/returns
// @access  Private (Admin, Cashier, Warehouse Keeper)
const getSalesReturns = async (req, res, next) => {
  try {
    const { scopeType, scopeId, startDate, endDate, search } = req.query;
    let page = parseInt(req.query.page, 10);
    let limit = parseInt(req.query.limit, 10);
    if (!Number.isFinite(page) || page < 1) page = 1;
    if (!Number.isFinite(limit) || limit < 1) limit = 25;
    if (limit > 200) limit = 200;
    const offset = (page - 1) * limit;
    let whereConditions = ['s.deleted_at IS NULL'];
    let params = [];

    // Apply role-based filtering
    if (req.user.role === 'CASHIER') {
      // Cashiers can always view sales returns (read-only access)
      // Get branch name if not already available
      let userBranchName = req.user.branchName;
      if (!userBranchName && req.user.branchId) {
        const [branches] = await pool.execute('SELECT name FROM branches WHERE id = ?', [req.user.branchId]);
        userBranchName = branches[0]?.name || null;
      }
      
      if (userBranchName) {
        // Handle both string and number comparisons for scope_id
        whereConditions.push('s.scope_type = ? AND (s.scope_id = ? OR s.scope_id = ?)');
        params.push('BRANCH', userBranchName, String(userBranchName));
      } else {
        whereConditions.push('s.scope_type = ?');
        params.push('BRANCH');
      }
    } else if (req.user.role === 'WAREHOUSE_KEEPER') {
      // Get warehouse name if not already available
      let userWarehouseName = req.user.warehouseName;
      if (!userWarehouseName && req.user.warehouseId) {
        const [warehouses] = await pool.execute('SELECT name FROM warehouses WHERE id = ?', [req.user.warehouseId]);
        userWarehouseName = warehouses[0]?.name || null;
      }
      
      if (userWarehouseName) {
        // Handle both string and number comparisons for scope_id
        whereConditions.push('s.scope_type = ? AND (s.scope_id = ? OR s.scope_id = ?)');
        params.push('WAREHOUSE', userWarehouseName, String(userWarehouseName));
      } else {
        whereConditions.push('s.scope_type = ?');
        params.push('WAREHOUSE');
      }
    } else if (req.user.role === 'ADMIN') {
      // Admin can filter by scopeType and/or scopeId
      if (scopeType && scopeType !== 'all') {
        whereConditions.push('s.scope_type = ?');
        params.push(scopeType);
        
        // If scopeId is also provided, handle both name (string) and ID (number) matching
        if (scopeId && scopeId !== 'all') {
          // Check if scopeId is numeric (branch/warehouse ID) or string (name)
          const isNumeric = /^\d+$/.test(String(scopeId));
          
          if (scopeType === 'BRANCH' && isNumeric) {
            // If scopeId is numeric, get branch name to match against sales.scope_id
            const [branches] = await pool.execute('SELECT name FROM branches WHERE id = ?', [parseInt(scopeId)]);
            if (branches.length > 0) {
              whereConditions.push('(s.scope_id = ? OR s.scope_id = ?)');
              params.push(branches[0].name, String(scopeId));
            } else {
              // Branch not found, match by ID as string
              whereConditions.push('s.scope_id = ?');
              params.push(String(scopeId));
            }
          } else if (scopeType === 'WAREHOUSE' && isNumeric) {
            // If scopeId is numeric, get warehouse name to match against sales.scope_id
            const [warehouses] = await pool.execute('SELECT name FROM warehouses WHERE id = ?', [parseInt(scopeId)]);
            if (warehouses.length > 0) {
              whereConditions.push('(s.scope_id = ? OR s.scope_id = ?)');
              params.push(warehouses[0].name, String(scopeId));
            } else {
              // Warehouse not found, match by ID as string
              whereConditions.push('s.scope_id = ?');
              params.push(String(scopeId));
            }
          } else {
            // scopeId is a string (name), match directly
            whereConditions.push('(s.scope_id = ? OR s.scope_id = ?)');
            params.push(scopeId, String(scopeId));
          }
        }
      } else if (scopeId && scopeId !== 'all') {
        // If only scopeId is provided without scopeType, try to match by both BRANCH and WAREHOUSE
        const isNumeric = /^\d+$/.test(String(scopeId));
        
        if (isNumeric) {
          // Try to find branch or warehouse with this ID
          const [branches] = await pool.execute('SELECT name FROM branches WHERE id = ?', [parseInt(scopeId)]);
          const [warehouses] = await pool.execute('SELECT name FROM warehouses WHERE id = ?', [parseInt(scopeId)]);
          
          if (branches.length > 0) {
            whereConditions.push('(s.scope_type = ? AND (s.scope_id = ? OR s.scope_id = ?))');
            params.push('BRANCH', branches[0].name, String(scopeId));
          }
          if (warehouses.length > 0) {
            if (branches.length > 0) {
              // Add OR condition for warehouse
              whereConditions[whereConditions.length - 1] = whereConditions[whereConditions.length - 1].replace(')', '') + ' OR (s.scope_type = ? AND (s.scope_id = ? OR s.scope_id = ?)))';
              params.push('WAREHOUSE', warehouses[0].name, String(scopeId));
            } else {
              whereConditions.push('(s.scope_type = ? AND (s.scope_id = ? OR s.scope_id = ?))');
              params.push('WAREHOUSE', warehouses[0].name, String(scopeId));
            }
          }
        } else {
          // scopeId is a string, match by name for both BRANCH and WAREHOUSE
          whereConditions.push('((s.scope_type = ? AND s.scope_id = ?) OR (s.scope_type = ? AND s.scope_id = ?))');
          params.push('BRANCH', scopeId, 'WAREHOUSE', scopeId);
        }
      }
      // If neither scopeType nor scopeId is provided, show all returns (no scope filtering)
    }

    if (startDate) {
      whereConditions.push('sr.created_at >= ?');
      params.push(startDate);
    }

    if (endDate) {
      whereConditions.push('sr.created_at <= ?');
      params.push(endDate);
    }

    if (search && search.trim()) {
      const like = `%${search.trim()}%`;
      whereConditions.push(
        '(sr.return_no LIKE ? OR s.invoice_no LIKE ? OR sr.reason LIKE ? OR sr.notes LIKE ? OR s.customer_name LIKE ? OR s.customer_phone LIKE ?)'
      );
      params.push(like, like, like, like, like, like);
    }

    const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

    // Total count for pagination
    const [countRows] = await pool.execute(`
      SELECT COUNT(*) AS count
      FROM sales_returns sr
      JOIN sales s ON sr.original_sale_id = s.id
      ${whereClause}
    `, params);
    const total = countRows?.[0]?.count || 0;

    const [returns] = await pool.execute(`
      SELECT 
        sr.*,
        s.invoice_no,
        s.customer_name,
        s.customer_phone,
        u.username,
        u.email,
        u.username as user_name,
        p.username as processed_by_username,
        p.username as processed_by_name,
        b.name as branch_name,
        w.name as warehouse_name,
        (
          SELECT SUM(sri.remaining_quantity) 
          FROM sales_return_items sri 
          WHERE sri.return_id = sr.id
        ) AS remaining_total
      FROM sales_returns sr
      JOIN sales s ON sr.original_sale_id = s.id
      LEFT JOIN users u ON sr.user_id = u.id
      LEFT JOIN users p ON sr.processed_by = p.id
      LEFT JOIN branches b ON (
        s.scope_type = 'BRANCH' AND (
          CAST(s.scope_id AS CHAR) COLLATE utf8mb4_bin = CAST(b.name AS CHAR) COLLATE utf8mb4_bin OR 
          CAST(s.scope_id AS UNSIGNED) = b.id OR
          CAST(b.id AS CHAR) COLLATE utf8mb4_bin = CAST(s.scope_id AS CHAR) COLLATE utf8mb4_bin
        )
      )
      LEFT JOIN warehouses w ON (
        s.scope_type = 'WAREHOUSE' AND (
          CAST(s.scope_id AS CHAR) COLLATE utf8mb4_bin = CAST(w.name AS CHAR) COLLATE utf8mb4_bin OR 
          CAST(s.scope_id AS UNSIGNED) = w.id OR
          CAST(w.id AS CHAR) COLLATE utf8mb4_bin = CAST(s.scope_id AS CHAR) COLLATE utf8mb4_bin
        )
      )
      ${whereClause}
      ORDER BY sr.created_at DESC
      LIMIT ? OFFSET ?
    `, [...params, limit, offset]);

    if (returns.length > 0) {
    }

    // ✅ FIXED: Calculate total refund for each return by summing its items
    // Also calculate overall summary totals
    let totalReturnsAmount = 0;
    const returnsWithCalculatedTotals = await Promise.all(
      returns.map(async (returnRecord) => {
        // Get return items to calculate actual total refund
        const [items] = await pool.execute(`
          SELECT refund_amount
          FROM sales_return_items
          WHERE return_id = ?
        `, [returnRecord.id]);

        // Calculate total refund as sum of all items' refund amounts
        const calculatedTotalRefund = items.reduce((sum, item) => {
          return sum + parseFloat(item.refund_amount || 0);
        }, 0);

        // Add to overall total
        totalReturnsAmount += calculatedTotalRefund;

        return {
          ...returnRecord,
          // ✅ Use calculated total refund (sum of items) instead of stored value
          total_refund: calculatedTotalRefund,
          totalRefund: calculatedTotalRefund, // Add camelCase for frontend compatibility
          customerName: returnRecord.customer_name || null,
          customerPhone: returnRecord.customer_phone || null,
          // Keep original stored value for reference
          _original_total_refund: returnRecord.total_refund
        };
      })
    );

    res.json({
      success: true,
      count: returnsWithCalculatedTotals.length,
      total,
      page,
      limit,
      summary: {
        totalReturns: total,
        totalAmount: totalReturnsAmount
      },
      data: returnsWithCalculatedTotals
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error retrieving sales returns',
      error: error.message
    });
  }
};

// @desc    Get single sales return with items
// @route   GET /api/sales/returns/:id
// @access  Private (Admin, Cashier, Warehouse Keeper)
const getSalesReturn = async (req, res, next) => {
  try {
    const { id } = req.params;

    // Get return details
    const [returns] = await pool.execute(`
      SELECT 
        sr.*,
        s.invoice_no,
        s.scope_type,
        s.scope_id,
        u.username as user_name,
        p.username as processed_by_username,
        p.username as processed_by_name,
        b.name as branch_name,
        w.name as warehouse_name
      FROM sales_returns sr
      LEFT JOIN sales s ON sr.original_sale_id = s.id
      LEFT JOIN users u ON sr.user_id = u.id
      LEFT JOIN users p ON sr.processed_by = p.id
      LEFT JOIN branches b ON (
        s.scope_type = 'BRANCH' AND (
          CAST(s.scope_id AS CHAR) COLLATE utf8mb4_bin = CAST(b.name AS CHAR) COLLATE utf8mb4_bin OR 
          CAST(s.scope_id AS UNSIGNED) = b.id OR
          CAST(b.id AS CHAR) COLLATE utf8mb4_bin = CAST(s.scope_id AS CHAR) COLLATE utf8mb4_bin
        )
      )
      LEFT JOIN warehouses w ON (
        s.scope_type = 'WAREHOUSE' AND (
          CAST(s.scope_id AS CHAR) COLLATE utf8mb4_bin = CAST(w.name AS CHAR) COLLATE utf8mb4_bin OR 
          CAST(s.scope_id AS UNSIGNED) = w.id OR
          CAST(w.id AS CHAR) COLLATE utf8mb4_bin = CAST(s.scope_id AS CHAR) COLLATE utf8mb4_bin
        )
      )
      WHERE sr.id = ?
    `, [id]);

    if (returns.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Return not found'
      });
    }

    const returnData = returns[0];

    // Get return items
    const [items] = await pool.execute(`
      SELECT 
        sri.*,
        ii.name as inventory_item_name,
        ii.sku as inventory_sku,
        ii.selling_price as inventory_price,
        ii.category as inventory_category,
        ii.barcode as inventory_barcode
      FROM sales_return_items sri
      LEFT JOIN inventory_items ii ON sri.inventory_item_id = ii.id
      WHERE sri.return_id = ?
      ORDER BY sri.id
    `, [id]);

    if (items.length > 0) {
    }

    const [exchangeItemRows] = await pool.execute(`
      SELECT
        sei.*,
        ii.name as inventory_item_name,
        ii.sku as inventory_sku,
        ii.selling_price as inventory_price
      FROM sales_exchange_items sei
      LEFT JOIN inventory_items ii ON sei.inventory_item_id = ii.id
      WHERE sei.return_id = ?
      ORDER BY sei.id
    `, [id]);
    const exchangeItemsForResponse = exchangeItemRows.map((item) => ({
      id: item.id,
      returnId: item.return_id,
      inventoryItemId: item.inventory_item_id,
      itemName: item.item_name || item.inventory_item_name || 'Unknown Item',
      sku: item.sku || item.inventory_sku || null,
      barcode: item.barcode || null,
      category: item.category || null,
      quantity: parseFloat(item.quantity) || 0,
      unitPrice: parseFloat(item.unit_price) || 0,
      lineTotal: parseFloat(item.line_total) || 0,
    }));

    // FALLBACK: If no items found (old returns that weren't saved), try to reconstruct from original sale
    let itemsToUse = items;
    if (items.length === 0 && returnData.original_sale_id) {
      
      try {
        // Get original sale items
        const [originalSaleItems] = await pool.execute(`
          SELECT 
            si.*,
            ii.name as inventory_item_name,
            ii.sku as inventory_sku,
            ii.selling_price as inventory_price,
            ii.category as inventory_category,
            ii.barcode as inventory_barcode
          FROM sale_items si
          LEFT JOIN inventory_items ii ON si.inventory_item_id = ii.id
          WHERE si.sale_id = ?
          ORDER BY si.id
        `, [returnData.original_sale_id]);

        if (originalSaleItems.length > 0) {
          
          // Reconstruct return items from original sale items
          // Use the total refund amount divided by number of items as a simple approximation
          const refundPerItem = returnData.total_refund ? (parseFloat(returnData.total_refund) / originalSaleItems.length) : 0;
          
          itemsToUse = originalSaleItems.map((saleItem, index) => ({
            id: null, // No actual return item ID
            return_id: returnData.id,
            inventory_item_id: saleItem.inventory_item_id,
            item_name: saleItem.item_name || saleItem.inventory_item_name || 'Unknown Item',
            sku: saleItem.sku || saleItem.inventory_sku || 'N/A',
            barcode: saleItem.barcode || saleItem.inventory_barcode || null,
            category: saleItem.category || saleItem.inventory_category || null,
            quantity: parseFloat(saleItem.quantity) || 0,
            original_quantity: parseFloat(saleItem.quantity) || 0,
            remaining_quantity: parseFloat(saleItem.quantity) || 0,
            unit_price: parseFloat(saleItem.unit_price) || 0,
            refund_amount: refundPerItem || parseFloat(saleItem.total) || 0,
            created_at: returnData.created_at,
            inventory_item_name: saleItem.inventory_item_name,
            inventory_sku: saleItem.inventory_sku,
            inventory_price: parseFloat(saleItem.inventory_price) || 0,
            inventory_category: saleItem.inventory_category,
            inventory_barcode: saleItem.inventory_barcode
          }));
        }
      } catch (fallbackError) {
        // Continue with empty items array
      }
    }

    // Transform items data
    const transformedItems = itemsToUse.map(item => ({
      id: item.id,
      returnId: item.return_id,
      inventoryItemId: item.inventory_item_id,
      itemName: item.item_name || item.inventory_item_name || 'Unknown Item',
      name: item.item_name || item.inventory_item_name || 'Unknown Item', // Add 'name' for frontend compatibility
      productName: item.item_name || item.inventory_item_name || 'Unknown Item', // Add 'productName' for frontend compatibility
      sku: item.sku || item.inventory_sku || 'N/A',
      barcode: item.barcode || item.inventory_barcode || null,
      category: item.category || item.inventory_category || null,
      quantity: parseFloat(item.quantity) || 0,
      originalQuantity: parseFloat(item.original_quantity) || 0,
      remainingQuantity: parseFloat(item.remaining_quantity) || 0,
      unitPrice: parseFloat(item.unit_price) || 0,
      unit_price: parseFloat(item.unit_price) || 0, // Add snake_case for frontend compatibility
      refundAmount: parseFloat(item.refund_amount) || 0,
      refund_amount: parseFloat(item.refund_amount) || 0, // Add snake_case for frontend compatibility
      createdAt: item.created_at,
      // Additional inventory info
      inventoryItemName: item.inventory_item_name,
      inventorySku: item.inventory_sku,
      inventoryPrice: parseFloat(item.inventory_price) || 0,
      currentStock: parseFloat(item.current_stock) || 0,
      minStockLevel: parseFloat(item.min_stock_level) || 0,
      maxStockLevel: parseFloat(item.max_stock_level) || 0
    }));

    // ✅ FIXED: Calculate total refund as sum of all items' refund amounts
    const calculatedTotalRefund = transformedItems.reduce((sum, item) => {
      const refundAmount = parseFloat(item.refundAmount || item.refund_amount || 0);
      return sum + refundAmount;
    }, 0);

    // Combine return data with items
    const returnWithItems = {
      ...returnData,
      items: transformedItems,
      // ✅ Use calculated total refund (sum of all items) instead of stored value
      total_refund: calculatedTotalRefund,
      totalRefund: calculatedTotalRefund, // Add camelCase for frontend compatibility
      customerName: returnData.customer_name || null,
      customerPhone: returnData.customer_phone || null,
      type: returnData.type || 'REFUND',
      refundMethod: returnData.refund_method || null,
      replacementSaleId: returnData.replacement_sale_id || null,
      replacementTotal: returnData.replacement_total != null ? parseFloat(returnData.replacement_total) : null,
      priceDifference: returnData.price_difference != null ? parseFloat(returnData.price_difference) : null,
      exchangeItems: exchangeItemsForResponse,
    };

    res.json({
      success: true,
      data: returnWithItems
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error retrieving sales return',
      error: error.message
    });
  }
};

// @desc    Update sales return
// @route   PUT /api/sales/returns/:id
// @access  Private (Admin, Cashier, Warehouse Keeper)
const updateSalesReturn = async (req, res, next) => {
  let connection;
  try {
    const { id } = req.params;
    const { status, reason, notes, processedBy, approvedBy, items } = req.body || {};

    if (!Array.isArray(items)) {
      const [existingReturns] = await pool.execute(
        'SELECT * FROM sales_returns WHERE id = ?',
        [id]
      );
      if (!existingReturns.length) {
        return res.status(404).json({ success: false, message: 'Sales return not found' });
      }

      const updateFields = [];
      const params = [];
      for (const [field, value] of Object.entries({ status, reason, notes, processedBy, approvedBy })) {
        if (value === undefined) continue;
        const column = field === 'processedBy' ? 'processed_by'
          : field === 'approvedBy' ? 'approved_by' : field;
        updateFields.push(`${column} = ?`);
        params.push(value);
      }
      if (!updateFields.length) {
        return res.status(400).json({ success: false, message: 'No fields to update' });
      }
      updateFields.push('updated_at = NOW()');
      params.push(id);
      await pool.execute(`UPDATE sales_returns SET ${updateFields.join(', ')} WHERE id = ?`, params);
      const [updatedRows] = await pool.execute(`
        SELECT sr.*, s.invoice_no, u.username, u.email,
               u.username AS user_name,
               p.username AS processed_by_username,
               p.username AS processed_by_name,
               b.name AS branch_name, w.name AS warehouse_name
        FROM sales_returns sr
        JOIN sales s ON sr.original_sale_id = s.id
        LEFT JOIN users u ON sr.user_id = u.id
        LEFT JOIN users p ON sr.processed_by = p.id
        LEFT JOIN branches b ON s.scope_type = 'BRANCH' AND s.scope_id = b.name
        LEFT JOIN warehouses w ON s.scope_type = 'WAREHOUSE' AND s.scope_id = w.name
        WHERE sr.id = ?
      `, [id]);
      return res.json({ success: true, message: 'Sales return updated successfully', data: updatedRows[0] });
    }

    connection = await pool.getConnection();
    await connection.beginTransaction();

    const [returnRows] = await connection.execute(
      'SELECT * FROM sales_returns WHERE id = ? FOR UPDATE',
      [id]
    );
    if (!returnRows.length) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Sales return not found' });
    }
    const existingReturn = returnRows[0];
    if (String(existingReturn.type || 'REFUND').toUpperCase() === 'EXCHANGE' && Array.isArray(items)) {
      await connection.rollback();
      return res.status(409).json({
        success: false,
        message: 'Exchange items cannot be edited after the exchange is created',
      });
    }
    if (['CANCELLED', 'REJECTED'].includes(String(existingReturn.status || '').toUpperCase())) {
      await connection.rollback();
      return res.status(409).json({ success: false, message: 'Cancelled or rejected returns cannot be edited' });
    }

    const [saleRows] = await connection.execute(
      'SELECT * FROM sales WHERE id = ? AND deleted_at IS NULL FOR UPDATE',
      [existingReturn.original_sale_id]
    );
    if (!saleRows.length) throw Object.assign(new Error('Original sale not found'), { statusCode: 404 });
    const originalSale = saleRows[0];

    if (req.user?.role === 'CASHIER') {
      const [branches] = await connection.execute(
        'SELECT id, name FROM branches WHERE id = ? OR name = ? LIMIT 1',
        [req.user.branch_id || req.user.branchId || null, originalSale.scope_id]
      );
      const branch = branches[0];
      if (originalSale.scope_type !== 'BRANCH' || !branch ||
          (String(originalSale.scope_id) !== String(branch.id) && String(originalSale.scope_id) !== String(branch.name))) {
        throw Object.assign(new Error('Access denied'), { statusCode: 403 });
      }
    } else if (req.user?.role === 'WAREHOUSE_KEEPER') {
      const [warehouses] = await connection.execute(
        'SELECT id, name FROM warehouses WHERE id = ? OR name = ? LIMIT 1',
        [req.user.warehouse_id || req.user.warehouseId || null, originalSale.scope_id]
      );
      const warehouse = warehouses[0];
      if (originalSale.scope_type !== 'WAREHOUSE' || !warehouse ||
          (String(originalSale.scope_id) !== String(warehouse.id) && String(originalSale.scope_id) !== String(warehouse.name))) {
        throw Object.assign(new Error('Access denied'), { statusCode: 403 });
      }
    }

    const [originalSaleItems] = await connection.execute(
      'SELECT * FROM sale_items WHERE sale_id = ? ORDER BY id FOR UPDATE',
      [existingReturn.original_sale_id]
    );
    const [oldItems] = await connection.execute(
      'SELECT * FROM sales_return_items WHERE return_id = ? ORDER BY id FOR UPDATE',
      [id]
    );
    if (!oldItems.length) {
      throw Object.assign(
        new Error('This return has no saved item lines and cannot be safely edited'),
        { statusCode: 409 }
      );
    }
    if (!oldItems.length) {
      throw Object.assign(
        new Error('This return has no saved item lines and cannot be safely edited'),
        { statusCode: 409 }
      );
    }
    const [refundSales] = await connection.execute(
      `SELECT * FROM sales
        WHERE invoice_no = ? AND payment_type = 'REFUND'
           AND deleted_at IS NULL
       ORDER BY id DESC LIMIT 1 FOR UPDATE`,
      [existingReturn.return_no]
    );
    if (!refundSales.length) {
      throw Object.assign(new Error('Refund transaction is missing; this return cannot be safely edited'), { statusCode: 409 });
    }

    let validated;
    try {
      validated = await validateAndNormalizeReturnItems(
        existingReturn.original_sale_id,
        items,
        originalSaleItems,
        originalSale,
        connection,
        Number(id)
      );
    } catch (validationError) {
      throw Object.assign(validationError, { statusCode: 400 });
    }

    const canonicalItems = [];
    for (const item of validated.normalizedItems) {
      const sourceItem = originalSaleItems.find((saleItem) => {
        if (item.inventoryItemId != null && saleItem.inventory_item_id != null) {
          return Number(item.inventoryItemId) === Number(saleItem.inventory_item_id);
        }
        return String(item.productName || '').trim().toLowerCase() ===
          String(saleItem.item_name || saleItem.name || '').trim().toLowerCase();
      });
      if (!sourceItem) throw Object.assign(new Error(`Item "${item.productName}" was not found on the original sale`), { statusCode: 400 });

      const inventoryItemId = sourceItem.inventory_item_id ?? null;
      let inventory = null;
      if (inventoryItemId != null) {
        const [inventoryRows] = await connection.execute(
          `SELECT id, name, sku, barcode, category, cost_price, scope_type, scope_id
           FROM inventory_items WHERE id = ? FOR UPDATE`,
          [inventoryItemId]
        );
        inventory = inventoryRows[0] || null;
        if (!inventory) throw Object.assign(new Error(`Inventory item ${inventoryItemId} no longer exists`), { statusCode: 409 });
      }

      canonicalItems.push({
        inventoryItemId,
        itemName: sourceItem.item_name || sourceItem.name || item.productName,
        sku: sourceItem.sku || inventory?.sku || 'N/A',
        barcode: inventory?.barcode || null,
        category: inventory?.category || null,
        quantity: Number(item.quantity),
        originalQuantity: Number(sourceItem.quantity) || 0,
        remainingQuantity: 0,
        unitPrice: Number(item.unitPrice) || 0,
        refundAmount: Number(item.refundAmount) || 0,
        costPrice: Number(inventory?.cost_price) || 0,
      });
    }

    const oldQtyByInventory = new Map();
    const newQtyByInventory = new Map();
    for (const item of oldItems) {
      if (item.inventory_item_id == null) continue;
      const itemId = Number(item.inventory_item_id);
      oldQtyByInventory.set(itemId, (oldQtyByInventory.get(itemId) || 0) + (Number(item.quantity) || 0));
    }
    for (const item of canonicalItems) {
      if (item.inventoryItemId == null) continue;
      newQtyByInventory.set(item.inventoryItemId, (newQtyByInventory.get(item.inventoryItemId) || 0) + item.quantity);
    }

    const actorName = req.user?.name || req.user?.username || req.user?.email || 'System';
    const actorRole = req.user?.role || 'ADMIN';
    const itemIds = new Set([...oldQtyByInventory.keys(), ...newQtyByInventory.keys()]);
    for (const inventoryItemId of itemIds) {
      const delta = (newQtyByInventory.get(inventoryItemId) || 0) - (oldQtyByInventory.get(inventoryItemId) || 0);
      if (Math.abs(delta) < 0.0001) continue;
      const [inventoryRows] = await connection.execute(
        'SELECT current_stock, scope_type, scope_id, cost_price FROM inventory_items WHERE id = ? FOR UPDATE',
        [inventoryItemId]
      );
      const inventory = inventoryRows[0];
      if (!inventory) throw Object.assign(new Error(`Inventory item ${inventoryItemId} no longer exists`), { statusCode: 409 });
      const previousStock = Number(inventory.current_stock) || 0;
      const quantity = Math.abs(delta);

      await InventoryProjection.applyEvent(connection, {
        event_type: delta > 0 ? 'RETURN' : 'ADJUSTMENT',
        inventory_item_id: inventoryItemId,
        scope_type: normalizeScope(inventory.scope_type),
        scope_id: String(inventory.scope_id != null ? inventory.scope_id : ''),
        quantity_in: delta > 0 ? quantity : 0,
        quantity_out: delta < 0 ? quantity : 0,
        reference_type: 'sales_return_edit',
        reference_id: `${id}:edit:${Date.now()}:${inventoryItemId}`,
        unit_cost: Number(inventory.cost_price) || 0,
        entry_date: new Date(),
        created_by: req.user?.id || null,
      });

      const [stockRows] = await connection.execute(
        'SELECT current_stock FROM inventory_items WHERE id = ?',
        [inventoryItemId]
      );
      const nextStock = Number(stockRows[0]?.current_stock) || 0;
      if (delta > 0) {
        const item = canonicalItems.find((line) => line.inventoryItemId === inventoryItemId);
        await createReturnTransaction(
          inventoryItemId, quantity, Number(item?.unitPrice) || 0,
          req.user?.id, actorName, actorRole, Number(id), connection,
          inventory.scope_type, inventory.scope_id, true
        );
      } else {
        await createAdjustmentTransaction(
          inventoryItemId, previousStock, nextStock, req.user?.id, actorName, actorRole,
          `Return ${existingReturn.return_no} item correction`, connection
        );
      }
    }

    const totalRefund = Number(validated.totalRefund) || 0;
    await connection.execute('DELETE FROM sales_return_items WHERE return_id = ?', [id]);
    for (const item of canonicalItems) {
      await connection.execute(
        `INSERT INTO sales_return_items (
          return_id, inventory_item_id, item_name, sku, barcode, category,
          quantity, original_quantity, remaining_quantity, unit_price, refund_amount
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, item.inventoryItemId, item.itemName, item.sku, item.barcode, item.category,
          item.quantity, item.originalQuantity, item.remainingQuantity, item.unitPrice, item.refundAmount]
      );
    }

    const nextStatus = status === undefined ? existingReturn.status : status;
    const nextReason = reason === undefined ? existingReturn.reason : reason;
    const nextNotes = notes === undefined ? existingReturn.notes : notes;
    await connection.execute(
      `UPDATE sales_returns
       SET reason = ?, notes = ?, total_refund = ?, status = ?,
           processed_by = COALESCE(?, processed_by), approved_by = COALESCE(?, approved_by), updated_at = NOW()
       WHERE id = ?`,
      [nextReason, nextNotes, totalRefund, nextStatus, processedBy ?? null, approvedBy ?? null, id]
    );

    const refundSale = refundSales[0];
    await connection.execute(
      `UPDATE sales
       SET subtotal = ?, total = ?, payment_amount = ?, credit_amount = 0,
           notes = ?, updated_at = NOW()
       WHERE id = ?`,
      [-totalRefund, -totalRefund, -totalRefund, nextNotes, refundSale.id]
    );
    const [updatedSaleRows] = await connection.execute('SELECT * FROM sales WHERE id = ?', [refundSale.id]);
    const updatedRefundSale = updatedSaleRows[0];

    await LedgerService.removeEntriesForSaleReference(
      connection,
      Number(id),
      `Return ${existingReturn.return_no} - %`
    );
    await LedgerService.recordReturnTransaction({
      returnId: Number(id), returnNo: existingReturn.return_no,
      originalSaleId: existingReturn.original_sale_id, originalSale,
      scopeType: originalSale.scope_type, scopeId: originalSale.scope_id,
      totalRefund, items: canonicalItems, userId: req.user?.id,
      refundMethod: existingReturn.refund_method || 'CASH',
    }, connection);

    if (await isLedgerMigrationComplete(connection)) {
      await CustomerLedgerEntries.appendFromSalesRow(connection, updatedRefundSale);
      const ledgerParty = {
        scopeType: updatedRefundSale.scope_type, scopeId: updatedRefundSale.scope_id,
        retailerId: updatedRefundSale.retailer_id, customerName: updatedRefundSale.customer_name,
        customerPhone: updatedRefundSale.customer_phone,
      };
      const finalBalance = await CustomerLedgerEntries.getCustomerBalance(connection, ledgerParty);
      const { debit, credit } = CustomerLedgerEntries.debitCreditForSaleRow(updatedRefundSale);
      await CustomerLedgerEntries.insertInvoiceSnapshot(connection, {
        sale_id: updatedRefundSale.id, customer_id: updatedRefundSale.customer_id,
        retailer_id: updatedRefundSale.retailer_id, scope_type: updatedRefundSale.scope_type,
        scope_id: updatedRefundSale.scope_id, invoice_no: updatedRefundSale.invoice_no,
        old_balance: finalBalance - (debit - credit), total: totalRefund,
        payment: 0, final_balance: finalBalance,
      });
    } else {
      const { recalculateCustomerLedger } = require('../../services/ledgerRecalcService');
      await recalculateCustomerLedger({
        retailerId: originalSale.retailer_id, customerPhone: originalSale.customer_phone,
        customerName: originalSale.customer_name, scopeType: originalSale.scope_type,
        scopeName: String(originalSale.scope_id), connection,
      });
    }

    const [updatedReturnRows] = await connection.execute('SELECT * FROM sales_returns WHERE id = ?', [id]);
    await connection.commit();
    return res.json({
      success: true,
      message: 'Sales return items and refund updated successfully',
      data: { ...updatedReturnRows[0], items: canonicalItems },
    });
  } catch (error) {
    if (connection) {
      try { await connection.rollback(); } catch (_) { /* connection may be closed */ }
    }
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.statusCode ? error.message : 'Error updating sales return',
      ...(error.statusCode ? { statusCode: error.statusCode } : { error: error.message }),
    });
  } finally {
    if (connection) connection.release();
  }
};

module.exports = {
  createSalesReturn,
  getSalesReturns,
  getSalesReturn,
  updateSalesReturn,
};
