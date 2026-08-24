const { executeQuery, pool } = require('../config/database');

class InventoryItem {
  static _legacyStockMutationGuard(source) {
    const msg = `[InventoryItem] Legacy stock mutation removed (${source}). Use inventoryProjectionService.applyEvent().`;
    if (process.env.NODE_ENV === 'production') {
      throw new Error('Direct stock mutation forbidden');
    }
    throw new Error(msg);
  }

  constructor(data) {
    this.id = data.id;
    this.sku = data.sku;
    this.barcode = data.barcode;
    this.name = data.name;
    this.description = data.description;
    this.category = data.category;
    this.unit = data.unit;
    this.costPrice = data.cost_price;
    this.sellingPrice = data.selling_price;
    this.minStockLevel = data.min_stock_level;
    this.maxStockLevel = data.max_stock_level;
    this.currentStock = data.current_stock;
    this.scopeType = data.scope_type;
    this.scopeId = data.scope_id;
    this.createdBy = data.created_by;
    this.createdAt = data.created_at;
    this.updatedAt = data.updated_at;
    
    // Supplier tracking fields
    this.supplierId = data.supplier_id;
    this.supplierName = data.supplier_name;
    this.purchaseDate = data.purchase_date;
    this.purchasePrice = data.purchase_price;
  }

