const { pool } = require('../config/database');

// @desc    Get stock reports
// @route   GET /api/stock-reports
// @access  Private (Admin, Warehouse Keeper, Cashier)
const getStockReports = async (req, res) => {
  try {
    const user = req.user;
    const { 
      warehouse, 
      category, 
      status, 
      dateFrom, 
      dateTo,
      lowStock,
      outOfStock,
      page = 1,
      limit = 25,
      searchTerm,
      scopeType,
      scopeId,
      transactionType,
      itemCategory,
      startDate,
      endDate,
      userRole
    } = req.query;
    
    // Build query conditions — source of truth: inventory_ledger_entries + inventory_items scope
    let whereConditions = [];
    let params = [];

    if (user?.role === 'WAREHOUSE_KEEPER' && user?.warehouseId) {
      whereConditions.push(`(ii.scope_type = 'WAREHOUSE' AND (
        CAST(ii.scope_id AS UNSIGNED) = ? OR CAST(ii.scope_id AS CHAR) COLLATE utf8mb4_bin = CAST(? AS CHAR) COLLATE utf8mb4_bin
      ))`);
      params.push(user.warehouseId, String(user.warehouseId));
    } else if (user?.role === 'CASHIER' && user?.branchId) {
      whereConditions.push(`(ii.scope_type = 'BRANCH' AND (
        CAST(ii.scope_id AS UNSIGNED) = ? OR CAST(ii.scope_id AS CHAR) COLLATE utf8mb4_bin = CAST(? AS CHAR) COLLATE utf8mb4_bin
      ))`);
      params.push(user.branchId, String(user.branchId));
    }

    if (searchTerm) {
      whereConditions.push('(ii.name LIKE ? OR ii.sku LIKE ?)');
      params.push(`%${searchTerm}%`, `%${searchTerm}%`);
    }

    if (scopeType && scopeType !== 'all') {
      whereConditions.push('ii.scope_type = ?');
      params.push(scopeType);
    }

    if (scopeId && scopeId !== 'all') {
      const scopeIdNum = parseInt(scopeId, 10);
      whereConditions.push(`(
        CAST(ii.scope_id AS UNSIGNED) = ? OR CAST(ii.scope_id AS CHAR) COLLATE utf8mb4_bin = CAST(? AS CHAR) COLLATE utf8mb4_bin
      )`);
      params.push(Number.isFinite(scopeIdNum) ? scopeIdNum : 0, String(scopeId));
    }

    if (transactionType && transactionType !== 'all') {
      whereConditions.push('le.event_type = ?');
      params.push(transactionType);
    }

    if (itemCategory && itemCategory !== 'all') {
      whereConditions.push('ii.category = ?');
      params.push(itemCategory);
    }

    if (startDate) {
      whereConditions.push('COALESCE(le.entry_date, le.created_at) >= ?');
      params.push(startDate);
    }

    if (endDate) {
      whereConditions.push('COALESCE(le.entry_date, le.created_at) <= ?');
      params.push(endDate);
    }
    
    if (userRole && userRole !== 'all') {
      whereConditions.push('u.role = ?');
      params.push(userRole);
    }
    
    const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';
    const offset = (page - 1) * limit;
    
    
    const [transactions] = await pool.execute(`
      SELECT 
        le.id,
        le.inventory_item_id as inventoryItemId,
        le.event_type as transactionType,
        (le.quantity_in - le.quantity_out) as quantityChange,
        NULL as previousQuantity,
        NULL as newQuantity,
        le.unit_cost as unitPrice,
        (le.unit_cost * (le.quantity_in + le.quantity_out)) as totalValue,
        CONCAT(IFNULL(le.reference_type,''), ':', IFNULL(le.reference_id,'')) as adjustmentReason,
        COALESCE(le.entry_date, le.created_at) as createdAt,
        le.quantity_in as quantityIn,
        le.quantity_out as quantityOut,
        ii.name as itemName,
        ii.sku as itemSku,
        ii.category as itemCategory,
        ii.supplier_id as supplierId,
        ii.supplier_name as supplierName,
        ii.purchase_date as purchaseDate,
        ii.purchase_price as purchasePrice,
        ii.created_at as itemCreatedAt,
        c.name as supplierCompanyName,
        c.contact_person as supplierContact,
        c.phone as supplierPhone,
        c.email as supplierEmail,
        u.username as userName,
        u.role as userRole,
        ii.scope_type as scopeType,
        COALESCE(b.name, w.name, CAST(ii.scope_id AS CHAR)) as scopeName,
        b.name as branchName,
        w.name as warehouseName
      FROM inventory_ledger_entries le
      INNER JOIN inventory_items ii ON ii.id = le.inventory_item_id
        AND le.scope_type = ii.scope_type
        AND (CAST(le.scope_id AS CHAR) COLLATE utf8mb4_bin = CAST(ii.scope_id AS CHAR) COLLATE utf8mb4_bin)
      LEFT JOIN users u ON le.created_by = u.id
      LEFT JOIN companies c ON ii.supplier_id = c.id
      LEFT JOIN branches b ON ii.scope_type = 'BRANCH' AND (
        CAST(ii.scope_id AS UNSIGNED) = b.id OR CAST(ii.scope_id AS CHAR) COLLATE utf8mb4_bin = CAST(b.id AS CHAR) COLLATE utf8mb4_bin
      )
      LEFT JOIN warehouses w ON ii.scope_type = 'WAREHOUSE' AND (
        CAST(ii.scope_id AS UNSIGNED) = w.id OR CAST(ii.scope_id AS CHAR) COLLATE utf8mb4_bin = CAST(w.id AS CHAR) COLLATE utf8mb4_bin
      )
      ${whereClause}
      ORDER BY le.created_at DESC, le.id DESC
      LIMIT ? OFFSET ?
    `, [...params, parseInt(limit), offset]);

    const [countResult] = await pool.execute(`
      SELECT COUNT(*) as total
      FROM inventory_ledger_entries le
      INNER JOIN inventory_items ii ON ii.id = le.inventory_item_id
        AND le.scope_type = ii.scope_type
        AND (CAST(le.scope_id AS CHAR) COLLATE utf8mb4_bin = CAST(ii.scope_id AS CHAR) COLLATE utf8mb4_bin)
      LEFT JOIN users u ON le.created_by = u.id
      ${whereClause}
    `, params);
    
    const totalCount = countResult[0]?.total || 0;
    const totalPages = Math.ceil(totalCount / limit);
    
    // Debug: Log the transactions data to see what's being returned
    if (transactions.length > 0) {
    }
    
    res.json({
      success: true,
      data: transactions,
      pagination: {
        currentPage: parseInt(page),
        totalPages,
        totalCount,
        limit: parseInt(limit)
      }
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error retrieving stock reports',
      error: error.message
    });
  }
};

