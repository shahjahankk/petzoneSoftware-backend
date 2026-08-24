const { validationResult } = require('express-validator');
const Company = require('../models/Company');
const Branch = require('../models/Branch');
const Warehouse = require('../models/Warehouse');
const { pool } = require('../config/database');
const { ledgerScopedQuantitySubquery } = require('../services/inventoryLedgerService');
const trashService = require('../services/trashService');

const defaultMetrics = {
  purchaseOrderCount: 0,
  totalPurchaseAmount: 0,
  lastPurchaseDate: null,
  totalQuantityOrdered: 0,
  totalItemsCost: 0,
  inventoryItemCount: 0,
  totalCurrentStock: 0,
  lastInventoryUpdate: null
};

const getScopeForMetrics = (req, queryScopeType, queryScopeId) => {
  if (req.user.role === 'WAREHOUSE_KEEPER') {
    return { scopeType: 'WAREHOUSE', scopeId: req.user.warehouseId };
  }

  if (req.user.role === 'CASHIER') {
    return { scopeType: 'BRANCH', scopeId: req.user.branchId };
  }

  if (queryScopeType && queryScopeId) {
    return { scopeType: queryScopeType, scopeId: queryScopeId };
  }

  return null;
};

const fetchCompanyMetrics = async (companyIds = [], scopeFilter = null) => {
  if (!companyIds || companyIds.length === 0) {
    return {};
  }

  const placeholders = companyIds.map(() => '?').join(',');
  const metricsMap = companyIds.reduce((acc, id) => {
    acc[id] = { ...defaultMetrics };
    return acc;
  }, {});

  const applyScopeFilter = (baseQuery, params) => {
    if (!scopeFilter || !scopeFilter.scopeType || !scopeFilter.scopeId) {
      return { query: baseQuery, params };
    }

    return {
      query: `${baseQuery} AND scope_type = ? AND scope_id = ?`,
      params: [...params, scopeFilter.scopeType, scopeFilter.scopeId]
    };
  };

  // Purchase orders aggregate
  const poBaseQuery = `SELECT supplier_id AS companyId,
      COUNT(*) AS purchaseOrderCount,
      COALESCE(SUM(total_amount), 0) AS totalPurchaseAmount,
      MAX(COALESCE(order_date, created_at)) AS lastPurchaseDate
    FROM purchase_orders
    WHERE supplier_id IN (${placeholders})`;
  const { query: poQuery, params: poParams } = applyScopeFilter(poBaseQuery, [...companyIds]);
  const [poRows] = await pool.execute(`${poQuery} GROUP BY supplier_id`, poParams);
  poRows.forEach(row => {
    const metrics = metricsMap[row.companyId];
    if (!metrics) return;
    metrics.purchaseOrderCount = Number(row.purchaseOrderCount) || 0;
    metrics.totalPurchaseAmount = Number(row.totalPurchaseAmount) || 0;
    metrics.lastPurchaseDate = row.lastPurchaseDate ? new Date(row.lastPurchaseDate).toISOString() : null;
  });

  // Purchase order items aggregate
  const poiBaseQuery = `SELECT po.supplier_id AS companyId,
      COALESCE(SUM(poi.quantity_ordered), 0) AS totalQuantityOrdered,
      COALESCE(SUM(poi.total_price), 0) AS totalItemsCost
    FROM purchase_order_items poi
    JOIN purchase_orders po ON poi.purchase_order_id = po.id
    WHERE po.supplier_id IN (${placeholders})`;
  const { query: poiQuery, params: poiParams } = applyScopeFilter(poiBaseQuery, [...companyIds]);
  const [poiRows] = await pool.execute(`${poiQuery} GROUP BY po.supplier_id`, poiParams);
  poiRows.forEach(row => {
    const metrics = metricsMap[row.companyId];
    if (!metrics) return;
    metrics.totalQuantityOrdered = Number(row.totalQuantityOrdered) || 0;
    metrics.totalItemsCost = Number(row.totalItemsCost) || 0;
  });

  const LQm = ledgerScopedQuantitySubquery();
  const inventoryBaseQuery = `SELECT i.supplier_id AS companyId,
      COUNT(*) AS inventoryItemCount,
      COALESCE(SUM(COALESCE(l.ledger_qty, 0)), 0) AS totalCurrentStock,
      MAX(i.updated_at) AS lastInventoryUpdate
    FROM inventory_items i
    LEFT JOIN ${LQm} l ON l.inventory_item_id = i.id
    WHERE i.supplier_id IN (${placeholders})`;
  const applyInventoryScope = (baseQuery, params) => {
    if (!scopeFilter || !scopeFilter.scopeType || !scopeFilter.scopeId) {
      return { query: baseQuery, params };
    }
    return {
      query: `${baseQuery} AND i.scope_type = ? AND i.scope_id = ?`,
      params: [...params, scopeFilter.scopeType, scopeFilter.scopeId],
    };
  };
  const { query: inventoryQuery, params: inventoryParams } = applyInventoryScope(inventoryBaseQuery, [...companyIds]);
  const [inventoryRows] = await pool.execute(`${inventoryQuery} GROUP BY i.supplier_id`, inventoryParams);
  inventoryRows.forEach(row => {
    const metrics = metricsMap[row.companyId];
    if (!metrics) return;
    metrics.inventoryItemCount = Number(row.inventoryItemCount) || 0;
    metrics.totalCurrentStock = Number(row.totalCurrentStock) || 0;
    metrics.lastInventoryUpdate = row.lastInventoryUpdate ? new Date(row.lastInventoryUpdate).toISOString() : null;
  });

  return metricsMap;
};

