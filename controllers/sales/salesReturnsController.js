
const { validationResult } = require('express-validator');
const Sale = require('../../models/Sale');
const SalesReturn = require('../../models/SalesReturn');
const { pool } = require('../../config/database');
const { createReturnTransaction } = require('../../middleware/stockTracking');
const LedgerService = require('../../services/ledgerService');
const InventoryProjection = require('../../services/inventoryProjectionService');
const { normalizeScope } = require('../../services/inventoryLedgerService');
const CustomerLedgerEntries = require('../../services/customerLedgerEntriesService');
const { isLedgerMigrationComplete } = require('../../services/ledgerMigrationMeta');
const { validateAndNormalizeReturnItems } = require('../../services/sales/returnValidationService');

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

    const { saleId, items, reason, notes } = req.body;

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
      const validated = await validateAndNormalizeReturnItems(saleId, items, originalSaleItems);
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
    
    for (const item of itemsForProcessing) {
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

    let salesReturn;
    let previousRunningBalance = 0;
    let returnOldBalance = 0;
    let returnRunningBalance = 0;
    let returnSaleId = null;

    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const migrationDone = await isLedgerMigrationComplete(connection);

      salesReturn = await SalesReturn.create(returnData, connection);

      for (let retIdx = 0; retIdx < itemsWithInventory.length; retIdx++) {
        const item = itemsWithInventory[retIdx];
        if (!item.inventoryItemId) {
          continue;
        }

        const [inventoryItems] = await connection.execute(
          'SELECT id, scope_type, scope_id, current_stock, name, sku, cost_price FROM inventory_items WHERE id = ?',
          [item.inventoryItemId]
        );

        if (inventoryItems.length === 0) {
          throw new Error(`Inventory item ${item.inventoryItemId} not found`);
        }

        const inventoryItem = inventoryItems[0];
        // Scope match: the system stores scope_id as either a numeric branch/warehouse ID
        // or a human-readable name string (e.g. "Pet Family Qasimabad"). Accept either form.
        const saleScopeId = String(originalSale.scopeId || originalSale.scope_id || '');
        const itemScopeId = String(inventoryItem.scope_id != null ? inventoryItem.scope_id : '');
        const saleType = originalSale.scopeType || originalSale.scope_type || '';
        const scopeTypeMatches = inventoryItem.scope_type === saleType;
        const scopeIdMatches = itemScopeId === saleScopeId || saleScopeId === '' || itemScopeId === '';
        const scopeMatches = scopeTypeMatches && scopeIdMatches;

        if (!scopeMatches) {
          // Soft check: also look up branch by name to handle name vs ID mismatch
          let resolvedMatch = false;
          if (scopeTypeMatches && !scopeIdMatches) {
            try {
              const table = saleType === 'WAREHOUSE' ? 'warehouses' : 'branches';
              const [nameRows] = await connection.execute(
                `SELECT id FROM ${table} WHERE id = ? OR name = ? LIMIT 1`,
                [saleScopeId, saleScopeId]
              );
              if (nameRows.length > 0) {
                resolvedMatch = String(nameRows[0].id) === itemScopeId ||
                                String(inventoryItem.scope_id) === String(nameRows[0].id);
              }
            } catch (_) { /* ignore lookup errors */ }
          }
          if (!resolvedMatch) {
            throw new Error(
              `Inventory item ${item.inventoryItemId} is in ${inventoryItem.scope_type}/${inventoryItem.scope_id}, ` +
                `but sale ${saleId} is in ${saleType}/${saleScopeId}`
            );
          }
        }

        const rq = parseFloat(item.quantity) || 0;
        if (rq <= 0) {
          continue;
        }

        await InventoryProjection.applyEvent(connection, {
          event_type: 'RETURN',
          inventory_item_id: item.inventoryItemId,
          scope_type: normalizeScope(inventoryItem.scope_type),
          scope_id: String(inventoryItem.scope_id != null ? inventoryItem.scope_id : ''),
          quantity_in: rq,
          quantity_out: 0,
          reference_type: 'sales_return',
          reference_id: `${salesReturn.id}:${item.inventoryItemId}:${retIdx}`,
          unit_cost: parseFloat(item.costPrice) || parseFloat(inventoryItem.cost_price) || 0,
          entry_date: new Date(),
          created_by: req.user.id,
        });

        await createReturnTransaction(
          item.inventoryItemId,
          rq,
          item.unitPrice,
          req.user.id,
          actingUserName,
          actingUserRole,
          salesReturn.id,
          connection,
          originalSale.scopeType,
          originalSale.scopeId,
          true
        );
      }

      if (itemsWithInventory.length > 0) {
        await connection.execute(
          `UPDATE sales_return_items
           SET remaining_quantity = 0
           WHERE return_id = ?
             AND inventory_item_id IS NOT NULL`,
          [salesReturn.id]
        );
      }

      const ledgerParty = {
        scopeType: returnScopeType,
        scopeId: returnScopeId,
        retailerId: originalSale.retailerId || originalSale.retailer_id || null,
        customerName: returnCustomerName || '',
        customerPhone: returnCustomerPhone || '',
      };

      if (migrationDone) {
        previousRunningBalance = await CustomerLedgerEntries.getCustomerBalance(connection, ledgerParty);
        returnOldBalance = previousRunningBalance;
        returnRunningBalance = previousRunningBalance;
      } else {
        const [latestSale] = await connection.execute(
          `SELECT running_balance FROM sales
           WHERE (customer_name = ? OR customer_phone = ?)
             AND scope_type = ? AND scope_id = ?
           ORDER BY created_at DESC, id DESC LIMIT 1`,
          [returnCustomerName, returnCustomerPhone, returnScopeType, returnScopeId]
        );
        previousRunningBalance = latestSale.length ? parseFloat(latestSale[0].running_balance) || 0 : 0;
        returnOldBalance = previousRunningBalance;
        returnRunningBalance = returnOldBalance - totalRefund;
      }

      const persistOldBal = migrationDone ? 0 : returnOldBalance;
      const persistRunBal = migrationDone ? 0 : returnRunningBalance;
      const returnNotes = notes || reason || `Return for sale ${originalSale.invoiceNo || originalSale.invoice_no || saleId}`;

      const [returnSaleResult] = await connection.execute(
        `INSERT INTO sales (
          invoice_no, scope_type, scope_id, user_id, shift_id,
          subtotal, tax, discount, total,
          payment_method, payment_type, payment_status,
          customer_info, notes, status,
          customer_name, customer_phone,
          payment_amount, credit_amount,
          old_balance, running_balance,
          credit_status, credit_due_date, customer_id, retailer_id
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          salesReturn.returnNo,
          returnScopeType,
          returnScopeId,
          req.user.id,
          null,
          -totalRefund,
          0,
          0,
          -totalRefund,
          'REFUND',
          'REFUND',
          'COMPLETED',
          returnCustomerInfo ? JSON.stringify(returnCustomerInfo) : null,
          returnNotes,
          'COMPLETED',
          returnCustomerName,
          returnCustomerPhone,
          -totalRefund,
          0,
          persistOldBal,
          persistRunBal,
          'NONE',
          null,
          originalSale.customerId || originalSale.customer_id || null,
          originalSale.retailerId || originalSale.retailer_id || null,
        ]
      );

      returnSaleId = returnSaleResult.insertId;

      if (migrationDone) {
        const [saleRows] = await connection.execute('SELECT * FROM sales WHERE id = ?', [returnSaleId]);
        if (saleRows.length > 0) {
          const sr = saleRows[0];
          await CustomerLedgerEntries.appendFromSalesRow(connection, sr);
          const balAfter = await CustomerLedgerEntries.getCustomerBalance(connection, ledgerParty);
          const { debit, credit } = CustomerLedgerEntries.debitCreditForSaleRow(sr);
          const oldSnap = balAfter - (debit - credit);
          await CustomerLedgerEntries.insertInvoiceSnapshot(connection, {
            sale_id: returnSaleId,
            customer_id: sr.customer_id,
            retailer_id: sr.retailer_id,
            scope_type: sr.scope_type,
            scope_id: sr.scope_id,
            invoice_no: sr.invoice_no,
            old_balance: oldSnap,
            total: Math.abs(parseFloat(sr.total) || parseFloat(sr.subtotal) || 0),
            payment: 0,
            final_balance: balAfter,
          });
          returnOldBalance = oldSnap;
          returnRunningBalance = balAfter;
        }
      }

      await LedgerService.recordReturnTransaction(
        {
          returnId: salesReturn.id,
          returnNo: salesReturn.returnNo,
          originalSaleId: saleId,
          originalSale,
          scopeType: originalSale.scopeType || originalSale.scope_type,
          scopeId: originalSale.scopeId || originalSale.scope_id,
          totalRefund,
          items: enrichedItems,
          userId: req.user.id,
        },
        connection
      );

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
        } : null
      },
      debug: {
        customerName: returnCustomerName,
        customerPhone: returnCustomerPhone,
        previousRunningBalance: previousRunningBalance,
        returnOldBalance: returnOldBalance,
        returnRunningBalance: returnRunningBalance,
        totalRefund: totalRefund
      }
    });
  } catch (error) {
    
    res.status(500).json({
      success: false,
      message: 'Error creating sales return',
      error: error.message,
      details: process.env.NODE_ENV === 'development' ? {
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
  try {
    const { id } = req.params;
    const { status, notes, processedBy, approvedBy } = req.body;

    // Check if return exists
    const [existingReturns] = await pool.execute(
      'SELECT * FROM sales_returns WHERE id = ?',
      [id]
    );

    if (existingReturns.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Sales return not found'
      });
    }

    const existingReturn = existingReturns[0];

    // Build update query dynamically
    const updateFields = [];
    const params = [];

    if (status !== undefined) {
      updateFields.push('status = ?');
      params.push(status);
    }

    if (notes !== undefined) {
      updateFields.push('notes = ?');
      params.push(notes);
    }

    if (processedBy !== undefined) {
      updateFields.push('processed_by = ?');
      params.push(processedBy);
    }

    if (approvedBy !== undefined) {
      updateFields.push('approved_by = ?');
      params.push(approvedBy);
    }

    if (updateFields.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No fields to update'
      });
    }

    // Add updated_at timestamp
    updateFields.push('updated_at = NOW()');
    params.push(id);

    const query = `UPDATE sales_returns SET ${updateFields.join(', ')} WHERE id = ?`;
    

    const [result] = await pool.execute(query, params);

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        message: 'Sales return not found or no changes made'
      });
    }

    // Fetch updated return
    const [updatedReturns] = await pool.execute(`
      SELECT 
        sr.*,
        s.invoice_no,
        u.username,
        u.email,
        u.username as user_name,
        p.username as processed_by_username,
        p.username as processed_by_name,
        b.name as branch_name,
        w.name as warehouse_name
      FROM sales_returns sr
      JOIN sales s ON sr.original_sale_id = s.id
      LEFT JOIN users u ON sr.user_id = u.id
      LEFT JOIN users p ON sr.processed_by = p.id
      LEFT JOIN branches b ON s.scope_type = 'BRANCH' AND s.scope_id = b.name
      LEFT JOIN warehouses w ON s.scope_type = 'WAREHOUSE' AND s.scope_id = w.name
      WHERE sr.id = ?
    `, [id]);

    res.json({
      success: true,
      message: 'Sales return updated successfully',
      data: updatedReturns[0]
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error updating sales return',
      error: error.message
    });
  }
};

module.exports = {
  createSalesReturn,
  getSalesReturns,
  getSalesReturn,
  updateSalesReturn,
};
