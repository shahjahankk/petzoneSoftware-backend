const { executeQuery, pool } = require('../config/database');

// ─────────────────────────────────────────────────────────────────────────────
// purchase_order_items optional columns (auto-added on first write if missing):
//   ALTER TABLE purchase_order_items ADD COLUMN selling_price DECIMAL(10,2) NULL;
//   ALTER TABLE purchase_order_items ADD COLUMN item_barcode VARCHAR(100) NULL;
// ─────────────────────────────────────────────────────────────────────────────

let itemBarcodeColumnReady = false;

async function ensureItemBarcodeColumn() {
  if (itemBarcodeColumnReady) return;
  try {
    const rows = await executeQuery(
      `SELECT COUNT(*) AS c FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'purchase_order_items'
         AND COLUMN_NAME = 'item_barcode'`
    );
    const exists = Number(rows?.[0]?.c || 0) > 0;
    if (!exists) {
      await executeQuery(
        `ALTER TABLE purchase_order_items ADD COLUMN item_barcode VARCHAR(100) NULL AFTER item_sku`
      );
    }
  } catch (err) {
    // Duplicate column / race: treat as ready so create can proceed
    if (err?.code !== 'ER_DUP_FIELDNAME') {
      console.warn('[PurchaseOrder] ensure item_barcode column:', err.message);
    }
  }
  itemBarcodeColumnReady = true;
}

class PurchaseOrder {
  constructor(data) {
    this.id              = data.id;
    this.orderNumber     = data.order_number;
    this.supplierId      = data.supplier_id;
    this.scopeType       = data.scope_type;
    this.scopeId         = data.scope_id;
    this.orderDate       = data.order_date;
    this.expectedDelivery = data.expected_delivery;
    this.actualDelivery  = data.actual_delivery;
    this.status          = data.status;
    this.totalAmount     = data.total_amount;
    this.notes           = data.notes;
    this.createdBy       = data.created_by;
    this.createdAt       = data.created_at;
    this.updatedAt       = data.updated_at;

    // Related data (populated by separate queries)
    this.supplierName    = data.supplier_name;
    this.supplierContact = data.supplier_contact;
    this.supplierPhone   = data.supplier_phone;
    this.supplierEmail   = data.supplier_email;
    this.scopeName       = data.scope_name;
    this.createdByName   = data.created_by_name;
    this.items           = data.items || [];
  }