// @desc    Get stock report summary
// @route   GET /api/stock-reports/summary
// @access  Private (Admin, Warehouse Keeper, Cashier)
const getStockReportSummary = async (req, res) => {
  try {
    const user = req.user;
    
    // Build query conditions
    let whereConditions = [];
    let params = [];
    
    if (user?.role === 'WAREHOUSE_KEEPER' && user?.warehouseId) {
      whereConditions.push('i.scope_type = ? AND i.scope_id = ?');
      params.push('WAREHOUSE', user.warehouseId);
    } else if (user?.role === 'CASHIER' && user?.branchId) {
      whereConditions.push('i.scope_type = ? AND i.scope_id = ?');
      params.push('BRANCH', user.branchId);
    }

    const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

    const [summaryResult] = await pool.execute(`
      SELECT 
        COUNT(*) as total_items,
        SUM(COALESCE(l.qty, 0)) as total_stock,
        SUM(COALESCE(l.qty, 0) * COALESCE(i.cost_price, 0)) as total_value,
        SUM(CASE WHEN COALESCE(l.qty, 0) <= 0 THEN 1 ELSE 0 END) as out_of_stock,
        SUM(CASE WHEN COALESCE(l.qty, 0) < 0 THEN 1 ELSE 0 END) as negative_stock,
        SUM(CASE WHEN COALESCE(l.qty, 0) = 0 THEN 1 ELSE 0 END) as zero_stock,
        SUM(CASE WHEN COALESCE(l.qty, 0) <= i.min_stock_level AND COALESCE(l.qty, 0) > 0 THEN 1 ELSE 0 END) as low_stock,
        SUM(CASE WHEN COALESCE(l.qty, 0) > i.min_stock_level THEN 1 ELSE 0 END) as in_stock,
        SUM(CASE WHEN COALESCE(l.qty, 0) < 0 THEN COALESCE(l.qty, 0) ELSE 0 END) as total_negative_quantity
      FROM inventory_items i
      LEFT JOIN (
        SELECT le.inventory_item_id,
               SUM(le.quantity_in - le.quantity_out) AS qty
        FROM inventory_ledger_entries le
        INNER JOIN inventory_items ix ON ix.id = le.inventory_item_id
          AND le.scope_type = ix.scope_type
          AND (CAST(le.scope_id AS CHAR) COLLATE utf8mb4_bin = CAST(ix.scope_id AS CHAR) COLLATE utf8mb4_bin)
        GROUP BY le.inventory_item_id
      ) l ON l.inventory_item_id = i.id
      ${whereClause}
    `, params);
    
    const summary = summaryResult[0] || {
      total_items: 0,
      total_stock: 0,
      total_value: 0,
      out_of_stock: 0,
      negative_stock: 0,
      zero_stock: 0,
      low_stock: 0,
      in_stock: 0,
      total_negative_quantity: 0
    };
    
    res.json({
      success: true,
      data: {
        totalItems: summary.total_items,
        totalStock: summary.total_stock,
        totalValue: summary.total_value,
        outOfStock: summary.out_of_stock,
        negativeStock: summary.negative_stock,
        zeroStock: summary.zero_stock,
        lowStock: summary.low_stock,
        inStock: summary.in_stock,
        totalNegativeQuantity: summary.total_negative_quantity
      }
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error retrieving stock report summary',
      error: error.message
    });
  }
};

