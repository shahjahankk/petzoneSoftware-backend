const { validationResult } = require('express-validator');
const Transfer = require('../models/Transfer');
const Branch = require('../models/Branch');
const Warehouse = require('../models/Warehouse');
const { pool } = require('../config/database');
const trashService = require('../services/trashService');
const InventoryProjection = require('../services/inventoryProjectionService');
const { getCurrentStock } = require('../services/inventoryLedgerService');

/** DB stores lowercase (approved); API may send APPROVED. */
function isApprovedTransferStatus(status) {
  return String(status || '').trim().toLowerCase() === 'approved';
}

// @desc    Create new transfer
// @route   POST /api/transfers
// @access  Private (Admin, Cashier, Warehouse Keeper with permissions)
const createTransfer = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
    }

    const { transferType, fromScopeType, fromScopeId, toScopeType, toScopeId, items, notes } = req.body;

    let fromWarehouseId = null, toWarehouseId = null, fromBranchId = null, toBranchId = null;
    if (fromScopeType === 'WAREHOUSE') fromWarehouseId = fromScopeId;
    else if (fromScopeType === 'BRANCH') fromBranchId = fromScopeId;
    if (toScopeType === 'WAREHOUSE') toWarehouseId = toScopeId;
    else if (toScopeType === 'BRANCH') toBranchId = toScopeId;

    if (req.user.role === 'CASHIER') {
      if (transferType !== 'BRANCH_TO_BRANCH') {
        return res.status(400).json({ success: false, message: 'Cashiers can only create branch transfers' });
      }
      const branch = await Branch.findById(fromBranchId);
      if (!branch) return res.status(404).json({ success: false, message: 'Source branch not found' });
      if (!branch.allow_branch_transfers) return res.status(403).json({ success: false, message: 'Branch transfers are disabled for this branch' });
      if (toBranchId && !branch.allow_branch_to_branch_transfers) return res.status(403).json({ success: false, message: 'Branch-to-branch transfers are disabled for this branch' });
      if (fromBranchId !== req.user.branchId) return res.status(403).json({ success: false, message: 'You can only transfer from your own branch' });

    } else if (req.user.role === 'WAREHOUSE_KEEPER') {
      if (transferType !== 'WAREHOUSE_TO_WAREHOUSE') {
        return res.status(400).json({ success: false, message: 'Warehouse keepers can only create warehouse transfers' });
      }
      const warehouse = await Warehouse.findById(fromWarehouseId);
      if (!warehouse) return res.status(404).json({ success: false, message: 'Source warehouse not found' });
      if (!warehouse.allow_warehouse_transfers) return res.status(403).json({ success: false, message: 'Warehouse transfers are disabled for this warehouse' });
      if (toWarehouseId && !warehouse.allow_warehouse_to_warehouse_transfers) return res.status(403).json({ success: false, message: 'Warehouse-to-warehouse transfers are disabled for this warehouse' });
      if (fromWarehouseId !== req.user.warehouseId) return res.status(403).json({ success: false, message: 'You can only transfer from your own warehouse' });
    }

    if (!items || items.length === 0) {
      return res.status(400).json({ success: false, message: 'Transfer must contain at least one item' });
    }

    for (const item of items) {
      let scopeType, scopeId;
      if (transferType === 'WAREHOUSE_TO_WAREHOUSE') { scopeType = 'WAREHOUSE'; scopeId = fromWarehouseId; }
      else if (transferType === 'BRANCH_TO_BRANCH') { scopeType = 'BRANCH'; scopeId = fromBranchId; }
      else { scopeType = fromScopeType; scopeId = fromScopeId; }

      const [inventory] = await pool.execute(
        'SELECT id FROM inventory_items WHERE id = ? AND scope_type = ? AND scope_id = ?',
        [item.inventoryItemId, scopeType, scopeId]
      );
      if (inventory.length === 0) return res.status(400).json({ success: false, message: `Item with ID ${item.inventoryItemId} not found in source location` });
      const onHand = await getCurrentStock(item.inventoryItemId, pool);
      if (onHand < item.quantityRequested) {
        return res.status(400).json({
          success: false,
          message: `Insufficient stock for item ${item.inventoryItemId}. Available: ${onHand}, Requested: ${item.quantityRequested}`,
        });
      }
    }

    const transferData = {
      transferType, fromWarehouseId, toWarehouseId, fromBranchId, toBranchId,
      createdBy: req.user.id,
      items: items.map(item => ({ inventoryItemId: item.inventoryItemId, quantity: item.quantityRequested })),
      notes
    };

    const connection = await pool.getConnection();
    await connection.beginTransaction();
    try {
      const transfer = await Transfer.create(transferData, connection);

      for (const item of items) {
        let scopeType, scopeId;
        if (transferType === 'WAREHOUSE_TO_WAREHOUSE') { scopeType = 'WAREHOUSE'; scopeId = fromWarehouseId; }
        else if (transferType === 'BRANCH_TO_BRANCH') { scopeType = 'BRANCH'; scopeId = fromBranchId; }
        else { scopeType = fromScopeType; scopeId = fromScopeId; }

        await InventoryProjection.applyEvent(connection, {
          event_type: 'TRANSFER_OUT',
          inventory_item_id: item.inventoryItemId,
          scope_type: scopeType,
          scope_id: String(scopeId != null ? scopeId : ''),
          quantity_in: 0,
          quantity_out: item.quantityRequested,
          reference_type: 'transfer',
          reference_id: `${transfer.id}:out:${item.inventoryItemId}`,
          created_by: req.user.id,
        });

        try {
          await connection.execute(`
            INSERT INTO stock_movements (movement_type, inventory_item_id, quantity, reference_type, reference_id, from_scope_type, from_scope_id, created_by, created_at)
            VALUES (?, ?, ?, 'TRANSFER', ?, ?, ?, ?, NOW())
          `, ['TRANSFER_OUT', item.inventoryItemId, item.quantityRequested, transfer.id, scopeType, scopeId, req.user.id]);
        } catch (movementError) {
        }
      }

      await connection.commit();

      res.status(201).json({ success: true, message: 'Transfer created successfully and inventory updated', data: transfer });
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }

  } catch (error) {
    res.status(500).json({ success: false, message: 'Error creating transfer', error: error.message });
  }
};

