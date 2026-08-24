const { validationResult } = require('express-validator');
const InventoryItem = require('../models/InventoryItem');
const Branch = require('../models/Branch');
const Warehouse = require('../models/Warehouse');
const { executeQuery, pool } = require('../config/database');
const { createStockReportEntry, createAdjustmentTransaction } = require('../middleware/stockTracking');
const trashService = require('../services/trashService');
const { getBatchItemSummaries, normalizeScope, ledgerScopedQuantitySubquery } = require('../services/inventoryLedgerService');
const InventoryProjection = require('../services/inventoryProjectionService');
const { generateUniqueSku } = require('../services/skuGeneratorService');

// Helper to normalise date strings to YYYY-MM-DD
const normalizeDateInput = (value) => {
  if (!value && value !== 0) return null;

  if (value instanceof Date) {
    return !isNaN(value.getTime()) ? value.toISOString().split('T')[0] : null;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;

    // Already ISO formatted
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      return trimmed;
    }

    // Attempt to parse using Date constructor
    const directDate = new Date(trimmed);
    if (!isNaN(directDate.getTime())) {
      return directDate.toISOString().split('T')[0];
    }

    // Handle DD/MM/YYYY or MM/DD/YYYY variations
    const match = trimmed.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
    if (match) {
      let [ , part1, part2, part3 ] = match;
      let day;
      let month;
      let year = parseInt(part3, 10);

      // Determine if format is DD/MM or MM/DD
      const first = parseInt(part1, 10);
      const second = parseInt(part2, 10);

      if (first > 12 && second <= 12) {
        // Clearly DD/MM
        day = first;
        month = second;
      } else if (second > 12 && first <= 12) {
        // Clearly MM/DD
        month = first;
        day = second;
      } else {
        // Ambiguous, fallback to MM/DD (default for many locales)
        month = first;
        day = second;
      }

      if (year < 100) {
        year += year >= 70 ? 1900 : 2000; // simple two-digit year handling
      }

      const composed = new Date(year, month - 1, day);
      if (!isNaN(composed.getTime())) {
        return composed.toISOString().split('T')[0];
      }
    }
  }

  return null;
};