// @desc    Get stock report statistics
// @route   GET /api/stock-reports/statistics
// @access  Private (Admin, Warehouse Keeper, Cashier)
const getStockReportStatistics = async (req, res) => {
  try {
    const user = req.user;
    const { 
      scopeType, 
      scopeId, 
      startDate, 
      endDate,
      category 
    } = req.query;
    
    let whereConditions = [];
    let params = [];

    if (user?.role === 'WAREHOUSE_KEEPER' && user?.warehouseId) {
      whereConditions.push(`ii.scope_type = 'WAREHOUSE' AND (
        CAST(ii.scope_id AS UNSIGNED) = ? OR CAST(ii.scope_id AS CHAR) COLLATE utf8mb4_bin = CAST(? AS CHAR) COLLATE utf8mb4_bin
      )`);
      params.push(user.warehouseId, String(user.warehouseId));
    } else if (user?.role === 'CASHIER' && user?.branchId) {
      whereConditions.push(`ii.scope_type = 'BRANCH' AND (
        CAST(ii.scope_id AS UNSIGNED) = ? OR CAST(ii.scope_id AS CHAR) COLLATE utf8mb4_bin = CAST(? AS CHAR) COLLATE utf8mb4_bin
      )`);
      params.push(user.branchId, String(user.branchId));
    }

    if (scopeType && scopeType !== 'all') {
      whereConditions.push('ii.scope_type = ?');
      params.push(scopeType);
    }

    if (scopeId && scopeId !== 'all') {
      const n = parseInt(scopeId, 10);
      whereConditions.push(`(
        CAST(ii.scope_id AS UNSIGNED) = ? OR CAST(ii.scope_id AS CHAR) COLLATE utf8mb4_bin = CAST(? AS CHAR) COLLATE utf8mb4_bin
      )`);
      params.push(Number.isFinite(n) ? n : 0, String(scopeId));
    }

    if (category && category !== 'all') {
      whereConditions.push('ii.category = ?');
      params.push(category);
    }

    if (startDate) {
      whereConditions.push('COALESCE(le.entry_date, le.created_at) >= ?');
      params.push(startDate);
    }

    if (endDate) {
      whereConditions.push('COALESCE(le.entry_date, le.created_at) <= ?');
      params.push(endDate);
    }

    const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

    const ledgerJoin = `
      FROM inventory_ledger_entries le
      INNER JOIN inventory_items ii ON ii.id = le.inventory_item_id
        AND le.scope_type = ii.scope_type
        AND (CAST(le.scope_id AS CHAR) COLLATE utf8mb4_bin = CAST(ii.scope_id AS CHAR) COLLATE utf8mb4_bin)
    `;

    const [overallResult] = await pool.execute(`
      SELECT 
        COUNT(*) as total_transactions,
        SUM(CASE WHEN le.event_type = 'PURCHASE' THEN le.quantity_in ELSE 0 END) as total_purchased,
        SUM(CASE WHEN le.event_type = 'SALE' THEN le.quantity_out ELSE 0 END) as total_sold,
        SUM(CASE WHEN le.event_type = 'RETURN' THEN le.quantity_in ELSE 0 END) as total_returned,
        SUM(CASE WHEN le.event_type = 'ADJUSTMENT' THEN (le.quantity_in - le.quantity_out) ELSE 0 END) as total_adjusted,
        SUM(CASE WHEN le.event_type = 'TRANSFER_IN' THEN le.quantity_in ELSE 0 END) as total_transferred_in,
        SUM(CASE WHEN le.event_type = 'TRANSFER_OUT' THEN le.quantity_out ELSE 0 END) as total_transferred_out
      ${ledgerJoin}
      ${whereClause}
    `, params);
    
    const overall = overallResult[0] || {
      totalTransactions: 0,
      totalPurchased: 0,
      totalSold: 0,
      totalReturned: 0,
      totalAdjusted: 0,
      totalTransferredIn: 0,
      totalTransferredOut: 0
    };
    
    const [transactionTypesResult] = await pool.execute(`
      SELECT 
        le.event_type AS transaction_type,
        COUNT(*) as count,
        SUM(ABS(le.quantity_in - le.quantity_out)) as total_quantity
      ${ledgerJoin}
      ${whereClause}
      GROUP BY le.event_type
      ORDER BY count DESC
    `, params);

    const transactionTypes = transactionTypesResult.map(row => ({
      transactionType: row.transaction_type,
      count: row.count,
      totalQuantity: row.total_quantity || 0
    }));

    const [topItemsResult] = await pool.execute(`
      SELECT 
        le.inventory_item_id,
        ii.name as item_name,
        ii.sku as item_sku,
        ii.category as item_category,
        COUNT(*) as transaction_count,
        SUM(ABS(le.quantity_in - le.quantity_out)) as total_quantity
      ${ledgerJoin}
      ${whereClause}
      GROUP BY le.inventory_item_id, ii.name, ii.sku, ii.category
      ORDER BY transaction_count DESC
      LIMIT 10
    `, params);
    
    const topItems = topItemsResult.map(item => ({
      inventoryItemId: item.inventory_item_id,
      itemName: item.item_name,
      itemSku: item.item_sku,
      itemCategory: item.item_category,
      transactionCount: item.transaction_count,
      totalQuantity: item.total_quantity || 0
    }));
    
    const dailyWhere =
      whereConditions.length > 0
        ? `WHERE COALESCE(le.entry_date, le.created_at) >= DATE_SUB(NOW(), INTERVAL 30 DAY) AND ${whereConditions.join(
            ' AND '
          )}`
        : `WHERE COALESCE(le.entry_date, le.created_at) >= DATE_SUB(NOW(), INTERVAL 30 DAY)`;

    const [dailyActivityResult] = await pool.execute(
      `
      SELECT 
        DATE(COALESCE(le.entry_date, le.created_at)) as date,
        COUNT(*) as transaction_count,
        SUM(CASE WHEN le.event_type = 'PURCHASE' THEN le.quantity_in ELSE 0 END) as purchased,
        SUM(CASE WHEN le.event_type = 'SALE' THEN le.quantity_out ELSE 0 END) as sold,
        SUM(CASE WHEN le.event_type = 'RETURN' THEN le.quantity_in ELSE 0 END) as returned
      ${ledgerJoin}
      ${dailyWhere}
      GROUP BY DATE(COALESCE(le.entry_date, le.created_at))
      ORDER BY date DESC
      LIMIT 30
    `,
      params
    );
    
    const dailyActivity = dailyActivityResult.map(day => ({
      date: day.date,
      transactionCount: day.transaction_count,
      purchased: day.purchased || 0,
      sold: day.sold || 0,
      returned: day.returned || 0
    }));
    
    const statistics = {
      overall,
      transactionTypes,
      topItems,
      dailyActivity
    };
    
    res.json({
      success: true,
      data: statistics
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error retrieving stock report statistics',
      error: error.message
    });
  }
};

