'use strict';

const { pool } = require('../../config/database');

// @desc    Search products by name or SKU
// @route   GET /api/sales/products/search
// @access  Private (Admin, Cashier, Warehouse Keeper)
const searchProducts = async (req, res, next) => {
  try {
    const { q, limit = 10 } = req.query;
    
    if (!q || q.trim().length < 2) {
      return res.status(400).json({
        success: false,
        message: 'Search query must be at least 2 characters'
      });
    }
    
    // Build WHERE conditions for role-based access
    let whereConditions = ['(name LIKE ? OR sku LIKE ?)'];
    let params = [`%${q}%`, `%${q}%`];
    
    // Apply role-based filtering
    if (req.user.role === 'CASHIER') {
      // Cashiers can only see products from their branch
      const userBranchId = req.user.branch_id || req.user.branchId;
      if (userBranchId) {
        whereConditions.push('scope_type = ? AND scope_id = ?');
        params.push('BRANCH', userBranchId);
      } else {
        // If no branch ID, show no products
        whereConditions.push('1 = 0');
      }
    } else if (req.user.role === 'WAREHOUSE_KEEPER') {
      // Warehouse keepers can only see products from their warehouse
      const userWarehouseId = req.user.warehouse_id || req.user.warehouseId;
      if (userWarehouseId) {
        whereConditions.push('scope_type = ? AND scope_id = ?');
        params.push('WAREHOUSE', userWarehouseId);
      } else {
        // If no warehouse ID, show no products
        whereConditions.push('1 = 0');
      }
    }
    // Admin can see all products (no additional scope filtering)
    
    const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';
    
    const [products] = await pool.execute(`
      SELECT 
        id,
        name,
        sku,
        selling_price,
        cost_price,
        current_stock,
        category,
        scope_type,
        scope_id
      FROM inventory_items 
      ${whereClause}
      ORDER BY 
        CASE 
          WHEN name = ? THEN 1
          WHEN sku = ? THEN 2
          WHEN name LIKE ? THEN 3
          WHEN sku LIKE ? THEN 4
          ELSE 5
        END,
        name ASC
      LIMIT ?
    `, [
      ...params,
      q, q, 
      `${q}%`, `${q}%`, 
      parseInt(limit)
    ]);
    
    res.json({
      success: true,
      data: products.map(product => ({
        id: product.id,
        name: product.name,
        sku: product.sku,
        sellingPrice: parseFloat(product.selling_price) || 0,
        costPrice: parseFloat(product.cost_price) || 0,
        currentStock: parseFloat(product.current_stock) || 0,
        category: product.category,
        scopeType: product.scope_type,
        scopeId: product.scope_id
      }))
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error searching products',
      error: error.message
    });
  }
};

// @desc    Search sales by invoice number or sale ID
// @route   GET /api/sales/search
// @access  Private (Admin, Cashier, Warehouse Keeper)
const searchSales = async (req, res, next) => {
  try {
    
    // Test database connection
    try {
      await pool.execute('SELECT 1');
    } catch (dbError) {
      throw new Error('Database connection failed');
    }
    
    const { invoiceNumber, saleId } = req.query;
    
    if (!invoiceNumber && !saleId) {
      return res.status(400).json({
        success: false,
        message: 'Invoice number or sale ID is required'
      });
    }

    let whereConditions = [];
    let params = [];

    // Search by invoice number or sale ID
    if (invoiceNumber) {
      whereConditions.push('(s.invoice_no LIKE ? OR s.id = ?)');
      params.push(`%${invoiceNumber}%`, invoiceNumber);
    } else if (saleId) {
      whereConditions.push('s.id = ?');
      params.push(saleId);
    }

    // Apply role-based filtering
    if (req.user.role === 'CASHIER') {
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
    }

    const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';
    
    // Check if sales table exists
    try {
      const [tables] = await pool.execute("SHOW TABLES LIKE 'sales'");
      if (tables.length === 0) {
        throw new Error('Sales table does not exist');
      }
      
    } catch (tableError) {
      throw new Error('Database table check failed');
    }
    

    // Get sales with items (simplified query without branches/warehouses joins)
    const [sales] = await pool.execute(`
      SELECT 
        s.*,
        u.username as user_name,
        u.role as user_role,
        s.scope_id as scope_name
      FROM sales s
      LEFT JOIN users u ON s.user_id = u.id
      ${whereClause}
      ORDER BY s.created_at DESC
      LIMIT 10
    `, params);
    

    // Get sales items for each sale
    const salesWithItems = await Promise.all(sales.map(async (sale) => {
      const [items] = await pool.execute(`
        SELECT 
          si.*,
          COALESCE(NULLIF(TRIM(si.name), ''), ii.name) AS item_name,
          COALESCE(NULLIF(TRIM(si.sku), ''), ii.sku) AS sku,
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
          itemName: item.item_name || item.name,
          name: item.item_name || item.name,
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
      count: salesWithItems.length,
      data: salesWithItems,
      debug: {
        version: 'V2.0',
        timestamp: new Date().toISOString(),
        fixedColumn: 'u.username instead of u.name'
      }
    });

  } catch (error) {
    
    res.status(500).json({
      success: false,
      message: 'Error searching sales',
      error: error.message,
      details: process.env.NODE_ENV === 'development' ? {
        stack: error.stack,
        code: error.code,
        sqlMessage: error.sqlMessage
      } : undefined
    });
  }
};

module.exports = {
  searchProducts,
  searchSales,
};