// @desc    Get all inventory items
// @route   GET /api/inventory
// @access  Private (Admin, Warehouse Keeper, Cashier)
const getInventoryItems = async (req, res, next) => {
  try {
    
    const { scopeType, scopeId, category, includeCrossBranch = false, supplierId, search } = req.query;

    // Pagination defaults
    const isLimitAll = typeof req.query.limit === 'string' && req.query.limit.toLowerCase() === 'all';
    let page = parseInt(req.query.page, 10);
    let limit = parseInt(req.query.limit, 10);
    if (!Number.isFinite(page) || page < 1) page = 1;
    if (isLimitAll) {
      limit = 1000000;
      page = 1;
    }
    if (!Number.isFinite(limit) || limit < 1) limit = 25;
    if (!isLimitAll && limit > 1000000) limit = 1000000;
    const offset = isLimitAll ? 0 : (page - 1) * limit;

    let whereConditions = ['i.deleted_at IS NULL'];
    let params = [];
    
    if (req.user.role === 'ADMIN') {
      if (scopeType) {
        whereConditions.push('i.scope_type = ?');
        params.push(scopeType);
      }
      if (scopeId) {
        whereConditions.push('i.scope_id = ?');
        params.push(scopeId);
      }
    } else {
      const userBranchId = req.user.branch_id || req.user.branchId;
      const userWarehouseId = req.user.warehouse_id || req.user.warehouseId;
      
      if (req.user.role === 'WAREHOUSE_KEEPER') {
        if (userWarehouseId) {
          whereConditions.push('i.scope_type = ? AND i.scope_id = ?');
          params.push('WAREHOUSE', userWarehouseId);
        } else {
          whereConditions.push('1 = 0');
        }
      } else if (req.user.role === 'CASHIER') {
        if (userBranchId) {
          whereConditions.push('i.scope_type = ? AND i.scope_id = ?');
          params.push('BRANCH', userBranchId);
        } else {
          whereConditions.push('1 = 0');
        }
        if (scopeType === 'BRANCH' && scopeId) {
          whereConditions.push('i.scope_id = ?');
          params.push(scopeId);
        }
      }
    }
    
    if (category) {
      whereConditions.push('category = ?');
      params.push(category);
    }
    
    if (supplierId) {
      whereConditions.push('i.supplier_id = ?');
      params.push(supplierId);
    }

    if (search && search.trim()) {
      const like = `%${search.trim()}%`;
      whereConditions.push('(i.name LIKE ? OR i.category LIKE ? OR i.description LIKE ? OR i.barcode LIKE ? OR i.sku LIKE ?)');
      params.push(like, like, like, like, like);
    }
    
    const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';
    

    // Total count for pagination
    const countRows = await executeQuery(`
      SELECT COUNT(*) as count
      FROM inventory_items i
      ${whereClause}
    `, params);
    const total = countRows?.[0]?.count || 0;

    const inventoryItems = await executeQuery(`
      SELECT 
        i.*,
        b.name as branch_name,
        w.name as warehouse_name,
        c.name as supplier_name,
        c.contact_person as supplier_contact,
        c.phone as supplier_phone,
        c.email as supplier_email,
        COALESCE(pr.pending_returns, 0) as pending_returns
      FROM inventory_items i
      LEFT JOIN branches b ON i.scope_type = 'BRANCH' AND i.scope_id = b.id
      LEFT JOIN warehouses w ON i.scope_type = 'WAREHOUSE' AND i.scope_id = w.id
      LEFT JOIN companies c ON i.supplier_id = c.id
      LEFT JOIN (
        SELECT 
          sri.inventory_item_id,
          SUM(sri.remaining_quantity) AS pending_returns
        FROM sales_return_items sri
        WHERE sri.remaining_quantity > 0
        GROUP BY sri.inventory_item_id
      ) pr ON i.id = pr.inventory_item_id
      ${whereClause}
      ORDER BY i.created_at DESC
      LIMIT ? OFFSET ?
    `, [...params, limit, offset]);
    

    // Transform field names to match frontend expectations
    let transformedItems = inventoryItems.map(item => {
      const rawPending = parseFloat(item.pending_returns) || 0;

      return {
        id: item.id,
        name: item.name,
        sku: item.sku,
        barcode: item.barcode,
        description: item.description,
        category: item.category,
        unit: item.unit,
        costPrice: item.cost_price,
        sellingPrice: item.selling_price,
        currentStock: parseFloat(item.current_stock) || 0,
        minStockLevel: item.min_stock_level,
        maxStockLevel: item.max_stock_level,
        scopeType: item.scope_type,
        scopeId: item.scope_id,
        createdBy: item.created_by,
        createdAt: item.created_at,
        updatedAt: item.updated_at,
        branchName: item.branch_name,
        warehouseName: item.warehouse_name,
        totalPurchased: 0,
        totalSold: 0,
        totalReturned: 0,
        totalRestocked: 0,
        pendingReturns: rawPending,
        totalAdjusted: 0,
        supplierId: item.supplier_id,
        supplierName: item.supplier_name,
        supplierContact: item.supplier_contact,
        supplierPhone: item.supplier_phone,
        supplierEmail: item.supplier_email,
        purchaseDate: item.purchase_date,
        purchasePrice: parseFloat(item.purchase_price) || null
      };
    });

    if (transformedItems.length > 0) {
      try {
        const ids = transformedItems.map((t) => t.id);
        const batch = await getBatchItemSummaries(ids);
        const flowRows = await executeQuery(
          `
          SELECT
            i.id AS inventory_item_id,
            COALESCE(pur.total_purchased, 0) AS total_purchased,
            COALESCE(sol.total_sold, 0) AS total_sold,
            COALESCE(ret.total_returned, 0) AS total_returned
          FROM inventory_items i
          LEFT JOIN (
            SELECT
              poi.inventory_item_id,
              SUM(COALESCE(poi.quantity_received, 0)) AS total_purchased
            FROM purchase_order_items poi
            INNER JOIN purchase_orders po ON po.id = poi.purchase_order_id
            WHERE po.deleted_at IS NULL
              AND po.status = 'COMPLETED'
            GROUP BY poi.inventory_item_id
          ) pur ON pur.inventory_item_id = i.id
          LEFT JOIN (
            SELECT
              si.inventory_item_id,
              SUM(COALESCE(si.quantity, 0)) AS total_sold
            FROM sale_items si
            INNER JOIN sales s ON s.id = si.sale_id
            WHERE s.deleted_at IS NULL
            GROUP BY si.inventory_item_id
          ) sol ON sol.inventory_item_id = i.id
          LEFT JOIN (
            SELECT
              sri.inventory_item_id,
              SUM(COALESCE(sri.quantity, 0)) AS total_returned
            FROM sales_return_items sri
            GROUP BY sri.inventory_item_id
          ) ret ON ret.inventory_item_id = i.id
          WHERE i.id IN (${ids.map(() => '?').join(',')})
          `,
          ids
        );
        const flowMap = new Map(
          flowRows.map((r) => [
            r.inventory_item_id,
            {
              purchased: parseFloat(r.total_purchased) || 0,
              sold: parseFloat(r.total_sold) || 0,
              returned: parseFloat(r.total_returned) || 0,
            },
          ])
        );
        transformedItems = transformedItems.map((t) => {
          const L = batch.get(t.id);
          const F = flowMap.get(t.id) || { purchased: 0, sold: 0, returned: 0 };
          if (!L) {
            const grossSold = parseFloat(F.sold) || 0;
            const returnedQty = parseFloat(F.returned) || 0;
            return {
              ...t,
              totalPurchased: F.purchased,
              totalSold: grossSold,
              netSold: Math.max(0, grossSold - returnedQty),
              totalReturned: returnedQty,
              openingBalance: 0,
              totalPurchaseIn: parseFloat(F.purchased) || 0,
              ledgerMathOk: true,
              ledgerMathDelta: 0,
            };
          }
          const ledgerHasSignal =
            Math.abs(parseFloat(L.current_stock) || 0) > 0.0001 ||
            Math.abs(parseFloat(L.purchased) || 0) > 0.0001 ||
            Math.abs(parseFloat(L.sold) || 0) > 0.0001 ||
            Math.abs(parseFloat(L.returned) || 0) > 0.0001 ||
            Math.abs(parseFloat(L.opening) || 0) > 0.0001;
          const openingBal = parseFloat(L.opening) || 0;
          const poPurchased = parseFloat(F.purchased) || 0;
          const grossSold = parseFloat(F.sold) || 0;
          const returnedQty = parseFloat(F.returned) || 0;
          const restockedQty = parseFloat(L.restocked) || 0;
          const ledgerQty = parseFloat(L.current_stock) || 0;
          const netSold = Math.max(0, grossSold - returnedQty - restockedQty);
          /** Opening + completed PO receipts — what users usually mean by “total purchase” */
          const totalPurchaseIn = openingBal + poPurchased;
          /** Recompute on-hand from movement buckets (must match ledgerQty when data is consistent). */
          const computedNet =
            openingBal +
            poPurchased -
            grossSold +
            returnedQty +
            restockedQty +
            (parseFloat(L.transfer_in) || 0) -
            (parseFloat(L.transfer_out) || 0) +
            (parseFloat(L.adjustments) || 0);
          const ledgerMathDelta = ledgerQty - computedNet;
          const ledgerMathOk = Math.abs(ledgerMathDelta) < 0.01;
          return {
            ...t,
            // When ledger has activity, on-hand comes from the ledger; purchased/sold from PO + invoices.
            currentStock: ledgerHasSignal ? ledgerQty : t.currentStock,
            openingBalance: openingBal,
            totalPurchased: poPurchased,
            totalSold: grossSold,
            netSold,
            totalReturned: returnedQty,
            totalPurchaseIn,
            ledgerMathOk,
            ledgerMathDelta,
            totalRestocked: L.restocked,
            totalAdjusted: L.adjustments,
            ledgerSummary: {
              opening: L.opening,
              purchaseOrders: poPurchased,
              sold: grossSold,
              netSold,
              returned: L.returned,
              restocked: L.restocked,
              transferIn: L.transfer_in,
              transferOut: L.transfer_out,
              adjustments: L.adjustments,
              currentStockFromLedger: L.current_stock,
              totalPurchaseIn,
              computedNetFromBuckets: computedNet,
              expectedStock: computedNet,
            },
          };
        });
      } catch (e) {
      }
    }
    
    res.json({
      success: true,
      count: transformedItems.length,
      total,
      page,
      limit,
      data: transformedItems,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error retrieving inventory items',
      error: error.message
    });
  }
};
// @desc    Get single inventory item
// @route   GET /api/inventory/:id
// @access  Private (Admin, Warehouse Keeper, Cashier)
const getInventoryItem = async (req, res, next) => {
  try {
    const { id } = req.params;
    
    const inventoryItem = await InventoryItem.findById(id);
    if (!inventoryItem) {
      return res.status(404).json({
        success: false,
        message: 'Inventory item not found'
      });
    }
    
    // Check access permissions
    if (req.user.role !== 'ADMIN') {
      if (req.user.role === 'WAREHOUSE_KEEPER' && 
          (inventoryItem.scopeType !== 'WAREHOUSE' || parseInt(inventoryItem.scopeId) !== parseInt(req.user.warehouseId))) {
        return res.status(403).json({
          success: false,
          message: 'Access denied'
        });
      }
      
      if (req.user.role === 'CASHIER' && inventoryItem.scopeType !== 'BRANCH') {
        return res.status(403).json({
          success: false,
          message: 'Access denied - Cashiers can only access branch inventory'
        });
      }
    }
    
    res.json({
      success: true,
      data: inventoryItem
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error retrieving inventory item',
      error: error.message
    });
  }
};