const fetchCompanyPurchaseOrders = async (companyId, scopeFilter = null, limit = 50) => {
  const params = [companyId];
  let query = `SELECT id, order_number, supplier_id, scope_type, scope_id, order_date, expected_delivery, actual_delivery, status, total_amount, created_at, updated_at
    FROM purchase_orders
    WHERE supplier_id = ?`;

  if (scopeFilter && scopeFilter.scopeType && scopeFilter.scopeId) {
    query += ' AND scope_type = ? AND scope_id = ?';
    params.push(scopeFilter.scopeType, scopeFilter.scopeId);
  }

  query += ' ORDER BY COALESCE(order_date, created_at) DESC LIMIT ?';
  params.push(limit);

  const [rows] = await pool.execute(query, params);

  const orderIds = rows.map(row => row.id);
  const itemsMap = {};

  if (orderIds.length > 0) {
    const placeholders = orderIds.map(() => '?').join(',');
    const [itemRows] = await pool.execute(
      `SELECT poi.*, poi.purchase_order_id
       FROM purchase_order_items poi
       WHERE poi.purchase_order_id IN (${placeholders})
       ORDER BY poi.purchase_order_id, poi.id`,
      orderIds
    );

    itemRows.forEach(item => {
      if (!itemsMap[item.purchase_order_id]) {
        itemsMap[item.purchase_order_id] = [];
      }
      itemsMap[item.purchase_order_id].push({
        id: item.id,
        inventoryItemId: item.inventory_item_id,
        name: item.item_name,
        sku: item.item_sku,
        category: item.item_category,
        description: item.item_description,
        quantityOrdered: Number(item.quantity_ordered) || 0,
        quantityReceived: Number(item.quantity_received) || 0,
        unitPrice: Number(item.unit_price) || 0,
        totalPrice: Number(item.total_price) || 0,
        notes: item.notes
      });
    });
  }

  return rows.map(row => ({
    ...row,
    total_amount: Number(row.total_amount) || 0,
    items: itemsMap[row.id] || []
  }));
};

const fetchCompanyInventoryItems = async (companyId, scopeFilter = null, limit = 100) => {
  const params = [companyId];
  const LQi = ledgerScopedQuantitySubquery();
  let query = `SELECT i.id, i.sku, i.name, i.category,
    COALESCE(l.ledger_qty, 0) AS current_stock,
    i.cost_price, i.purchase_price, i.scope_type, i.scope_id, i.purchase_date, i.created_at, i.updated_at
    FROM inventory_items i
    LEFT JOIN ${LQi} l ON l.inventory_item_id = i.id
    WHERE i.supplier_id = ?`;

  if (scopeFilter && scopeFilter.scopeType && scopeFilter.scopeId) {
    query += ' AND i.scope_type = ? AND i.scope_id = ?';
    params.push(scopeFilter.scopeType, scopeFilter.scopeId);
  }

  query += ' ORDER BY i.updated_at DESC LIMIT ?';
  params.push(limit);

  const [rows] = await pool.execute(query, params);
  return rows.map(row => ({
    ...row,
    current_stock: Number(row.current_stock) || 0,
    cost_price: Number(row.cost_price) || 0,
    purchase_price: Number(row.purchase_price) || 0
  }));
};

