const { pool } = require('../config/database');
const { ledgerScopedQuantitySubquery } = require('../services/inventoryLedgerService');

// Get dashboard analytics data
const getDashboardAnalytics = async (req, res) => {
  try {
    // Initialize dashboard data
    let dashboardData = {
      totalSales: 0,
      totalOrders: 0,
      totalCustomers: 0,
      totalProducts: 0,
      branches: 0,
      warehouses: 0
    }

    // Build role-based filtering conditions
    const scopeTypeParam = req.query.scopeType ? req.query.scopeType.toUpperCase() : null
    const scopeIdParam = req.query.scopeId || null
    let salesWhereClause = ''
    let inventoryWhereClause = ''
    let salesParams = []
    let inventoryParams = []

    if (scopeTypeParam && scopeIdParam) {
      // Explicit scope from query overrides defaults (used by dashboards for scoped counts)
      inventoryWhereClause = 'WHERE scope_type = ? AND scope_id = ?'
      inventoryParams = [scopeTypeParam, scopeIdParam]
    } else if (req.user.role === 'CASHIER') {
      // Cashiers see only their branch data for sales
      salesWhereClause = 'AND s.scope_type = ? AND s.scope_id = ?'
      salesParams = ['BRANCH', req.user.branchId]
      // Cashiers: scope inventory to their branch
      inventoryWhereClause = 'WHERE scope_type = ? AND scope_id = ?'
      inventoryParams = ['BRANCH', req.user.branchId]
    } else if (req.user.role === 'WAREHOUSE_KEEPER') {
      // Warehouse keepers see only their warehouse data
      salesWhereClause = 'AND s.scope_type = ? AND s.scope_id = ?'
      salesParams = ['WAREHOUSE', req.user.warehouseId]
      inventoryWhereClause = 'WHERE scope_type = ? AND scope_id = ?'
      inventoryParams = ['WAREHOUSE', req.user.warehouseId]
    }
    // Admins see all data (no additional filtering)

    // Get total sales (this month) - using sales table directly
    try {
      const [salesResult] = await pool.execute(`
        SELECT COALESCE(SUM(s.total), 0) as total_sales
        FROM sales s
        WHERE MONTH(s.created_at) = MONTH(CURDATE()) 
        AND YEAR(s.created_at) = YEAR(CURDATE())
        AND s.status = 'COMPLETED'
        ${salesWhereClause}
      `, salesParams)
      
      dashboardData.totalSales = parseFloat(salesResult[0]?.total_sales || 0)
    } catch (error) {
      dashboardData.totalSales = 0
    }

    // Get total orders (this month) - using sales table directly
    try {
      const [ordersResult] = await pool.execute(`
        SELECT COUNT(*) as total_orders
        FROM sales s
        WHERE MONTH(s.created_at) = MONTH(CURDATE()) 
        AND YEAR(s.created_at) = YEAR(CURDATE())
        AND s.status = 'COMPLETED'
        ${salesWhereClause}
      `, salesParams)
      
      dashboardData.totalOrders = parseInt(ordersResult[0]?.total_orders || 0)
    } catch (error) {
      dashboardData.totalOrders = 0
    }

    // Get total customers - using customers table directly
    try {
      const [customersResult] = await pool.execute(`
        SELECT COUNT(*) as total_customers
        FROM customers c
        WHERE c.status = 'ACTIVE'
        ${req.user.role === 'CASHIER' ? 'AND c.branch_id = ?' : ''}
        ${req.user.role === 'WAREHOUSE_KEEPER' ? 'AND c.warehouse_id = ?' : ''}
      `, req.user.role === 'CASHIER' ? [req.user.branchId] : 
         req.user.role === 'WAREHOUSE_KEEPER' ? [req.user.warehouseId] : [])
      
      dashboardData.totalCustomers = parseInt(customersResult[0]?.total_customers || 0)
    } catch (error) {
      dashboardData.totalCustomers = 0
    }

    // Get total products/inventory
    try {
      const [productsResult] = await pool.execute(`
        SELECT COUNT(*) as total_products
        FROM inventory_items
        ${inventoryWhereClause}
      `, inventoryParams)
      
      dashboardData.totalProducts = parseInt(productsResult[0]?.total_products || 0)
    } catch (error) {
      dashboardData.totalProducts = 0
    }

    // Get branches count (only for admins)
    if (req.user.role === 'ADMIN') {
      try {
        const [branchesResult] = await pool.execute(`
          SELECT COUNT(*) as total_branches
          FROM branches
        `)
        
        dashboardData.branches = parseInt(branchesResult[0]?.total_branches || 0)
      } catch (error) {
        dashboardData.branches = 0
      }
    }

    // Get warehouses count (only for admins)
    if (req.user.role === 'ADMIN') {
      try {
        const [warehousesResult] = await pool.execute(`
          SELECT COUNT(*) as total_warehouses
          FROM warehouses
        `)
        
        dashboardData.warehouses = parseInt(warehousesResult[0]?.total_warehouses || 0)
      } catch (error) {
        dashboardData.warehouses = 0
      }
    }

    res.json({
      success: true,
      message: 'Dashboard analytics retrieved successfully',
      data: dashboardData
    })
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve dashboard analytics',
      error: error.message
    })
  }
}