// @desc    Complete transfer and update inventory
// @route   PUT /api/transfers/:id/complete
// @access  Private (Admin, Warehouse Keeper)
const completeTransfer = async (req, res) => {
  try {
    const { id } = req.params;
    const { notes } = req.body;

    const transfer = await Transfer.findById(id);
    if (!transfer) return res.status(404).json({ success: false, message: 'Transfer not found' });
    if (!isApprovedTransferStatus(transfer.status)) {
      return res.status(400).json({ success: false, message: 'Transfer must be approved before completion' });
    }

    const connection = await pool.getConnection();
    await connection.beginTransaction();
    try {
      for (const item of transfer.items) {
        let destinationScopeType, destinationScopeId;
        if (transfer.transfer_type === 'WAREHOUSE_TO_WAREHOUSE') { destinationScopeType = 'WAREHOUSE'; destinationScopeId = transfer.to_warehouse_id; }
        else if (transfer.transfer_type === 'BRANCH_TO_BRANCH') { destinationScopeType = 'BRANCH'; destinationScopeId = transfer.to_branch_id; }
        else throw new Error('Unsupported transfer type for completion');

        const [existingItem] = await connection.execute(
          'SELECT id FROM inventory_items WHERE sku = (SELECT sku FROM inventory_items WHERE id = ?) AND scope_type = ? AND scope_id = ?',
          [item.inventory_item_id, destinationScopeType, destinationScopeId]
        );

        let destInventoryItemId;
        if (existingItem.length > 0) {
          destInventoryItemId = existingItem[0].id;
        } else {
          const [sourceItem] = await connection.execute('SELECT * FROM inventory_items WHERE id = ?', [item.inventory_item_id]);
          if (!sourceItem.length) continue;
          const [insRow] = await connection.execute(`
              INSERT INTO inventory_items (sku, name, description, category, unit, cost_price, selling_price, min_stock_level, max_stock_level, current_stock, scope_type, scope_id, created_by)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
            `, [sourceItem[0].sku, sourceItem[0].name, sourceItem[0].description, sourceItem[0].category, sourceItem[0].unit, sourceItem[0].cost_price, sourceItem[0].selling_price, sourceItem[0].min_stock_level, sourceItem[0].max_stock_level, destinationScopeType, destinationScopeId, req.user.id]);
          destInventoryItemId = insRow.insertId;
        }

        await InventoryProjection.applyEvent(connection, {
          event_type: 'TRANSFER_IN',
          inventory_item_id: destInventoryItemId,
          scope_type: destinationScopeType,
          scope_id: String(destinationScopeId != null ? destinationScopeId : ''),
          quantity_in: parseFloat(item.quantity) || 0,
          quantity_out: 0,
          reference_type: 'transfer',
          reference_id: `${id}:in:${item.inventory_item_id}`,
          created_by: req.user.id,
        });

        try {
          await connection.execute(`
          INSERT INTO stock_movements (inventory_item_id, movement_type, quantity, reference_type, reference_id, from_scope_type, from_scope_id, to_scope_type, to_scope_id, notes, created_by)
          VALUES (?, 'TRANSFER_OUT', ?, 'TRANSFER', ?, 'WAREHOUSE', ?, ?, ?, ?, ?, ?)
        `, [item.inventory_item_id, -item.quantity, transfer.id, transfer.from_warehouse_id, destinationScopeType, destinationScopeId, `Transfer to ${destinationScopeType === 'WAREHOUSE' ? 'Warehouse' : 'Branch'} - ${notes || 'Transfer completed'}`, req.user.id]);
          await connection.execute(`
            INSERT INTO stock_movements (inventory_item_id, movement_type, quantity, reference_type, reference_id, from_scope_type, from_scope_id, to_scope_type, to_scope_id, notes, created_by)
            VALUES (?, 'TRANSFER_IN', ?, 'TRANSFER', ?, 'WAREHOUSE', ?, ?, ?, ?, ?, ?)
          `, [destInventoryItemId, item.quantity, transfer.id, transfer.from_warehouse_id, destinationScopeType, destinationScopeId, `Transfer from Warehouse - ${notes || 'Transfer completed'}`, req.user.id]);
        } catch (movementErr) {
        }
      }

      await connection.execute(
        'UPDATE transfers SET status = ?, approved_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        ['delivered', req.user.id, id]
      );
      await connection.commit();

      const updatedTransfer = await Transfer.findById(id);
      res.json({ success: true, message: 'Transfer completed successfully and inventory updated', data: updatedTransfer });
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }

  } catch (error) {
    res.status(500).json({ success: false, message: 'Error completing transfer', error: error.message });
  }
};

