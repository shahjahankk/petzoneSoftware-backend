'use strict';

const { pool } = require('../../config/database');
const { isLedgerMigrationComplete } = require('../../services/ledgerMigrationMeta');

// @desc    Get sales history for a specific company
// @route   GET /api/sales/company/:companyId
// @access  Private (Admin, Cashier, Warehouse Keeper)
const getCompanySalesHistory = async (req, res, next) => {
  try {
    const { companyId } = req.params;
    const { startDate, endDate, limit = 50 } = req.query;
    
    let whereConditions = ['JSON_EXTRACT(customer_info, "$.id") = ?'];
    let params = [companyId];

    // Apply role-based filtering
    if (req.user.role === 'CASHIER') {
      // Get branch name/ID if not already available
      let userBranchName = req.user.branchName;
      let userBranchId = req.user.branchId;
      if ((!userBranchName || !userBranchId) && req.user.branchId) {
        const [branches] = await pool.execute('SELECT id, name FROM branches WHERE id = ?', [req.user.branchId]);
        if (branches.length > 0) {
          userBranchName = userBranchName || branches[0].name;
          userBranchId = userBranchId || branches[0].id;
        }
      } else if (!userBranchName && userBranchId) {
        const [branches] = await pool.execute('SELECT id, name FROM branches WHERE id = ?', [userBranchId]);
        if (branches.length > 0) {
          userBranchName = branches[0].name;
        }
      }

      if (userBranchName && userBranchId) {
        whereConditions.push(`(
          s.scope_type = 'BRANCH' AND (
            CAST(s.scope_id AS CHAR) COLLATE utf8mb4_bin = CAST(? AS CHAR) COLLATE utf8mb4_bin OR
            CAST(s.scope_id AS UNSIGNED) = ? OR
            CAST(s.scope_id AS CHAR) COLLATE utf8mb4_bin = CAST(? AS CHAR) COLLATE utf8mb4_bin
          )
        )`);
        params.push(userBranchName, userBranchId, String(userBranchId));
      } else if (userBranchName) {
        whereConditions.push(`(
          s.scope_type = 'BRANCH' AND (
            CAST(s.scope_id AS CHAR) COLLATE utf8mb4_bin = CAST(? AS CHAR) COLLATE utf8mb4_bin OR
            s.scope_id = ?
          )
        )`);
        params.push(userBranchName, String(userBranchName));
      } else if (userBranchId) {
        whereConditions.push(`(
          s.scope_type = 'BRANCH' AND (
            CAST(s.scope_id AS UNSIGNED) = ? OR
            CAST(s.scope_id AS CHAR) COLLATE utf8mb4_bin = CAST(? AS CHAR) COLLATE utf8mb4_bin
          )
        )`);
        params.push(userBranchId, String(userBranchId));
      } else {
        whereConditions.push("s.scope_type = 'BRANCH'");
      }
    } else if (req.user.role === 'WAREHOUSE_KEEPER') {
      // Get warehouse name/ID if not already available
      let userWarehouseName = req.user.warehouseName;
      let userWarehouseId = req.user.warehouseId;
      if ((!userWarehouseName || !userWarehouseId) && req.user.warehouseId) {
        const [warehouses] = await pool.execute('SELECT id, name FROM warehouses WHERE id = ?', [req.user.warehouseId]);
        if (warehouses.length > 0) {
          userWarehouseName = userWarehouseName || warehouses[0].name;
          userWarehouseId = userWarehouseId || warehouses[0].id;
        }
      } else if (!userWarehouseName && userWarehouseId) {
        const [warehouses] = await pool.execute('SELECT id, name FROM warehouses WHERE id = ?', [userWarehouseId]);
        if (warehouses.length > 0) {
          userWarehouseName = warehouses[0].name;
        }
      }

      if (userWarehouseName && userWarehouseId) {
        whereConditions.push(`(
          s.scope_type = 'WAREHOUSE' AND (
            CAST(s.scope_id AS CHAR) COLLATE utf8mb4_bin = CAST(? AS CHAR) COLLATE utf8mb4_bin OR
            CAST(s.scope_id AS UNSIGNED) = ? OR
            CAST(s.scope_id AS CHAR) COLLATE utf8mb4_bin = CAST(? AS CHAR) COLLATE utf8mb4_bin
          )
        )`);
        params.push(userWarehouseName, userWarehouseId, String(userWarehouseId));
      } else if (userWarehouseName) {
        whereConditions.push(`(
          s.scope_type = 'WAREHOUSE' AND (
            CAST(s.scope_id AS CHAR) COLLATE utf8mb4_bin = CAST(? AS CHAR) COLLATE utf8mb4_bin OR
            s.scope_id = ?
          )
        )`);
        params.push(userWarehouseName, String(userWarehouseName));
      } else if (userWarehouseId) {
        whereConditions.push(`(
          s.scope_type = 'WAREHOUSE' AND (
            CAST(s.scope_id AS UNSIGNED) = ? OR
            CAST(s.scope_id AS CHAR) COLLATE utf8mb4_bin = CAST(? AS CHAR) COLLATE utf8mb4_bin
          )
        )`);
        params.push(userWarehouseId, String(userWarehouseId));
      } else {
        whereConditions.push("s.scope_type = 'WAREHOUSE'");
      }
    } else if (req.user.role === 'ADMIN') {
      // Admin - no implicit scope restriction; rely on explicit filters if any
    }

    if (startDate) {
      whereConditions.push('created_at >= ?');
      params.push(startDate);
    }

    if (endDate) {
      whereConditions.push('created_at <= ?');
      params.push(endDate);
    }

    const whereClause = `WHERE ${whereConditions.join(' AND ')}`;

    // Get sales history
    const [sales] = await pool.execute(`
      SELECT 
        s.id,
        s.invoice_no,
        s.subtotal,
        s.tax,
        s.discount,
        s.total,
        s.payment_method,
        s.payment_status,
        s.status,
        s.customer_info,
        s.notes,
        s.created_at,
        s.updated_at,
        u.username as created_by,
        b.name as branch_name,
        w.name as warehouse_name
      FROM sales s
      LEFT JOIN users u ON s.user_id = u.id
      LEFT JOIN branches b ON s.scope_type = 'BRANCH' AND (
        CAST(s.scope_id AS CHAR) COLLATE utf8mb4_bin = CAST(b.name AS CHAR) COLLATE utf8mb4_bin OR
        CAST(s.scope_id AS UNSIGNED) = b.id OR
        CAST(b.id AS CHAR) COLLATE utf8mb4_bin = CAST(s.scope_id AS CHAR) COLLATE utf8mb4_bin
      )
      LEFT JOIN warehouses w ON s.scope_type = 'WAREHOUSE' AND (
        CAST(s.scope_id AS CHAR) COLLATE utf8mb4_bin = CAST(w.name AS CHAR) COLLATE utf8mb4_bin OR
        CAST(s.scope_id AS UNSIGNED) = w.id OR
        CAST(w.id AS CHAR) COLLATE utf8mb4_bin = CAST(s.scope_id AS CHAR) COLLATE utf8mb4_bin
      )
      ${whereClause}
      ORDER BY s.created_at DESC
      LIMIT ?
    `, [...params, parseInt(limit)]);

    // Get sales items for each sale
    const salesWithItems = await Promise.all(sales.map(async (sale) => {
      const [items] = await pool.execute(`
        SELECT 
          si.*,
          ii.name as item_name,
          ii.sku,
          ii.unit_price
        FROM sale_items si
        LEFT JOIN inventory_items ii ON si.inventory_item_id = ii.id
        WHERE si.sale_id = ?
        ORDER BY si.id
      `, [sale.id]);

      return {
        ...sale,
        items: items.map(item => ({
          id: item.id,
          inventoryItemId: item.inventory_item_id,
          itemName: item.item_name,
          sku: item.sku,
          quantity: item.quantity,
          unitPrice: parseFloat(item.unit_price) || 0,
          total: parseFloat(item.total) || 0
        }))
      };
    }));

    // Calculate summary statistics
    const totalSales = salesWithItems.length;
    const totalAmount = salesWithItems.reduce((sum, sale) => sum + parseFloat(sale.total), 0);
    const paymentMethods = [...new Set(salesWithItems.map(sale => sale.payment_method))];
    const paymentStatuses = [...new Set(salesWithItems.map(sale => sale.payment_status))];

    res.json({
      success: true,
      message: 'Company sales history retrieved successfully',
      data: {
        company: salesWithItems[0]?.customer_info || {},
        summary: {
          totalSales,
          totalAmount,
          paymentMethods,
          paymentStatuses
        },
        sales: salesWithItems
      }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error retrieving company sales history',
      error: error.message
    });
  }
};

