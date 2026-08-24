const { validationResult } = require('express-validator');
const { PurchaseOrder, PurchaseOrderItem } = require('../models/PurchaseOrder');
const { executeQuery, pool } = require('../config/database');
const { createStockReportEntry } = require('../middleware/stockTracking');
const trashService = require('../services/trashService');
const { normalizeScope } = require('../services/inventoryLedgerService');
const InventoryProjection = require('../services/inventoryProjectionService');
const { generateUniqueSku } = require('../services/skuGeneratorService');

// ─────────────────────────────────────────────────────────────────────────────
// KEY FIXES:
//  1. cost_price ALWAYS written when completing PO (was missing → 100% margin)
//  2. selling_price only written when operator explicitly provides it (no forced 20% markup)
//  3. New items: selling_price = provided value OR 0 (not unitPrice*1.2)
// ─────────────────────────────────────────────────────────────────────────────

const OPEN_PO_STATUSES = new Set(['PENDING', 'ORDERED']);

const isOpenPurchaseOrderStatus = (status) =>
  OPEN_PO_STATUSES.has(String(status || '').trim().toUpperCase());

const hasScopedAccess = (purchaseOrder, reqUser) => {
  if (!purchaseOrder || !reqUser) return false;
  if (reqUser.role === 'ADMIN') return true;

  const orderScopeType = String(purchaseOrder.scopeType || '').toUpperCase();
  const orderScopeId = Number(purchaseOrder.scopeId);

  if (reqUser.role === 'WAREHOUSE_KEEPER') {
    return orderScopeType === 'WAREHOUSE' && orderScopeId === Number(reqUser.warehouseId);
  }
  if (reqUser.role === 'CASHIER') {
    return orderScopeType === 'BRANCH' && orderScopeId === Number(reqUser.branchId);
  }
  return true;
};

const getPurchaseOrders = async (req, res, next) => {
  try {
    const { supplierId, scopeType, scopeId, status, orderDateFrom, orderDateTo, search, page = 1, limit = 20 } = req.query;
    const conditions = {};
    if (supplierId) conditions.supplierId = supplierId;
    if (scopeType) conditions.scopeType = scopeType;
    if (scopeId) conditions.scopeId = scopeId;
    if (status) conditions.status = status;
    if (orderDateFrom) conditions.orderDateFrom = orderDateFrom;
    if (orderDateTo) conditions.orderDateTo = orderDateTo;
    if (search) conditions.search = search;
if (req.user.role === 'ADMIN') {
  // Admin can filter by any scope passed as query params (including simulation)
  // conditions already have scopeType/scopeId from req.query above — nothing to override
} else if (req.user.role === 'WAREHOUSE_KEEPER') {
  conditions.scopeType = 'WAREHOUSE';
  conditions.scopeId = req.user.warehouseId;
} else if (req.user.role === 'CASHIER') {
  conditions.scopeType = 'BRANCH';
  conditions.scopeId = req.user.branchId;
}
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const purchaseOrders = await PurchaseOrder.find(conditions, { sort: '-created_at', limit: parseInt(limit), skip });
    const totalCount = await PurchaseOrder.count(conditions);
    res.json({ success: true, count: purchaseOrders.length, total: totalCount, page: parseInt(page), pages: Math.ceil(totalCount / parseInt(limit)), data: purchaseOrders });
  } catch (error) { res.status(500).json({ success: false, message: 'Error retrieving purchase orders', error: error.message }); }
};

const getPurchaseOrder = async (req, res, next) => {
  try {
    const purchaseOrder = await PurchaseOrder.findById(req.params.id);
    if (!purchaseOrder) return res.status(404).json({ success: false, message: 'Purchase order not found' });
    if (!hasScopedAccess(purchaseOrder, req.user))
      return res.status(403).json({ success: false, message: 'Access denied' });
    res.json({ success: true, data: purchaseOrder });
  } catch (error) { res.status(500).json({ success: false, message: 'Error retrieving purchase order', error: error.message }); }
};