  static async create(orderData) {
    const {
      orderNumber, supplierId, scopeType, scopeId, orderDate,
      expectedDelivery, status, totalAmount, notes, createdBy
    } = orderData;

    const result = await executeQuery(
      `INSERT INTO purchase_orders (
        order_number, supplier_id, scope_type, scope_id, order_date,
        expected_delivery, status, total_amount, notes, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        orderNumber, supplierId, scopeType, scopeId, orderDate,
        expectedDelivery || null, status || 'PENDING', totalAmount || 0.00,
        notes || null, createdBy
      ]
    );
    return await PurchaseOrder.findById(result.insertId || result.lastID);
  }

  static async findById(id) {
    try {
      const [baseRows] = await pool.execute('SELECT * FROM purchase_orders WHERE id = ?', [id]);
      if (baseRows.length === 0) return null;

      const poData = baseRows[0];
      let supplierName = null, supplierContact = null, supplierPhone = null, supplierEmail = null;

      if (poData.supplier_id) {
        try {
          const [suppliers] = await pool.execute(
            'SELECT name, contact_person, phone, email FROM companies WHERE id = ?',
            [poData.supplier_id]
          );
          if (suppliers.length > 0) {
            supplierName    = suppliers[0].name;
            supplierContact = suppliers[0].contact_person;
            supplierPhone   = suppliers[0].phone;
            supplierEmail   = suppliers[0].email;
          }
        } catch (err) { /* supplier lookup optional */ }
      }

      let scopeName = poData.scope_id;
      if (poData.scope_type === 'BRANCH' && poData.scope_id) {
        try {
          const [r] = await pool.execute('SELECT name FROM branches WHERE id = ? LIMIT 1', [poData.scope_id]);
          if (r.length > 0) scopeName = r[0].name;
          else {
            const [r2] = await pool.execute('SELECT name FROM branches WHERE name = ? LIMIT 1', [String(poData.scope_id)]);
            if (r2.length > 0) scopeName = r2[0].name;
          }
        } catch (e) { /* branch lookup optional */ }
      } else if (poData.scope_type === 'WAREHOUSE' && poData.scope_id) {
        try {
          const [r] = await pool.execute('SELECT name FROM warehouses WHERE id = ? LIMIT 1', [poData.scope_id]);
          if (r.length > 0) scopeName = r[0].name;
          else {
            const [r2] = await pool.execute('SELECT name FROM warehouses WHERE name = ? LIMIT 1', [String(poData.scope_id)]);
            if (r2.length > 0) scopeName = r2[0].name;
          }
        } catch (e) { /* warehouse lookup optional */ }
      }

      let createdByName = null;
      if (poData.created_by) {
        try {
          const [users] = await pool.execute('SELECT username FROM users WHERE id = ?', [poData.created_by]);
          if (users.length > 0) createdByName = users[0].username;
        } catch (err) { /* user lookup optional */ }
      }

      const order = new PurchaseOrder({
        ...poData,
        supplier_name: supplierName, supplier_contact: supplierContact,
        supplier_phone: supplierPhone, supplier_email: supplierEmail,
        scope_name: scopeName, created_by_name: createdByName
      });
      order.items = await PurchaseOrderItem.findByOrderId(id);
      return order;
    } catch (error) {
      const [baseRows] = await pool.execute('SELECT * FROM purchase_orders WHERE id = ?', [id]);
      if (baseRows.length === 0) return null;
      const order = new PurchaseOrder({ ...baseRows[0], supplier_name: null, scope_name: baseRows[0].scope_id, created_by_name: null });
      order.items = await PurchaseOrderItem.findByOrderId(id);
      return order;
    }
  }

  static async find(conditions = {}, options = {}) {
    let query = `
      SELECT po.*, NULL as supplier_name, NULL as supplier_contact,
             NULL as supplier_phone, NULL as supplier_email,
             po.scope_id as scope_name, NULL as created_by_name
      FROM purchase_orders po WHERE 1=1`;
    const params = [];

    if (conditions.supplierId)    { query += ' AND po.supplier_id = ?';  params.push(conditions.supplierId); }
    if (conditions.scopeType)     { query += ' AND po.scope_type = ?';   params.push(conditions.scopeType); }
    if (conditions.scopeId)       { query += ' AND po.scope_id = ?';     params.push(conditions.scopeId); }
    if (conditions.status)        { query += ' AND po.status = ?';       params.push(conditions.status); }
    if (conditions.orderDateFrom) { query += ' AND po.order_date >= ?';  params.push(conditions.orderDateFrom); }
    if (conditions.orderDateTo)   { query += ' AND po.order_date <= ?';  params.push(conditions.orderDateTo); }
    if (conditions.search) {
      query += ' AND (po.order_number LIKE ? OR EXISTS(SELECT 1 FROM companies c WHERE c.id = po.supplier_id AND c.name LIKE ?))';
      params.push(`%${conditions.search}%`, `%${conditions.search}%`);
    }

    if (options.sort) {
      const f = options.sort.replace(/^-/, '');
      query += ` ORDER BY po.${f} ${options.sort.startsWith('-') ? 'DESC' : 'ASC'}`;
    } else {
      query += ' ORDER BY po.created_at DESC';
    }
    if (options.limit) {
      query += ' LIMIT ?'; params.push(options.limit);
      if (options.skip) { query += ' OFFSET ?'; params.push(options.skip); }
    }

    const rows   = await executeQuery(query, params);
    const orders = rows.map(row => new PurchaseOrder(row));

    for (const order of orders) {
      if (order.supplierId) {
        try {
          const [s] = await pool.execute('SELECT name, contact_person, phone, email FROM companies WHERE id = ? LIMIT 1', [order.supplierId]);
          if (s.length > 0) { order.supplierName = s[0].name; order.supplierContact = s[0].contact_person; order.supplierPhone = s[0].phone; order.supplierEmail = s[0].email; }
        } catch (e) {}
      }
      if (order.scopeType === 'BRANCH' && order.scopeId) {
        try { const [b] = await pool.execute('SELECT name FROM branches WHERE id = ? LIMIT 1', [order.scopeId]); if (b.length > 0) order.scopeName = b[0].name; } catch (e) {}
      } else if (order.scopeType === 'WAREHOUSE' && order.scopeId) {
        try { const [w] = await pool.execute('SELECT name FROM warehouses WHERE id = ? LIMIT 1', [order.scopeId]); if (w.length > 0) order.scopeName = w[0].name; } catch (e) {}
      }
      if (order.createdBy) {
        try { const [u] = await pool.execute('SELECT username FROM users WHERE id = ? LIMIT 1', [order.createdBy]); if (u.length > 0) order.createdByName = u[0].username; } catch (e) {}
      }
    }
    return orders;
  }

  static async count(conditions = {}) {
    let query  = 'SELECT COUNT(*) as count FROM purchase_orders po WHERE 1=1';
    const params = [];
    if (conditions.supplierId)    { query += ' AND po.supplier_id = ?';  params.push(conditions.supplierId); }
    if (conditions.scopeType)     { query += ' AND po.scope_type = ?';   params.push(conditions.scopeType); }
    if (conditions.scopeId)       { query += ' AND po.scope_id = ?';     params.push(conditions.scopeId); }
    if (conditions.status)        { query += ' AND po.status = ?';       params.push(conditions.status); }
    if (conditions.orderDateFrom) { query += ' AND po.order_date >= ?';  params.push(conditions.orderDateFrom); }
    if (conditions.orderDateTo)   { query += ' AND po.order_date <= ?';  params.push(conditions.orderDateTo); }
    if (conditions.search) {
      query += ' AND (po.order_number LIKE ? OR EXISTS(SELECT 1 FROM companies c WHERE c.id = po.supplier_id AND c.name LIKE ?))';
      params.push(`%${conditions.search}%`, `%${conditions.search}%`);
    }
    const rows = await executeQuery(query, params);
    return rows[0].count;
  }

  static async updateStatus(id, status, actualDelivery = null) {
    const result = await executeQuery(
      'UPDATE purchase_orders SET status = ?, actual_delivery = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [status, actualDelivery, id]
    );
    if (result.affectedRows === 0) throw new Error('Purchase order not found');
    return await PurchaseOrder.findById(id);
  }

  static async generateOrderNumber(scopeType, scopeId) {
    const prefix    = scopeType === 'WAREHOUSE' ? 'PO-WH' : 'PO-BR';
    const yearMonth = new Date().toISOString().slice(0, 7).replace('-', '');
    const [rows]    = await pool.execute(
      `SELECT COALESCE(MAX(CAST(SUBSTRING(order_number, -4) AS UNSIGNED)), 0) + 1 as next_number
       FROM purchase_orders WHERE order_number LIKE ?`,
      [`${prefix}-${yearMonth}%`]
    );
    return `${prefix}-${yearMonth}-${String(rows[0].next_number).padStart(4, '0')}`;
  }

  async save() {
    if (this.id) {
      await executeQuery(
        `UPDATE purchase_orders SET
           order_number = ?, supplier_id = ?, scope_type = ?, scope_id = ?,
           order_date = ?, expected_delivery = ?, actual_delivery = ?,
           status = ?, total_amount = ?, notes = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [this.orderNumber, this.supplierId, this.scopeType, this.scopeId,
         this.orderDate, this.expectedDelivery, this.actualDelivery,
         this.status, this.totalAmount, this.notes, this.id]
      );
    } else {
      const result = await executeQuery(
        `INSERT INTO purchase_orders (
           order_number, supplier_id, scope_type, scope_id, order_date,
           expected_delivery, actual_delivery, status, total_amount, notes, created_by
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [this.orderNumber, this.supplierId, this.scopeType, this.scopeId,
         this.orderDate, this.expectedDelivery, this.actualDelivery,
         this.status, this.totalAmount, this.notes, this.createdBy]
      );
      this.id = result.insertId || result.lastID;
    }
    return this;
  }

  async addItem(itemData) {
    return await PurchaseOrderItem.create({ ...itemData, purchaseOrderId: this.id });
  }

  async calculateTotal() {
    const items = await PurchaseOrderItem.findByOrderId(this.id);
    this.totalAmount = items.reduce((t, i) => t + (i.totalPrice || 0), 0);
    await this.save();
    return this.totalAmount;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PurchaseOrderItem
// KEY CHANGES:
//   constructor  — added  this.sellingPrice = data.selling_price ?? null
//   create()     — added  selling_price column in INSERT
//   save()       — added  selling_price in both UPDATE and INSERT
// ─────────────────────────────────────────────────────────────────────────────
class PurchaseOrderItem {
  constructor(data) {
    this.id              = data.id;
    this.purchaseOrderId = data.purchase_order_id;
    this.inventoryItemId = data.inventory_item_id;
    this.itemName        = data.item_name;
    this.itemSku         = data.item_sku;
    this.itemBarcode     = data.item_barcode ?? null;
    this.itemCategory    = data.item_category   || 'General';
    this.itemDescription = data.item_description;
    this.quantityOrdered = data.quantity_ordered;
    this.quantityReceived= data.quantity_received;
    this.unitPrice       = data.unit_price;       // cost price (what you paid supplier)
    this.sellingPrice    = data.selling_price     ?? null; // optional selling price
    this.totalPrice      = data.total_price;
    this.notes           = data.notes;
    this.createdAt       = data.created_at;
    this.updatedAt       = data.updated_at;
  }

  // ── CREATE ─────────────────────────────────────────────────────────────────
  static async create(itemData) {
    await ensureItemBarcodeColumn();

    const {
      purchaseOrderId, inventoryItemId, itemName, itemSku, itemBarcode, itemCategory,
      itemDescription, quantityOrdered, quantityReceived,
      unitPrice,    // cost price
      sellingPrice, // optional — null means "don't change existing selling price"
      totalPrice, notes
    } = itemData;

    const barcode = itemBarcode != null && String(itemBarcode).trim() !== ''
      ? String(itemBarcode).trim()
      : null;

    const result = await executeQuery(
      `INSERT INTO purchase_order_items (
         purchase_order_id, inventory_item_id, item_name, item_sku, item_barcode, item_category,
         item_description, quantity_ordered, quantity_received,
         unit_price, selling_price, total_price, notes
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        purchaseOrderId,
        inventoryItemId   || null,
        itemName,
        itemSku           || null,
        barcode,
        itemCategory      || 'General',
        itemDescription   || null,
        quantityOrdered,
        quantityReceived  || 0,
        unitPrice,
        sellingPrice != null ? sellingPrice : null,
        totalPrice,
        notes             || null
      ]
    );
    return await PurchaseOrderItem.findById(result.insertId || result.lastID);
  }