// @desc    Create new inventory item
// @route   POST /api/inventory
// @access  Private (Admin, Warehouse Keeper)
const createInventoryItem = async (req, res, next) => {
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
      barcode,
      name,
      description,
      category,
      unit,
      costPrice,
      sellingPrice,
      minStockLevel,
      maxStockLevel,
      currentStock,
      scopeType,
      scopeId,
      supplierId,
      supplierName,
      purchaseDate,
      purchasePrice
    } = req.body;

    // Debug: log incoming payload and validation results

    // Normalise numeric fields to avoid unexpected types or undefined values
    const numericFields = {
      costPrice: 'float',
      sellingPrice: 'float',
      currentStock: 'int',
      minStockLevel: 'int',
      maxStockLevel: 'int',
      purchasePrice: 'float'
    };

    const normalizedBody = { ...req.body };
    Object.entries(numericFields).forEach(([field, type]) => {
      if (Object.prototype.hasOwnProperty.call(normalizedBody, field)) {
        const val = normalizedBody[field];
        if (val === null || val === '' || typeof val === 'undefined') {
          normalizedBody[field] = null;
        } else {
          const parsed = type === 'int' ? parseInt(val, 10) : parseFloat(val);
          normalizedBody[field] = Number.isNaN(parsed) ? null : parsed;
        }
      } else {
        // Ensure optional numeric fields are explicit null when missing
        normalizedBody[field] = null;
      }
    });

    // Some DB schemas don't allow NULL for min/max stock; default to 0 to avoid SQL errors
    if (normalizedBody.minStockLevel === null) {
      normalizedBody.minStockLevel = 0;
    }
    if (normalizedBody.maxStockLevel === null) {
      normalizedBody.maxStockLevel = 0;
    }

    // Check permissions - cashiers are now allowed to create inventory items
    // Permission checking is handled by middleware (checkCashierInventoryPermission)

    // Warehouse keepers can only create items for their assigned warehouse
    if (req.user.role === 'WAREHOUSE_KEEPER') {
      if (scopeType !== 'WAREHOUSE' || parseInt(scopeId) !== parseInt(req.user.warehouseId)) {
        return res.status(403).json({
          success: false,
          message: 'Warehouse keepers can only create items for their assigned warehouse'
        });
      }
    }

    // Get branch/warehouse name for scope_id
    let scopeName = '';
    if (scopeType === 'BRANCH' && scopeId) {
      const [branches] = await pool.execute('SELECT name FROM branches WHERE id = ?', [scopeId]);
      scopeName = branches[0]?.name || scopeId;
    } else if (scopeType === 'WAREHOUSE' && scopeId) {
      const [warehouses] = await pool.execute('SELECT name FROM warehouses WHERE id = ?', [scopeId]);
      scopeName = warehouses[0]?.name || scopeId;
    } else {
      scopeName = scopeId || '';
    }

    // SKU is always system-generated to keep scope uniqueness reliable.
    const finalSku = await generateUniqueSku({
      scopeType,
      scopeId: scopeName,
      name,
      connection: pool,
    });

