'use strict';

const { validationResult } = require('express-validator');
const Sale = require('../../models/Sale');
const { pool } = require('../../config/database');
const CustomerLedgerEntries = require('../../services/customerLedgerEntriesService');
const { isLedgerMigrationComplete } = require('../../services/ledgerMigrationMeta');
const {
  mergeSaleRowWithSnapshotBalances,
  mergeSaleRowsWithSnapshotBalances,
} = require('../../utils/invoiceSnapshotBalances');
const InventoryProjection = require('../../services/inventoryProjectionService');
const { normalizeScope } = require('../../services/inventoryLedgerService');
const trashService = require('../../services/trashService');
// @desc    Get all sales
// @route   GET /api/sales
// @access  Private (Admin, Cashier)
const getSales = async (req, res, next) => {
  try {
    const {
      scopeType,
      scopeId,
      startDate,
      endDate,
      paymentMethod,
      status,
      retailerId,
      customerPhone,
      customerName,
      creditStatus,
      paymentStatus,
      scopeSearch,
      search,
      page = 1,
      limit = 50
    } = req.query;

    // Basic pagination guardrails
    const parsedLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    const parsedPage = Math.max(parseInt(page, 10) || 1, 1);
    const offset = (parsedPage - 1) * parsedLimit;
    let whereConditions = ['s.deleted_at IS NULL'];
    let params = [];

    // Apply role-based filtering
    if (req.user.role === 'CASHIER') {
      // Cashiers can always view sales (read-only access)
      // Get branch name and ID if not already available
      let userBranchName = req.user.branchName;
      let userBranchId = req.user.branchId;
      
      if (!userBranchName && userBranchId) {
        const [branches] = await pool.execute('SELECT id, name FROM branches WHERE id = ?', [userBranchId]);
        if (branches.length > 0) {
          userBranchName = branches[0].name;
          userBranchId = branches[0].id;
        }
      }
      
      if (userBranchName && userBranchId) {
        // Handle both string (branch name) and number (branch ID) comparisons for scope_id
        // Sales table might have scope_id as either branch name (string) or branch ID (number)
        whereConditions.push(`(
          s.scope_type = 'BRANCH' AND (
            CAST(s.scope_id AS CHAR) COLLATE utf8mb4_bin = CAST(? AS CHAR) COLLATE utf8mb4_bin OR 
            CAST(s.scope_id AS UNSIGNED) = ? OR
            CAST(s.scope_id AS CHAR) COLLATE utf8mb4_bin = CAST(? AS CHAR) COLLATE utf8mb4_bin
          )
        )`);
        params.push(userBranchName, userBranchId, String(userBranchId));
        
      } else if (userBranchName) {
        // Fallback: only branch name available
        whereConditions.push(`(
          s.scope_type = 'BRANCH' AND (
            CAST(s.scope_id AS CHAR) COLLATE utf8mb4_bin = CAST(? AS CHAR) COLLATE utf8mb4_bin
          )
        )`);
        params.push(userBranchName);
        
      } else {
        whereConditions.push('s.scope_type = ?');
        params.push('BRANCH');
        
      }
    } else if (req.user.role === 'WAREHOUSE_KEEPER') {
      // Filter by warehouse - get warehouse name if not already available
      let userWarehouseName = req.user.warehouseName;
      let userWarehouseId = req.user.warehouseId;
      
      if (!userWarehouseName && userWarehouseId) {
        const [warehouses] = await pool.execute('SELECT name FROM warehouses WHERE id = ?', [userWarehouseId]);
        if (warehouses.length > 0) {
          userWarehouseName = warehouses[0].name;
        }
      }
      
      if (userWarehouseName) {
        // Filter by warehouse name and ID (handle both string and number comparisons)
        whereConditions.push(`(
          s.scope_type = 'WAREHOUSE' AND (
            CAST(s.scope_id AS CHAR) COLLATE utf8mb4_bin = CAST(? AS CHAR) COLLATE utf8mb4_bin
            OR s.scope_id = ?
            OR s.scope_id = ?
          )
        )`);
        params.push(userWarehouseName, String(userWarehouseId || ''), userWarehouseId);
        
      } else if (userWarehouseId) {
        // Fallback: only warehouse ID available
        whereConditions.push(`(
          s.scope_type = 'WAREHOUSE' AND (
            s.scope_id = ?
            OR s.scope_id = ?
          )
        )`);
        params.push(String(userWarehouseId), userWarehouseId);
        
      } else {
        // No warehouse info available, only filter by type
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
      // If neither scopeType nor scopeId is provided, show all sales (no scope filtering)
    }

    if (startDate) {
      whereConditions.push('s.created_at >= ?');
      params.push(startDate);
    }

    if (endDate) {
      whereConditions.push('s.created_at <= ?');
      params.push(endDate);
    }

    if (paymentMethod) {
      whereConditions.push('s.payment_method = ?');
      params.push(paymentMethod);
    }

    if (status) {
      whereConditions.push('s.status = ?');
      params.push(status);
    }

    if (retailerId && retailerId !== 'all') {
      whereConditions.push('JSON_EXTRACT(s.customer_info, "$.id") = ?');
      params.push(retailerId);
    }

    if (customerPhone) {
      whereConditions.push('s.customer_phone = ?');
      params.push(customerPhone);
    }

    if (customerName) {
      whereConditions.push('s.customer_name LIKE ?');
      params.push(`%${customerName}%`);
    }

    if (creditStatus) {
      whereConditions.push('s.credit_status = ?');
      params.push(creditStatus);
    }

    if (paymentStatus) {
      whereConditions.push('s.payment_status = ?');
      params.push(paymentStatus);
    }

    if (search && String(search).trim()) {
      const term = `%${String(search).trim()}%`;
      whereConditions.push(
        '(s.invoice_no LIKE ? OR s.customer_name LIKE ? OR s.customer_phone LIKE ? OR CAST(s.id AS CHAR) LIKE ?)'
      );
      params.push(term, term, term, term);
    }

    // Admin scope search by branch/warehouse name or id
    if (scopeSearch && req.user.role === 'ADMIN') {
      const term = `%${scopeSearch}%`;
      whereConditions.push(`
        (
          s.scope_id LIKE ?
          OR (
            s.scope_type = 'BRANCH' AND EXISTS (
              SELECT 1 FROM branches b
              WHERE b.id = s.scope_id OR b.name LIKE ?
            )
          )
          OR (
            s.scope_type = 'WAREHOUSE' AND EXISTS (
              SELECT 1 FROM warehouses w
              WHERE w.id = s.scope_id OR w.name LIKE ?
            )
          )
        )
      `);
      params.push(term, term, term);
    }

    const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

    // Total count for pagination
    const [countRows] = await pool.execute(`
      SELECT COUNT(*) as total
      FROM sales s
      ${whereClause}
    `, params);
    const totalCount = countRows?.[0]?.total || 0;

    // Summary aggregates across all matching rows (not limited by pagination)
    const [summaryRows] = await pool.execute(`
      SELECT 
        COUNT(*) as totalTransactions,
        COALESCE(SUM(s.total), 0) as totalSales,
        SUM(CASE WHEN s.payment_status = 'COMPLETED' THEN 1 ELSE 0 END) as completedSales,
        COALESCE(SUM(CASE WHEN s.payment_status = 'COMPLETED' THEN s.total ELSE 0 END), 0) as completedSalesAmount
      FROM sales s
      ${whereClause}
    `, params);

    const summaryRow = summaryRows?.[0] || {};
    const summary = {
      totalSales: Math.abs(Number(summaryRow.totalSales || 0)),
      totalTransactions: Number(summaryRow.totalTransactions || 0),
      completedSales: Number(summaryRow.completedSales || 0),
      averageOrderValue: summaryRow.completedSales
        ? Math.abs(Number(summaryRow.completedSalesAmount || 0)) / Number(summaryRow.completedSales || 1)
        : 0
    };

    const [sales] = await pool.execute(`
      SELECT 
        s.*,
        u.username,
        u.email,
        b.name as branch_name,
        w.name as warehouse_name
      FROM sales s
      LEFT JOIN users u ON s.user_id = u.id
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
      ORDER BY s.created_at DESC
      LIMIT ? OFFSET ?
    `, [...params, parsedLimit, offset]);

    let salesForList = sales;
    if (await isLedgerMigrationComplete(pool)) {
      salesForList = await mergeSaleRowsWithSnapshotBalances(pool, sales);
    }

    if (salesForList.length > 0) {
    }

    // Debug: Log payment method values

    

    // Get sales items for each sale
    const salesWithItems = await Promise.all(salesForList.map(async (sale) => {
      const [items] = await pool.execute(`
        SELECT 
          si.*,
          ii.name as item_name,
          ii.sku,
          ii.selling_price as catalog_price,
          ii.cost_price,
          ii.category
        FROM sale_items si
        LEFT JOIN inventory_items ii ON si.inventory_item_id = ii.id
        WHERE si.sale_id = ?
        ORDER BY si.id
      `, [sale.id]);

      // Parse customer_info and enrich with salesperson name if missing
      let customerInfo = sale.customer_info ? JSON.parse(sale.customer_info) : null;
      
      // If customerInfo has salesperson with ID but no name, fetch the name from database
      if (customerInfo && customerInfo.salesperson && customerInfo.salesperson.id && !customerInfo.salesperson.name) {
        try {
          const [salespersonRows] = await pool.execute(
            'SELECT name, phone FROM salespeople WHERE id = ?',
            [customerInfo.salesperson.id]
          );
          if (salespersonRows.length > 0) {
            customerInfo.salesperson.name = salespersonRows[0].name || null;
            customerInfo.salesperson.phone = customerInfo.salesperson.phone || salespersonRows[0].phone || null;
          }
        } catch (error) {
        }
      }
      
      const saleData = {
        ...sale,
        customerInfo: customerInfo,
        items: items.map(item => ({
          id: item.id,
          inventoryItemId: item.inventory_item_id,
          itemName: item.item_name,
          name: item.item_name, // For compatibility
          sku: item.sku,
          quantity: item.quantity,
          unitPrice: parseFloat(item.unit_price) || 0,
          originalPrice: parseFloat(item.original_price) || 0,
          discount: parseFloat(item.discount) || 0,
          discountType: item.discount_type || 'amount',
          total: parseFloat(item.total) || 0,
          category: item.category
        }))
      };
      
      return saleData;
    }));

    res.json({
      success: true,
      count: totalCount,
      page: parsedPage,
      limit: parsedLimit,
      totalPages: Math.max(1, Math.ceil(totalCount / parsedLimit)),
      summary,
      data: salesWithItems
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error retrieving sales',
      error: error.message,
      sqlError: error.sqlMessage || null
    });
  }
};

// @desc    Get single sale
// @route   GET /api/sales/:id
// @access  Private (Admin, Cashier)
const getSale = async (req, res, next) => {
  try {
    const { id } = req.params;

    const sale = await Sale.findById(id);
    if (!sale) {
      return res.status(404).json({
        success: false,
        message: 'Sale not found'
      });
    }

    // Check access permissions
    if (req.user.role !== 'ADMIN') {
      // For cashiers, get branch name if not already available
      let userBranchName = req.user.branchName;
      if (req.user.role === 'CASHIER' && !userBranchName && req.user.branchId) {
        const [branches] = await pool.execute('SELECT name FROM branches WHERE id = ?', [req.user.branchId]);
        userBranchName = branches[0]?.name || null;
      }
      
      if (req.user.role === 'CASHIER' && 
          (sale.scopeType !== 'BRANCH' || sale.scopeId !== userBranchName)) {
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
          (sale.scopeType !== 'WAREHOUSE' || sale.scopeId !== userWarehouseName)) {
        return res.status(403).json({
          success: false,
          message: 'Access denied'
        });
      }
    }

    // Get sale items
    const saleItems = await Sale.getSaleItems(id);

    // Debug: Log the sale data being returned

    if (await isLedgerMigrationComplete(pool)) {
      sale.financialSource = 'invoice_snapshots';
      const [snapRows] = await pool.execute(
        'SELECT old_balance, final_balance, total, payment FROM invoice_snapshots WHERE sale_id = ? LIMIT 1',
        [id]
      );
      if (snapRows.length) {
        sale.oldBalance = parseFloat(snapRows[0].old_balance) || 0;
        sale.runningBalance = parseFloat(snapRows[0].final_balance) || 0;
        sale.snapshotTotal = parseFloat(snapRows[0].total);
        sale.snapshotPayment = parseFloat(snapRows[0].payment);
        sale.paymentAmount = Number.isFinite(sale.snapshotPayment) ? sale.snapshotPayment : sale.paymentAmount;
        sale.creditAmount = null;
      } else {
        sale.oldBalance = null;
        sale.runningBalance = null;
        sale.snapshotTotal = null;
        sale.snapshotPayment = null;
        sale.paymentAmount = null;
        sale.creditAmount = null;
      }
    }

    res.json({
      success: true,
      data: {
        ...sale,
        items: saleItems
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error retrieving sale',
      error: error.message
    });
  }
};

const updateSale = async (req, res, next) => {
  let connection;
  
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
    const { 
      items, 
      inventoryChanges, 
      paymentMethod, 
      paymentAmount, 
      creditAmount, 
      total, 
      subtotal, 
      tax, 
      discount,
      notes, 
      status, 
      paymentStatus,
      customerInfo,
      customerName,
      customerPhone
    } = updateData;

    // Get connection
    connection = await pool.getConnection();
    
    // Get sale with all details
    const [saleRows] = await connection.execute(`
      SELECT s.*, 
        s.customer_name, 
        s.customer_phone, 
        s.scope_type, 
        s.scope_id,
        s.payment_method,
        s.payment_amount,
        s.credit_amount,
        s.old_balance,
        s.running_balance,
        s.total as sale_total,
        s.subtotal as sale_subtotal,
        s.tax as sale_tax,
        s.discount as sale_discount
      FROM sales s WHERE id = ? AND s.deleted_at IS NULL`, 
      [id]
    );
    
    if (saleRows.length === 0) {
      connection.release();
      return res.status(404).json({
        success: false,
        message: 'Sale not found'
      });
    }

    const sale = saleRows[0];
    const ledgerMigrationDone = await isLedgerMigrationComplete(connection);

    let openingOldForLedger = null;
    if (ledgerMigrationDone) {
      const [preSnaps] = await connection.execute(
        'SELECT old_balance FROM invoice_snapshots WHERE sale_id = ? LIMIT 1',
        [id]
      );
      if (preSnaps.length) {
        openingOldForLedger = parseFloat(preSnaps[0].old_balance);
      } else {
        const bal = await CustomerLedgerEntries.getCustomerBalance(connection, {
          scopeType: sale.scope_type,
          scopeId: sale.scope_id,
          retailerId: sale.retailer_id,
          customerName: sale.customer_name,
          customerPhone: sale.customer_phone,
        });
        const { debit, credit } = CustomerLedgerEntries.debitCreditForSaleRow(sale);
        openingOldForLedger = bal - (debit - credit);
      }
    }

    // Start transaction
    await connection.beginTransaction();

    try {
      // ✅ FIX: Read OLD sale items BEFORE deleting them
      // This is used to restore stock correctly regardless of frontend inventoryChanges
      const [oldSaleItems] = await connection.execute(
        'SELECT id, inventory_item_id, quantity FROM sale_items WHERE sale_id = ?',
        [id]
      );

      // 2. Update sale items if provided
      let finalSubtotal = parseFloat(subtotal) || parseFloat(sale.sale_subtotal) || 0;
      let finalTotal = parseFloat(total) || parseFloat(sale.sale_total) || 0;
      
      if (items && Array.isArray(items) && items.length > 0) {

        for (const oldItem of oldSaleItems) {
          if (!oldItem.inventory_item_id) continue;
          const oldQty = parseFloat(oldItem.quantity) || 0;
          if (oldQty <= 0) continue;
          const [scopeRows0] = await connection.execute(
            'SELECT scope_type, scope_id FROM inventory_items WHERE id = ?',
            [oldItem.inventory_item_id]
          );
          if (!scopeRows0.length) continue;
          await InventoryProjection.applyEvent(connection, {
            event_type: 'RESTOCK',
            inventory_item_id: oldItem.inventory_item_id,
            scope_type: normalizeScope(scopeRows0[0].scope_type),
            scope_id: String(scopeRows0[0].scope_id != null ? scopeRows0[0].scope_id : ''),
            quantity_in: oldQty,
            quantity_out: 0,
            reference_type: 'sale_edit_old',
            reference_id: `${id}:${oldItem.id}`,
            created_by: req.user.id,
          });
        }
        
        // Delete existing sale_items
        await connection.execute('DELETE FROM sale_items WHERE sale_id = ?', [id]);
        
        // Calculate new subtotal from items
        finalSubtotal = 0;
        for (const item of items) {
          const itemQuantity = parseFloat(item.quantity) || 0;
          const itemUnitPrice = parseFloat(item.unitPrice) || parseFloat(item.unit_price) || 0;
          const itemDiscount = parseFloat(item.discount) || 0;
          const itemTotal = (itemQuantity * itemUnitPrice) - itemDiscount;
          
          const [insRow] = await connection.execute(`
            INSERT INTO sale_items (
              sale_id, inventory_item_id, sku, name, quantity, 
              unit_price, discount, discount_type, total, original_price, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
          `, [
            id,
            item.inventoryItemId || item.inventory_item_id,
            item.sku,
            item.name || item.itemName,
            itemQuantity,
            itemUnitPrice,
            itemDiscount,
            item.discountType || 'amount',
            itemTotal,
            item.originalPrice || itemUnitPrice
          ]);
          const newSaleItemId = insRow.insertId;

          const invId = item.inventoryItemId || item.inventory_item_id;
          if (invId && itemQuantity > 0) {
            const [scopeRows] = await connection.execute(
              'SELECT scope_type, scope_id FROM inventory_items WHERE id = ?',
              [invId]
            );
            if (scopeRows.length) {
              await InventoryProjection.applyEvent(connection, {
                event_type: 'SALE',
                inventory_item_id: invId,
                scope_type: normalizeScope(scopeRows[0].scope_type),
                scope_id: String(scopeRows[0].scope_id != null ? scopeRows[0].scope_id : ''),
                quantity_in: 0,
                quantity_out: itemQuantity,
                reference_type: 'sale',
                reference_id: `${id}:${newSaleItemId}`,
                created_by: req.user.id,
              });
            }
          }
          
          finalSubtotal += itemTotal;
        }
        
        // Calculate final total
        finalTotal = finalSubtotal + (parseFloat(tax) || 0) - (parseFloat(discount) || 0);
        

        // ✅ FIX: Delete old stock_reports entries and re-insert correct ones
        
        // Step 1: Delete old SALE entries for this sale
        await connection.execute(
          'DELETE FROM stock_reports WHERE sale_id = ? AND transaction_type = ?',
          [id, 'SALE']
        );
        
        // Step 2: Re-insert correct entries based on updated sale_items
        for (const item of items) {
          const itemId = item.inventoryItemId || item.inventory_item_id;
          if (!itemId) continue;
          
          const itemQty = parseFloat(item.quantity) || 0;
          const itemPrice = parseFloat(item.unitPrice) || parseFloat(item.unit_price) || 0;
          
          if (itemQty <= 0) continue;
          
          // Get current stock for tracking
          const [stockRows] = await connection.execute(
            'SELECT current_stock, name, sku, category, scope_type, scope_id FROM inventory_items WHERE id = ?',
            [itemId]
          );
          
          if (stockRows.length === 0) continue;
          
          const invItem = stockRows[0];
          
          // Get scope name
          let scopeName = invItem.scope_id;
          if (invItem.scope_type === 'WAREHOUSE') {
            const [wRows] = await connection.execute(
              'SELECT name FROM warehouses WHERE id = ? OR name = ? LIMIT 1',
              [invItem.scope_id, invItem.scope_id]
            );
            if (wRows.length > 0) scopeName = wRows[0].name;
          } else if (invItem.scope_type === 'BRANCH') {
            const [bRows] = await connection.execute(
              'SELECT name FROM branches WHERE id = ? OR name = ? LIMIT 1',
              [invItem.scope_id, invItem.scope_id]
            );
            if (bRows.length > 0) scopeName = bRows[0].name;
          }
          
          const currentStock = parseFloat(invItem.current_stock) || 0;
          
          await connection.execute(`
            INSERT INTO stock_reports (
              inventory_item_id, item_name, item_sku, item_category,
              scope_type, scope_id, scope_name,
              transaction_type, quantity_change, previous_quantity, new_quantity,
              sale_id, unit_price, total_value,
              user_id, user_name, user_role, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
          `, [
            itemId,
            invItem.name,
            invItem.sku,
            invItem.category,
            invItem.scope_type,
            invItem.scope_id,
            scopeName,
            'SALE',
            -itemQty,
            currentStock + itemQty,
            currentStock,
            id,
            itemPrice,
            itemQty * itemPrice,
            req.user.id,
            req.user.name || req.user.username || 'system',
            req.user.role
          ]);
        }
        
      }

      // 3. Calculate payment amounts
      let finalPaymentAmount = parseFloat(paymentAmount);
      let finalCreditAmount = parseFloat(creditAmount);
      
      if (isNaN(finalPaymentAmount)) {
        finalPaymentAmount = parseFloat(sale.payment_amount) || 0;
      }
      
      if (isNaN(finalCreditAmount)) {
        finalCreditAmount = parseFloat(sale.credit_amount) || 0;
      }
      
      const finalPaymentMethod = paymentMethod || sale.payment_method;
      if (finalPaymentMethod === 'FULLY_CREDIT') {
        finalPaymentAmount = 0;
        finalCreditAmount = finalTotal;
      }
      

      const oldBalance = ledgerMigrationDone
        ? (Number.isFinite(openingOldForLedger) ? openingOldForLedger : 0)
        : (parseFloat(sale.old_balance) || 0);
      const runningBalance = oldBalance + finalCreditAmount - finalPaymentAmount;

      // 4. Determine payment status
      let finalPaymentStatus = paymentStatus;
      if (!finalPaymentStatus) {
        finalPaymentStatus = finalCreditAmount > 0 ? 'PENDING' : 'COMPLETED';
      }
      
      const finalCreditStatus = finalCreditAmount > 0 ? 'PENDING' : 'NONE';

      // 5. Update the sale (immutable ledger: do not persist running_balance — ledger is truth)
      const updateQuery = ledgerMigrationDone
        ? `
        UPDATE sales SET
          subtotal = ?,
          total = ?,
          tax = ?,
          discount = ?,
          payment_method = ?,
          payment_amount = ?,
          credit_amount = ?,
          payment_status = ?,
          credit_status = ?,
          notes = ?,
          customer_name = ?,
          customer_phone = ?,
          customer_info = ?,
          updated_at = NOW()
        WHERE id = ?
      `
        : `
        UPDATE sales SET
          subtotal = ?,
          total = ?,
          tax = ?,
          discount = ?,
          payment_method = ?,
          payment_amount = ?,
          credit_amount = ?,
          running_balance = ?,
          payment_status = ?,
          credit_status = ?,
          notes = ?,
          customer_name = ?,
          customer_phone = ?,
          customer_info = ?,
          updated_at = NOW()
        WHERE id = ?
      `;

      const updateParams = ledgerMigrationDone
        ? [
            finalSubtotal,
            finalTotal,
            parseFloat(tax) || 0,
            parseFloat(discount) || 0,
            finalPaymentMethod,
            finalPaymentAmount,
            finalCreditAmount,
            finalPaymentStatus,
            finalCreditStatus,
            notes || sale.notes,
            customerName || sale.customer_name,
            customerPhone || sale.customer_phone,
            customerInfo ? JSON.stringify(customerInfo) : sale.customer_info,
            id
          ]
        : [
            finalSubtotal,
            finalTotal,
            parseFloat(tax) || 0,
            parseFloat(discount) || 0,
            finalPaymentMethod,
            finalPaymentAmount,
            finalCreditAmount,
            runningBalance,
            finalPaymentStatus,
            finalCreditStatus,
            notes || sale.notes,
            customerName || sale.customer_name,
            customerPhone || sale.customer_phone,
            customerInfo ? JSON.stringify(customerInfo) : sale.customer_info,
            id
          ];

      const [updateResult] = await connection.execute(updateQuery, updateParams);

      if (ledgerMigrationDone) {
        const [upRows] = await connection.execute('SELECT * FROM sales WHERE id = ?', [id]);
        if (upRows.length > 0) {
          const u = upRows[0];
          await CustomerLedgerEntries.appendFromSalesRow(connection, u);
          const balAfter = await CustomerLedgerEntries.getCustomerBalance(connection, {
            scopeType: u.scope_type,
            scopeId: u.scope_id,
            retailerId: u.retailer_id,
            customerName: u.customer_name,
            customerPhone: u.customer_phone,
          });
          const { debit, credit } = CustomerLedgerEntries.debitCreditForSaleRow(u);
          const oldSnap = balAfter - (debit - credit);
          await CustomerLedgerEntries.insertInvoiceSnapshot(connection, {
            sale_id: parseInt(id, 10),
            customer_id: u.customer_id,
            retailer_id: u.retailer_id,
            scope_type: u.scope_type,
            scope_id: u.scope_id,
            invoice_no: u.invoice_no,
            old_balance: oldSnap,
            total: u.total,
            payment: u.payment_amount,
            final_balance: balAfter,
          });

          const [itemRowsForGl] = await connection.execute(
            `SELECT si.*, ii.cost_price FROM sale_items si
             LEFT JOIN inventory_items ii ON si.inventory_item_id = ii.id
             WHERE si.sale_id = ?`,
            [id]
          );
          const { syncSaleGlFromRow } = require('../../services/saleLedgerSyncService');
          await syncSaleGlFromRow(connection, u, itemRowsForGl);
        }
      }

      // 6. Update subsequent transactions
      const customerIdentifier = customerName || sale.customer_name;
      const customerPhoneIdentifier = customerPhone || sale.customer_phone;
      
      if ((customerIdentifier || customerPhoneIdentifier) && !ledgerMigrationDone) {
        const { recalculateCustomerLedger } = require('../../services/ledgerRecalcService');
        await recalculateCustomerLedger({
          retailerId: null,
          customerPhone: customerPhoneIdentifier || null,
          customerName: customerIdentifier || null,
          scopeType: sale.scope_type,
          scopeName: sale.scope_id,
          connection,
        });
      }

      // 7. Update customer balance — customers table uses branch_id / warehouse_id (not scope_type)
      if (customerIdentifier || customerPhoneIdentifier) {
        const scopeType = sale.scope_type;
        const scopeId = sale.scope_id;
        let resolvedBranchId = null;
        let resolvedWarehouseId = null;
        const isNumericScopeId = (v) => v != null && /^\d+$/.test(String(v));

        if (scopeType === 'BRANCH') {
          if (isNumericScopeId(scopeId)) {
            resolvedBranchId = parseInt(scopeId, 10);
          } else if (scopeId) {
            const [branchRows] = await connection.execute(
              'SELECT id FROM branches WHERE name = ? LIMIT 1',
              [scopeId]
            );
            resolvedBranchId = branchRows[0]?.id || null;
          }
        } else if (scopeType === 'WAREHOUSE') {
          if (isNumericScopeId(scopeId)) {
            resolvedWarehouseId = parseInt(scopeId, 10);
          } else if (scopeId) {
            const [whRows] = await connection.execute(
              'SELECT id FROM warehouses WHERE name = ? LIMIT 1',
              [scopeId]
            );
            resolvedWarehouseId = whRows[0]?.id || null;
          }
        }

        let customerRows = [];
        const phone = customerPhoneIdentifier || null;
        const name = customerIdentifier || null;

        if (phone && resolvedBranchId) {
          [customerRows] = await connection.execute(
            'SELECT id FROM customers WHERE phone = ? AND branch_id = ? LIMIT 1',
            [phone, resolvedBranchId]
          );
        } else if (phone && resolvedWarehouseId) {
          [customerRows] = await connection.execute(
            'SELECT id FROM customers WHERE phone = ? AND warehouse_id = ? LIMIT 1',
            [phone, resolvedWarehouseId]
          );
        } else if (phone) {
          [customerRows] = await connection.execute(
            'SELECT id FROM customers WHERE phone = ? LIMIT 1',
            [phone]
          );
        } else if (name && resolvedBranchId) {
          [customerRows] = await connection.execute(
            'SELECT id FROM customers WHERE LOWER(TRIM(name)) = LOWER(TRIM(?)) AND branch_id = ? LIMIT 1',
            [name, resolvedBranchId]
          );
        } else if (name && resolvedWarehouseId) {
          [customerRows] = await connection.execute(
            'SELECT id FROM customers WHERE LOWER(TRIM(name)) = LOWER(TRIM(?)) AND warehouse_id = ? LIMIT 1',
            [name, resolvedWarehouseId]
          );
        }

        if (customerRows.length > 0) {
          const customerId = customerRows[0].id;
          const balForCustomer = ledgerMigrationDone
            ? await CustomerLedgerEntries.getCustomerBalance(connection, {
                scopeType: sale.scope_type,
                scopeId: sale.scope_id,
                retailerId: sale.retailer_id,
                customerName: customerName || sale.customer_name,
                customerPhone: customerPhone || sale.customer_phone,
              })
            : runningBalance;
          await connection.execute(
            'UPDATE customers SET current_balance = ?, updated_at = NOW() WHERE id = ?',
            [balForCustomer, customerId]
          );
        }
      }

      await connection.commit();

      // 8. Get updated sale
      const [updatedSaleRows] = await connection.execute(`
        SELECT s.*, u.username as user_name
        FROM sales s
        LEFT JOIN users u ON s.user_id = u.id
        WHERE s.id = ?`, 
        [id]
      );
      
      const [updatedItems] = await connection.execute(`
        SELECT si.*, ii.name as item_name, ii.sku
        FROM sale_items si
        LEFT JOIN inventory_items ii ON si.inventory_item_id = ii.id
        WHERE si.sale_id = ?`, 
        [id]
      );

      
      connection.release();

      let salePayload = updatedSaleRows[0];
      if (ledgerMigrationDone) {
        salePayload = await mergeSaleRowWithSnapshotBalances(pool, salePayload);
      }

      res.json({
        success: true,
        message: 'Sale updated successfully',
        data: {
          ...salePayload,
          items: updatedItems.map(item => ({
            ...item,
            itemName: item.item_name,
            unitPrice: item.unit_price,
            originalPrice: item.original_price
          }))
        }
      });
      
    } catch (error) {
      await connection.rollback();
      throw error;
    }
    
  } catch (error) {
    
    if (connection) {
      try {
        connection.release();
      } catch (releaseError) {
      }
    }
    
    res.status(400).json({
      success: false,
      message: error.message || 'Error updating sale',
      error: error.message
    });
  }
};

const deleteSale = async (req, res, next) => {
  const connection = await pool.getConnection();
  
  try {
    const { id } = req.params;

    // Permission checks run before the transaction starts — do NOT rollback here.
    if (req.user.role !== 'ADMIN') {
      if (req.user.role === 'CASHIER') {
        const [saleRows] = await connection.execute('SELECT * FROM sales WHERE id = ? AND deleted_at IS NULL', [id]);
        if (saleRows.length === 0) {
          connection.release();
          return res.status(404).json({ success: false, message: 'Sale not found' });
        }
        const sale = saleRows[0];
        if (sale.user_id !== req.user.id) {
          connection.release();
          return res.status(403).json({ success: false, message: 'You can only delete your own sales' });
        }
        const Branch = require('../../models/Branch');
        const branchSettings = await Branch.getSettings(sale.scope_id);
        if (!branchSettings?.allowCashierSalesDelete) {
          connection.release();
          return res.status(403).json({ success: false, message: 'You do not have permission to delete sales. Contact your administrator.' });
        }
      } else {
        connection.release();
        return res.status(403).json({ success: false, message: 'Access denied' });
      }
    }

    await connection.beginTransaction();

    // Get sale and sale items in the same transaction (if not already fetched)
    let saleRows;
    if (req.user.role === 'ADMIN') {
      [saleRows] = await connection.execute('SELECT * FROM sales WHERE id = ? AND deleted_at IS NULL', [id]);
      if (saleRows.length === 0) {
        await connection.rollback();
        return res.status(404).json({
          success: false,
          message: 'Sale not found'
        });
      }
    }

    const [saleRowsForDelete] = await connection.execute(
      'SELECT * FROM sales WHERE id = ? AND deleted_at IS NULL',
      [id]
    );
    const saleRow = saleRowsForDelete[0];

    const [saleItemRows] = await connection.execute('SELECT * FROM sale_items WHERE sale_id = ?', [id]);

    const { removeSaleFromLedgers } = require('../../services/saleLedgerSyncService');
    if (saleRow) {
      await removeSaleFromLedgers(connection, parseInt(id, 10), saleRow);
    }
    
    for (const row of saleItemRows) {
      if (!row.inventory_item_id) continue;
      const qty = parseFloat(row.quantity) || 0;
      if (qty <= 0) continue;
      const [scopeRows] = await connection.execute(
        'SELECT scope_type, scope_id FROM inventory_items WHERE id = ?',
        [row.inventory_item_id]
      );
      if (!scopeRows.length) continue;
      await InventoryProjection.applyEvent(connection, {
        event_type: 'RESTOCK',
        inventory_item_id: row.inventory_item_id,
        scope_type: normalizeScope(scopeRows[0].scope_type),
        scope_id: String(scopeRows[0].scope_id != null ? scopeRows[0].scope_id : ''),
        quantity_in: qty,
        quantity_out: 0,
        reference_type: 'sale_delete',
        reference_id: `${id}:${row.id}`,
        created_by: req.user.id,
      });
    }

    // Delete sale items first (due to foreign key constraints)
    await connection.execute('DELETE FROM sale_items WHERE sale_id = ?', [id]);

    // Delete the sale
    // Inline trash operations inside the same transaction so rollback covers everything.
    await connection.execute(
      `INSERT INTO trash (entity_type, entity_id, entity_data, deleted_by, deleted_at, expires_at, is_expired)
       VALUES ('sale', ?, ?, ?, NOW(), DATE_ADD(NOW(), INTERVAL 6 MONTH), 0)`,
      [id, JSON.stringify(saleRow || {}), req.user.id]
    );
    await connection.execute('UPDATE sales SET deleted_at = NOW() WHERE id = ?', [id]);

    await connection.commit();

    res.json({
      success: true,
      message: 'Moved to trash'
    });
  } catch (error) {
    await connection.rollback();
    res.status(500).json({
      success: false,
      message: 'Error deleting sale',
      error: error.message
    });
  } finally {
    connection.release();
  }
};

module.exports = {
  getSales,
  getSale,
  updateSale,
  deleteSale,
};
