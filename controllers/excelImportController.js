const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const { pool } = require('../config/database');
const { createStockReportEntry } = require('../middleware/stockTracking');
const { cleanupFile } = require('../middleware/upload');
const { generateUniqueSku } = require('../services/skuGeneratorService');

function buildInventoryExportFilters(req) {
  const { scopeType, scopeId, category, search } = req.query;
  const whereConditions = ['ii.deleted_at IS NULL'];
  const params = [];

  if (req.user.role === 'ADMIN') {
    if (scopeType) {
      whereConditions.push('ii.scope_type = ?');
      params.push(scopeType);
    }
    if (scopeId) {
      whereConditions.push('ii.scope_id = ?');
      params.push(scopeId);
    }
  } else {
    const userBranchId = req.user.branch_id || req.user.branchId;
    const userWarehouseId = req.user.warehouse_id || req.user.warehouseId;

    if (req.user.role === 'WAREHOUSE_KEEPER') {
      if (userWarehouseId) {
        whereConditions.push('ii.scope_type = ? AND ii.scope_id = ?');
        params.push('WAREHOUSE', userWarehouseId);
      } else {
        whereConditions.push('1 = 0');
      }
    } else if (req.user.role === 'CASHIER') {
      if (userBranchId) {
        whereConditions.push('ii.scope_type = ? AND ii.scope_id = ?');
        params.push('BRANCH', userBranchId);
      } else {
        whereConditions.push('1 = 0');
      }
      if (scopeType === 'BRANCH' && scopeId) {
        whereConditions.push('ii.scope_id = ?');
        params.push(scopeId);
      }
    }
  }

  if (category && category !== 'all') {
    whereConditions.push('ii.category = ?');
    params.push(category);
  }

  if (search && String(search).trim()) {
    const like = `%${String(search).trim()}%`;
    whereConditions.push(
      '(ii.name LIKE ? OR ii.category LIKE ? OR ii.description LIKE ? OR ii.barcode LIKE ? OR ii.sku LIKE ?)'
    );
    params.push(like, like, like, like, like);
  }

  return {
    whereClause: whereConditions.length ? `WHERE ${whereConditions.join(' AND ')}` : '',
    params,
  };
}

async function fetchInventoryExportRows(req) {
  const { whereClause, params } = buildInventoryExportFilters(req);

  const [rows] = await pool.execute(
    `
    SELECT
      ii.id,
      ii.sku,
      ii.barcode,
      ii.name,
      ii.category,
      ii.unit,
      ii.scope_type,
      ii.scope_id,
      COALESCE(b.name, w.name, CONCAT(ii.scope_type, ' ', ii.scope_id)) AS location_name,
      COALESCE(lg.opening_balance, 0) AS opening_balance,
      COALESCE(lg.purchases, 0) AS purchases,
      COALESCE(lg.sold, 0) AS sold,
      COALESCE(lg.current_stock, 0) AS current_stock,
      ii.cost_price,
      ii.selling_price
    FROM inventory_items ii
    LEFT JOIN branches b ON ii.scope_type = 'BRANCH' AND ii.scope_id = b.id
    LEFT JOIN warehouses w ON ii.scope_type = 'WAREHOUSE' AND ii.scope_id = w.id
    LEFT JOIN (
      SELECT
        le.inventory_item_id,
        SUM(le.quantity_in - le.quantity_out) AS current_stock,
        SUM(CASE WHEN le.event_type = 'OPENING' THEN le.quantity_in ELSE 0 END) AS opening_balance,
        SUM(CASE WHEN le.event_type = 'PURCHASE' THEN le.quantity_in ELSE 0 END) AS purchases,
        SUM(CASE WHEN le.event_type = 'SALE' THEN le.quantity_out ELSE 0 END) AS sold
      FROM inventory_ledger_entries le
      INNER JOIN inventory_items ix ON ix.id = le.inventory_item_id
        AND le.scope_type = ix.scope_type
        AND (CAST(le.scope_id AS CHAR) COLLATE utf8mb4_bin = CAST(ix.scope_id AS CHAR) COLLATE utf8mb4_bin)
      GROUP BY le.inventory_item_id
    ) lg ON lg.inventory_item_id = ii.id
    ${whereClause}
    ORDER BY ii.name ASC
    `,
    params
  );

  return enrichInventoryExportRows(rows);
}

