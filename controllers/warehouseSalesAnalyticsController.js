const { pool } = require('../config/database');

// @desc    Get comprehensive warehouse sales analytics
// @route   GET /api/warehouse-sales/:warehouseId/analytics
// @access  Private (Admin, Warehouse Keeper)
const getWarehouseSalesAnalytics = async (req, res) => {
  try {
    const { warehouseId } = req.params;
    const { 
      retailerId, 
      paymentMethod, 
      startDate, 
      endDate, 
      invoiceNo,
      limit = 100,
      offset = 0
    } = req.query;

    // Build WHERE conditions — scope sales by the requested warehouse id
    const targetWarehouseId = warehouseId;
    const [warehouseRows] = await pool.execute('SELECT name FROM warehouses WHERE id = ?', [targetWarehouseId]);
    const warehouseName = warehouseRows.length > 0 ? warehouseRows[0].name : null;

    const scopeFilterValues = [];
    scopeFilterValues.push(String(targetWarehouseId));
    if (!scopeFilterValues.includes(Number(targetWarehouseId))) {
      const numericId = Number(targetWarehouseId);
      if (!Number.isNaN(numericId)) {
        scopeFilterValues.push(numericId);
      }
    }
    if (warehouseName) {
      scopeFilterValues.push(warehouseName);
    }

    const scopePlaceholders = scopeFilterValues.map(() => '?').join(', ');

    let whereConditions = [`s.scope_type = ? AND s.scope_id IN (${scopePlaceholders})`, 's.deleted_at IS NULL'];
    let params = ['WAREHOUSE', ...scopeFilterValues];

    if (retailerId && retailerId !== 'all') {
      whereConditions.push('JSON_EXTRACT(s.customer_info, "$.id") = ?');
      params.push(retailerId);
    }

    if (paymentMethod && paymentMethod !== 'all') {
      whereConditions.push(`
        (JSON_EXTRACT(s.customer_info, "$.paymentMethod") = ? OR 
         JSON_EXTRACT(s.customer_info, "$.payment") = ? OR 
         JSON_EXTRACT(s.customer_info, "$.payment_type") = ?)
      `);
      params.push(paymentMethod, paymentMethod, paymentMethod);
    }

    if (startDate) {
      whereConditions.push('DATE(s.created_at) >= ?');
      params.push(startDate);
    }

    if (endDate) {
      whereConditions.push('DATE(s.created_at) <= ?');
      params.push(endDate);
    }

    if (invoiceNo) {
      whereConditions.push('s.invoice_no LIKE ?');
      params.push(`%${invoiceNo}%`);
    }

    const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

    // Main sales query with retailer info
    const salesQuery = `
      SELECT 
        s.id,
        s.invoice_no as sale_number,
        s.created_at,
        s.updated_at,
        s.subtotal,
        s.tax,
        s.discount,
        s.total,
        s.customer_info,
        s.payment_status,
        s.customer_info as customer_name,
        s.user_id as created_by,
        r.name as retailer_name,
        r.email as retailer_email,
        r.phone as retailer_phone,
        r.business_type as retailer_business_type,
        r.payment_terms as retailer_payment_terms,
        u.username as created_by_username,
        u.email as created_by_email
      FROM sales s
      LEFT JOIN retailers r ON JSON_EXTRACT(s.customer_info, "$.id") = r.id
      LEFT JOIN users u ON s.user_id = u.id
      ${whereClause}
      ORDER BY s.created_at DESC
      LIMIT ? OFFSET ?
    `;

    params.push(parseInt(limit), parseInt(offset));


    const [sales] = await pool.execute(salesQuery, params);

    // Get count for pagination
    const countQuery = `
      SELECT COUNT(*) as total
      FROM sales s
      LEFT JOIN retailers r ON JSON_EXTRACT(s.customer_info, "$.id") = r.id
      ${whereClause}
    `;
    
    const countParams = params.slice(0, -2); // Remove limit and offset
    const [countResult] = await pool.execute(countQuery, countParams);
    const total = countResult[0].total;

    // Process sales data to include parsed customer_info and items
    const processedSales = await Promise.all(sales.map(async (sale) => {
      let customerInfo = {};
      try {
        customerInfo = JSON.parse(sale.customer_info || '{{}}');
      } catch (e) {
      }

      // Get sale items
      const itemsQuery = `
        SELECT 
          si.id,
          si.inventory_item_id as item_id,
          si.quantity,
          si.unit_price,
          si.total as total_price,
          ii.name as item_name,
          ii.sku as item_sku,
          ii.category as item_category
        FROM sale_items si
        LEFT JOIN inventory_items ii ON si.inventory_item_id = ii.id
        WHERE si.sale_id = ?
      `;
      
      const [items] = await pool.execute(itemsQuery, [sale.id]);

      return {
        id: sale.id,
        saleNumber: sale.sale_number,
        createdAt: sale.created_at,
        updatedAt: sale.updated_at,
        subtotal: parseFloat(sale.subtotal) || 0,
        tax: parseFloat(sale.tax) || 0,
        discount: parseFloat(sale.discount) || 0,
        total: parseFloat(sale.total) || 0,
        paymentStatus: sale.payment_status,
        customerName: sale.customer_name,
        createdBy: sale.created_by,
        createdByUsername: sale.created_by_username,
        createdByEmail: sale.created_by_email,
        retailer: {
          id: sale.retailer_id,
          name: sale.retailer_name,
          email: sale.retailer_email,
          phone: sale.retailer_phone,
          businessType: sale.retailer_business_type,
          paymentTerms: sale.retailer_payment_terms
        },
        customerInfo: customerInfo,
        paymentMethod: customerInfo.paymentMethod || customerInfo.payment || customerInfo.payment_type || 'CASH',
        paymentTerms: customerInfo.paymentTerms || null,
        items: items.map(item => ({
          id: item.id,
          itemId: item.item_id,
          itemName: item.item_name,
          itemSku: item.item_sku,
          itemCategory: item.item_category,
          quantity: parseInt(item.quantity) || 0,
          unitPrice: parseFloat(item.unit_price) || 0,
          totalPrice: parseFloat(item.total_price) || 0
        }))
      };
    }));

    // Get summary statistics
    const summaryQuery = `
      SELECT 
        COUNT(*) as total_sales,
        SUM(s.total) as total_amount,
        SUM(CASE 
          WHEN JSON_EXTRACT(s.customer_info, "$.paymentMethod") = 'CASH' OR 
               JSON_EXTRACT(s.customer_info, "$.payment") = 'CASH' OR
               JSON_EXTRACT(s.customer_info, "$.payment_type") = 'CASH'
          THEN s.total ELSE 0 
        END) as cash_amount,
        SUM(CASE 
          WHEN JSON_EXTRACT(s.customer_info, "$.paymentMethod") = 'CREDIT' OR 
               JSON_EXTRACT(s.customer_info, "$.payment") = 'CREDIT' OR
               JSON_EXTRACT(s.customer_info, "$.payment_type") = 'CREDIT'
          THEN s.total ELSE 0 
        END) as credit_amount,
        SUM(CASE 
          WHEN JSON_EXTRACT(s.customer_info, "$.paymentMethod") = 'BANK_TRANSFER' OR 
               JSON_EXTRACT(s.customer_info, "$.payment") = 'BANK_TRANSFER' OR
               JSON_EXTRACT(s.customer_info, "$.payment_type") = 'BANK_TRANSFER'
          THEN s.total ELSE 0 
        END) as bank_transfer_amount,
        SUM(CASE 
          WHEN JSON_EXTRACT(s.customer_info, "$.paymentMethod") = 'CARD' OR 
               JSON_EXTRACT(s.customer_info, "$.payment") = 'CARD' OR
               JSON_EXTRACT(s.customer_info, "$.payment_type") = 'CARD'
          THEN s.total ELSE 0 
        END) as card_amount,
        SUM(CASE 
          WHEN JSON_EXTRACT(s.customer_info, "$.paymentMethod") = 'CHEQUE' OR 
               JSON_EXTRACT(s.customer_info, "$.payment") = 'CHEQUE' OR
               JSON_EXTRACT(s.customer_info, "$.payment_type") = 'CHEQUE'
          THEN s.total ELSE 0 
        END) as cheque_amount,
        SUM(CASE 
          WHEN JSON_EXTRACT(s.customer_info, "$.paymentMethod") = 'MOBILE_PAYMENT' OR 
               JSON_EXTRACT(s.customer_info, "$.payment") = 'MOBILE_PAYMENT' OR
               JSON_EXTRACT(s.customer_info, "$.payment_type") = 'MOBILE_PAYMENT'
          THEN s.total ELSE 0 
        END) as mobile_payment_amount,
        SUM(s.tax) as total_tax,
        SUM(s.discount) as total_discount,
        AVG(s.total) as average_sale_amount
      FROM sales s
      LEFT JOIN retailers r ON JSON_EXTRACT(s.customer_info, "$.id") = r.id
      ${whereClause}
    `;

    const summaryParams = countParams;
    const [summaryResult] = await pool.execute(summaryQuery, summaryParams);
    const summary = summaryResult[0];

    // Get retailer-wise breakdown
    const retailerBreakdownQuery = `
      SELECT 
        r.id as retailer_id,
        r.name as retailer_name,
        COUNT(s.id) as sales_count,
        SUM(s.total) as total_amount,
        AVG(s.total) as average_amount,
        MAX(s.created_at) as last_sale_date,
        MIN(s.created_at) as first_sale_date
      FROM sales s
      LEFT JOIN retailers r ON JSON_EXTRACT(s.customer_info, "$.id") = r.id
      ${whereClause}
      GROUP BY r.id, r.name
      ORDER BY SUM(s.total) DESC
    `;

    const [retailerBreakdown] = await pool.execute(retailerBreakdownQuery, countParams);

    res.status(200).json({
      success: true,
      data: {
        sales: processedSales,
        summary: {
          totalSales: summary.total_sales || 0,
          totalAmount: parseFloat(summary.total_amount) || 0,
          cashAmount: parseFloat(summary.cash_amount) || 0,
          creditAmount: parseFloat(summary.credit_amount) || 0,
          bankTransferAmount: parseFloat(summary.bank_transfer_amount) || 0,
          cardAmount: parseFloat(summary.card_amount) || 0,
          chequeAmount: parseFloat(summary.cheque_amount) || 0,
          mobilePaymentAmount: parseFloat(summary.mobile_payment_amount) || 0,
          totalTax: parseFloat(summary.total_tax) || 0,
          totalDiscount: parseFloat(summary.total_discount) || 0,
          averageSaleAmount: parseFloat(summary.average_sale_amount) || 0
        },
        retailerBreakdown: retailerBreakdown.map(retailer => ({
          id: retailer.retailer_id,
          name: retailer.retailer_name,
          salesCount: retailer.sales_count || 0,
          totalAmount: parseFloat(retailer.total_amount) || 0,
          averageAmount: parseFloat(retailer.average_amount) || 0,
          lastSaleDate: retailer.last_sale_date,
          firstSaleDate: retailer.first_sale_date
        })),
        pagination: {
          current: Math.floor(offset / limit) + 1,
          total: Math.ceil(total / limit),
          limit: parseInt(limit),
          offset: parseInt(offset),
          count: sales.length,
          totalCount: total
        }
      }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error fetching warehouse sales analytics',
      error: error.message
    });
  }
};