// Find this section in createInventoryItem, just before the InventoryItem.create() call:
const rawItemData = {
  sku: finalSku,
  barcode: normalizedBody.barcode ?? null,
  name,
  description: description ?? null,
  category: category || 'General',
  unit: unit || 'piece',
  costPrice: normalizedBody.costPrice ?? 0,
  sellingPrice: normalizedBody.sellingPrice ?? 0,
  minStockLevel: normalizedBody.minStockLevel ?? 0,
  maxStockLevel: normalizedBody.maxStockLevel ?? 0,
  currentStock: (parseFloat(normalizedBody.currentStock) || 0) > 0 ? 0 : (normalizedBody.currentStock ?? 0),
  scopeType: scopeType ?? null,        // ← was: scopeType (undefined when missing)
  scopeId: scopeId ?? null,            // ← was: scopeId (undefined when missing)
  createdBy: req.user.id,
  supplierId: supplierId ?? null,
  supplierName: supplierName ?? null,
  purchaseDate: normalizeDateInput(purchaseDate),
  purchasePrice: normalizedBody.purchasePrice ?? null
};    // Defensive: convert any undefined values to null before creating DB record
    const undefinedFields = Object.entries(rawItemData).filter(([k, v]) => typeof v === 'undefined').map(([k]) => k);
    if (undefinedFields.length) {
    }
    const safeItemData = Object.fromEntries(Object.entries(rawItemData).map(([k, v]) => [k, typeof v === 'undefined' ? null : v]));

    const inventoryItem = await InventoryItem.create(safeItemData);

    if (currentStock > 0) {
      const st = normalizeScope(scopeType);
      await InventoryProjection.applyEvent(pool, {
        event_type: 'OPENING',
        inventory_item_id: inventoryItem.id,
        scope_type: st,
        scope_id: String(scopeId != null ? scopeId : ''),
        quantity_in: currentStock,
        quantity_out: 0,
        reference_type: 'inventory_create',
        reference_id: String(inventoryItem.id),
        unit_cost: costPrice || 0,
        entry_date: new Date(),
        created_by: req.user.id,
      });
      try {
        await createStockReportEntry({
          inventoryItemId: inventoryItem.id,
          transactionType: 'PURCHASE',
          quantityChange: currentStock,
          previousQuantity: 0,
          newQuantity: currentStock,
          unitPrice: costPrice || 0,
          totalValue: (costPrice || 0) * currentStock,
          userId: req.user.id,
          userName: req.user.name || req.user.username,
          userRole: req.user.role,
          adjustmentReason: 'Initial inventory creation',
        });
      } catch (stockError) {
      }
    }

    const refreshed = await InventoryItem.findById(inventoryItem.id);

    res.status(201).json({
      success: true,
      message: 'Inventory item created successfully',
      data: refreshed
    });
  } catch (error) {
    // Enhanced logging to help trace where the error originates

    res.status(500).json({
      success: false,
      message: 'Error creating inventory item',
      error: error && error.message ? error.message : String(error)
    });
  }
};