async function fetchPurchaseOrderDetails(itemIds) {
  if (!itemIds.length) return new Map();

  const placeholders = itemIds.map(() => '?').join(',');
  const [rows] = await pool.execute(
    `
    SELECT
      poi.inventory_item_id,
      po.order_number,
      SUM(COALESCE(poi.quantity_received, poi.quantity_ordered, 0)) AS qty
    FROM purchase_order_items poi
    INNER JOIN purchase_orders po ON po.id = poi.purchase_order_id
    WHERE po.deleted_at IS NULL
      AND poi.inventory_item_id IN (${placeholders})
    GROUP BY poi.inventory_item_id, po.id, po.order_number
    ORDER BY poi.inventory_item_id, po.order_date, po.id
    `,
    itemIds
  );

  const map = new Map();
  rows.forEach((row) => {
    if (!map.has(row.inventory_item_id)) {
      map.set(row.inventory_item_id, { names: [], details: [] });
    }
    const entry = map.get(row.inventory_item_id);
    if (!entry.names.includes(row.order_number)) {
      entry.names.push(row.order_number);
    }
    entry.details.push({
      po: row.order_number,
      qty: Number(row.qty) || 0,
    });
  });

  return map;
}

async function fetchSaleInvoiceDetails(itemIds) {
  if (!itemIds.length) return new Map();

  const placeholders = itemIds.map(() => '?').join(',');
  const [rows] = await pool.execute(
    `
    SELECT
      si.inventory_item_id,
      s.invoice_no,
      SUM(si.quantity) AS qty
    FROM sale_items si
    INNER JOIN sales s ON s.id = si.sale_id
    WHERE s.deleted_at IS NULL
      AND si.inventory_item_id IN (${placeholders})
    GROUP BY si.inventory_item_id, s.id, s.invoice_no
    ORDER BY si.inventory_item_id, s.created_at, s.id
    `,
    itemIds
  );

  const map = new Map();
  rows.forEach((row) => {
    if (!map.has(row.inventory_item_id)) {
      map.set(row.inventory_item_id, []);
    }
    map.get(row.inventory_item_id).push({
      invoice: row.invoice_no || '',
      qty: Number(row.qty) || 0,
    });
  });

  return map;
}

async function enrichInventoryExportRows(rows) {
  const itemIds = rows.map((row) => row.id).filter(Boolean);
  const [poMap, saleMap] = await Promise.all([
    fetchPurchaseOrderDetails(itemIds),
    fetchSaleInvoiceDetails(itemIds),
  ]);

  return rows.map((row) => {
    const po = poMap.get(row.id) || { names: [], details: [] };
    const invoices = saleMap.get(row.id) || [];

    return {
      ...row,
      po_names: po.names.join(', '),
      po_details_json: po.details.length ? JSON.stringify(po.details) : '[]',
      invoice_count: invoices.length,
      sold_invoices_json: invoices.length ? JSON.stringify(invoices) : '[]',
    };
  });
}

const BASE_COLUMN_WIDTHS = [
  { wch: 28 },
  { wch: 16 },
  { wch: 36 },
  { wch: 16 },
  { wch: 8 },
];

const LOCATION_COLUMN_WIDTHS = [{ wch: 14 }, { wch: 22 }];

const METRIC_COLUMN_WIDTHS = [
  { wch: 16 },
  { wch: 12 },
  { wch: 28 },
  { wch: 10 },
  { wch: 14 },
  { wch: 52 },
  { wch: 14 },
  { wch: 12 },
  { wch: 14 },
];

