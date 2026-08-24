const { pool } = require('../config/database');

class Warehouse {
  constructor(data) {
    this.id = data.id;
    this.name = data.name;
    this.code = data.code;
    this.location = data.location;
    this.phone = data.phone || null;
    this.branchId = data.branch_id;
    this.capacity = data.capacity || null;
    this.currentStock = data.current_stock || null;
    this.stock = data.stock || null;
    this.manager = data.manager || 'Not Assigned';
    this.status = data.status || 'active';

    // Parse settings from JSON field
    this.settings = {};
    if (data.settings) {
      try {
        this.settings = typeof data.settings === 'string'
          ? JSON.parse(data.settings)
          : data.settings;
      } catch (error) {
        this.settings = {};
      }
    }

    // ==================== BASIC WAREHOUSE PERMISSIONS ====================
    this.allow_warehouse_inventory_add  = data.allow_warehouse_inventory_add  !== undefined ? data.allow_warehouse_inventory_add  : 0;
    this.allow_warehouse_inventory_edit = data.allow_warehouse_inventory_edit !== undefined ? data.allow_warehouse_inventory_edit : 0;
    this.allow_warehouse_returns        = data.allow_warehouse_returns        !== undefined ? data.allow_warehouse_returns        : 0;
    this.allow_warehouse_companies      = data.allow_warehouse_companies      !== undefined ? data.allow_warehouse_companies      : 0;
    this.allow_warehouse_direct_sales   = data.allow_warehouse_direct_sales   !== undefined ? data.allow_warehouse_direct_sales   : 0;
    this.allow_warehouse_ledger_edit    = data.allow_warehouse_ledger_edit    !== undefined ? data.allow_warehouse_ledger_edit    : 0;
    this.require_approval_for_transfers = data.require_approval_for_transfers !== undefined ? data.require_approval_for_transfers : 1;
    this.auto_stock_alerts              = data.auto_stock_alerts              !== undefined ? data.auto_stock_alerts              : 0;

    // ==================== SALES PERMISSIONS ====================
    this.allow_warehouse_sales_edit   = data.allow_warehouse_sales_edit   !== undefined ? data.allow_warehouse_sales_edit   : 0;
    this.allow_warehouse_sales_delete = data.allow_warehouse_sales_delete !== undefined ? data.allow_warehouse_sales_delete : 0;

    // Old company CRUD (backward compatibility)
    this.allow_warehouse_company_crud = data.allow_warehouse_company_crud || 0;

    // ==================== COMPANY PERMISSIONS ====================
    this.allow_company_create = data.allow_company_create !== undefined ? data.allow_company_create : 0;
    this.allow_company_edit   = data.allow_company_edit   !== undefined ? data.allow_company_edit   : 0;
    this.allow_company_delete = data.allow_company_delete !== undefined ? data.allow_company_delete : 0;

    // ==================== RETAILER PERMISSIONS ====================
    this.allow_retailer_create        = data.allow_retailer_create        !== undefined ? data.allow_retailer_create        : 0;
    this.allow_retailer_edit          = data.allow_retailer_edit          !== undefined ? data.allow_retailer_edit          : 0;
    this.allow_retailer_delete        = data.allow_retailer_delete        !== undefined ? data.allow_retailer_delete        : 0;
    this.allow_retailer_customer_edit = data.allow_retailer_customer_edit !== undefined ? data.allow_retailer_customer_edit : 0;
    this.allow_whatsapp_ledger        = data.allow_whatsapp_ledger        !== undefined ? data.allow_whatsapp_ledger        : 0;

    // ==================== TRANSFER SETTINGS ====================
    this.allow_warehouse_transfers              = data.allow_warehouse_transfers              !== undefined ? data.allow_warehouse_transfers              : 0;
    this.allow_warehouse_to_branch_transfers    = data.allow_warehouse_to_branch_transfers    !== undefined ? data.allow_warehouse_to_branch_transfers    : 0;
    this.allow_warehouse_to_warehouse_transfers = data.allow_warehouse_to_warehouse_transfers !== undefined ? data.allow_warehouse_to_warehouse_transfers : 0;
    this.require_approval_for_warehouse_transfers = data.require_approval_for_warehouse_transfers !== undefined ? data.require_approval_for_warehouse_transfers : 1;
    this.max_transfer_amount          = data.max_transfer_amount        ? parseFloat(data.max_transfer_amount)        : 50000.00;
    this.auto_approve_small_transfers = data.auto_approve_small_transfers !== undefined ? data.auto_approve_small_transfers : 0;
    this.small_transfer_threshold     = data.small_transfer_threshold   ? parseFloat(data.small_transfer_threshold)   : 1000.00;

    // ==================== BACKWARD COMPAT CAMELCASE ====================
    this.allowWarehouseTransfers              = this.allow_warehouse_transfers === 1;
    this.allowWarehouseToBranchTransfers      = this.allow_warehouse_to_branch_transfers === 1;
    this.allowWarehouseToWarehouseTransfers   = this.allow_warehouse_to_warehouse_transfers === 1;
    this.requireApprovalForWarehouseTransfers = this.require_approval_for_warehouse_transfers === 1;
    this.maxTransferAmount                    = this.max_transfer_amount;
    this.autoApproveSmallTransfers            = this.auto_approve_small_transfers === 1;
    this.smallTransferThreshold               = this.small_transfer_threshold;

    this.createdBy = data.created_by;
    this.updatedBy = data.updated_by;
    this.createdAt = data.created_at;
    this.updatedAt = data.updated_at;
  }