  static async findById(id) {
    const rows = await executeQuery('SELECT * FROM purchase_order_items WHERE id = ?', [id]);
    if (rows.length === 0) return null;
    return new PurchaseOrderItem(rows[0]);
  }

  static async findByOrderId(orderId) {
    const rows = await executeQuery(
      'SELECT * FROM purchase_order_items WHERE purchase_order_id = ? ORDER BY id',
      [orderId]
    );
    return rows.map(row => new PurchaseOrderItem(row));
  }

  // ── SAVE (UPDATE / INSERT) ──────────────────────────────────────────────────
  async save() {
    await ensureItemBarcodeColumn();

    const barcode = this.itemBarcode != null && String(this.itemBarcode).trim() !== ''
      ? String(this.itemBarcode).trim()
      : null;

    if (this.id) {
      await executeQuery(
        `UPDATE purchase_order_items SET
           purchase_order_id = ?, inventory_item_id = ?, item_name = ?, item_sku = ?, item_barcode = ?,
           item_category = ?, item_description = ?, quantity_ordered = ?, quantity_received = ?,
           unit_price = ?, selling_price = ?, total_price = ?, notes = ?,
           updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [
          this.purchaseOrderId, this.inventoryItemId, this.itemName, this.itemSku, barcode,
          this.itemCategory || 'General', this.itemDescription,
          this.quantityOrdered, this.quantityReceived,
          this.unitPrice,
          this.sellingPrice != null ? this.sellingPrice : null,
          this.totalPrice, this.notes,
          this.id
        ]
      );
    } else {
      const result = await executeQuery(
        `INSERT INTO purchase_order_items (
           purchase_order_id, inventory_item_id, item_name, item_sku, item_barcode, item_category,
           item_description, quantity_ordered, quantity_received,
           unit_price, selling_price, total_price, notes
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          this.purchaseOrderId, this.inventoryItemId, this.itemName, this.itemSku, barcode,
          this.itemCategory || 'General', this.itemDescription,
          this.quantityOrdered, this.quantityReceived,
          this.unitPrice,
          this.sellingPrice != null ? this.sellingPrice : null,
          this.totalPrice, this.notes
        ]
      );
      this.id = result.insertId || result.lastID;
    }
    return this;
  }

  async updateReceivedQuantity(quantity) {
    this.quantityReceived = quantity;
    await this.save();
    return this;
  }
}

module.exports = { PurchaseOrder, PurchaseOrderItem };