// @desc    Update inventory item
// @route   PUT /api/inventory/:id
// @access  Private (Admin, Warehouse Keeper)
const updateInventoryItem = async (req, res, next) => {
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
    // Never pass arbitrary request keys to the generic SQL updater. Stock,
    // scope, SKU, audit, joined, and aggregate fields are managed elsewhere.
    const allowedUpdateFields = new Set([
      'name',
      'barcode',
      'description',
      'category',
      'unit',
      'costPrice',
      'sellingPrice',
      'minStockLevel',
      'maxStockLevel',
      'supplierId',
      'supplierName',
      'purchaseDate',
      'purchasePrice'
    ]);
    const updateData = Object.fromEntries(
      Object.entries(req.body).filter(([key]) => allowedUpdateFields.has(key))
    );

    const inventoryItem = await InventoryItem.findById(id);
    if (!inventoryItem) {
      return res.status(404).json({
        success: false,
        message: 'Inventory item not found'
      });
    }

    // Check permissions - cashiers are now allowed to update inventory items
    // Permission checking is handled by middleware (checkCashierInventoryPermission)

    // Warehouse keepers can only update items in their assigned warehouse
    if (req.user.role === 'WAREHOUSE_KEEPER') {
      // Use warehouse ID directly for comparison (inventory items store numeric IDs)
      if (inventoryItem.scopeType !== 'WAREHOUSE' || inventoryItem.scopeId != req.user.warehouseId) {
        return res.status(403).json({
          success: false,
          message: 'Access denied'
        });
      }
    }

    // SKU is immutable/system-managed for reliability.
    if (Object.prototype.hasOwnProperty.call(updateData, 'sku')) {
      delete updateData.sku;
    }

    // Normalise numeric fields
    const numericFields = {
      costPrice: 'float',
      sellingPrice: 'float',
      currentStock: 'int',
      minStockLevel: 'int',
      maxStockLevel: 'int',
      purchasePrice: 'float'
    };

    Object.entries(numericFields).forEach(([field, type]) => {
      if (Object.prototype.hasOwnProperty.call(updateData, field) && updateData[field] !== null && updateData[field] !== '') {
        const parsed = type === 'int' ? parseInt(updateData[field], 10) : parseFloat(updateData[field]);
        if (!Number.isNaN(parsed)) {
          updateData[field] = parsed;
        } else {
          delete updateData[field];
        }
      }
    });

    if (Object.prototype.hasOwnProperty.call(updateData, 'purchaseDate')) {
      const normalizedDate = normalizeDateInput(updateData.purchaseDate);
      updateData.purchaseDate = normalizedDate;
    }

    await InventoryItem.update(id, updateData);
    const updatedItem = await InventoryItem.findById(id);

    res.json({
      success: true,
      message: 'Inventory item updated successfully',
      data: updatedItem
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error updating inventory item',
      error: error.message
    });
  }
};

// @desc    Delete inventory item
// @route   DELETE /api/inventory/:id
// @access  Private (Admin only)
const deleteInventoryItem = async (req, res, next) => {
  try {
    const { id } = req.params;

    const inventoryItem = await InventoryItem.findById(id);
    if (!inventoryItem) {
      return res.status(404).json({
        success: false,
        message: 'Inventory item not found'
      });
    }

    // Only admin can delete inventory items
    if (req.user.role !== 'ADMIN') {
      return res.status(403).json({
        success: false,
        message: 'Only administrators can delete inventory items'
      });
    }

    await trashService.softDelete('inventory_item', id, req.user.id);

    res.json({
      success: true,
      message: 'Moved to trash'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error deleting inventory item',
      error: error.message
    });
  }
};

// @desc    Update stock levels
// @route   PUT /api/inventory/:id/stock
// @access  Private (Admin, Warehouse Keeper)
const updateStock = async (req, res, next) => {
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
    const { currentStock, operation, quantity } = req.body;

    const inventoryItem = await InventoryItem.findById(id);
    if (!inventoryItem) {
      return res.status(404).json({
        success: false,
        message: 'Inventory item not found'
      });
    }

    // Check permissions
    if (req.user.role === 'CASHIER') {
      return res.status(403).json({
        success: false,
        message: 'Cashiers cannot update stock levels'
      });
    }

    // Warehouse keepers can only update items in their assigned warehouse
    if (req.user.role === 'WAREHOUSE_KEEPER') {
      // Use warehouse ID directly for comparison (inventory items store numeric IDs)
      if (inventoryItem.scopeType !== 'WAREHOUSE' || inventoryItem.scopeId != req.user.warehouseId) {
        return res.status(403).json({
          success: false,
          message: 'Access denied'
        });
      }
    }

    let newStock = inventoryItem.currentStock;

    if (operation === 'ADD') {
      newStock += quantity;
    } else if (operation === 'SUBTRACT') {
      newStock -= quantity;
      // Allow negative quantities for sales operations
      // Only prevent negative for manual adjustments
    } else if (operation === 'SET') {
      newStock = currentStock;
    }

    const prevStock = inventoryItem.currentStock;
    const delta = newStock - prevStock;
    if (delta !== 0) {
      await InventoryProjection.applyEvent(pool, {
        event_type: 'ADJUSTMENT',
        inventory_item_id: parseInt(id, 10),
        scope_type: normalizeScope(inventoryItem.scopeType),
        scope_id: String(inventoryItem.scopeId != null ? inventoryItem.scopeId : ''),
        quantity_in: delta > 0 ? delta : 0,
        quantity_out: delta < 0 ? -delta : 0,
        reference_type: 'inventory_stock',
        reference_id: `inv_stock:${id}:${Date.now()}`,
        created_by: req.user.id,
      });
    }

    await createAdjustmentTransaction(
      id,
      prevStock,
      newStock,
      req.user.id,
      req.user.name,
      req.user.role,
      `Stock ${operation.toLowerCase()} by ${req.user.name}`
    );

    const updatedItem = await InventoryItem.findById(id);

    res.json({
      success: true,
      message: 'Stock updated successfully',
      data: updatedItem
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error updating stock',
      error: error.message
    });
  }
};