// @desc    Get stock summary
// @route   GET /api/stock-reports/summary
// @access  Private (Admin, Warehouse Keeper, Cashier)
const getStockSummary = async (req, res) => {
  try {
    const user = req.user;
    const { page = 1, limit = 25, searchTerm, scopeType, scopeId, itemCategory } = req.query;
    
    // Build query conditions
    let whereConditions = [];
    let params = [];
    
    // Role-based filtering
    if (user?.role === 'WAREHOUSE_KEEPER' && user?.warehouseId) {
      whereConditions.push('ii.scope_type = ? AND ii.scope_id = ?');
      params.push('WAREHOUSE', user.warehouseId);
    } else if (user?.role === 'CASHIER' && user?.branchId) {
      // For cashiers, use branch ID directly (inventory_items stores numeric IDs)
      whereConditions.push('ii.scope_type = ? AND ii.scope_id = ?');
      params.push('BRANCH', user.branchId);
    }
    
    // Additional filters
    if (searchTerm) {
      whereConditions.push('(ii.name LIKE ? OR ii.sku LIKE ?)');
      params.push(`%${searchTerm}%`, `%${searchTerm}%`);
    }
    
    if (scopeType && scopeType !== 'all') {
      whereConditions.push('ii.scope_type = ?');
      params.push(scopeType);
    }
    
    if (scopeId && scopeId !== 'all') {
      whereConditions.push('ii.scope_id = ?');
      params.push(scopeId);
    }
    
    if (itemCategory && itemCategory !== 'all') {
      whereConditions.push('ii.category = ?');
      params.push(itemCategory);
    }
    
    const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';
    const offset = (page - 1) * limit;
    
    const [summaryResult] = await pool.execute(`
      SELECT 
        ii.id,
        ii.name as itemName,
        ii.sku as itemSku,
        ii.category as itemCategory,
        COALESCE(lg.ledger_stock, 0) as currentStock,
        ii.min_stock_level as minStockLevel,
        ii.max_stock_level as maxStockLevel,
        ii.cost_price as costPrice,
        ii.selling_price as sellingPrice,
        ii.supplier_id as supplierId,
        ii.supplier_name as supplierName,
        ii.purchase_date as purchaseDate,
        ii.purchase_price as purchasePrice,
        ii.created_at as itemCreatedAt,
        c.name as supplierCompanyName,
        c.contact_person as supplierContact,
        c.phone as supplierPhone,
        c.email as supplierEmail,
        b.name as branchName,
        w.name as warehouseName,
        ii.scope_type as scopeType,
        ii.scope_id as scopeId,
        (COALESCE(lg.ledger_stock, 0) * ii.cost_price) as currentStockValue,
        COALESCE(lg.total_purchased, 0) as totalPurchased,
        COALESCE(lg.total_sold, 0) as totalSold,
        COALESCE(lg.total_returned, 0) as totalReturned,
        COALESCE(lg.total_adjusted, 0) as totalAdjusted,
        COALESCE(lg.total_transferred_in, 0) as totalTransferredIn,
        COALESCE(lg.total_transferred_out, 0) as totalTransferredOut
      FROM inventory_items ii
      LEFT JOIN companies c ON ii.supplier_id = c.id
      LEFT JOIN branches b ON ii.scope_type = 'BRANCH' AND ii.scope_id = b.id
      LEFT JOIN warehouses w ON ii.scope_type = 'WAREHOUSE' AND ii.scope_id = w.id
      LEFT JOIN (
        SELECT 
          le.inventory_item_id,
          SUM(le.quantity_in - le.quantity_out) AS ledger_stock,
          SUM(CASE WHEN le.event_type = 'PURCHASE' THEN le.quantity_in ELSE 0 END) AS total_purchased,
          SUM(CASE WHEN le.event_type = 'SALE' THEN le.quantity_out ELSE 0 END) AS total_sold,
          SUM(CASE WHEN le.event_type = 'RETURN' THEN le.quantity_in ELSE 0 END) AS total_returned,
          SUM(CASE WHEN le.event_type = 'ADJUSTMENT' THEN (le.quantity_in - le.quantity_out) ELSE 0 END) AS total_adjusted,
          SUM(CASE WHEN le.event_type = 'TRANSFER_IN' THEN le.quantity_in ELSE 0 END) AS total_transferred_in,
          SUM(CASE WHEN le.event_type = 'TRANSFER_OUT' THEN le.quantity_out ELSE 0 END) AS total_transferred_out
        FROM inventory_ledger_entries le
        INNER JOIN inventory_items ix ON ix.id = le.inventory_item_id
          AND le.scope_type = ix.scope_type
          AND (CAST(le.scope_id AS CHAR) COLLATE utf8mb4_bin = CAST(ix.scope_id AS CHAR) COLLATE utf8mb4_bin)
        GROUP BY le.inventory_item_id
      ) lg ON lg.inventory_item_id = ii.id
      ${whereClause}
      ORDER BY ii.name ASC
      LIMIT ? OFFSET ?
    `, [...params, parseInt(limit), offset]);
    
    // Get total count for pagination
    const [countResult] = await pool.execute(`
      SELECT COUNT(*) as total
      FROM inventory_items ii
      ${whereClause}
    `, params);
    
    const totalCount = countResult[0]?.total || 0;
    const totalPages = Math.ceil(totalCount / limit);
    
    res.json({
      success: true,
      data: summaryResult,
      pagination: {
        currentPage: parseInt(page),
        totalPages,
        totalCount,
        limit: parseInt(limit)
      }
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error retrieving stock summary',
      error: error.message
    });
  }
};