  static async create(warehouseData) {
    const {
      name, code, location, branch_id,
      capacity = null, stock = null,
      manager = 'Not Assigned', phone,
      status = 'active', created_by,
      settings = {}
    } = warehouseData;

    const [result] = await pool.execute(
      `INSERT INTO warehouses (
        name, code, location, branch_id, capacity, stock, manager, phone,
        status, created_by, settings,
        allow_warehouse_inventory_add, allow_warehouse_inventory_edit,
        allow_warehouse_returns, allow_warehouse_companies,
        allow_warehouse_direct_sales, allow_warehouse_ledger_edit,
        require_approval_for_transfers, auto_stock_alerts,
        allow_warehouse_company_crud,
        allow_warehouse_sales_edit, allow_warehouse_sales_delete,
        allow_company_create, allow_company_edit, allow_company_delete,
        allow_retailer_create, allow_retailer_edit, allow_retailer_delete,
        allow_retailer_customer_edit, allow_whatsapp_ledger,
        allow_warehouse_transfers, allow_warehouse_to_branch_transfers,
        allow_warehouse_to_warehouse_transfers,
        require_approval_for_warehouse_transfers,
        max_transfer_amount, auto_approve_small_transfers, small_transfer_threshold
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        name, code, location, branch_id, capacity, stock, manager,
        phone || null, status, created_by, JSON.stringify(settings),
        0, 0,       // allow_warehouse_inventory_add, allow_warehouse_inventory_edit
        0, 0,       // allow_warehouse_returns, allow_warehouse_companies
        0, 0,       // allow_warehouse_direct_sales, allow_warehouse_ledger_edit
        1, 0, 0,    // require_approval_for_transfers, auto_stock_alerts, allow_warehouse_company_crud
        0, 0,       // allow_warehouse_sales_edit, allow_warehouse_sales_delete
        0, 0, 0,    // allow_company_create, allow_company_edit, allow_company_delete
        0, 0, 0,    // allow_retailer_create, allow_retailer_edit, allow_retailer_delete
        0, 0,       // allow_retailer_customer_edit, allow_whatsapp_ledger
        0, 0, 0,    // allow_warehouse_transfers, allow_warehouse_to_branch_transfers, allow_warehouse_to_warehouse_transfers
        1,          // require_approval_for_warehouse_transfers
        50000.00, 0, 1000.00  // max_transfer_amount, auto_approve_small_transfers, small_transfer_threshold
      ]
    );

    return await Warehouse.findById(result.insertId);
  }

  static async findById(id) {
    const [rows] = await pool.execute('SELECT * FROM warehouses WHERE id = ?', [id]);
    if (rows.length === 0) return null;
    return new Warehouse(rows[0]);
  }

  static async findOne(conditions) {
    let query = 'SELECT * FROM warehouses WHERE ';
    const params = [];
    const conditionsArray = [];

    if (conditions.code) { conditionsArray.push('code = ?'); params.push(conditions.code); }
    if (conditions.name) { conditionsArray.push('name = ?'); params.push(conditions.name); }
    if (conditions._id)  { conditionsArray.push('id = ?');   params.push(conditions._id); }
    if (conditions.id)   { conditionsArray.push('id = ?');   params.push(conditions.id); }

    if (conditionsArray.length === 0) return null;

    query += conditionsArray.join(' AND ') + ' LIMIT 1';

    const [rows] = await pool.execute(query, params);
    if (rows.length === 0) return null;
    return new Warehouse(rows[0]);
  }

  async save() {
    if (this.id) {
      await pool.execute(
        `UPDATE warehouses SET
          name = ?,
          code = ?,
          location = ?,
          branch_id = ?,
          capacity = ?,
          stock = ?,
          manager = ?,
          phone = ?,
          status = ?,
          updated_by = ?,
          settings = ?,
          allow_warehouse_inventory_add = ?,
          allow_warehouse_inventory_edit = ?,
          allow_warehouse_returns = ?,
          allow_warehouse_companies = ?,
          allow_warehouse_direct_sales = ?,
          allow_warehouse_ledger_edit = ?,
          require_approval_for_transfers = ?,
          auto_stock_alerts = ?,
          allow_warehouse_company_crud = ?,
          allow_warehouse_sales_edit = ?,
          allow_warehouse_sales_delete = ?,
          allow_company_create = ?,
          allow_company_edit = ?,
          allow_company_delete = ?,
          allow_retailer_create = ?,
          allow_retailer_edit = ?,
          allow_retailer_delete = ?,
          allow_retailer_customer_edit = ?,
          allow_whatsapp_ledger = ?,
          allow_warehouse_transfers = ?,
          allow_warehouse_to_branch_transfers = ?,
          allow_warehouse_to_warehouse_transfers = ?,
          require_approval_for_warehouse_transfers = ?,
          max_transfer_amount = ?,
          auto_approve_small_transfers = ?,
          small_transfer_threshold = ?,
          updated_at = NOW()
        WHERE id = ?`,
        [
          this.name,
          this.code,
          this.location,
          this.branchId || null,
          this.capacity || null,
          this.stock || null,
          this.manager || 'Not Assigned',
          this.phone || null,
          this.status || 'active',
          this.updatedBy || null,
          JSON.stringify(this.settings),
          this.allow_warehouse_inventory_add  || 0,
          this.allow_warehouse_inventory_edit || 0,
          this.allow_warehouse_returns        || 0,
          this.allow_warehouse_companies      || 0,
          this.allow_warehouse_direct_sales   || 0,
          this.allow_warehouse_ledger_edit    || 0,
          this.require_approval_for_transfers !== undefined ? this.require_approval_for_transfers : 1,
          this.auto_stock_alerts              || 0,
          this.allow_warehouse_company_crud   || 0,
          this.allow_warehouse_sales_edit     || 0,
          this.allow_warehouse_sales_delete   || 0,
          this.allow_company_create           || 0,
          this.allow_company_edit             || 0,
          this.allow_company_delete           || 0,
          this.allow_retailer_create          || 0,
          this.allow_retailer_edit            || 0,
          this.allow_retailer_delete          || 0,
          this.allow_retailer_customer_edit   || 0,
          this.allow_whatsapp_ledger          || 0,
          this.allow_warehouse_transfers              || 0,
          this.allow_warehouse_to_branch_transfers    || 0,
          this.allow_warehouse_to_warehouse_transfers || 0,
          this.require_approval_for_warehouse_transfers !== undefined ? this.require_approval_for_warehouse_transfers : 1,
          this.max_transfer_amount          || 50000.00,
          this.auto_approve_small_transfers || 0,
          this.small_transfer_threshold     || 1000.00,
          this.id
        ]
      );
    } else {
      const [result] = await pool.execute(
        `INSERT INTO warehouses (
          name, code, location, settings,
          allow_warehouse_inventory_add, allow_warehouse_inventory_edit,
          allow_warehouse_returns, allow_warehouse_companies,
          allow_warehouse_direct_sales, allow_warehouse_ledger_edit,
          require_approval_for_transfers, auto_stock_alerts,
          allow_warehouse_company_crud,
          allow_warehouse_sales_edit, allow_warehouse_sales_delete,
          allow_company_create, allow_company_edit, allow_company_delete,
          allow_retailer_create, allow_retailer_edit, allow_retailer_delete,
          allow_retailer_customer_edit, allow_whatsapp_ledger,
          allow_warehouse_transfers, allow_warehouse_to_branch_transfers,
          allow_warehouse_to_warehouse_transfers,
          require_approval_for_warehouse_transfers,
          max_transfer_amount, auto_approve_small_transfers, small_transfer_threshold
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          this.name, this.code, this.location, JSON.stringify(this.settings),
          this.allow_warehouse_inventory_add  || 0,
          this.allow_warehouse_inventory_edit || 0,
          this.allow_warehouse_returns        || 0,
          this.allow_warehouse_companies      || 0,
          this.allow_warehouse_direct_sales   || 0,
          this.allow_warehouse_ledger_edit    || 0,
          this.require_approval_for_transfers !== undefined ? this.require_approval_for_transfers : 1,
          this.auto_stock_alerts              || 0,
          this.allow_warehouse_company_crud   || 0,
          this.allow_warehouse_sales_edit     || 0,
          this.allow_warehouse_sales_delete   || 0,
          this.allow_company_create           || 0,
          this.allow_company_edit             || 0,
          this.allow_company_delete           || 0,
          this.allow_retailer_create          || 0,
          this.allow_retailer_edit            || 0,
          this.allow_retailer_delete          || 0,
          this.allow_retailer_customer_edit   || 0,
          this.allow_whatsapp_ledger          || 0,
          this.allow_warehouse_transfers              || 0,
          this.allow_warehouse_to_branch_transfers    || 0,
          this.allow_warehouse_to_warehouse_transfers || 0,
          this.require_approval_for_warehouse_transfers !== undefined ? this.require_approval_for_warehouse_transfers : 1,
          this.max_transfer_amount          || 50000.00,
          this.auto_approve_small_transfers || 0,
          this.small_transfer_threshold     || 1000.00
        ]
      );
      this.id = result.insertId;
    }
    return this;
  }

  static async find(conditions = {}, options = {}) {
    let query = 'SELECT * FROM warehouses WHERE 1=1 AND deleted_at IS NULL';
    const params = [];

    if (conditions.name)     { query += ' AND name LIKE ?';     params.push(`%${conditions.name}%`); }
    if (conditions.code)     { query += ' AND code LIKE ?';     params.push(`%${conditions.code}%`); }
    if (conditions.location) { query += ' AND location LIKE ?'; params.push(`%${conditions.location}%`); }

    if (options.sort) {
      const sortField = options.sort.replace(/^-/, '');
      const sortOrder = options.sort.startsWith('-') ? 'DESC' : 'ASC';
      query += ` ORDER BY ${sortField} ${sortOrder}`;
    } else {
      query += ' ORDER BY created_at DESC';
    }

    if (options.limit) {
      query += ' LIMIT ?';
      params.push(options.limit);
      if (options.skip) { query += ' OFFSET ?'; params.push(options.skip); }
    }

    const [rows] = await pool.execute(query, params);
    return rows.map(row => new Warehouse(row));
  }

  static async count(conditions = {}) {
    let query = 'SELECT COUNT(*) as count FROM warehouses WHERE 1=1 AND deleted_at IS NULL';
    const params = [];

    if (conditions.name)     { query += ' AND name LIKE ?';     params.push(`%${conditions.name}%`); }
    if (conditions.code)     { query += ' AND code LIKE ?';     params.push(`%${conditions.code}%`); }
    if (conditions.location) { query += ' AND location LIKE ?'; params.push(`%${conditions.location}%`); }

    const [rows] = await pool.execute(query, params);
    return rows[0].count;
  }

  static async update(id, updateData) {
    const dbUpdateData = {};

    if (updateData.name     !== undefined) dbUpdateData.name      = updateData.name;
    if (updateData.code     !== undefined) dbUpdateData.code      = updateData.code;
    if (updateData.location !== undefined) dbUpdateData.location  = updateData.location;
    if (updateData.branchId !== undefined) dbUpdateData.branch_id = updateData.branchId;
    if (updateData.capacity !== undefined) dbUpdateData.capacity  = updateData.capacity;
    if (updateData.stock    !== undefined) dbUpdateData.stock     = updateData.stock;
    if (updateData.phone    !== undefined) dbUpdateData.phone     = updateData.phone;
    if (updateData.manager  !== undefined) dbUpdateData.manager   = updateData.manager;
    if (updateData.status   !== undefined) dbUpdateData.status    = updateData.status;

    const permissionFields = [
      'allow_warehouse_inventory_add', 'allow_warehouse_inventory_edit',
      'allow_warehouse_returns', 'allow_warehouse_companies',
      'allow_warehouse_direct_sales', 'allow_warehouse_ledger_edit',
      'require_approval_for_transfers', 'auto_stock_alerts',
      'allow_warehouse_company_crud',
      'allow_warehouse_sales_edit', 'allow_warehouse_sales_delete',
      'allow_company_create', 'allow_company_edit', 'allow_company_delete',
      'allow_retailer_create', 'allow_retailer_edit', 'allow_retailer_delete',
      'allow_retailer_customer_edit', 'allow_whatsapp_ledger',
      'allow_warehouse_transfers', 'allow_warehouse_to_branch_transfers',
      'allow_warehouse_to_warehouse_transfers',
      'require_approval_for_warehouse_transfers',
      'max_transfer_amount', 'auto_approve_small_transfers', 'small_transfer_threshold'
    ];

    permissionFields.forEach(field => {
      if (updateData[field] !== undefined) dbUpdateData[field] = updateData[field];
    });

    if (updateData.settings !== undefined) {
      dbUpdateData.settings = typeof updateData.settings === 'string'
        ? updateData.settings
        : JSON.stringify(updateData.settings);
    }

    if (updateData.updatedBy !== undefined) dbUpdateData.updated_by = updateData.updatedBy;
    dbUpdateData.updated_at = new Date();

    const setClauses = [];
    const params = [];

    Object.keys(dbUpdateData).forEach(key => {
      setClauses.push(`${key} = ?`);
      params.push(dbUpdateData[key]);
    });

    if (setClauses.length === 0) throw new Error('No fields to update');

    const query = `UPDATE warehouses SET ${setClauses.join(', ')} WHERE id = ?`;
    params.push(id);

    const [result] = await pool.execute(query, params);
    if (result.affectedRows === 0) throw new Error('Warehouse not found');

    return await Warehouse.findById(id);
  }

  static async updateOne(conditions, updateData) {
    let query = 'UPDATE warehouses SET ';
    const params = [];
    const setClauses = [];

    Object.keys(updateData).forEach(key => {
      if (key !== 'id') { setClauses.push(`${key} = ?`); params.push(updateData[key]); }
    });

    if (setClauses.length === 0) return { modifiedCount: 0 };

    query += setClauses.join(', ') + ' WHERE ';

    const whereClauses = [];
    if (conditions._id)  { whereClauses.push('id = ?');   params.push(conditions._id); }
    if (conditions.id)   { whereClauses.push('id = ?');   params.push(conditions.id); }
    if (conditions.code) { whereClauses.push('code = ?'); params.push(conditions.code); }

    if (whereClauses.length === 0) return { modifiedCount: 0 };

    query += whereClauses.join(' AND ');

    const [result] = await pool.execute(query, params);
    return { modifiedCount: result.affectedRows };
  }

  static async delete(id) {
    const [result] = await pool.execute('DELETE FROM warehouses WHERE id = ?', [id]);
    if (result.affectedRows === 0) throw new Error('Warehouse not found');
    return { deletedCount: result.affectedRows };
  }

  static async deleteOne(conditions) {
    let query = 'DELETE FROM warehouses WHERE ';
    const params = [];
    const whereClauses = [];

    if (conditions._id)  { whereClauses.push('id = ?');   params.push(conditions._id); }
    if (conditions.id)   { whereClauses.push('id = ?');   params.push(conditions.id); }
    if (conditions.code) { whereClauses.push('code = ?'); params.push(conditions.code); }

    if (whereClauses.length === 0) return { deletedCount: 0 };

    query += whereClauses.join(' AND ');

    const [result] = await pool.execute(query, params);
    return { deletedCount: result.affectedRows };
  }

  static async findByCode(code) {
    const [rows] = await pool.execute('SELECT * FROM warehouses WHERE code = ?', [code]);
    if (rows.length === 0) return null;
    return new Warehouse(rows[0]);
  }

  getCompanyPermissions() {
    return {
      canCreate: this.allow_company_create === 1,
      canEdit:   this.allow_company_edit   === 1,
      canDelete: this.allow_company_delete === 1
    };
  }

  getRetailerPermissions() {
    return {
      canCreate: this.allow_retailer_create === 1,
      canEdit:   this.allow_retailer_edit   === 1,
      canDelete: this.allow_retailer_delete === 1
    };
  }
}

module.exports = Warehouse;