const createPurchaseOrder = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ success: false, message: 'Validation error', errors: errors.array() });
    const { supplierId, scopeType, scopeId, orderDate, expectedDelivery, notes, items } = req.body;
    if (!supplierId || !items || items.length === 0)
      return res.status(400).json({ success: false, message: 'Supplier ID and items are required' });
    let finalScopeType = scopeType, finalScopeId = scopeId;
    if (req.user.role === 'WAREHOUSE_KEEPER') { finalScopeType = 'WAREHOUSE'; finalScopeId = req.user.warehouseId; }
    else if (req.user.role === 'CASHIER') { finalScopeType = 'BRANCH'; finalScopeId = req.user.branchId; }
    const orderNumber = await PurchaseOrder.generateOrderNumber(finalScopeType, finalScopeId);
    const totalAmount = items.reduce((t, i) => t + (i.quantityOrdered * i.unitPrice), 0);
    const purchaseOrder = await PurchaseOrder.create({
      orderNumber, supplierId, scopeType: finalScopeType, scopeId: finalScopeId,
      orderDate: orderDate || new Date().toISOString().split('T')[0],
      expectedDelivery, status: 'PENDING', totalAmount, notes, createdBy: req.user.id
    });
    const reservedSkus = new Set();
    for (const item of items) {
      // SKU is backend-owned: never trust incoming itemSku from API payload.
      let itemSku = null;
      if (item.inventoryItemId) {
        const [inv] = await pool.execute('SELECT sku FROM inventory_items WHERE id = ? LIMIT 1', [item.inventoryItemId]);
        if (inv.length > 0 && inv[0].sku) itemSku = inv[0].sku;
      }
      if (!itemSku) {
        itemSku = await generateUniqueSku({
          scopeType: finalScopeType,
          scopeId: finalScopeId,
          name: item.itemName,
          connection: pool,
          reservedSkus,
        });
      }
      await PurchaseOrderItem.create({
        purchaseOrderId: purchaseOrder.id,
        inventoryItemId: item.inventoryItemId || null,
        itemName: item.itemName,
        itemSku,
        itemBarcode: item.itemBarcode || null,
        itemCategory: item.itemCategory || 'General',
        itemDescription: item.itemDescription || null,
        quantityOrdered: item.quantityOrdered,
        unitPrice: item.unitPrice,                                      // cost price (required)
        sellingPrice: item.sellingPrice != null ? item.sellingPrice : null, // optional
        totalPrice: item.quantityOrdered * item.unitPrice,
        notes: item.notes || null
      });
    }
    const completeOrder = await PurchaseOrder.findById(purchaseOrder.id);
    res.status(201).json({ success: true, message: 'Purchase order created successfully', data: completeOrder });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error creating purchase order', error: error.message });
  }
};

const updatePurchaseOrderStatus = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { status, actualDelivery } = req.body;
    if (!['PENDING', 'COMPLETED', 'CANCELLED'].includes(status))
      return res.status(400).json({ success: false, message: 'Invalid status' });
    const purchaseOrder = await PurchaseOrder.findById(id);
    if (!purchaseOrder) return res.status(404).json({ success: false, message: 'Purchase order not found' });
    if (req.user.role !== 'ADMIN') return res.status(403).json({ success: false, message: 'Only admins can update order status' });
    if (!isOpenPurchaseOrderStatus(purchaseOrder.status))
      return res.status(400).json({ success: false, message: 'Only pending or ordered purchase orders can be updated' });
    const updatedOrder = await PurchaseOrder.updateStatus(id, status, status === 'COMPLETED' ? (actualDelivery || new Date().toISOString().split('T')[0]) : null);
    if (status === 'COMPLETED') {
      const orderItems = await PurchaseOrderItem.findByOrderId(id);
      for (const item of orderItems) {
        if (!item.quantityReceived || item.quantityReceived === 0)
          await executeQuery('UPDATE purchase_order_items SET quantity_received = ? WHERE id = ?', [item.quantityOrdered, item.id]);
      }
      await updateInventoryFromPurchaseOrder(id);
    }
    res.json({ success: true, message: 'Purchase order status updated successfully', data: updatedOrder });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error updating purchase order status', error: error.message });
  }
};