// @desc    Get product stock history
// @route   GET /api/stock-reports/product/:id
// @access  Private (Admin, Warehouse Keeper, Cashier)
const getProductStockHistory = async (req, res) => {
  try {
    const { id } = req.params;
    const user = req.user;
    
    // Get product details with supplier info
    const [productResult] = await pool.execute(`
      SELECT 
        ii.*,
        c.name as supplierCompanyName,
        c.contact_person as supplierContact,
        c.phone as supplierPhone,
        c.email as supplierEmail,
        b.name as branchName,
        w.name as warehouseName
      FROM inventory_items ii
      LEFT JOIN companies c ON ii.supplier_id = c.id
      LEFT JOIN branches b ON ii.scope_type = 'BRANCH' AND ii.scope_id = b.id
      LEFT JOIN warehouses w ON ii.scope_type = 'WAREHOUSE' AND ii.scope_id = w.id
      WHERE ii.id = ?
    `, [id]);
    
    if (productResult.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }
    
    const product = productResult[0];
    
    const [historyResult] = await pool.execute(`
      SELECT 
        le.id,
        le.inventory_item_id as inventoryItemId,
        le.event_type as transactionType,
        (le.quantity_in - le.quantity_out) as quantityChange,
        NULL as previousQuantity,
        NULL as newQuantity,
        le.unit_cost as unitPrice,
        (le.unit_cost * (le.quantity_in + le.quantity_out)) as totalValue,
        CONCAT(IFNULL(le.reference_type,''), ':', IFNULL(le.reference_id,'')) as adjustmentReason,
        COALESCE(le.entry_date, le.created_at) as createdAt,
        le.quantity_in as quantityIn,
        le.quantity_out as quantityOut,
        u.username as userName,
        u.role as userRole
      FROM inventory_ledger_entries le
      INNER JOIN inventory_items ii ON ii.id = le.inventory_item_id
        AND le.scope_type = ii.scope_type
        AND (CAST(le.scope_id AS CHAR) COLLATE utf8mb4_bin = CAST(ii.scope_id AS CHAR) COLLATE utf8mb4_bin)
      LEFT JOIN users u ON le.created_by = u.id
      WHERE le.inventory_item_id = ?
      ORDER BY le.created_at DESC, le.id DESC
      LIMIT 100
    `, [id]);

    const [summaryResult] = await pool.execute(`
      SELECT 
        COUNT(*) as total_transactions,
        SUM(CASE WHEN le.event_type = 'PURCHASE' THEN le.quantity_in ELSE 0 END) as total_purchased,
        SUM(CASE WHEN le.event_type = 'SALE' THEN le.quantity_out ELSE 0 END) as total_sold,
        SUM(CASE WHEN le.event_type = 'RETURN' THEN le.quantity_in ELSE 0 END) as total_returned,
        SUM(CASE WHEN le.event_type = 'ADJUSTMENT' THEN (le.quantity_in - le.quantity_out) ELSE 0 END) as total_adjusted,
        SUM(CASE WHEN le.event_type = 'TRANSFER_IN' THEN le.quantity_in ELSE 0 END) as total_transferred_in,
        SUM(CASE WHEN le.event_type = 'TRANSFER_OUT' THEN le.quantity_out ELSE 0 END) as total_transferred_out
      FROM inventory_ledger_entries le
      INNER JOIN inventory_items ii ON ii.id = le.inventory_item_id
        AND le.scope_type = ii.scope_type
        AND (CAST(le.scope_id AS CHAR) COLLATE utf8mb4_bin = CAST(ii.scope_id AS CHAR) COLLATE utf8mb4_bin)
      WHERE le.inventory_item_id = ?
    `, [id]);
    
    const summary = summaryResult[0] || {
      total_transactions: 0,
      total_purchased: 0,
      total_sold: 0,
      total_returned: 0,
      total_adjusted: 0,
      total_transferred_in: 0,
      total_transferred_out: 0
    };
    
    const [dailyMovementsResult] = await pool.execute(`
      SELECT 
        DATE(COALESCE(le.entry_date, le.created_at)) as date,
        SUM(CASE WHEN le.event_type = 'PURCHASE' THEN le.quantity_in ELSE 0 END) as purchased,
        SUM(CASE WHEN le.event_type = 'SALE' THEN le.quantity_out ELSE 0 END) as sold,
        SUM(CASE WHEN le.event_type = 'RETURN' THEN le.quantity_in ELSE 0 END) as returned,
        SUM(CASE WHEN le.event_type = 'ADJUSTMENT' THEN (le.quantity_in - le.quantity_out) ELSE 0 END) as adjusted,
        COUNT(*) as transactions
      FROM inventory_ledger_entries le
      INNER JOIN inventory_items ii ON ii.id = le.inventory_item_id
        AND le.scope_type = ii.scope_type
        AND (CAST(le.scope_id AS CHAR) COLLATE utf8mb4_bin = CAST(ii.scope_id AS CHAR) COLLATE utf8mb4_bin)
      WHERE le.inventory_item_id = ? AND COALESCE(le.entry_date, le.created_at) >= DATE_SUB(NOW(), INTERVAL 30 DAY)
      GROUP BY DATE(COALESCE(le.entry_date, le.created_at))
      ORDER BY date DESC
    `, [id]);

    const [monthlyMovementsResult] = await pool.execute(`
      SELECT 
        YEAR(COALESCE(le.entry_date, le.created_at)) as year,
        MONTH(COALESCE(le.entry_date, le.created_at)) as month,
        SUM(CASE WHEN le.event_type = 'PURCHASE' THEN le.quantity_in ELSE 0 END) as purchased,
        SUM(CASE WHEN le.event_type = 'SALE' THEN le.quantity_out ELSE 0 END) as sold,
        SUM(CASE WHEN le.event_type = 'RETURN' THEN le.quantity_in ELSE 0 END) as returned,
        SUM(CASE WHEN le.event_type = 'ADJUSTMENT' THEN (le.quantity_in - le.quantity_out) ELSE 0 END) as adjusted,
        COUNT(*) as transactions
      FROM inventory_ledger_entries le
      INNER JOIN inventory_items ii ON ii.id = le.inventory_item_id
        AND le.scope_type = ii.scope_type
        AND (CAST(le.scope_id AS CHAR) COLLATE utf8mb4_bin = CAST(ii.scope_id AS CHAR) COLLATE utf8mb4_bin)
      WHERE le.inventory_item_id = ? AND COALESCE(le.entry_date, le.created_at) >= DATE_SUB(NOW(), INTERVAL 12 MONTH)
      GROUP BY YEAR(COALESCE(le.entry_date, le.created_at)), MONTH(COALESCE(le.entry_date, le.created_at))
      ORDER BY year DESC, month DESC
    `, [id]);
    
    res.json({
      success: true,
      data: {
        inventoryItem: product,
        summary: summary,
        dailyMovements: dailyMovementsResult,
        monthlyMovements: monthlyMovementsResult,
        recentTransactions: historyResult
      }
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error retrieving product stock history',
      error: error.message
    });
  }
};