  // Static method to create a new inventory item
  static async create(itemData) {
    const { 
      sku, barcode, name, description, category, unit, costPrice, sellingPrice, 
      minStockLevel, maxStockLevel, currentStock, scopeType, scopeId, createdBy,
      supplierId, supplierName, purchaseDate, purchasePrice
    } = itemData;
    
    const insertQuery = `INSERT INTO inventory_items (sku, barcode, name, description, category, unit, cost_price, selling_price, 
       min_stock_level, max_stock_level, current_stock, scope_type, scope_id, created_by,
       supplier_id, supplier_name, purchase_date, purchase_price) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

    // Ensure min/max default to 0 so that NOT NULL DB constraints are satisfied
    const safeMinStockLevel = (typeof minStockLevel === 'number' ? minStockLevel : 0);
    const safeMaxStockLevel = (typeof maxStockLevel === 'number' ? maxStockLevel : 0);
    if (safeMinStockLevel !== minStockLevel || safeMaxStockLevel !== maxStockLevel) {
    }

    const params = [sku, barcode || null, name, description, category, unit, costPrice, sellingPrice, 
      safeMinStockLevel, safeMaxStockLevel, currentStock, scopeType, scopeId, createdBy,
      supplierId || null, supplierName || null, purchaseDate || null, purchasePrice || null];

    // Defensive: convert any undefined bind parameters to null to satisfy SQL drivers
    const undefinedIndexes = params.map((p, i) => ({ i, p })).filter(x => typeof x.p === 'undefined');
    if (undefinedIndexes.length) {
    }

    const sanitizedParams = params.map(p => (typeof p === 'undefined' ? null : p));

    const result = await executeQuery(insertQuery, sanitizedParams);
    
    return await InventoryItem.findById(result.insertId || result.lastID);
  }

  // Static method to find inventory item by ID
  static async findById(id) {
    const rows = await executeQuery(
      'SELECT * FROM inventory_items WHERE id = ?',
      [id]
    );
    
    if (rows.length === 0) return null;
    return new InventoryItem(rows[0]);
  }

  // Static method to find inventory item by SKU
  static async findBySku(sku) {
    const [rows] = await pool.execute(
      'SELECT * FROM inventory_items WHERE sku = ?',
      [sku]
    );
    
    if (rows.length === 0) return null;
    return new InventoryItem(rows[0]);
  }

  // Static method to find inventory item by SKU within a specific scope
  static async findBySkuInScope(sku, scopeType, scopeId) {
    const [rows] = await pool.execute(
      'SELECT * FROM inventory_items WHERE sku = ? AND scope_type = ? AND scope_id = ?',
      [sku, scopeType, scopeId]
    );
    
    if (rows.length === 0) return null;
    return new InventoryItem(rows[0]);
  }

  // Static method to find inventory item
  static async findOne(conditions) {
    let query = 'SELECT * FROM inventory_items WHERE ';
    const params = [];
    const conditionsArray = [];

    if (conditions.sku) {
      conditionsArray.push('sku = ?');
      params.push(conditions.sku);
    }

    if (conditions.name) {
      conditionsArray.push('name = ?');
      params.push(conditions.name);
    }

    if (conditions._id) {
      conditionsArray.push('id = ?');
      params.push(conditions._id);
    }

    if (conditions.id) {
      conditionsArray.push('id = ?');
      params.push(conditions.id);
    }

    if (conditions.scopeType && conditions.scopeId) {
      conditionsArray.push('scope_type = ? AND scope_id = ?');
      params.push(conditions.scopeType, conditions.scopeId);
    }

    if (conditionsArray.length === 0) return null;

    query += conditionsArray.join(' AND ');
    query += ' LIMIT 1';

    const rows = await executeQuery(query, params);
    
    if (rows.length === 0) return null;
    return new InventoryItem(rows[0]);
  }

  // Instance method to save inventory item
  async save() {
    if (this.id) {
      // Update existing inventory item
      await executeQuery(
        `UPDATE inventory_items SET sku = ?, barcode = ?, name = ?, description = ?, category = ?, unit = ?, 
         cost_price = ?, selling_price = ?, min_stock_level = ?, max_stock_level = ?, 
         current_stock = ?, scope_type = ?, scope_id = ?, created_by = ?,
         supplier_id = ?, supplier_name = ?, purchase_date = ?, purchase_price = ?
         WHERE id = ?`,
        [this.sku, this.barcode || null, this.name, this.description, this.category, this.unit, 
         this.costPrice, this.sellingPrice, this.minStockLevel, this.maxStockLevel, 
         this.currentStock, this.scopeType, this.scopeId, this.createdBy,
         this.supplierId || null, this.supplierName || null, this.purchaseDate || null, this.purchasePrice || null,
         this.id]
      );
    } else {
      // Create new inventory item
      const insertQuery = `INSERT INTO inventory_items (sku, name, description, category, unit, cost_price, selling_price, 
         min_stock_level, max_stock_level, current_stock, scope_type, scope_id, created_by,
         supplier_id, supplier_name, purchase_date, purchase_price) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

      // Ensure min/max default to 0 to satisfy NOT NULL columns
      const safeMinStockLevel = (typeof this.minStockLevel === 'number' ? this.minStockLevel : 0);
      const safeMaxStockLevel = (typeof this.maxStockLevel === 'number' ? this.maxStockLevel : 0);
      if (safeMinStockLevel !== this.minStockLevel || safeMaxStockLevel !== this.maxStockLevel) {
      }

      const params = [this.sku, this.name, this.description, this.category, this.unit, 
         this.costPrice, this.sellingPrice, safeMinStockLevel, safeMaxStockLevel, 
         this.currentStock, this.scopeType, this.scopeId, this.createdBy,
         this.supplierId || null, this.supplierName || null, this.purchaseDate || null, this.purchasePrice || null];

      const undefinedIndexes = params.map((p, i) => ({ i, p })).filter(x => typeof x.p === 'undefined');
      if (undefinedIndexes.length) {
      }

      const sanitizedParams = params.map(p => (typeof p === 'undefined' ? null : p));

      const result = await executeQuery(insertQuery, sanitizedParams);
      this.id = result.insertId || result.lastID;
    }
    return this;
  }

  // Static method to find inventory items with pagination
  static async find(conditions = {}, options = {}) {
    let query = 'SELECT * FROM inventory_items WHERE 1=1';
    const params = [];

    if (conditions.sku) {
      query += ' AND sku LIKE ?';
      params.push(`%${conditions.sku}%`);
    }

    if (conditions.name) {
      query += ' AND name LIKE ?';
      params.push(`%${conditions.name}%`);
    }

    if (conditions.category) {
      query += ' AND category = ?';
      params.push(conditions.category);
    }

    if (conditions.scopeType) {
      query += ' AND scope_type = ?';
      params.push(conditions.scopeType);
    }

    if (conditions.scopeId) {
      query += ' AND scope_id = ?';
      params.push(conditions.scopeId);
    }

    if (conditions.createdBy) {
      query += ' AND created_by = ?';
      params.push(conditions.createdBy);
    }

    // Add sorting
    if (options.sort) {
      const sortField = options.sort.replace(/^-/, ''); // Remove minus sign
      const sortOrder = options.sort.startsWith('-') ? 'DESC' : 'ASC';
      query += ` ORDER BY ${sortField} ${sortOrder}`;
    } else {
      query += ' ORDER BY created_at DESC';
    }

    // Add pagination
    if (options.limit) {
      query += ' LIMIT ?';
      params.push(options.limit);
      
      if (options.skip) {
        query += ' OFFSET ?';
        params.push(options.skip);
      }
    }

    const rows = await executeQuery(query, params);
    return rows.map(row => new InventoryItem(row));
  }

  // Static method to count inventory items
  static async count(conditions = {}) {
    let query = 'SELECT COUNT(*) as count FROM inventory_items WHERE 1=1';
    const params = [];

    if (conditions.sku) {
      query += ' AND sku LIKE ?';
      params.push(`%${conditions.sku}%`);
    }

    if (conditions.name) {
      query += ' AND name LIKE ?';
      params.push(`%${conditions.name}%`);
    }

    if (conditions.category) {
      query += ' AND category = ?';
      params.push(conditions.category);
    }

    if (conditions.scopeType) {
      query += ' AND scope_type = ?';
      params.push(conditions.scopeType);
    }

    if (conditions.scopeId) {
      query += ' AND scope_id = ?';
      params.push(conditions.scopeId);
    }

    if (conditions.createdBy) {
      query += ' AND created_by = ?';
      params.push(conditions.createdBy);
    }

    const rows = await executeQuery(query, params);
    return rows[0].count;
  }

  // Static method to update inventory item by ID (alias for updateOne)
  static async update(id, updateData) {
    return await InventoryItem.updateOne({ id }, updateData);
  }

  // Static method to delete inventory item by ID (alias for deleteOne)
  static async delete(id) {
    return await InventoryItem.deleteOne({ id });
  }

  // Static method to update inventory item
  static async updateOne(conditions, updateData) {
    let query = 'UPDATE inventory_items SET ';
    const params = [];
    const setClauses = [];

    // Fields to exclude from updates (computed fields from JOINs)
    const excludedFields = [
      'id',
      // Derived/joined display fields
      'branchName', 'branch_name',
      'warehouseName', 'warehouse_name',
      'scopeName', 'scope_name',
      'createdByName', 'updatedByName',
      'supplierContact', 'supplier_contact',
      'supplierPhone', 'supplier_phone',
      'supplierEmail', 'supplier_email',
      // Aggregated stock fields (should never be persisted directly)
      'totalPurchased', 'total_purchased',
      'totalSold', 'total_sold',
      'totalReturned', 'total_returned',
      'totalAdjusted', 'total_adjusted',
      'totalRestocked', 'total_restocked',
      'pendingReturns', 'pending_returns',
      // Cache only — must never be overwritten via UPDATE; use ledger + projection.
      'currentStock',
      'current_stock',
    ];
    
    Object.keys(updateData).forEach(key => {
      if (!excludedFields.includes(key)) {
        // Map camelCase to snake_case for database columns
        const fieldMapping = {
          'costPrice': 'cost_price',
          'sellingPrice': 'selling_price',
          'minStockLevel': 'min_stock_level',
          'maxStockLevel': 'max_stock_level',
          'currentStock': 'current_stock',
          'scopeType': 'scope_type',
          'scopeId': 'scope_id',
          'createdBy': 'created_by',
          'createdAt': 'created_at',
          'updatedAt': 'updated_at',
          'supplierId': 'supplier_id',
          'supplierName': 'supplier_name',
          'purchaseDate': 'purchase_date',
          'purchasePrice': 'purchase_price'
        };
        
        const dbColumn = fieldMapping[key] || key;
        setClauses.push(`${dbColumn} = ?`);
        params.push(updateData[key]);
      }
    });

    if (setClauses.length === 0) return { modifiedCount: 0 };

    query += setClauses.join(', ');
    query += ' WHERE ';

    const whereClauses = [];
    if (conditions._id) {
      whereClauses.push('id = ?');
      params.push(conditions._id);
    }
    if (conditions.id) {
      whereClauses.push('id = ?');
      params.push(conditions.id);
    }
    if (conditions.sku) {
      whereClauses.push('sku = ?');
      params.push(conditions.sku);
    }

    if (whereClauses.length === 0) return { modifiedCount: 0 };

    query += whereClauses.join(' AND ');

    const result = await executeQuery(query, params);
    return { modifiedCount: result.affectedRows };
  }

  // Static method to delete inventory item
  static async deleteOne(conditions) {
    let query = 'DELETE FROM inventory_items WHERE ';
    const params = [];
    const whereClauses = [];

    if (conditions._id) {
      whereClauses.push('id = ?');
      params.push(conditions._id);
    }
    if (conditions.id) {
      whereClauses.push('id = ?');
      params.push(conditions.id);
    }
    if (conditions.sku) {
      whereClauses.push('sku = ?');
      params.push(conditions.sku);
    }

    if (whereClauses.length === 0) return { deletedCount: 0 };

    query += whereClauses.join(' AND ');

    const result = await executeQuery(query, params);
    return { deletedCount: result.affectedRows };
  }

  /**
   * Do not use to change on-hand qty — use inventory ledger + inventoryProjectionService.
   * Saving current_stock directly bypasses the event log.
   */
  async updateStock(newStock) {
    return InventoryItem._legacyStockMutationGuard('instance.updateStock');
  }

  // Method to check if stock is low
  isLowStock() {
    return this.currentStock <= this.minStockLevel;
  }

  // Method to check if stock is high
  isHighStock() {
    return this.maxStockLevel && this.currentStock >= this.maxStockLevel;
  }

  static async updateStock() {
    return InventoryItem._legacyStockMutationGuard('static.updateStock');
  }

  static async updateStockWithValidation() {
    return InventoryItem._legacyStockMutationGuard('static.updateStockWithValidation');
  }
}

module.exports = InventoryItem;