// @desc    Get warehouse sales analytics export data
// @route   GET /api/warehouse-sales/:warehouseId/analytics/export
// @access  Private (Admin, Warehouse Keeper)
const exportWarehouseSalesAnalytics = async (req, res) => {
  try {
    const { warehouseId } = req.params;
    const { 
      retailerId, 
      paymentMethod, 
      startDate, 
      endDate, 
      invoiceNo,
      format = 'csv'
    } = req.query;

    // Build WHERE conditions (same as analytics query)
    const targetWarehouseId = warehouseId;
    const [warehouseRows] = await pool.execute('SELECT name FROM warehouses WHERE id = ?', [targetWarehouseId]);
    const warehouseName = warehouseRows.length > 0 ? warehouseRows[0].name : null;

    const scopeFilterValues = [];
    scopeFilterValues.push(String(targetWarehouseId));
    if (!scopeFilterValues.includes(Number(targetWarehouseId))) {
      const numericId = Number(targetWarehouseId);
      if (!Number.isNaN(numericId)) {
        scopeFilterValues.push(numericId);
      }
    }
    if (warehouseName) {
      scopeFilterValues.push(warehouseName);
    }

    const scopePlaceholders = scopeFilterValues.map(() => '?').join(', ');

    let whereConditions = [`s.scope_type = ? AND s.scope_id IN (${scopePlaceholders})`, 's.deleted_at IS NULL'];
    let params = ['WAREHOUSE', ...scopeFilterValues];

    if (retailerId && retailerId !== 'all') {
      whereConditions.push('JSON_EXTRACT(s.customer_info, "$.id") = ?');
      params.push(retailerId);
    }

    if (paymentMethod && paymentMethod !== 'all') {
      whereConditions.push(`
        (JSON_EXTRACT(s.customer_info, "$.paymentMethod") = ? OR 
         JSON_EXTRACT(s.customer_info, "$.payment") = ? OR 
         JSON_EXTRACT(s.customer_info, "$.payment_type") = ?)
      `);
      params.push(paymentMethod, paymentMethod, paymentMethod);
    }

    if (startDate) {
      whereConditions.push('DATE(s.created_at) >= ?');
      params.push(startDate);
    }

    if (endDate) {
      whereConditions.push('DATE(s.created_at) <= ?');
      params.push(endDate);
    }

    if (invoiceNo) {
      whereConditions.push('s.invoice_no LIKE ?');
      params.push(`%${invoiceNo}%`);
    }

    const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

    // Export query with detailed item information
    const exportQuery = `
      SELECT 
        s.id as sale_id,
        s.invoice_no as invoice_number,
        s.created_at as sale_date,
        s.total as sale_amount,
        s.tax,
        s.discount,
        s.payment_status,
        s.customer_info,
        r.name as retailer_name,
        r.email as retailer_email,
        r.phone as retailer_phone,
        r.business_type as retailer_business_type,
        r.payment_terms as retailer_payment_terms,
        u.username as created_by,
        COALESCE(
          NULLIF(JSON_EXTRACT(s.customer_info, "$.paymentMethod"), 'null'),
          NULLIF(JSON_EXTRACT(s.customer_info, "$.payment"), 'null'),
          NULLIF(JSON_EXTRACT(s.customer_info, "$.payment_type"), 'null'),
          'CASH'
        ) as payment_method
      FROM sales s
      LEFT JOIN retailers r ON JSON_EXTRACT(s.customer_info, "$.id") = r.id
      LEFT JOIN users u ON s.user_id = u.id
      ${whereClause}
      ORDER BY s.created_at DESC, s.id DESC
    `;

    const [exportData] = await pool.execute(exportQuery, params);

    // Process data for export
      const processedExportData = exportData.map(row => {
        let customerInfo = {};
        try {
          customerInfo = JSON.parse(row.customer_info || '{}');
        } catch (e) {
          // Keep empty object if parsing fails
        }

        return {
          saleId: row.sale_id,
          invoiceNumber: row.invoice_number,
          saleDate: row.sale_date,
          saleAmount: parseFloat(row.sale_amount) || 0,
          tax: parseFloat(row.tax) || 0,
          discount: parseFloat(row.discount) || 0,
          paymentStatus: row.payment_status,
          paymentMethod: row.payment_method || 'CASH',
          paymentTerms: row.retailer_payment_terms || '',
          retailerName: row.retailer_name || '',
          retailerEmail: row.retailer_email || '',
          retailerPhone: row.retailer_phone || '',
          retailerBusinessType: row.retailer_business_type || '',
          retailerPaymentTerms: row.retailer_payment_terms || '',
          createdBy: row.created_by || ''
        };
      });

    // Generate filename
    const timestamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '');
    const filename = `warehouse-sales-analytics-${warehouseId}-${timestamp}`;

    if (format === 'csv') {
      // Generate CSV
      const headers = [
        'Sale ID', 'Invoice Number', 'Sale Date', 'Sale Amount', 'Tax', 'Discount',
        'Payment Status', 'Payment Method', 'Payment Terms', 'Retailer Name',
        'Retailer Email', 'Retailer Phone', 'Retailer Business Type',
        'Retailer Payment Terms', 'Created By'
      ];

      const csvRows = processedExportData.map(row => [
        row.saleId,
        row.invoiceNumber,
        row.saleDate,
        row.saleAmount,
        row.tax,
        row.discount,
        row.paymentStatus,
        row.paymentMethod,
        row.paymentTerms,
        row.retailerName,
        row.retailerEmail,
        row.retailerPhone,
        row.retailerBusinessType,
        row.retailerPaymentTerms,
        row.createdBy
      ]);

      const csvContent = [headers, ...csvRows]
        .map(row => row.map(field => `"${field}"`).join(','))
        .join('\n');

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
      res.send(csvContent);

    } else {
      // Return JSON data for other formats
      res.status(200).json({
        success: true,
        data: processedExportData,
        filename: filename
      });
    }

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error exporting warehouse sales analytics',
      error: error.message
    });
  }
};

module.exports = {
  getWarehouseSalesAnalytics,
  exportWarehouseSalesAnalytics
};