// @desc    Get transfer logs
// @route   GET /api/transfers/logs
// @access  Private (Admin only)
const getTransferLogs = async (req, res) => {
  try {
    if (req.user.role !== 'ADMIN') return res.status(403).json({ success: false, message: 'Only admins can view transfer logs' });

    const { startDate, endDate, status, fromWarehouseId, toWarehouseId, toBranchId, page = 1, limit = 50 } = req.query;
    const whereConditions = [];
    const params = [];

    if (startDate) { whereConditions.push('DATE(t.created_at) >= ?'); params.push(startDate); }
    if (endDate) { whereConditions.push('DATE(t.created_at) <= ?'); params.push(endDate); }
    if (status) { whereConditions.push('t.status = ?'); params.push(status); }
    if (fromWarehouseId) { whereConditions.push('t.from_warehouse_id = ?'); params.push(fromWarehouseId); }
    if (toWarehouseId) { whereConditions.push('t.to_warehouse_id = ?'); params.push(toWarehouseId); }
    if (toBranchId) { whereConditions.push('t.to_branch_id = ?'); params.push(toBranchId); }

    const whereClause = whereConditions.length > 0
      ? `WHERE t.deleted_at IS NULL AND ${whereConditions.join(' AND ')}`
      : 'WHERE t.deleted_at IS NULL';
    const offset = (page - 1) * limit;

    const [logs] = await pool.execute(`
      SELECT t.*, u1.username as created_by_name, u2.username as approved_by_name,
        w1.name as from_warehouse_name, w2.name as to_warehouse_name, b.name as to_branch_name,
        COUNT(ti.id) as item_count, SUM(ti.quantity) as total_quantity
      FROM transfers t
      LEFT JOIN users u1 ON t.created_by = u1.id
      LEFT JOIN users u2 ON t.approved_by = u2.id
      LEFT JOIN warehouses w1 ON t.from_warehouse_id = w1.id
      LEFT JOIN warehouses w2 ON t.to_warehouse_id = w2.id
      LEFT JOIN branches b ON t.to_branch_id = b.id
      LEFT JOIN transfer_items ti ON t.id = ti.transfer_id
      ${whereClause}
      GROUP BY t.id ORDER BY t.created_at DESC LIMIT ? OFFSET ?
    `, [...params, limit, offset]);

    const [countResult] = await pool.execute(`SELECT COUNT(*) as total FROM transfers t ${whereClause}`, params);

    res.json({ success: true, data: logs, pagination: { total: countResult[0].total, page: parseInt(page), limit: parseInt(limit), totalPages: Math.ceil(countResult[0].total / limit) } });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error getting transfer logs', error: error.message });
  }
};