function getSheetColumnWidths(includeLocationColumns = true) {
  return includeLocationColumns
    ? [...BASE_COLUMN_WIDTHS, ...LOCATION_COLUMN_WIDTHS, ...METRIC_COLUMN_WIDTHS]
    : [...BASE_COLUMN_WIDTHS, ...METRIC_COLUMN_WIDTHS];
}

function sanitizeSheetName(name, fallback = 'Sheet') {
  const cleaned = String(name || fallback)
    .replace(/[\\/?*[\]:]/g, ' ')
    .trim()
    .slice(0, 31);
  return cleaned || fallback;
}

function buildSheetRows(rows, { includeLocationColumns = true } = {}) {
  const metricHeaders = [
    'Opening Balance',
    'Purchases',
    'PO Names',
    'Sold',
    'Invoice Count',
    'Sold Invoices (JSON)',
    'Current Stock',
    'Cost Price',
    'Selling Price',
  ];

  const headers = includeLocationColumns
    ? [
        'SKU',
        'Barcode',
        'Product Name',
        'Category',
        'Unit',
        'Location Type',
        'Location',
        ...metricHeaders,
      ]
    : ['SKU', 'Barcode', 'Product Name', 'Category', 'Unit', ...metricHeaders];

  const sheetRows = [
    headers,
    ...rows.map((row) => {
      const base = [
        row.sku || '',
        row.barcode || '',
        row.name || '',
        row.category || '',
        row.unit || '',
      ];

      if (includeLocationColumns) {
        base.push(row.scope_type || '', row.location_name || '');
      }

      base.push(
        Number(row.opening_balance) || 0,
        Number(row.purchases) || 0,
        row.po_names || '',
        Number(row.sold) || 0,
        Number(row.invoice_count) || 0,
        row.sold_invoices_json || '[]',
        Number(row.current_stock) || 0,
        Number(row.cost_price) || 0,
        Number(row.selling_price) || 0
      );

      return base;
    }),
  ];

  if (rows.length > 0) {
    const totals = rows.reduce(
      (acc, row) => ({
        opening: acc.opening + (Number(row.opening_balance) || 0),
        purchases: acc.purchases + (Number(row.purchases) || 0),
        sold: acc.sold + (Number(row.sold) || 0),
        current: acc.current + (Number(row.current_stock) || 0),
        invoices: acc.invoices + (Number(row.invoice_count) || 0),
      }),
      { opening: 0, purchases: 0, sold: 0, current: 0, invoices: 0 }
    );

    const totalPrefix = includeLocationColumns
      ? ['', '', 'TOTAL', '', '', '', '']
      : ['', '', 'TOTAL', '', ''];

    sheetRows.push([
      ...totalPrefix,
      totals.opening,
      totals.purchases,
      '',
      totals.sold,
      totals.invoices,
      '',
      totals.current,
      '',
      '',
    ]);
  }

  return sheetRows;
}

function appendSheet(workbook, sheetName, rows, options = {}) {
  const worksheet = XLSX.utils.aoa_to_sheet(buildSheetRows(rows, options));
  worksheet['!cols'] = getSheetColumnWidths(options.includeLocationColumns !== false);
  XLSX.utils.book_append_sheet(workbook, worksheet, sanitizeSheetName(sheetName));
}

function groupRowsByLocation(rows) {
  const groups = new Map();

  rows.forEach((row) => {
    const key = `${row.scope_type}::${row.scope_id}`;
    if (!groups.has(key)) {
      groups.set(key, {
        scopeType: row.scope_type,
        locationName: row.location_name || `${row.scope_type} ${row.scope_id}`,
        rows: [],
      });
    }
    groups.get(key).rows.push(row);
  });

  return [...groups.values()].sort((a, b) => {
    if (a.scopeType !== b.scopeType) {
      return a.scopeType === 'WAREHOUSE' ? -1 : 1;
    }
    return String(a.locationName).localeCompare(String(b.locationName));
  });
}