const fetchCompanyPurchaseTimeline = async (companyId, scopeFilter = null, months = 12) => {
  const params = [companyId];
  let query = `SELECT DATE_FORMAT(COALESCE(order_date, created_at), '%Y-%m') AS period,
      COALESCE(SUM(total_amount), 0) AS totalAmount,
      COUNT(*) AS orders
    FROM purchase_orders
    WHERE supplier_id = ?`;

  if (scopeFilter && scopeFilter.scopeType && scopeFilter.scopeId) {
    query += ' AND scope_type = ? AND scope_id = ?';
    params.push(scopeFilter.scopeType, scopeFilter.scopeId);
  }

  query += ' GROUP BY period ORDER BY period DESC LIMIT ?';
  params.push(months);

  const [rows] = await pool.execute(query, params);
  return rows.reverse().map(row => ({
    period: row.period,
    totalAmount: Number(row.totalAmount) || 0,
    orders: Number(row.orders) || 0
  }));
};

const fetchCompanyTopProducts = async (companyId, scopeFilter = null, limit = 10) => {
  const params = [companyId];
  let query = `SELECT poi.item_name AS name,
      COALESCE(SUM(poi.quantity_ordered), 0) AS totalQuantity,
      COALESCE(SUM(poi.total_price), 0) AS totalCost
    FROM purchase_order_items poi
    JOIN purchase_orders po ON poi.purchase_order_id = po.id
    WHERE po.supplier_id = ?`;

  if (scopeFilter && scopeFilter.scopeType && scopeFilter.scopeId) {
    query += ' AND po.scope_type = ? AND po.scope_id = ?';
    params.push(scopeFilter.scopeType, scopeFilter.scopeId);
  }

  query += ' GROUP BY poi.item_name ORDER BY totalQuantity DESC LIMIT ?';
  params.push(limit);

  const [rows] = await pool.execute(query, params);
  return rows.map(row => ({
    name: row.name || 'Unnamed Product',
    totalQuantity: Number(row.totalQuantity) || 0,
    totalCost: Number(row.totalCost) || 0
  }));
};