// @desc    Get stock movements for a transfer
// @route   GET /api/transfers/:id/movements
// @access  Private (Admin, Warehouse Keeper)
const getTransferMovements = async (req, res) => {
  try {
    const { id } = req.params;
    const [movements] = await pool.execute(`
      SELECT sm.*, ii.name as item_name, ii.sku,
        w1.name as from_warehouse_name, w2.name as to_warehouse_name,
        b.name as to_branch_name, u.username as created_by_name
      FROM stock_movements sm
      LEFT JOIN inventory_items ii ON sm.inventory_item_id = ii.id
      LEFT JOIN warehouses w1 ON sm.from_scope_type = 'WAREHOUSE' AND sm.from_scope_id = w1.id
      LEFT JOIN warehouses w2 ON sm.to_scope_type = 'WAREHOUSE' AND sm.to_scope_id = w2.id
      LEFT JOIN branches b ON sm.to_scope_type = 'BRANCH' AND sm.to_scope_id = b.id
      LEFT JOIN users u ON sm.created_by = u.id
      WHERE sm.reference_type = 'TRANSFER' AND sm.reference_id = ?
      ORDER BY sm.created_at DESC
    `, [id]);
    res.json({ success: true, data: movements });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error getting transfer movements', error: error.message });
  }
};