function buildInventoryWorkbook(rows, { separateByLocation = true } = {}) {
  const workbook = XLSX.utils.book_new();

  if (separateByLocation) {
    const groups = groupRowsByLocation(rows);

    groups.forEach((group) => {
      const prefix = group.scopeType === 'WAREHOUSE' ? 'WH' : 'Branch';
      appendSheet(workbook, `${prefix} - ${group.locationName}`, group.rows, {
        includeLocationColumns: false,
      });
    });

    appendSheet(workbook, 'All Items', rows, { includeLocationColumns: true });
  } else {
    appendSheet(workbook, 'Inventory Stock', rows, { includeLocationColumns: true });
  }

  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

// @desc    Import inventory data from Excel file
// @route   POST /api/inventory/import-excel
// @access  Private (Admin, Warehouse Keeper)
const importInventoryFromExcel = async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No file uploaded'
      });
    }

    const filePath = req.file.path;
    const { scopeType, scopeId } = req.body;

    // Validate required parameters
    if (!scopeType || !scopeId) {
      cleanupFile(filePath);
      return res.status(400).json({
        success: false,
        message: 'scopeType and scopeId are required'
      });
    }

    // Validate scopeType
    if (!['BRANCH', 'WAREHOUSE'].includes(scopeType)) {
      cleanupFile(filePath);
      return res.status(400).json({
        success: false,
        message: 'scopeType must be either BRANCH or WAREHOUSE'
      });
    }

    // Read Excel file
    const workbook = XLSX.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    
    // Convert to JSON
    const jsonData = XLSX.utils.sheet_to_json(worksheet, {
      header: 1, // Use first row as headers
      defval: '' // Default value for empty cells
    });

    if (jsonData.length < 2) {
      cleanupFile(filePath);
      return res.status(400).json({
        success: false,
        message: 'Excel file must contain at least a header row and one data row'
      });
    }

    // Extract headers and data
    const headers = jsonData[0];
    const dataRows = jsonData.slice(1);

    // Expected column mapping
    const expectedColumns = {
      'name': ['name', 'item_name', 'product_name', 'item name', 'product name'],
      'code': ['code', 'item_code', 'product_code', 'sku', 'item code', 'product code'],
      'barcode': ['barcode', 'bar code', 'ean', 'upc', 'gtin', 'scan code'],
      'category': ['category', 'item_category', 'product_category', 'item category', 'product category'],
      'description': ['description', 'item_description', 'product_description', 'item description', 'product description'],
      'current_stock': ['current_stock', 'stock', 'quantity', 'qty', 'current stock', 'available stock'],
      'min_stock_level': ['min_stock_level', 'min_stock', 'minimum_stock', 'min stock', 'minimum stock', 'reorder_level'],
      'max_stock_level': ['max_stock_level', 'max_stock', 'maximum_stock', 'max stock', 'maximum stock'],
      'unit_price': ['unit_price', 'price', 'cost', 'unit price', 'selling_price', 'selling price'],
      'cost_price': ['cost_price', 'cost', 'purchase_price', 'cost price', 'purchase price'],
      'unit': ['unit', 'unit_of_measure', 'uom', 'unit of measure', 'measurement_unit']
    };

    // Map headers to expected fields
    const headerMapping = {};
    headers.forEach((header, index) => {
      if (header) {
        const normalizedHeader = header.toString().toLowerCase().trim();
        Object.keys(expectedColumns).forEach(field => {
          if (expectedColumns[field].includes(normalizedHeader)) {
            headerMapping[field] = index;
          }
        });
      }
    });

    // Validate required fields
    const requiredFields = ['name', 'current_stock'];
    const missingFields = requiredFields.filter(field => headerMapping[field] === undefined);
    
    if (missingFields.length > 0) {
      cleanupFile(filePath);
      return res.status(400).json({
        success: false,
        message: `Missing required columns: ${missingFields.join(', ')}`,
        expectedColumns: Object.keys(expectedColumns),
        foundColumns: headers
      });
    }

    // Process data rows
    const inventoryItems = [];
    const errors = [];
    const warnings = [];

    dataRows.forEach((row, rowIndex) => {
      try {
        // Skip empty rows
        if (row.every(cell => !cell || cell.toString().trim() === '')) {
          return;
        }

        const item = {
          name: row[headerMapping.name]?.toString().trim() || '',
          // Never trust/accept SKU from Excel content; backend always generates SKU.
          code: row[headerMapping.code]?.toString().trim() || '',
          barcode: headerMapping.barcode !== undefined 
            ? (row[headerMapping.barcode]?.toString().trim() || '')
            : '',
          category: row[headerMapping.category]?.toString().trim() || 'General',
          description: row[headerMapping.description]?.toString().trim() || '',
          current_stock: parseFloat(row[headerMapping.current_stock]) || 0,
          min_stock_level: parseFloat(row[headerMapping.min_stock_level]) || 0,
          max_stock_level: parseFloat(row[headerMapping.max_stock_level]) || 0,
          unit_price: parseFloat(row[headerMapping.unit_price]) || 0,
          cost_price: parseFloat(row[headerMapping.cost_price]) || 0,
          unit: row[headerMapping.unit]?.toString().trim() || 'pcs',
          scope_type: scopeType,
          scope_id: scopeId, // Use scopeId as numeric ID (branch/warehouse ID)
          status: 'ACTIVE',
          created_at: new Date(),
          updated_at: new Date()
        };

        // Validate item data
        if (!item.name) {
          errors.push(`Row ${rowIndex + 2}: Name is required`);
          return;
        }

        // SKU/Code is now optional - no validation needed

        if (item.current_stock < 0) {
          warnings.push(`Row ${rowIndex + 2}: Negative stock value for ${item.name}`);
        }

        if (item.unit_price < 0) {
          warnings.push(`Row ${rowIndex + 2}: Negative unit price for ${item.name}`);
        }

        inventoryItems.push(item);
      } catch (error) {
        errors.push(`Row ${rowIndex + 2}: ${error.message}`);
      }
    });

    // If there are critical errors, return them
    if (errors.length > 0) {
      cleanupFile(filePath);
      return res.status(400).json({
        success: false,
        message: 'Validation errors found in Excel file',
        errors: errors,
        warnings: warnings
      });
    }

    // Insert inventory items into database
    const insertedItems = [];
    const duplicateItems = [];
    const failedItems = [];

    const reservedSkus = new Set();
    for (const item of inventoryItems) {
      try {
        const finalSku = await generateUniqueSku({
          scopeType: item.scope_type,
          scopeId: item.scope_id,
          name: item.name,
          connection: pool,
          reservedSkus,
        });

        // If barcode exists, ensure uniqueness within the same scope
        if (item.barcode && item.barcode.trim() !== '') {
          const [existingBarcode] = await pool.execute(
            'SELECT id FROM inventory_items WHERE barcode = ? AND scope_type = ? AND scope_id = ?',
            [item.barcode, item.scope_type, item.scope_id]
          );

          if (existingBarcode.length > 0) {
            duplicateItems.push({
              name: item.name,
              sku: finalSku,
              barcode: item.barcode,
              reason: 'Item with this barcode already exists'
            });
            continue;
          }
        }

        // Insert new item
        const [result] = await pool.execute(`
          INSERT INTO inventory_items (
            name, sku, barcode, category, description, current_stock, min_stock_level, 
            max_stock_level, selling_price, cost_price, unit, scope_type, scope_id, 
            created_by, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          item.name, finalSku, item.barcode || null, item.category, item.description, item.current_stock,
          item.min_stock_level, item.max_stock_level, item.unit_price, item.cost_price,
          item.unit, item.scope_type, item.scope_id, req.user.id, item.created_at, item.updated_at
        ]);

        // Create stock report entry for initial inventory creation
        if (item.current_stock > 0) {
          try {
            await createStockReportEntry({
              inventoryItemId: result.insertId,
              transactionType: 'PURCHASE', // Initial stock is treated as a purchase
              quantityChange: item.current_stock,
              previousQuantity: 0,
              newQuantity: item.current_stock,
              unitPrice: item.cost_price || 0,
              totalValue: (item.cost_price || 0) * item.current_stock,
              userId: req.user.id,
              userName: req.user.name || req.user.username,
              userRole: req.user.role,
              adjustmentReason: 'Initial inventory creation via Excel import'
            });
          } catch (stockError) {
            // Don't fail the import if stock tracking fails
          }
        }

        insertedItems.push({
          id: result.insertId,
          name: item.name,
          sku: finalSku
        });
      } catch (error) {
        failedItems.push({
          name: item.name,
          sku: null,
          reason: error.message
        });
      }
    }

    // Cleanup uploaded file
    cleanupFile(filePath);

    // Return results
    res.json({
      success: true,
      message: 'Excel import completed',
      summary: {
        totalRows: dataRows.length,
        processedItems: inventoryItems.length,
        insertedItems: insertedItems.length,
        duplicateItems: duplicateItems.length,
        failedItems: failedItems.length,
        warnings: warnings.length
      },
      insertedItems: insertedItems,
      duplicateItems: duplicateItems,
      failedItems: failedItems,
      warnings: warnings
    });

  } catch (error) {
    // Cleanup file on error
    if (req.file) {
      cleanupFile(req.file.path);
    }
    
    res.status(500).json({
      success: false,
      message: 'Error processing Excel file',
      error: error.message
    });
  }
};

// @desc    Get Excel template for inventory import
// @route   GET /api/inventory/excel-template
// @access  Private (Admin, Warehouse Keeper)
const getExcelTemplate = async (req, res, next) => {
  try {
    // Create sample data for template (min/max stock columns removed)
    const sampleData = [
      ['name', 'barcode', 'category', 'description', 'current_stock', 'unit_price', 'cost_price', 'unit'],
      ['Sample Product 1', '1234567890123', 'Electronics', 'Sample electronic product', '100', '25.50', '20.00', 'pcs'],
      ['Sample Product 2', '9876543210987', 'Clothing', 'Sample clothing item', '50', '15.75', '12.00', 'pcs'],
      ['Sample Product 3', '4567890123456', 'Books', 'Sample book', '75', '12.00', '8.50', 'pcs']
    ];

    // Create workbook
    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.aoa_to_sheet(sampleData);

    // Set column widths (min/max columns removed)
    const columnWidths = [
      { wch: 20 }, // name
      { wch: 18 }, // barcode
      { wch: 15 }, // category
      { wch: 30 }, // description
      { wch: 15 }, // current_stock
      { wch: 15 }, // unit_price
      { wch: 15 }, // cost_price
      { wch: 10 }  // unit
    ];
    worksheet['!cols'] = columnWidths;

    XLSX.utils.book_append_sheet(workbook, worksheet, 'Inventory Template');

    // Generate Excel file buffer
    const excelBuffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

    // Set response headers
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=inventory_template.xlsx');
    res.setHeader('Content-Length', excelBuffer.length);

    res.send(excelBuffer);
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error generating Excel template',
      error: error.message
    });
  }
};

// @desc    Export inventory stock summary to Excel
// @route   GET /api/inventory/export-excel
// @access  Private (Admin, Warehouse Keeper, Cashier)
const exportInventoryExcel = async (req, res) => {
  try {
    const rows = await fetchInventoryExportRows(req);
    const excelBuffer = buildInventoryWorkbook(rows);
    const dateStamp = new Date().toISOString().split('T')[0];
    const filename = `inventory-stock-by-location-${dateStamp}.xlsx`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
    res.setHeader('Content-Length', excelBuffer.length);
    res.send(excelBuffer);
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error exporting inventory Excel file',
      error: error.message,
    });
  }
};

module.exports = {
  importInventoryFromExcel,
  getExcelTemplate,
  exportInventoryExcel,
  fetchInventoryExportRows,
  enrichInventoryExportRows,
  buildInventoryWorkbook,
};