// @desc    Get stock reports by scope
// @route   GET /api/stock-reports/scope/:scopeType/:scopeId
// @access  Private (Admin, Warehouse Keeper, Cashier)
const getStockReportsByScope = async (req, res) => {
  try {
    const { scopeType, scopeId } = req.params;
    const user = req.user;
    
    // Check permissions
    if (user?.role === 'WAREHOUSE_KEEPER' && 
        (scopeType !== 'WAREHOUSE' || scopeId !== user.warehouseName)) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }
    
    if (user?.role === 'CASHIER' && 
        (scopeType !== 'BRANCH' || scopeId !== user.branchName)) {
      // For cashiers, check against branch name instead of branchId
      const [branches] = await pool.execute('SELECT name FROM branches WHERE id = ?', [user.branchName]);
      const branchName = branches[0]?.name || user.branchName;
      
      if (scopeType !== 'BRANCH' || scopeId !== branchName) {
        return res.status(403).json({
          success: false,
          message: 'Access denied'
        });
      }
    }
    
    const [reportsResult] = await pool.execute(
      `
      SELECT 
        le.id,
        le.event_id,
        le.event_type,
        le.inventory_item_id,
        le.scope_type,
        le.scope_id,
        le.quantity_in,
        le.quantity_out,
        le.reference_type,
        le.reference_id,
        le.unit_cost,
        le.entry_date,
        le.created_at,
        ii.name as item_name,
        ii.sku as item_sku,
        ii.category as item_category,
        ii.supplier_id as supplier_id,
        ii.supplier_name as supplier_name,
        ii.purchase_date as purchase_date,
        ii.purchase_price as purchase_price,
        ii.created_at as item_created_at,
        c.name as supplier_company_name,
        c.contact_person as supplier_contact,
        c.phone as supplier_phone,
        c.email as supplier_email,
        u.username as user_name,
        u.role as user_role
      FROM inventory_ledger_entries le
      INNER JOIN inventory_items ii ON ii.id = le.inventory_item_id
        AND le.scope_type = ii.scope_type
        AND (CAST(le.scope_id AS CHAR) COLLATE utf8mb4_bin = CAST(ii.scope_id AS CHAR) COLLATE utf8mb4_bin)
      LEFT JOIN users u ON le.created_by = u.id
      LEFT JOIN companies c ON ii.supplier_id = c.id
      WHERE ii.scope_type = ? AND (
        CAST(ii.scope_id AS UNSIGNED) = CAST(? AS UNSIGNED) OR CAST(ii.scope_id AS CHAR) COLLATE utf8mb4_bin = CAST(? AS CHAR) COLLATE utf8mb4_bin
      )
      ORDER BY le.created_at DESC, le.id DESC
      LIMIT 100
    `,
      [scopeType, scopeId, String(scopeId)]
    );
    
    res.json({
      success: true,
      data: reportsResult
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error retrieving stock reports by scope',
      error: error.message
    });
  }
};

module.exports = {
  getStockReports,
  getStockReportSummary,
  getStockReportStatistics,
  getStockSummary,
  getProductStockHistory,
  getStockReportsByScope
};