const deletePurchaseOrder = async (req, res, next) => {
  try {
    const { id } = req.params;
    const purchaseOrder = await PurchaseOrder.findById(id);
    if (!purchaseOrder) return res.status(404).json({ success: false, message: 'Purchase order not found' });
    if (!hasScopedAccess(purchaseOrder, req.user))
      return res.status(403).json({ success: false, message: 'Access denied' });
    if (!isOpenPurchaseOrderStatus(purchaseOrder.status))
      return res.status(400).json({ success: false, message: 'Only pending or ordered purchase orders can be deleted' });
    await trashService.softDelete('purchase_order', id, req.user.id);
    res.json({ success: true, message: 'Moved to trash' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error deleting purchase order', error: error.message });
  }
};

const getSuppliers = async (req, res, next) => {
  try {
    const { search } = req.query;
    let whereConditions = ['status = ?'], params = ['active'];
    if (req.user.role === 'WAREHOUSE_KEEPER') {
      whereConditions.push('(scope_type = ? OR scope_type = ?)'); params.push('WAREHOUSE', 'COMPANY');
      whereConditions.push('(scope_id = ? OR scope_id = ?)'); params.push(req.user.warehouseId, '1');
    } else if (req.user.role === 'CASHIER') {
      whereConditions.push('(scope_type = ? OR scope_type = ?)'); params.push('BRANCH', 'COMPANY');
      whereConditions.push('(scope_id = ? OR scope_id = ?)'); params.push(req.user.branchId, '1');
    }
    if (search) { whereConditions.push('(name LIKE ? OR contact_person LIKE ?)'); params.push(`%${search}%`, `%${search}%`); }
    const suppliers = await executeQuery(`SELECT id, name, code, contact_person, phone, email, address, transaction_type FROM companies WHERE ${whereConditions.join(' AND ')} ORDER BY name ASC`, params);
    res.json({ success: true, count: suppliers.length, data: suppliers });
  } catch (error) { res.status(500).json({ success: false, message: 'Error retrieving suppliers', error: error.message }); }
};

const updateInventoryFromPurchaseOrder = async (purchaseOrderId) => {
  const orderItems = await PurchaseOrderItem.findByOrderId(purchaseOrderId);
  const purchaseOrder = await PurchaseOrder.findById(purchaseOrderId);
  if (!purchaseOrder) throw new Error(`Purchase order ${purchaseOrderId} not found`);

  const [users] = await pool.execute('SELECT id, username, role FROM users WHERE id = ?', [purchaseOrder.createdBy]);
  const user = users[0] || { id: purchaseOrder.createdBy, username: 'system', role: 'ADMIN' };
  if (!user.name) user.name = user.username || 'System';

  const normalizeBarcode = (v) => {
    const s = String(v || '').trim();
    return s || null;
  };

  const applyInventoryMetaUpdate = async (connection, inventoryItemId, item, barcode) => {
    const hasSellingPrice = item.sellingPrice !== null &&
      item.sellingPrice !== undefined &&
      item.sellingPrice !== '';
    if (hasSellingPrice && barcode) {
      await connection.execute(
        `UPDATE inventory_items SET cost_price=?, selling_price=?, purchase_price=?, supplier_id=?, supplier_name=?, purchase_date=?, barcode=?, updated_at=NOW() WHERE id=?`,
        [item.unitPrice||0, item.sellingPrice, item.unitPrice||0, purchaseOrder.supplierId||null, purchaseOrder.supplierName||null, purchaseOrder.orderDate||null, barcode, inventoryItemId]
      );
    } else if (hasSellingPrice) {
      await connection.execute(
        `UPDATE inventory_items SET cost_price=?, selling_price=?, purchase_price=?, supplier_id=?, supplier_name=?, purchase_date=?, updated_at=NOW() WHERE id=?`,
        [item.unitPrice||0, item.sellingPrice, item.unitPrice||0, purchaseOrder.supplierId||null, purchaseOrder.supplierName||null, purchaseOrder.orderDate||null, inventoryItemId]
      );
    } else if (barcode) {
      await connection.execute(
        `UPDATE inventory_items SET cost_price=?, purchase_price=?, supplier_id=?, supplier_name=?, purchase_date=?, barcode=COALESCE(NULLIF(barcode,''), ?), updated_at=NOW() WHERE id=?`,
        [item.unitPrice||0, item.unitPrice||0, purchaseOrder.supplierId||null, purchaseOrder.supplierName||null, purchaseOrder.orderDate||null, barcode, inventoryItemId]
      );
    } else {
      await connection.execute(
        `UPDATE inventory_items SET cost_price=?, purchase_price=?, supplier_id=?, supplier_name=?, purchase_date=?, updated_at=NOW() WHERE id=?`,
        [item.unitPrice||0, item.unitPrice||0, purchaseOrder.supplierId||null, purchaseOrder.supplierName||null, purchaseOrder.orderDate||null, inventoryItemId]
      );
    }
  };

  const connection = await pool.getConnection();
  await connection.beginTransaction();
  try {
    const reservedSkus = new Set();
    for (const item of orderItems) {
      const quantityToAdd = (item.quantityReceived != null && item.quantityReceived > 0) ? item.quantityReceived : (item.quantityOrdered || 0);
      if (quantityToAdd <= 0) { continue; }

      const barcode = normalizeBarcode(item.itemBarcode);
      const hasSellingPrice = item.sellingPrice !== null &&
        item.sellingPrice !== undefined &&
        item.sellingPrice !== '';

      let inventoryItemId = item.inventoryItemId;
      let previousQuantity = 0;

      if (inventoryItemId) {
        const [existing] = await connection.execute(
          'SELECT id, current_stock FROM inventory_items WHERE id = ? AND deleted_at IS NULL',
          [inventoryItemId]
        );
        if (existing.length > 0) {
          previousQuantity = parseFloat(existing[0].current_stock) || 0;
          await applyInventoryMetaUpdate(connection, inventoryItemId, item, barcode);
        } else {
          inventoryItemId = null;
        }
      }
      if (!inventoryItemId) {
        const searchSku = item.itemSku, searchName = item.itemName;
        let scopeName = null;
        if (purchaseOrder.scopeType === 'BRANCH' && !isNaN(purchaseOrder.scopeId)) {
          const [b] = await connection.execute('SELECT name FROM branches WHERE id = ?', [purchaseOrder.scopeId]);
          if (b.length > 0) scopeName = b[0].name;
        } else if (purchaseOrder.scopeType === 'WAREHOUSE' && !isNaN(purchaseOrder.scopeId)) {
          const [w] = await connection.execute('SELECT name FROM warehouses WHERE id = ?', [purchaseOrder.scopeId]);
          if (w.length > 0) scopeName = w[0].name;
        }

        let existingItems = [];
        if (barcode) {
          const [byBarcode] = await connection.execute(
            `SELECT id, current_stock FROM inventory_items
             WHERE barcode=? AND scope_type=? AND (CAST(scope_id AS CHAR)=? OR scope_id=? OR CAST(scope_id AS CHAR)=?)
               AND deleted_at IS NULL LIMIT 1`,
            [barcode, purchaseOrder.scopeType, String(purchaseOrder.scopeId), purchaseOrder.scopeId, scopeName || '']
          );
          existingItems = byBarcode;
        }

        if (existingItems.length === 0) {
          const nameSkuCond   = searchSku?.trim() ? 'name=? AND sku=?' : 'name=? AND (sku IS NULL OR sku=?)';
          const nameSkuParams = searchSku?.trim() ? [searchName, searchSku] : [searchName, ''];
          const [byNameSku] = await connection.execute(
            `SELECT id, current_stock FROM inventory_items WHERE ${nameSkuCond} AND scope_type=? AND (CAST(scope_id AS CHAR)=? OR scope_id=? OR CAST(scope_id AS CHAR)=?) AND deleted_at IS NULL LIMIT 1`,
            [...nameSkuParams, purchaseOrder.scopeType, String(purchaseOrder.scopeId), purchaseOrder.scopeId, scopeName || '']
          );
          existingItems = byNameSku;
        }

        if (existingItems.length > 0) {
          inventoryItemId = existingItems[0].id;
          previousQuantity = parseFloat(existingItems[0].current_stock) || 0;
          await applyInventoryMetaUpdate(connection, inventoryItemId, item, barcode);
        } else {
          const newSellingPrice = hasSellingPrice ? item.sellingPrice : 0;
          const generatedSku = await generateUniqueSku({
            scopeType: purchaseOrder.scopeType,
            scopeId: purchaseOrder.scopeId,
            name: item.itemName,
            connection,
            reservedSkus,
          });
          const [ins] = await connection.execute(
            `INSERT INTO inventory_items (name,sku,barcode,description,category,unit,cost_price,selling_price,min_stock_level,max_stock_level,current_stock,scope_type,scope_id,supplier_id,supplier_name,purchase_date,purchase_price,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [item.itemName, generatedSku, barcode, item.itemDescription||'Purchased item', item.itemCategory||'General', 'PIECE',
             item.unitPrice||0, newSellingPrice, 0, 1000, 0,
             purchaseOrder.scopeType, purchaseOrder.scopeId,
             purchaseOrder.supplierId||null, purchaseOrder.supplierName||null, purchaseOrder.orderDate||null, item.unitPrice||0, purchaseOrder.createdBy]
          );
          inventoryItemId = ins.insertId;
          previousQuantity = 0;
        }
      }

      if (inventoryItemId && !item.inventoryItemId) {
        try { await connection.execute('UPDATE purchase_order_items SET inventory_item_id=? WHERE id=?', [inventoryItemId, item.id]); } catch (e) {}
      }

      if (inventoryItemId && quantityToAdd > 0) {
        const [sc] = await connection.execute(
          'SELECT scope_type, scope_id FROM inventory_items WHERE id = ?',
          [inventoryItemId]
        );
        if (!sc.length) throw new Error(`[PO] inventory item ${inventoryItemId} missing`);
        await InventoryProjection.applyEvent(connection, {
          event_type: 'PURCHASE',
          inventory_item_id: inventoryItemId,
          scope_type: normalizeScope(sc[0].scope_type),
          scope_id: String(sc[0].scope_id != null ? sc[0].scope_id : ''),
          quantity_in: quantityToAdd,
          quantity_out: 0,
          reference_type: 'purchase_order',
          reference_id: `${purchaseOrderId}:${item.id}`,
          unit_cost: item.unitPrice || 0,
          created_by: user.id,
        });
        const [afterRow] = await connection.execute('SELECT current_stock FROM inventory_items WHERE id = ?', [inventoryItemId]);
        const newQuantity = afterRow.length ? parseFloat(afterRow[0].current_stock) : previousQuantity + quantityToAdd;
        try {
          await createStockReportEntry({
            inventoryItemId,
            transactionType: 'PURCHASE',
            quantityChange: quantityToAdd,
            previousQuantity: newQuantity - quantityToAdd,
            newQuantity,
            unitPrice: item.unitPrice||0,
            totalValue: (item.unitPrice||0)*quantityToAdd,
            userId: user.id,
            userName: user.name||user.username,
            userRole: user.role,
            adjustmentReason: `Purchase order: ${purchaseOrder.orderNumber}`,
          }, connection);
        } catch (e) { /* stock report optional */ }
      }
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
};

const updatePurchaseOrder = async (req, res, next) => {
  try {
    const { id } = req.params;
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ success: false, message: 'Validation error', errors: errors.array() });
    const purchaseOrder = await PurchaseOrder.findById(id);
    if (!purchaseOrder) return res.status(404).json({ success: false, message: 'Purchase order not found' });
    if (req.user.role !== 'ADMIN' && !isOpenPurchaseOrderStatus(purchaseOrder.status))
      return res.status(400).json({ success: false, message: 'Only pending or ordered purchase orders can be updated' });
    if (!hasScopedAccess(purchaseOrder, req.user))
      return res.status(403).json({ success: false, message: 'Access denied' });

    const { supplierId, orderDate, expectedDelivery, notes, items } = req.body;
    if (supplierId) purchaseOrder.supplierId = supplierId;
    if (orderDate) purchaseOrder.orderDate = orderDate;
    if (expectedDelivery !== undefined) purchaseOrder.expectedDelivery = expectedDelivery;
    if (notes !== undefined) purchaseOrder.notes = notes;
    if (items?.length > 0) purchaseOrder.totalAmount = items.reduce((t, i) => t + (i.quantityOrdered * i.unitPrice), 0);
    await purchaseOrder.save();

    if (items?.length > 0) {
      const isCompleted = ['COMPLETED', 'DELIVERED', 'APPROVED'].includes(purchaseOrder.status);
      if (isCompleted) {
        const oldItems = await PurchaseOrderItem.findByOrderId(id);
        for (const oldItem of oldItems) {
          const oldQty = oldItem.quantityReceived || oldItem.quantityOrdered || 0;
          if (oldQty <= 0) continue;
          let iid = oldItem.inventoryItemId;
          if (!iid) {
            const sk = oldItem.itemSku, nm = oldItem.itemName;
            const c = sk?.trim() ? 'name=? AND sku=?' : 'name=? AND (sku IS NULL OR sku=?)';
            const p = sk?.trim() ? [nm, sk] : [nm, ''];
            const [f] = await pool.execute(`SELECT id FROM inventory_items WHERE ${c} AND scope_type=? AND scope_id=? LIMIT 1`, [...p, purchaseOrder.scopeType, String(purchaseOrder.scopeId)]);
            if (f.length > 0) iid = f[0].id;
          }
          if (iid) {
            const [invRow] = await pool.execute('SELECT scope_type, scope_id FROM inventory_items WHERE id = ?', [iid]);
            if (invRow.length) {
              const conn = await pool.getConnection();
              await conn.beginTransaction();
              try {
                await InventoryProjection.applyEvent(conn, {
                  event_type: 'ADJUSTMENT',
                  inventory_item_id: iid,
                  scope_type: normalizeScope(invRow[0].scope_type),
                  scope_id: String(invRow[0].scope_id != null ? invRow[0].scope_id : ''),
                  quantity_in: 0,
                  quantity_out: oldQty,
                  reference_type: 'purchase_order_edit_undo',
                  reference_id: `${id}:${oldItem.id}`,
                  created_by: req.user.id,
                });
                await conn.commit();
              } catch (e) {
                await conn.rollback();
                throw e;
              } finally {
                conn.release();
              }
            }
            await executeQuery(`DELETE FROM stock_reports WHERE inventory_item_id=? AND transaction_type='PURCHASE' AND adjustment_reason LIKE ?`, [iid, `%${purchaseOrder.orderNumber}%`]);
          }
        }
      }
      await executeQuery('DELETE FROM purchase_order_items WHERE purchase_order_id=?', [id]);
      const reservedSkus = new Set();
      for (const item of items) {
        // SKU is backend-owned: never trust incoming itemSku from API payload.
        let itemSku = null;
        if (item.inventoryItemId) {
          const [inv] = await pool.execute('SELECT sku FROM inventory_items WHERE id = ? LIMIT 1', [item.inventoryItemId]);
          if (inv.length > 0 && inv[0].sku) itemSku = inv[0].sku;
        }
        if (!itemSku) {
          itemSku = await generateUniqueSku({
            scopeType: purchaseOrder.scopeType,
            scopeId: purchaseOrder.scopeId,
            name: item.itemName,
            connection: pool,
            reservedSkus,
          });
        }
        await PurchaseOrderItem.create({
          purchaseOrderId: parseInt(id), inventoryItemId: item.inventoryItemId||null,
          itemName: item.itemName, itemSku,
          itemBarcode: item.itemBarcode || null,
          itemCategory: item.itemCategory||'General', itemDescription: item.itemDescription||null,
          quantityOrdered: item.quantityOrdered, unitPrice: item.unitPrice,
          sellingPrice: item.sellingPrice != null ? item.sellingPrice : null,
          totalPrice: item.quantityOrdered * item.unitPrice, notes: item.notes||null
        });
      }
      if (isCompleted) {
        const newItems = await PurchaseOrderItem.findByOrderId(id);
        for (const ni of newItems) {
          if (!ni.quantityReceived || ni.quantityReceived === 0)
            await executeQuery('UPDATE purchase_order_items SET quantity_received=? WHERE id=?', [ni.quantityOrdered, ni.id]);
        }
        await updateInventoryFromPurchaseOrder(parseInt(id));
      }
    }
    const updatedOrder = await PurchaseOrder.findById(id);
    res.json({ success: true, message: 'Purchase order updated successfully', data: updatedOrder });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error updating purchase order', error: error.message });
  }
};

module.exports = {
  getPurchaseOrders,
  getPurchaseOrder,
  createPurchaseOrder,
  updatePurchaseOrderStatus,
  deletePurchaseOrder,
  updatePurchaseOrder,
  getSuppliers,
  updateInventoryFromPurchaseOrder,
  isOpenPurchaseOrderStatus,
};