const buildCompaniesSummaryHtml = (rows, summary) => {
  const formatCurrency = (value) => Number(value || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const formatNumber = (value) => Number(value || 0).toLocaleString();
  const summaryRows = [
    `<tr><th>Total Companies</th><td>${formatNumber(summary.totalCompanies)}</td></tr>`,
    `<tr><th>Total Purchase Orders</th><td>${formatNumber(summary.totalPurchaseOrders)}</td></tr>`,
    `<tr><th>Total Purchase Amount</th><td>${formatCurrency(summary.totalPurchaseAmount)}</td></tr>`,
    `<tr><th>Total Products Purchased</th><td>${formatNumber(summary.totalProductsPurchased)}</td></tr>`,
    `<tr><th>Total Inventory Items</th><td>${formatNumber(summary.totalInventoryItems)}</td></tr>`
  ].join('');

  const tableRows = rows.map((row, index) => (
    `<tr>
      <td>${index + 1}</td>
      <td>${row.name || ''}</td>
      <td>${row.contactPerson || ''}</td>
      <td>${row.phone || ''}</td>
      <td>${row.email || ''}</td>
      <td>${formatNumber(row.metrics.purchaseOrderCount)}</td>
      <td>${formatCurrency(row.metrics.totalPurchaseAmount)}</td>
      <td>${formatNumber(row.metrics.totalQuantityOrdered)}</td>
      <td>${formatNumber(row.metrics.inventoryItemCount)}</td>
      <td>${row.metrics.lastPurchaseDate ? new Date(row.metrics.lastPurchaseDate).toLocaleDateString() : '—'}</td>
    </tr>`
  )).join('');

  return `<!DOCTYPE html>
  <html>
    <head>
      <meta charset="utf-8" />
      <title>Company Summary Report</title>
      <style>
        body { font-family: Arial, sans-serif; padding: 24px; color: #333; }
        h1 { margin-bottom: 4px; }
        h2 { margin-top: 32px; }
        table { width: 100%; border-collapse: collapse; margin-top: 12px; }
        th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
        th { background-color: #f5f5f5; }
        .summary-table { width: 50%; }
      </style>
    </head>
    <body>
      <h1>Company Summary Report</h1>
      <p>Generated on ${new Date().toLocaleString()}</p>
      <h2>Overview</h2>
      <table class="summary-table">
        <tbody>${summaryRows}</tbody>
      </table>
      <h2>Companies</h2>
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Company</th>
            <th>Contact Person</th>
            <th>Phone</th>
            <th>Email</th>
            <th>Purchase Orders</th>
            <th>Total Purchase Amount</th>
            <th>Products Purchased</th>
            <th>Inventory Items</th>
            <th>Last Purchase</th>
          </tr>
        </thead>
        <tbody>
          ${tableRows || '<tr><td colspan="10" style="text-align:center;">No companies available</td></tr>'}
        </tbody>
      </table>
    </body>
  </html>`;
};

const buildCompanyDetailHtml = (detail) => {
  const { company, stats, purchaseOrders, inventoryItems, purchaseTimeline, topProducts } = detail;
  const formatCurrency = (value) => Number(value || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const formatNumber = (value) => Number(value || 0).toLocaleString();

  const purchaseRows = purchaseOrders.map((order, index) => (
    `<tr>
      <td>${index + 1}</td>
      <td>${order.order_number || ''}</td>
      <td>${order.order_date ? new Date(order.order_date).toLocaleDateString() : (order.created_at ? new Date(order.created_at).toLocaleDateString() : '—')}</td>
      <td>${order.status || ''}</td>
      <td>${formatCurrency(order.total_amount)}</td>
      <td>${order.items.length}</td>
    </tr>`
  )).join('');

  const inventoryRows = inventoryItems.map((item, index) => (
    `<tr>
      <td>${index + 1}</td>
      <td>${item.name || ''}</td>
      <td>${item.sku || ''}</td>
      <td>${item.category || ''}</td>
      <td>${formatNumber(item.current_stock)}</td>
      <td>${formatCurrency(item.cost_price)}</td>
      <td>${item.updated_at ? new Date(item.updated_at).toLocaleDateString() : '—'}</td>
    </tr>`
  )).join('');

  const timelineRows = purchaseTimeline.map(row => (
    `<tr>
      <td>${row.period}</td>
      <td>${formatNumber(row.orders)}</td>
      <td>${formatCurrency(row.totalAmount)}</td>
    </tr>`
  )).join('');

  const productsRows = topProducts.map((product, index) => (
    `<tr>
      <td>${index + 1}</td>
      <td>${product.name}</td>
      <td>${formatNumber(product.totalQuantity)}</td>
      <td>${formatCurrency(product.totalCost)}</td>
    </tr>`
  )).join('');

  return `<!DOCTYPE html>
  <html>
    <head>
      <meta charset="utf-8" />
      <title>Company Detail Report</title>
      <style>
        body { font-family: Arial, sans-serif; padding: 24px; color: #333; }
        h1, h2 { margin-bottom: 12px; }
        table { width: 100%; border-collapse: collapse; margin-top: 12px; }
        th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
        th { background-color: #f5f5f5; }
        .summary-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin-top: 12px; }
        .summary-card { border: 1px solid #ddd; border-radius: 6px; padding: 12px; background: #fafafa; }
        .summary-card h3 { margin: 0 0 4px 0; font-size: 14px; color: #555; }
        .summary-card p { margin: 0; font-size: 18px; font-weight: bold; }
      </style>
    </head>
    <body>
      <h1>${company.name || 'Company'} - Detail Report</h1>
      <p>Generated on ${new Date().toLocaleString()}</p>
      <section>
        <h2>Company Information</h2>
        <div class="summary-grid">
          <div class="summary-card">
            <h3>Code</h3>
            <p>${company.code || '—'}</p>
          </div>
          <div class="summary-card">
            <h3>Status</h3>
            <p>${company.status || '—'}</p>
          </div>
          <div class="summary-card">
            <h3>Contact</h3>
            <p>${company.contactPerson || company.contact_person || '—'}</p>
          </div>
          <div class="summary-card">
            <h3>Phone</h3>
            <p>${company.phone || '—'}</p>
          </div>
          <div class="summary-card">
            <h3>Email</h3>
            <p>${company.email || '—'}</p>
          </div>
          <div class="summary-card">
            <h3>Address</h3>
            <p>${company.address || '—'}</p>
          </div>
        </div>
      </section>
      <section>
        <h2>Key Metrics</h2>
        <div class="summary-grid">
          <div class="summary-card">
            <h3>Purchase Orders</h3>
            <p>${formatNumber(stats.purchaseOrderCount)}</p>
          </div>
          <div class="summary-card">
            <h3>Total Purchase Amount</h3>
            <p>${formatCurrency(stats.totalPurchaseAmount)}</p>
          </div>
          <div class="summary-card">
            <h3>Products Purchased</h3>
            <p>${formatNumber(stats.totalQuantityOrdered)}</p>
          </div>
          <div class="summary-card">
            <h3>Inventory Items Linked</h3>
            <p>${formatNumber(stats.inventoryItemCount)}</p>
          </div>
        </div>
      </section>
      <section>
        <h2>Purchase Timeline</h2>
        <table>
          <thead>
            <tr>
              <th>Period</th>
              <th>Orders</th>
              <th>Total Amount</th>
            </tr>
          </thead>
          <tbody>${timelineRows || '<tr><td colspan="3" style="text-align:center;">No purchase data available</td></tr>'}</tbody>
        </table>
      </section>
      <section>
        <h2>Recent Purchase Orders</h2>
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Order #</th>
              <th>Date</th>
              <th>Status</th>
              <th>Total Amount</th>
              <th>Items</th>
            </tr>
          </thead>
          <tbody>${purchaseRows || '<tr><td colspan="6" style="text-align:center;">No purchase orders found</td></tr>'}</tbody>
        </table>
      </section>
      <section>
        <h2>Linked Inventory Items</h2>
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Name</th>
              <th>SKU</th>
              <th>Category</th>
              <th>Current Stock</th>
              <th>Cost Price</th>
              <th>Last Updated</th>
            </tr>
          </thead>
          <tbody>${inventoryRows || '<tr><td colspan="7" style="text-align:center;">No inventory items linked</td></tr>'}</tbody>
        </table>
      </section>
      <section>
        <h2>Top Purchased Products</h2>
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Product</th>
              <th>Total Quantity</th>
              <th>Total Cost</th>
            </tr>
          </thead>
          <tbody>${productsRows || '<tr><td colspan="4" style="text-align:center;">No product data available</td></tr>'}</tbody>
        </table>
      </section>
    </body>
  </html>`;
};

const buildCompanyDetailData = async (req, companyId) => {
  const company = await Company.findById(companyId);

  if (!company) {
    const error = new Error('Company not found');
    error.statusCode = 404;
    throw error;
  }

  if (req.user.role === 'WAREHOUSE_KEEPER') {
    if (company.scopeType !== 'WAREHOUSE' || String(company.scopeId) !== String(req.user.warehouseId)) {
      const error = new Error('Access denied');
      error.statusCode = 403;
      throw error;
    }
  } else if (req.user.role === 'CASHIER') {
    if (company.scopeType !== 'BRANCH' || String(company.scopeId) !== String(req.user.branchId)) {
      const error = new Error('Access denied');
      error.statusCode = 403;
      throw error;
    }
  }

  const scopeFilter = getScopeForMetrics(req, company.scopeType, company.scopeId);
  const metricsMap = await fetchCompanyMetrics([company.id], scopeFilter);
  const stats = metricsMap[company.id] ? { ...metricsMap[company.id] } : { ...defaultMetrics };

  const purchaseOrders = await fetchCompanyPurchaseOrders(company.id, scopeFilter);
  const inventoryItems = await fetchCompanyInventoryItems(company.id, scopeFilter);
  const purchaseTimeline = await fetchCompanyPurchaseTimeline(company.id, scopeFilter);
  const topProducts = await fetchCompanyTopProducts(company.id, scopeFilter);

  return {
    company: { ...company },
    stats,
    purchaseOrders,
    inventoryItems,
    purchaseTimeline,
    topProducts
  };
};

// @desc    Get all companies
// @route   GET /api/companies
// @access  Private (Admin, Warehouse Keeper)
const getCompanies = async (req, res, next) => {
  try {
    const { status, scopeType, scopeId, transactionType } = req.query;
    
    // Build conditions object for filtering
    const conditions = {};
    if (status) conditions.status = status;
    if (scopeType) conditions.scopeType = scopeType;
    if (scopeId) conditions.scopeId = scopeId;
    if (transactionType) conditions.transactionType = transactionType;
    
    // Apply role-based filtering
    if (req.user.role === 'WAREHOUSE_KEEPER') {
      // Warehouse keepers can only see companies in their warehouse scope
      conditions.scopeType = 'WAREHOUSE';
      conditions.scopeId = req.user.warehouseId;
    } else if (req.user.role === 'CASHIER') {
      // Cashiers can only see companies in their branch scope
      conditions.scopeType = 'BRANCH';
      conditions.scopeId = req.user.branchId;
    }
    // Admins can see all companies (no additional filtering)
    
    // Get companies using the MySQL-based model
    const companies = await Company.find(conditions, { 
      sort: '-created_at'
    });

    const companyIds = companies.map(company => company.id);
    const scopeFilter = getScopeForMetrics(req, scopeType, scopeId);
    const metricsMap = await fetchCompanyMetrics(companyIds, scopeFilter);

    const companiesWithMetrics = companies.map(company => {
      const plainCompany = { ...company };
      plainCompany.metrics = metricsMap[company.id] ? { ...metricsMap[company.id] } : { ...defaultMetrics };
      return plainCompany;
    });

    const summary = companiesWithMetrics.reduce((acc, company) => {
      const metrics = company.metrics || defaultMetrics;
      acc.totalCompanies += 1;
      acc.totalPurchaseOrders += metrics.purchaseOrderCount || 0;
      acc.totalPurchaseAmount += metrics.totalPurchaseAmount || 0;
      acc.totalProductsPurchased += metrics.totalQuantityOrdered || 0;
      acc.totalInventoryItems += metrics.inventoryItemCount || 0;
      if (!acc.lastPurchaseDate || (metrics.lastPurchaseDate && metrics.lastPurchaseDate > acc.lastPurchaseDate)) {
        acc.lastPurchaseDate = metrics.lastPurchaseDate;
      }
      if (!acc.lastInventoryUpdate || (metrics.lastInventoryUpdate && metrics.lastInventoryUpdate > acc.lastInventoryUpdate)) {
        acc.lastInventoryUpdate = metrics.lastInventoryUpdate;
      }
      return acc;
    }, {
      totalCompanies: 0,
      totalPurchaseOrders: 0,
      totalPurchaseAmount: 0,
      totalProductsPurchased: 0,
      totalInventoryItems: 0,
      lastPurchaseDate: null,
      lastInventoryUpdate: null
    });

    res.json({
      success: true,
      count: companiesWithMetrics.length,
      summary,
      data: companiesWithMetrics
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error retrieving companies',
      error: error.message
    });
  }
};

// @desc    Get single company
// @route   GET /api/companies/:id
// @access  Private (Admin, Warehouse Keeper)
const getCompany = async (req, res, next) => {
  try {
    const company = await Company.findById(req.params.id);
    
    if (!company) {
      return res.status(404).json({
        success: false,
        message: 'Company not found'
      });
    }
    
    res.json({
      success: true,
      data: company
    });
  } catch (error) {
    next(error);
  }
};

const getCompanyDetails = async (req, res, next) => {
  try {
    const companyId = parseInt(req.params.id, 10);
    if (Number.isNaN(companyId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid company id'
      });
    }

    const detail = await buildCompanyDetailData(req, companyId);

    res.json({
      success: true,
      data: detail
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({
        success: false,
        message: error.message
      });
    }
    next(error);
  }
};

// @desc    Create new company
// @route   POST /api/companies
// @access  Private (Admin, Warehouse Keeper with permission)
const createCompany = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation error',
        errors: errors.array()
      });
    }

    const { name, code, contactPerson, phone, email, address, status, scopeType, scopeId, transactionType } = req.body;
    
    // Set default scope based on user role
    let finalScopeType = scopeType;
    let finalScopeId = scopeId;
    
    if (req.user.role === 'WAREHOUSE_KEEPER') {
      finalScopeType = 'WAREHOUSE';
      finalScopeId = req.user.warehouseId;
    } else if (req.user.role === 'CASHIER') {
      finalScopeType = 'BRANCH';
      finalScopeId = req.user.branchId;
    } else if (!scopeType || !scopeId) {
      // Admin creating company without scope - default to COMPANY scope
      finalScopeType = 'COMPANY';
      finalScopeId = 1;
    }

    // Check if scope exists (for validation)
    if (finalScopeType === 'BRANCH') {
      const branch = await Branch.findById(finalScopeId);
      if (!branch) {
        return res.status(400).json({
          success: false,
          message: 'Invalid branch ID'
        });
      }
    } else if (finalScopeType === 'WAREHOUSE') {
      const warehouse = await Warehouse.findById(finalScopeId);
      if (!warehouse) {
        return res.status(400).json({
          success: false,
          message: 'Invalid warehouse ID'
        });
      }
    }

    // Prepare company data
    const normalizeOptional = (v) => (v === undefined || v === '' ? null : v);
    const companyData = {
      name,
      code: normalizeOptional(code),
      contactPerson: normalizeOptional(contactPerson),
      phone: normalizeOptional(phone),
      email: normalizeOptional(email),
      address: normalizeOptional(address),
      status: status || 'active',
      scopeType: finalScopeType,
      scopeId: finalScopeId,
      transactionType: transactionType || 'CASH',
      createdBy: req.user.id
    };

    const company = await Company.create(companyData);
    
    res.status(201).json({
      success: true,
      message: 'Company created successfully',
      data: company
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error creating company',
      error: error.message
    });
  }
};