// @desc    Get low stock items
// @route   GET /api/inventory/low-stock
// @access  Private (Admin, Warehouse Keeper, Cashier)
const getLowStockItems = async (req, res, next) => {
  try {
    let whereConditions = ['i.deleted_at IS NULL'];
    let params = [];

    if (req.user.role === 'WAREHOUSE_KEEPER') {
      whereConditions.push('i.scope_type = ? AND i.scope_id = ?');
      params.push('WAREHOUSE', req.user.warehouseId);
    } else if (req.user.role === 'CASHIER') {
      whereConditions.push('i.scope_type = ? AND i.scope_id = ?');
      params.push('BRANCH', req.user.branchId);
    }

    whereConditions.push('COALESCE(l.ledger_qty, 0) <= i.min_stock_level');

    const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

    const lowStockItems = await executeQuery(`
      SELECT 
        i.*,
        b.name as branch_name,
        w.name as warehouse_name,
        COALESCE(l.ledger_qty, 0) AS ledger_stock
      FROM inventory_items i
      LEFT JOIN ${ledgerScopedQuantitySubquery()} l ON l.inventory_item_id = i.id
      LEFT JOIN branches b ON i.scope_type = 'BRANCH' AND i.scope_id = b.id
      LEFT JOIN warehouses w ON i.scope_type = 'WAREHOUSE' AND i.scope_id = w.id
      ${whereClause}
      ORDER BY (COALESCE(l.ledger_qty, 0) - i.min_stock_level) ASC
    `, params);
    
    // Transform field names to match frontend expectations
    const transformedItems = lowStockItems.map(item => ({
      id: item.id,
      name: item.name,
      sku: item.sku,
      description: item.description,
      category: item.category,
      unit: item.unit,
      costPrice: item.cost_price,
      sellingPrice: item.selling_price,
      currentStock: parseFloat(item.ledger_stock) || 0,
      minStockLevel: item.min_stock_level,
      maxStockLevel: item.max_stock_level,
      scopeType: item.scope_type,
      scopeId: item.scope_id,
      createdBy: item.created_by,
      createdAt: item.created_at,
      updatedAt: item.updated_at,
      branchName: item.branch_name,
      warehouseName: item.warehouse_name
    }));
    
    res.json({
      success: true,
      count: transformedItems.length,
      data: transformedItems
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error retrieving low stock items',
      error: error.message
    });
  }
};

// @desc    Update inventory quantity
// @route   PATCH /api/inventory/:id/quantity
// @access  Private (Admin, Warehouse Keeper, Cashier with permission)
const updateQuantity = async (req, res, next) => {
  const msg =
    'Legacy stock mutation endpoint removed. Use /api/inventory/:id/stock (ADJUSTMENT via inventoryProjectionService.applyEvent).';
  if (process.env.NODE_ENV === 'production') {
    return res.status(409).json({ success: false, message: 'Direct stock mutation forbidden' });
  }
  return res.status(409).json({ success: false, message: msg });
};