// Get dashboard summary for quick stats
const getDashboardSummary = async (req, res) => {
  try {
    const summary = {
      totalSales: 0,
      totalOrders: 0,
      totalCustomers: 0,
      totalProducts: 0,
      lowStockItems: 0,
      pendingTransfers: 0,
      branches: 0,
      warehouses: 0
    }

    // Build role-based filtering conditions
    let salesWhereClause = ''
    let inventoryWhereClause = ''
    let salesParams = []
    let inventoryParams = []

    if (req.user.role === 'CASHIER') {
      // Cashiers see only their branch data for sales
      salesWhereClause = 'AND s.scope_type = ? AND s.scope_id = ?'
      salesParams = ['BRANCH', req.user.branchId]
      // Cashiers can see ALL branch inventory (not just their own branch)
      inventoryWhereClause = 'WHERE scope_type = ?'
      inventoryParams = ['BRANCH']
    } else if (req.user.role === 'WAREHOUSE_KEEPER') {
      // Warehouse keepers see only their warehouse data
      salesWhereClause = 'AND s.scope_type = ? AND s.scope_id = ?'
      salesParams = ['WAREHOUSE', req.user.warehouseId]
      inventoryWhereClause = 'WHERE scope_type = ? AND scope_id = ?'
      inventoryParams = ['WAREHOUSE', req.user.warehouseId]
    }
    // Admins see all data (no additional filtering)

    const LQ = ledgerScopedQuantitySubquery();
    let lowStockQuery;
    let lowStockParams;
    if (req.user.role === 'CASHIER') {
      lowStockQuery = `SELECT COUNT(*) as value FROM inventory_items i
        LEFT JOIN ${LQ} l ON l.inventory_item_id = i.id
        WHERE i.scope_type = ? AND COALESCE(l.ledger_qty, 0) <= i.min_stock_level`;
      lowStockParams = ['BRANCH'];
    } else if (req.user.role === 'WAREHOUSE_KEEPER') {
      lowStockQuery = `SELECT COUNT(*) as value FROM inventory_items i
        LEFT JOIN ${LQ} l ON l.inventory_item_id = i.id
        WHERE i.scope_type = ? AND i.scope_id = ? AND COALESCE(l.ledger_qty, 0) <= i.min_stock_level`;
      lowStockParams = ['WAREHOUSE', req.user.warehouseId];
    } else {
      lowStockQuery = `SELECT COUNT(*) as value FROM inventory_items i
        LEFT JOIN ${LQ} l ON l.inventory_item_id = i.id
        WHERE COALESCE(l.ledger_qty, 0) <= i.min_stock_level`;
      lowStockParams = [];
    }

    // Quick queries for summary data
    const queries = [
      { 
        key: 'totalSales', 
        query: `SELECT COALESCE(SUM(s.total), 0) as value 
                FROM sales s
                WHERE MONTH(s.created_at) = MONTH(CURDATE()) 
                AND YEAR(s.created_at) = YEAR(CURDATE())
                AND s.status = 'COMPLETED'
                ${salesWhereClause}`,
        params: salesParams
      },
      { 
        key: 'totalOrders', 
        query: `SELECT COUNT(*) as value 
                FROM sales s
                WHERE MONTH(s.created_at) = MONTH(CURDATE()) 
                AND YEAR(s.created_at) = YEAR(CURDATE())
                AND s.status = 'COMPLETED'
                ${salesWhereClause}`,
        params: salesParams
      },
      { 
        key: 'totalCustomers', 
        query: `SELECT COUNT(*) as value 
                FROM customers c
                WHERE c.status = 'ACTIVE'
                ${req.user.role === 'CASHIER' ? 'AND c.branch_id = ?' : ''}
                ${req.user.role === 'WAREHOUSE_KEEPER' ? 'AND c.warehouse_id = ?' : ''}`,
        params: req.user.role === 'CASHIER' ? [req.user.branchId] : 
                req.user.role === 'WAREHOUSE_KEEPER' ? [req.user.warehouseId] : []
      },
      { 
        key: 'totalProducts', 
        query: `SELECT COUNT(*) as value FROM inventory_items ${inventoryWhereClause}`,
        params: inventoryParams
      },
      {
        key: 'scopeProductCount',
        query: `SELECT COUNT(*) as value FROM inventory_items ${inventoryWhereClause}`,
        params: inventoryParams
      },
      {
        key: 'lowStockItems',
        query: lowStockQuery,
        params: lowStockParams,
      },
      { 
        key: 'pendingTransfers', 
        query: `SELECT COUNT(*) as value FROM transfers 
                WHERE status = 'PENDING'
                ${req.user.role === 'WAREHOUSE_KEEPER' ? 'AND from_warehouse_id = ?' : ''}
                ${req.user.role === 'CASHIER' ? 'AND to_branch_id = ?' : ''}`,
        params: req.user.role === 'WAREHOUSE_KEEPER' ? [req.user.warehouseId] : 
                req.user.role === 'CASHIER' ? [req.user.branchId] : []
      },
      { 
        key: 'branches', 
        query: `SELECT COUNT(*) as value FROM branches`,
        params: []
      },
      { 
        key: 'warehouses', 
        query: `SELECT COUNT(*) as value FROM warehouses`,
        params: []
      }
    ]

    for (const { key, query, params } of queries) {
      try {
        const [result] = await pool.execute(query, params)
        summary[key] = key === 'totalSales' ? parseFloat(result[0]?.value || 0) : parseInt(result[0]?.value || 0)
      } catch (error) {
        summary[key] = 0
      }
    }

    res.json({
      success: true,
      message: 'Dashboard summary retrieved successfully',
      data: summary
    })

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve dashboard summary',
      error: error.message
    })
  }
}

module.exports = {
  getDashboardAnalytics,
  getDashboardSummary
}