// @desc    Get all transfers with filtering
// @route   GET /api/transfers
// @access  Private (Admin, Cashier, Warehouse Keeper)
const getTransfers = async (req, res) => {
  try {
    const {
      fromWarehouseId, toWarehouseId, toBranchId, status,
      startDate, endDate, search, page, limit, sortBy, sortOrder,
      cashierBranchId, warehouseKeeperWarehouseId
    } = req.query;

    const filters = {};
    const options = { page: parseInt(page) || 1, limit: parseInt(limit) || 50 };

    if (cashierBranchId) filters.cashierBranchId = parseInt(cashierBranchId);
    else if (req.user.role === 'CASHIER') filters.cashierBranchId = req.user.branchId;

    if (warehouseKeeperWarehouseId) filters.warehouseKeeperWarehouseId = parseInt(warehouseKeeperWarehouseId);
    else if (req.user.role === 'WAREHOUSE_KEEPER') filters.warehouseKeeperWarehouseId = req.user.warehouseId;

    if (fromWarehouseId) filters.fromWarehouseId = fromWarehouseId;
    if (toWarehouseId) filters.toWarehouseId = toWarehouseId;
    if (toBranchId) filters.toBranchId = toBranchId;
    if (status && status !== 'all') filters.status = status;
    if (startDate) filters.startDate = startDate;
    if (endDate) filters.endDate = endDate;
    if (search) filters.search = search;
    if (sortBy) options.sortBy = sortBy;
    if (sortOrder) options.sortOrder = sortOrder;

    const result = await Transfer.find(filters, options);

    res.json({ success: true, data: result.transfers, pagination: { total: result.total, page: result.page, limit: result.limit, totalPages: result.totalPages } });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error getting transfers', error: error.message });
  }
};

// @desc    Get single transfer by ID
// @route   GET /api/transfers/:id
// @access  Private (Admin, Cashier, Warehouse Keeper)
const getTransfer = async (req, res) => {
  try {
    const { id } = req.params;
    const transfer = await Transfer.findById(id);

    if (!transfer) return res.status(404).json({ success: false, message: 'Transfer not found' });

    if (req.user.role === 'CASHIER') {
      if (transfer.to_branch_id !== req.user.branchId && transfer.from_branch_id !== req.user.branchId) {
        return res.status(403).json({ success: false, message: 'Access denied - You can only view transfers related to your branch' });
      }
    } else if (req.user.role === 'WAREHOUSE_KEEPER') {
      if (transfer.from_warehouse_id !== req.user.warehouseId && transfer.to_warehouse_id !== req.user.warehouseId) {
        return res.status(403).json({ success: false, message: 'Access denied - You can only view transfers related to your warehouse' });
      }
    }

    res.json({ success: true, data: transfer });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error getting transfer', error: error.message });
  }
};

// @desc    Update transfer status
// @route   PUT /api/transfers/:id/status
// @access  Private (Admin, Cashier, Warehouse Keeper)
const updateTransferStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, notes } = req.body;

    if (!status) return res.status(400).json({ success: false, message: 'Status is required' });

    const statusMapping = { PENDING: 'pending', APPROVED: 'approved', IN_TRANSIT: 'shipped', COMPLETED: 'delivered', REJECTED: 'cancelled', CANCELLED: 'cancelled' };
    const dbStatus = statusMapping[status];
    if (!dbStatus) return res.status(400).json({ success: false, message: 'Invalid status' });

    const transfer = await Transfer.findById(id);
    if (!transfer) return res.status(404).json({ success: false, message: 'Transfer not found' });

    if ((status === 'APPROVED' || status === 'REJECTED') && req.user.role !== 'ADMIN') {
      return res.status(403).json({ success: false, message: 'Only admins can approve or reject transfers' });
    }

    const updatedTransfer = await Transfer.updateStatus(id, dbStatus, req.user.id, notes);
    res.json({ success: true, message: `Transfer ${status.toLowerCase()} successfully`, data: updatedTransfer });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error updating transfer status', error: error.message });
  }
};