// @desc    Update company
// @route   PUT /api/companies/:id
// @access  Private (Admin, Warehouse Keeper)
const updateCompany = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation error',
        errors: errors.array()
      });
    }

    const company = await Company.findById(req.params.id);
    
    if (!company) {
      return res.status(404).json({
        success: false,
        message: 'Company not found'
      });
    }

    // Role-based access control
    if (req.user.role === 'WAREHOUSE_KEEPER') {
      if (company.scopeType !== 'WAREHOUSE' || company.scopeId != req.user.warehouseId) {
        return res.status(403).json({
          success: false,
          message: 'Access denied'
        });
      }
    } else if (req.user.role === 'CASHIER') {
      if (company.scopeType !== 'BRANCH' || company.scopeId != req.user.branchId) {
        return res.status(403).json({
          success: false,
          message: 'Access denied'
        });
      }
    }

    const {
      name,
      code,
      contactPerson,
      phone,
      email,
      address,
      status,
      transactionType,
      scopeType,
      scopeId
    } = req.body;

    const updateData = {};
    if (name !== undefined) updateData.name = name;
    if (code !== undefined) updateData.code = code;
    if (contactPerson !== undefined) updateData.contact_person = contactPerson;
    if (phone !== undefined) updateData.phone = phone;
    if (email !== undefined) updateData.email = email;
    if (address !== undefined) updateData.address = address;
    if (status !== undefined) updateData.status = status;
    if (transactionType !== undefined) updateData.transaction_type = transactionType;
    if (scopeType !== undefined) updateData.scope_type = scopeType;
    if (scopeId !== undefined) updateData.scope_id = scopeId;

    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No fields to update'
      });
    }

    await Company.updateOne({ id: req.params.id }, updateData);
    const updatedCompany = await Company.findById(req.params.id);
    
    res.json({
      success: true,
      message: 'Company updated successfully',
      data: updatedCompany
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Delete company
// @route   DELETE /api/companies/:id
// @access  Private (Admin only)
const deleteCompany = async (req, res, next) => {
  try {
    const company = await Company.findById(req.params.id);
    
    if (!company) {
      return res.status(404).json({
        success: false,
        message: 'Company not found'
      });
    }

    // Role-based access control
    if (req.user.role === 'WAREHOUSE_KEEPER') {
      if (company.scopeType !== 'WAREHOUSE' || company.scopeId != req.user.warehouseId) {
        return res.status(403).json({
          success: false,
          message: 'Access denied'
        });
      }
    } else if (req.user.role === 'CASHIER') {
      if (company.scopeType !== 'BRANCH' || company.scopeId != req.user.branchId) {
        return res.status(403).json({
          success: false,
          message: 'Access denied'
        });
      }
    }
    
    await trashService.softDelete('company', company.id, req.user.id);
    
    res.json({
      success: true,
      message: 'Company moved to trash successfully'
    });
  } catch (error) {
    next(error);
  }
};

const exportCompanies = async (req, res) => {
  try {
    const { status, scopeType, scopeId, transactionType, format = 'excel' } = req.query;

    const conditions = {};
    if (status) conditions.status = status;
    if (scopeType) conditions.scopeType = scopeType;
    if (scopeId) conditions.scopeId = scopeId;
    if (transactionType) conditions.transactionType = transactionType;

    if (req.user.role === 'WAREHOUSE_KEEPER') {
      conditions.scopeType = 'WAREHOUSE';
      conditions.scopeId = req.user.warehouseId;
    } else if (req.user.role === 'CASHIER') {
      conditions.scopeType = 'BRANCH';
      conditions.scopeId = req.user.branchId;
    }

    const companies = await Company.find(conditions, { sort: '-created_at' });
    const companyIds = companies.map(company => company.id);
    const scopeFilter = getScopeForMetrics(req, scopeType, scopeId);
    const metricsMap = await fetchCompanyMetrics(companyIds, scopeFilter);

    const rows = companies.map(company => ({
      ...company,
      metrics: metricsMap[company.id] ? { ...metricsMap[company.id] } : { ...defaultMetrics }
    }));

    const summary = rows.reduce((acc, row) => {
      const metrics = row.metrics || defaultMetrics;
      acc.totalCompanies += 1;
      acc.totalPurchaseOrders += metrics.purchaseOrderCount || 0;
      acc.totalPurchaseAmount += metrics.totalPurchaseAmount || 0;
      acc.totalProductsPurchased += metrics.totalQuantityOrdered || 0;
      acc.totalInventoryItems += metrics.inventoryItemCount || 0;
      if (!acc.lastPurchaseDate || (metrics.lastPurchaseDate && metrics.lastPurchaseDate > acc.lastPurchaseDate)) {
        acc.lastPurchaseDate = metrics.lastPurchaseDate;
      }
      if (!acc.lastInventoryUpdate || (metrics.lastInventoryUpdate && metrics.lastInventoryUpdate > acc.lastInventoryUpdate)) {
        acc.lastInventoryUpdate = metrics.lastInventoryUpdate;
      }
      return acc;
    }, {
      totalCompanies: 0,
      totalPurchaseOrders: 0,
      totalPurchaseAmount: 0,
      totalProductsPurchased: 0,
      totalInventoryItems: 0,
      lastPurchaseDate: null,
      lastInventoryUpdate: null
    });

    const normalizedFormat = String(format || 'excel').toLowerCase();

    if (normalizedFormat === 'pdf') {
      const html = buildCompaniesSummaryHtml(rows, summary);
      return res.send(html);
    }

    res.json({
      success: true,
      data: {
        rows,
        summary
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error exporting companies',
      error: error.message
    });
  }
};

const exportCompanyDetails = async (req, res, next) => {
  try {
    const companyId = parseInt(req.params.id, 10);
    if (Number.isNaN(companyId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid company id'
      });
    }

    const detail = await buildCompanyDetailData(req, companyId);
    const normalizedFormat = String(req.query.format || 'excel').toLowerCase();

    if (normalizedFormat === 'pdf') {
      const html = buildCompanyDetailHtml(detail);
      return res.send(html);
    }

    res.json({
      success: true,
      data: detail
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({
        success: false,
        message: error.message
      });
    }
    next(error);
  }
};

module.exports = {
  getCompanies,
  getCompany,
  getCompanyDetails,
  createCompany,
  updateCompany,
  deleteCompany,
  exportCompanies,
  exportCompanyDetails
};