// @desc    Get invoice details with items
// @route   GET /api/sales/invoice/:invoiceId
// @access  Private (Admin, Cashier, Warehouse Keeper)
const getInvoiceDetails = async (req, res, next) => {
  try {
    const { invoiceId } = req.params;
    
    // Validate invoiceId
    if (!invoiceId || isNaN(invoiceId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid invoice ID'
      });
    }
    
    // Get the sale/invoice details
    const [sales] = await pool.execute(`
      SELECT 
        s.*,
        u.username as created_by_username,
        u.email as created_by_email,
        b.name as branch_name,
        w.name as warehouse_name
      FROM sales s
      LEFT JOIN users u ON s.user_id = u.id
      LEFT JOIN branches b ON s.scope_type = 'BRANCH' AND (
        CAST(s.scope_id AS CHAR) COLLATE utf8mb4_bin = CAST(b.name AS CHAR) COLLATE utf8mb4_bin OR
        CAST(s.scope_id AS UNSIGNED) = b.id OR
        CAST(b.id AS CHAR) COLLATE utf8mb4_bin = CAST(s.scope_id AS CHAR) COLLATE utf8mb4_bin
      )
      LEFT JOIN warehouses w ON s.scope_type = 'WAREHOUSE' AND (
        CAST(s.scope_id AS CHAR) COLLATE utf8mb4_bin = CAST(w.name AS CHAR) COLLATE utf8mb4_bin OR
        CAST(s.scope_id AS UNSIGNED) = w.id OR
        CAST(w.id AS CHAR) COLLATE utf8mb4_bin = CAST(s.scope_id AS CHAR) COLLATE utf8mb4_bin
      )
      WHERE s.id = ? AND s.deleted_at IS NULL
    `, [invoiceId]);
    
    if (sales.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Invoice not found'
      });
    }
    
    const sale = sales[0];
    
    // Get sale items
    const [items] = await pool.execute(`
      SELECT 
        si.*,
        ii.name as item_name,
        ii.sku,
        ii.selling_price as catalog_price,
        ii.cost_price,
        ii.category
      FROM sale_items si
      LEFT JOIN inventory_items ii ON si.inventory_item_id = ii.id
      WHERE si.sale_id = ?
      ORDER BY si.id
    `, [invoiceId]);
    
    // Parse customer_info safely
    let customerInfo = null;
    try {
      if (sale.customer_info) {
        customerInfo = JSON.parse(sale.customer_info);
      }
    } catch (parseError) {
      customerInfo = null;
    }
    
    // Format the response
    const invoiceDetails = {
      id: sale.id,
      invoiceNo: sale.invoice_no,
      createdAt: sale.created_at,
      updatedAt: sale.updated_at,
      subtotal: parseFloat(sale.subtotal) || 0,
      tax: parseFloat(sale.tax) || 0,
      discount: parseFloat(sale.discount) || 0,
      total: parseFloat(sale.total) || 0,
      paymentMethod: sale.payment_method,
      paymentStatus: sale.payment_status,
      status: sale.status,
      notes: sale.notes,
      customerInfo: customerInfo,
      scopeType: sale.scope_type,
      scopeId: sale.scope_id,
      branchName: sale.branch_name,
      warehouseName: sale.warehouse_name,
      createdBy: {
        username: sale.created_by_username,
        email: sale.created_by_email
      },
      items: items.map(item => ({
        id: item.id,
        inventoryItemId: item.inventory_item_id,
        itemName: item.item_name,
        sku: item.sku,
        category: item.category,
        quantity: item.quantity,
        unitPrice: parseFloat(item.unit_price) || 0,
        catalogPrice: parseFloat(item.catalog_price) || 0,
        costPrice: parseFloat(item.cost_price) || 0,
        discount: parseFloat(item.discount) || 0,
        total: parseFloat(item.total) || 0
      }))
    };

    const ledgerMigratedInvoice = await isLedgerMigrationComplete(pool);
    let invoicePayload = { ...invoiceDetails };

    if (ledgerMigratedInvoice) {
      const [snapRows] = await pool.execute(
        `SELECT old_balance, total AS snapshot_total, payment AS snapshot_payment, final_balance
         FROM invoice_snapshots WHERE sale_id = ? LIMIT 1`,
        [invoiceId]
      );
      if (snapRows.length) {
        const snapPay = parseFloat(snapRows[0].snapshot_payment);
        const snapTot = parseFloat(snapRows[0].snapshot_total);
        const snapOld = parseFloat(snapRows[0].old_balance);
        const snapFinal = parseFloat(snapRows[0].final_balance);
        invoicePayload = {
          ...invoicePayload,
          financialSource: 'invoice_snapshots',
          oldBalance: Number.isFinite(snapOld) ? snapOld : null,
          runningBalance: Number.isFinite(snapFinal) ? snapFinal : null,
          snapshotTotal: Number.isFinite(snapTot) ? snapTot : null,
          snapshotPayment: Number.isFinite(snapPay) ? snapPay : null,
          paymentAmount: Number.isFinite(snapPay) ? snapPay : null,
          creditAmount: null,
        };
      } else {
        invoicePayload = {
          ...invoicePayload,
          financialSource: 'invoice_snapshots',
          oldBalance: null,
          runningBalance: null,
          snapshotTotal: null,
          snapshotPayment: null,
          paymentAmount: null,
          creditAmount: null,
        };
      }
    } else {
      invoicePayload = {
        ...invoicePayload,
        paymentAmount: parseFloat(sale.payment_amount) || 0,
        creditAmount: parseFloat(sale.credit_amount) || 0,
      };
    }
    
    res.json({
      success: true,
      message: 'Invoice details retrieved successfully',
      data: invoicePayload
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error retrieving invoice details',
      error: error.message
    });
  }
};

module.exports = {
  getCompanySalesHistory,
  getInvoiceDetails,
};