// @desc    Get inventory summary
// @route   GET /api/inventory/summary
// @access  Private (Admin, Warehouse Keeper, Cashier)
const getSummary = async (req, res, next) => {
  try {
    let whereConditions = ['i.deleted_at IS NULL'];
    let params = [];

    if (req.user.role === 'WAREHOUSE_KEEPER') {
      whereConditions.push('i.scope_type = ? AND i.scope_id = ?');
      params.push('WAREHOUSE', req.user.warehouseId);
    } else if (req.user.role === 'CASHIER') {
      whereConditions.push('i.scope_type = ? AND i.scope_id = ?');
      params.push('BRANCH', req.user.branchId);
    }

    const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';
    const ledgerJoin = `LEFT JOIN ${ledgerScopedQuantitySubquery()} l ON l.inventory_item_id = i.id`;

    const totalCount = await executeQuery(
      `
      SELECT COUNT(*) as count FROM inventory_items i ${whereClause}
    `,
      params
    );

    const lowStockCount = await executeQuery(
      `
      SELECT COUNT(*) as count FROM inventory_items i
      ${ledgerJoin}
      ${whereClause} AND COALESCE(l.ledger_qty, 0) <= i.min_stock_level
    `,
      params
    );

    const outOfStockCount = await executeQuery(
      `
      SELECT COUNT(*) as count FROM inventory_items i
      ${ledgerJoin}
      ${whereClause} AND COALESCE(l.ledger_qty, 0) <= 0
    `,
      params
    );

    const totalValue = await executeQuery(
      `
      SELECT SUM(COALESCE(l.ledger_qty, 0) * COALESCE(i.cost_price, 0)) as total_value
      FROM inventory_items i
      ${ledgerJoin}
      ${whereClause}
    `,
      params
    );

    const categoryBreakdown = await executeQuery(
      `
      SELECT 
        i.category,
        COUNT(*) as count,
        SUM(COALESCE(l.ledger_qty, 0)) as total_stock,
        SUM(COALESCE(l.ledger_qty, 0) * COALESCE(i.cost_price, 0)) as total_value
      FROM inventory_items i
      ${ledgerJoin}
      ${whereClause}
      GROUP BY i.category
      ORDER BY count DESC
    `,
      params
    );

    res.json({
      success: true,
      data: {
        totalItems: totalCount[0].count,
        lowStockItems: lowStockCount[0].count,
        outOfStockItems: outOfStockCount[0].count,
        totalValue: totalValue[0].total_value || 0,
        categoryBreakdown
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error retrieving inventory summary',
      error: error.message
    });
  }
};

// @desc    Get inventory changes since timestamp
// @route   GET /api/inventory/changes/since
// @access  Private (Admin, Warehouse Keeper, Cashier)
const getInventoryChangesSince = async (req, res, next) => {
  try {
    const { since } = req.query;
    
    if (!since) {
      return res.status(400).json({
        success: false,
        message: 'Since timestamp is required'
      });
    }

    let whereConditions = ['updated_at > ?', 'i.deleted_at IS NULL'];
    let params = [since];

    // Apply role-based filtering
    if (req.user.role === 'WAREHOUSE_KEEPER') {
      // Use warehouse ID directly for filtering (inventory items store numeric IDs)
      whereConditions.push('scope_type = ? AND scope_id = ?');
      params.push('WAREHOUSE', req.user.warehouseId);
    } else if (req.user.role === 'CASHIER') {
      // Use branch ID directly for filtering (inventory items store numeric IDs)
      whereConditions.push('scope_type = ? AND scope_id = ?');
      params.push('BRANCH', req.user.branchId);
    }

    const whereClause = whereConditions.join(' AND ');

    const changes = await executeQuery(`
      SELECT 
        i.*,
        b.name as branch_name,
        w.name as warehouse_name
      FROM inventory_items i
      LEFT JOIN branches b ON i.scope_type = 'BRANCH' AND i.scope_id = b.id
      LEFT JOIN warehouses w ON i.scope_type = 'WAREHOUSE' AND i.scope_id = w.id
      WHERE ${whereClause}
      ORDER BY i.updated_at DESC
    `, params);

    // Transform field names to match frontend expectations
    const transformedChanges = changes.map(item => ({
      id: item.id,
      name: item.name,
      sku: item.sku,
      description: item.description,
      category: item.category,
      unit: item.unit,
      costPrice: item.cost_price,
      sellingPrice: item.selling_price,
      currentStock: item.current_stock,
      minStockLevel: item.min_stock_level,
      maxStockLevel: item.max_stock_level,
      scopeType: item.scope_type,
      scopeId: item.scope_id,
      createdBy: item.created_by,
      createdAt: item.created_at,
      updatedAt: item.updated_at,
      branchName: item.branch_name,
      warehouseName: item.warehouse_name
    }));

    res.json({
      success: true,
      count: transformedChanges.length,
      data: transformedChanges,
      since: since,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error retrieving inventory changes since timestamp',
      error: error.message
    });
  }
};

// @desc    Get latest inventory changes
// @route   GET /api/inventory/changes
// @access  Private (Admin, Warehouse Keeper, Cashier)
const getLatestInventoryChanges = async (req, res, next) => {
  try {
    const { lastUpdate } = req.query;
    let whereConditions = ['i.deleted_at IS NULL'];
    let params = [];

    // Apply role-based filtering
    if (req.user.role === 'WAREHOUSE_KEEPER') {
      // Use warehouse ID directly for filtering (inventory items store numeric IDs)
      whereConditions.push('scope_type = ? AND scope_id = ?');
      params.push('WAREHOUSE', req.user.warehouseId);
    } else if (req.user.role === 'CASHIER') {
      // Use branch ID directly for filtering (inventory items store numeric IDs)
      whereConditions.push('scope_type = ? AND scope_id = ?');
      params.push('BRANCH', req.user.branchId);
    }

    if (lastUpdate) {
      whereConditions.push('updated_at > ?');
      params.push(lastUpdate);
    }

    const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

    const changes = await executeQuery(`
      SELECT 
        i.*,
        b.name as branch_name,
        w.name as warehouse_name
      FROM inventory_items i
      LEFT JOIN branches b ON i.scope_type = 'BRANCH' AND i.scope_id = b.id
      LEFT JOIN warehouses w ON i.scope_type = 'WAREHOUSE' AND i.scope_id = w.id
      ${whereClause}
      ORDER BY i.updated_at DESC
      LIMIT 50
    `, params);

    // Transform field names to match frontend expectations
    const transformedChanges = changes.map(item => ({
      id: item.id,
      name: item.name,
      sku: item.sku,
      description: item.description,
      category: item.category,
      unit: item.unit,
      costPrice: item.cost_price,
      sellingPrice: item.selling_price,
      currentStock: item.current_stock,
      minStockLevel: item.min_stock_level,
      maxStockLevel: item.max_stock_level,
      scopeType: item.scope_type,
      scopeId: item.scope_id,
      createdBy: item.created_by,
      createdAt: item.created_at,
      updatedAt: item.updated_at,
      branchName: item.branch_name,
      warehouseName: item.warehouse_name
    }));

    res.json({
      success: true,
      count: transformedChanges.length,
      data: transformedChanges,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error retrieving latest inventory changes',
      error: error.message
    });
  }
};

// @desc    Get cross-branch inventory
// @route   GET /api/inventory/cross-branch
// @access  Private (Admin, Warehouse Keeper, Cashier)
const getCrossBranchInventory = async (req, res, next) => {
  try {
    const { category, branchId } = req.query;
    let whereConditions = ['i.scope_type = ?', 'i.deleted_at IS NULL'];
    let params = ['BRANCH'];

    // Exclude the caller's own branch so this is truly "other branches"
    const ownBranchId = req.user?.branchId || req.user?.branch_id || null;
    if (ownBranchId !== null && ownBranchId !== undefined && ownBranchId !== '') {
      whereConditions.push('i.scope_id <> ?');
      params.push(String(ownBranchId));
    }

    // Optional: filter to one target branch
    if (branchId !== undefined && branchId !== null && branchId !== '') {
      whereConditions.push('i.scope_id = ?');
      params.push(String(branchId));
    }

    if (category) {
      whereConditions.push('i.category = ?');
      params.push(category);
    }

    const whereClause = whereConditions.join(' AND ');

    // Do NOT require settings.openAccount on the target branch — that hid all stock
    // from branches that simply haven't flipped that flag. Visibility is gated by
    // checkCrossBranchVisibility on the caller's branch instead.
    const inventoryItems = await executeQuery(`
      SELECT 
        i.*,
        b.name as branch_name,
        b.code as branch_code,
        b.location as branch_location
      FROM inventory_items i
      LEFT JOIN branches b ON CAST(i.scope_id AS CHAR) = CAST(b.id AS CHAR)
      WHERE ${whereClause}
      ORDER BY i.created_at DESC
    `, params);

    // Transform field names to match frontend expectations
    const transformedItems = inventoryItems.map(item => {
      const stock = parseFloat(item.current_stock) || 0;
      return {
        id: item.id,
        name: item.name,
        sku: item.sku,
        description: item.description,
        category: item.category || 'Uncategorized',
        unit: item.unit,
        costPrice: parseFloat(item.cost_price) || 0,
        sellingPrice: parseFloat(item.selling_price) || 0,
        currentStock: stock,
        quantity: stock, // alias used by Other Branches Inventory UI
        minStockLevel: parseFloat(item.min_stock_level) || 0,
        maxStockLevel: parseFloat(item.max_stock_level) || 0,
        scopeType: item.scope_type,
        scopeId: item.scope_id != null ? Number(item.scope_id) : item.scope_id,
        createdBy: item.created_by,
        createdAt: item.created_at,
        updatedAt: item.updated_at,
        branchName: item.branch_name,
        branchCode: item.branch_code,
        branchLocation: item.branch_location,
        totalSold: 0,
        totalReturned: 0,
        totalPurchased: 0,
      };
    });

    res.json({
      success: true,
      count: transformedItems.length,
      data: transformedItems
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error retrieving cross-branch inventory',
      error: error.message
    });
  }
};

// @desc    Get cross-warehouse inventory
// @route   GET /api/inventory/cross-warehouse
// @access  Private (Admin, Warehouse Keeper)
const getCrossWarehouseInventory = async (req, res, next) => {
  try {
    const { category } = req.query;
    const whereConditions = ['i.scope_type = ?', 'i.deleted_at IS NULL'];
    const params = ['WAREHOUSE'];

    if (category) {
      whereConditions.push('i.category = ?');
      params.push(category);
    }

    if (req.user.role === 'WAREHOUSE_KEEPER' && req.user.warehouseId) {
      whereConditions.push('i.scope_id <> ?');
      params.push(req.user.warehouseId);
    }

    const whereClause = whereConditions.join(' AND ');

    const inventoryItems = await executeQuery(`
      SELECT 
        i.*,
        w.name AS warehouse_name,
        w.code AS warehouse_code,
        w.location AS warehouse_location
      FROM inventory_items i
      LEFT JOIN warehouses w ON i.scope_id = w.id
      WHERE ${whereClause}
      ORDER BY i.created_at DESC
    `, params);

    const transformedItems = inventoryItems.map(item => ({
      id: item.id,
      name: item.name,
      sku: item.sku,
      description: item.description,
      category: item.category,
      unit: item.unit,
      costPrice: item.cost_price,
      sellingPrice: item.selling_price,
      currentStock: item.current_stock,
      minStockLevel: item.min_stock_level,
      maxStockLevel: item.max_stock_level,
      scopeType: item.scope_type,
      scopeId: item.scope_id,
      createdBy: item.created_by,
      createdAt: item.created_at,
      updatedAt: item.updated_at,
      warehouseName: item.warehouse_name,
      warehouseCode: item.warehouse_code,
      warehouseLocation: item.warehouse_location
    }));

    res.json({
      success: true,
      count: transformedItems.length,
      data: transformedItems
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error retrieving cross-warehouse inventory',
      error: error.message
    });
  }
};

module.exports = {
  getInventoryItems,
  getInventoryItem,
  createInventoryItem,
  updateInventoryItem,
  deleteInventoryItem,
  updateStock,
  getLowStockItems,
  updateQuantity,
  getSummary,
  getLatestInventoryChanges,
  getInventoryChangesSince,
  getCrossBranchInventory,
  getCrossWarehouseInventory
};