// @desc    Get transfer settings for a location
// @route   GET /api/transfers/settings/:type/:id
// @access  Private (Admin, Cashier, Warehouse Keeper)
const getLocationTransferSettings = async (req, res) => {
  try {
    const { type, id } = req.params;

    if (type === 'warehouse') {
      const warehouse = await Warehouse.findById(id);
      if (!warehouse) return res.status(404).json({ success: false, message: 'Warehouse not found' });
      return res.json({ success: true, data: {
        allowTransfers: warehouse.allow_warehouse_transfers,
        allowToBranch: warehouse.allow_warehouse_to_branch_transfers,
        allowToWarehouse: warehouse.allow_warehouse_to_warehouse_transfers,
        requireApproval: warehouse.require_approval_for_warehouse_transfers,
        maxAmount: warehouse.max_transfer_amount,
        autoApproveSmall: warehouse.auto_approve_small_transfers,
        smallThreshold: warehouse.small_transfer_threshold
      }});
    }

    if (type === 'branch') {
      const branch = await Branch.findById(id);
      if (!branch) return res.status(404).json({ success: false, message: 'Branch not found' });
      return res.json({ success: true, data: {
        allowTransfers: branch.allow_branch_transfers,
        allowToWarehouse: branch.allow_branch_to_warehouse_transfers,
        allowToBranch: branch.allow_branch_to_branch_transfers,
        requireApproval: branch.require_approval_for_branch_transfers,
        maxAmount: branch.max_transfer_amount
      }});
    }

    return res.status(400).json({ success: false, message: 'Invalid type. Must be "warehouse" or "branch"' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error getting transfer settings', error: error.message });
  }
};

// @desc    Get transfer statistics
// @route   GET /api/transfers/statistics
// @access  Private (Admin, Warehouse Keeper)
const getTransferStatistics = async (req, res) => {
  try {
    const { fromWarehouseId, startDate, endDate } = req.query;
    const filters = {};

    if (req.user.role === 'WAREHOUSE_KEEPER') filters.fromWarehouseId = req.user.warehouseId;
    else if (fromWarehouseId) filters.fromWarehouseId = fromWarehouseId;
    if (startDate) filters.startDate = startDate;
    if (endDate) filters.endDate = endDate;

    const statistics = await Transfer.getStatistics(filters);
    res.json({ success: true, data: statistics });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error getting transfer statistics', error: error.message });
  }
};

// @desc    Get transfer settings (global)
// @route   GET /api/transfers/settings
// @access  Private (Admin)
const getTransferSettings = async (req, res) => {
  try {
    if (req.user.role !== 'ADMIN') return res.status(403).json({ success: false, message: 'Only admins can access transfer settings' });

    const [settings] = await pool.execute('SELECT setting_key, setting_value, description FROM transfer_settings ORDER BY setting_key');
    const settingsObj = {};
    settings.forEach(s => { settingsObj[s.setting_key] = { value: s.setting_value === 1, description: s.description }; });

    res.json({ success: true, data: settingsObj });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error getting transfer settings', error: error.message });
  }
};

// @desc    Update transfer settings (global)
// @route   PUT /api/transfers/settings
// @access  Private (Admin)
const updateTransferSettings = async (req, res) => {
  try {
    if (req.user.role !== 'ADMIN') return res.status(403).json({ success: false, message: 'Only admins can update transfer settings' });

    const { allowBranchTransfers, allowWarehouseTransfers, requireApproval } = req.body;
    const updates = [];
    if (allowBranchTransfers !== undefined) updates.push(['allow_branch_transfers', allowBranchTransfers ? 1 : 0]);
    if (allowWarehouseTransfers !== undefined) updates.push(['allow_warehouse_transfers', allowWarehouseTransfers ? 1 : 0]);
    if (requireApproval !== undefined) updates.push(['require_approval', requireApproval ? 1 : 0]);

    for (const [key, value] of updates) {
      await pool.execute('UPDATE transfer_settings SET setting_value = ? WHERE setting_key = ?', [value, key]);
    }

    res.json({ success: true, message: 'Transfer settings updated successfully' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error updating transfer settings', error: error.message });
  }
};

module.exports = {
  createTransfer, getTransfers, getTransfer, updateTransferStatus,
  getLocationTransferSettings, getTransferSettings, updateTransferSettings,
  completeTransfer, getTransferLogs, getTransferMovements, getTransferStatistics
};
