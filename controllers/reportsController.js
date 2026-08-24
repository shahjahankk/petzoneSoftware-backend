const { pool } = require('../config/database');
const { isLedgerMigrationComplete } = require('../services/ledgerMigrationMeta');
const { CLINIC_LINE_SQL, PRODUCT_LINE_SQL } = require('../utils/clinicSaleItem');

// @desc    Get reports summary
// @route   GET /api/reports/summary
// @access  Private
const getReportsSummary = async (req, res) => {
  try {
    const user = req.user;
    const summary = {
      totalSales: 0, totalRevenue: 0, totalCustomers: 0, totalProducts: 0,
      totalOrders: 0, totalInventory: 0, totalCompanies: 0, totalTransfers: 0,
      totalLedgerEntries: 0, totalBillingRecords: 0,
    };

    try {
      let q = 'SELECT COUNT(*) as count FROM companies'; const p = [];
      if (user?.role === 'WAREHOUSE_KEEPER' && user?.warehouseId) { q += ' WHERE warehouse_id = ?'; p.push(user.warehouseId); }
      const [r] = await pool.execute(q, p); summary.totalCompanies = r[0]?.count || 0;
    } catch (e) { /* optional */ }

    try {
      let q = 'SELECT COUNT(*) as count FROM ledgers'; const p = [];
      if (user?.role === 'WAREHOUSE_KEEPER' && user?.warehouseId) { q += ' WHERE scope_id = ? AND scope_type = "WAREHOUSE"'; p.push(user.warehouseId); }
      const [r] = await pool.execute(q, p); summary.totalLedgerEntries = r[0]?.count || 0;
    } catch (e) { /* optional */ }

    try {
      let q = `SELECT COUNT(*) as count FROM sales WHERE status='COMPLETED'
               AND deleted_at IS NULL
               AND (payment_type IS NULL OR payment_type NOT IN ('OUTSTANDING_SETTLEMENT','CASH_REFUND','REFUND','BILTY_CHARGE','CREDIT_REFUND_SETTLEMENT'))
               AND (payment_method IS NULL OR payment_method NOT IN ('CASH_REFUND','REFUND'))`;
      const p = [];
      if (user?.role === 'WAREHOUSE_KEEPER' && user?.warehouseId) { q += ' AND scope_type = "WAREHOUSE" AND scope_id = ?'; p.push(String(user.warehouseId)); }
      const [r] = await pool.execute(q, p); summary.totalSales = r[0]?.count || 0;
    } catch (e) { /* optional */ }

    try {
      let q = 'SELECT COUNT(*) as count FROM inventory_items'; const p = [];
      if (user?.role === 'WAREHOUSE_KEEPER' && user?.warehouseId) { q += ' WHERE scope_type = "WAREHOUSE" AND scope_id = ?'; p.push(String(user.warehouseId)); }
      const [r] = await pool.execute(q, p); summary.totalProducts = r[0]?.count || 0;
    } catch (e) { /* optional */ }

    try {
      const [r] = await pool.execute('SELECT COUNT(*) as count FROM transfers');
      summary.totalTransfers = r[0]?.count || 0;
    } catch (e) { /* optional */ }

    res.json({ success: true, data: summary });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error retrieving reports summary', error: error.message });
  }
};

// Helper: is this row a refund?
const isRefundRow = (sale) => {
  const pm = (sale.payment_method || '').toUpperCase();
  const pt = (sale.payment_type   || '').toUpperCase();
  return pm === 'CASH_REFUND' || pm === 'REFUND' || pt === 'CASH_REFUND' || pt === 'REFUND';
};

// Helper: is this row an outstanding settlement?
const isSettlementRow = (sale) => {
  const pt = (sale.payment_type || '').toUpperCase();
  return pt === 'OUTSTANDING_SETTLEMENT';
};

/** Shared sales scope / date / branch / cashier filters (alias `s`). */
const buildSalesReportWhere = async (user, { branch, cashier, startDate, endDate } = {}) => {
  let whereClause = `WHERE s.status = 'COMPLETED' AND s.deleted_at IS NULL`;
  const params = [];

  if (user?.role === 'WAREHOUSE_KEEPER') {
    let warehouseName = user.warehouseName;
    const warehouseId = user.warehouseId;
    if (!warehouseName && warehouseId) {
      const [wrows] = await pool.execute('SELECT name FROM warehouses WHERE id = ?', [warehouseId]);
      if (wrows.length > 0) warehouseName = wrows[0].name;
    }
    if (warehouseName) {
      whereClause += ` AND s.scope_type = 'WAREHOUSE' AND (s.scope_id = ? OR s.scope_id = ?)`;
      params.push(warehouseName, String(warehouseId || ''));
    } else if (warehouseId) {
      whereClause += ` AND s.scope_type = 'WAREHOUSE' AND s.scope_id = ?`;
      params.push(String(warehouseId));
    } else {
      whereClause += ` AND s.scope_type = 'WAREHOUSE'`;
    }
  }

  if (user?.role === 'CASHIER') {
    let branchName = user.branchName;
    if (!branchName && user?.branchId) {
      const [brows] = await pool.execute('SELECT name FROM branches WHERE id = ?', [user.branchId]);
      branchName = brows[0]?.name || null;
    }
    if (branchName || user?.branchId) {
      whereClause += ` AND s.scope_type = 'BRANCH' AND (s.scope_id = ? OR s.scope_id = ?)`;
      params.push(branchName || String(user.branchId), String(user.branchId || ''));
    } else {
      whereClause += ` AND s.scope_type = 'BRANCH'`;
    }
  }

  if (branch && branch !== 'all')   { whereClause += ' AND s.scope_id = ?';          params.push(branch); }
  if (cashier && cashier !== 'all') { whereClause += ' AND s.user_id = ?';           params.push(cashier); }
  if (startDate)                    { whereClause += ' AND DATE(s.created_at) >= ?'; params.push(startDate); }
  if (endDate)                      { whereClause += ' AND DATE(s.created_at) <= ?'; params.push(endDate); }

  return { whereClause, params };
};

/** Per-sale product vs clinic line totals. */
const fetchSaleLineSplits = async (saleIds) => {
  const map = {};
  if (!saleIds.length) return map;
  const placeholders = saleIds.map(() => '?').join(',');
  const [rows] = await pool.execute(
    `SELECT si.sale_id,
       SUM(CASE WHEN ${CLINIC_LINE_SQL}
                THEN COALESCE(si.total, 0) ELSE 0 END) AS clinic_total,
       SUM(CASE WHEN NOT (${CLINIC_LINE_SQL})
                THEN COALESCE(si.total, 0) ELSE 0 END) AS product_total
     FROM sale_items si
     WHERE si.sale_id IN (${placeholders})
     GROUP BY si.sale_id`,
    saleIds
  );
  rows.forEach((r) => {
    map[r.sale_id] = {
      clinic:  parseFloat(r.clinic_total  || 0),
      product: parseFloat(r.product_total || 0),
    };
  });
  return map;
};

// @desc    Get sales reports — product sales only (clinic lines excluded)
// @route   GET /api/reports/sales
// @access  Private
const getSalesReports = async (req, res) => {
  try {
    const user = req.user;
    const { branch, cashier, startDate, endDate } = req.query;

    const { whereClause, params } = await buildSalesReportWhere(user, {
      branch, cashier, startDate, endDate,
    });

    const ledgerMigrationDone = await isLedgerMigrationComplete(pool);

    // ── Fetch ALL rows (real sales + settlements + refunds) ────────────────
    const snapshotJoin = ledgerMigrationDone
      ? `LEFT JOIN invoice_snapshots inv ON inv.sale_id = s.id`
      : '';
    const snapshotSelect = ledgerMigrationDone
      ? `, inv.final_balance AS snapshot_final_balance`
      : '';

    const [rows] = await pool.execute(
      `SELECT s.*, u.username AS user_name${snapshotSelect}
       FROM sales s
       LEFT JOIN users u ON s.user_id = u.id
       ${snapshotJoin}
       ${whereClause}
       ORDER BY s.created_at DESC`,
      params
    );


    // ── Classify rows ──────────────────────────────────────────────────────
    const realSaleRows   = rows.filter(s => !isRefundRow(s) && !isSettlementRow(s));
    const settlementRows = rows.filter(s => isSettlementRow(s));
    const refundRows     = rows.filter(s => isRefundRow(s));

    // Clinic service lines are reported separately — strip them from product sales.
    const lineSplits = await fetchSaleLineSplits(realSaleRows.map((r) => r.id).filter(Boolean));

    const productSaleMeta = realSaleRows.map((sale) => {
      const split = lineSplits[sale.id];
      const billTotal = parseFloat(sale.total || 0);
      let productTotal;
      let clinicTotal;
      if (split) {
        productTotal = split.product;
        clinicTotal = split.clinic;
      } else {
        // No line rows found — treat whole bill as product (legacy / edge).
        productTotal = billTotal;
        clinicTotal = 0;
      }
      // Pure clinic invoice → exclude entirely from product sales report.
      if (productTotal <= 0 && clinicTotal > 0) {
        return null;
      }
      const denom = billTotal > 0 ? billTotal : (productTotal + clinicTotal);
      const share = denom > 0 ? productTotal / denom : 1;
      const paid = parseFloat(sale.payment_amount || 0) * share;
      const credit = parseFloat(sale.credit_amount || 0) * share;
      return {
        sale,
        total: productTotal,
        paid,
        credit,
        discount: parseFloat(sale.discount || 0) * share,
        tax: parseFloat(sale.tax || 0) * share,
      };
    }).filter(Boolean);

    // ── Aggregate product (non-clinic) sales ───────────────────────────────
    let totalRevenue      = 0;
    let cashSalesAmount   = 0;
    let cardSalesAmount   = 0;
    let fullyCreditTotal  = 0;
    let partialTotal      = 0;
    let partialCollected  = 0;
    let partialCredit     = 0;
    let totalCashReceived = 0;
    let totalCreditGiven  = 0;
    let fullyPaidCount    = 0;
    let fullyCreditCount  = 0;
    let partialCount      = 0;
    let discounts         = 0;
    let taxCollected      = 0;

    productSaleMeta.forEach(({ sale, total, paid, credit, discount, tax }) => {
      const method    = (sale.payment_method || 'CASH').toUpperCase();
      const payType   = (sale.payment_type   || '').toUpperCase();
      const payStatus = (sale.payment_status || '').toUpperCase();

      totalRevenue     += total;
      totalCreditGiven += credit;
      discounts        += discount;
      taxCollected     += tax;

      if (method === 'FULLY_CREDIT') {
        fullyCreditCount++;
        fullyCreditTotal += total;

      } else if (
        method    === 'PARTIAL'  ||
        payType   === 'PARTIAL'  ||
        payStatus === 'PARTIAL'
      ) {
        partialCount++;
        partialTotal      += total;
        partialCollected  += paid;
        partialCredit     += credit;
        totalCashReceived += paid;

      } else if (method === 'CARD' || method === 'CREDIT_CARD') {
        fullyPaidCount++;
        cardSalesAmount   += total;
        totalCashReceived += paid > 0 ? paid : total;

      } else {
        fullyPaidCount++;
        cashSalesAmount   += total;
        totalCashReceived += paid > 0 ? paid : total;
      }
    });

    // ── Add settlement cash inflow ─────────────────────────────────────────
    const outstandingSettled         = settlementRows.reduce((s, r) => s + parseFloat(r.payment_amount || 0), 0);
    const outstandingSettlementCount = settlementRows.length;
    totalCashReceived += outstandingSettled;

    // ── Subtract refunds ───────────────────────────────────────────────────
    const refundTotal = refundRows.reduce((s, r) => s + Math.abs(parseFloat(r.payment_amount || r.total || 0)), 0);
    const refundCount = refundRows.length;
    totalCashReceived -= refundTotal;

    // ── Derived ───────────────────────────────────────────────────────────
    const totalOutstanding = totalCreditGiven;
    const realisedRevenue  = totalCashReceived;

    // ── Sales by date ──────────────────────────────────────────────────────
    const dateMap = {};
    productSaleMeta.forEach(({ sale, total, paid, credit }) => {
      const date = sale.created_at ? new Date(sale.created_at).toISOString().split('T')[0] : 'Unknown';
      if (!dateMap[date]) dateMap[date] = { date, total: 0, collected: 0, credit: 0, transactions: 0 };
      dateMap[date].total        += total;
      dateMap[date].collected    += paid;
      dateMap[date].credit       += credit;
      dateMap[date].transactions += 1;
    });
    const salesByDate = Object.values(dateMap)
      .sort((a, b) => a.date.localeCompare(b.date))
      .map(d => ({ ...d, avgTicket: d.transactions > 0 ? d.total / d.transactions : 0 }));

    // ── Sales by cashier ───────────────────────────────────────────────────
    const cashierMap = {};
    productSaleMeta.forEach(({ sale, total, paid, credit }) => {
      const key = sale.user_name || (sale.user_id ? `User ${sale.user_id}` : 'Unknown');
      if (!cashierMap[key]) cashierMap[key] = { cashier: key, total: 0, collected: 0, credit: 0, transactions: 0 };
      cashierMap[key].total        += total;
      cashierMap[key].collected    += paid;
      cashierMap[key].credit       += credit;
      cashierMap[key].transactions += 1;
    });

    // ── Sales by branch ────────────────────────────────────────────────────
    const branchMap = {};
    productSaleMeta.forEach(({ sale, total, paid, credit }) => {
      const key = sale.scope_id || 'Unknown';
      if (!branchMap[key]) branchMap[key] = { branch: key, total: 0, collected: 0, credit: 0, transactions: 0 };
      branchMap[key].total        += total;
      branchMap[key].collected    += paid;
      branchMap[key].credit       += credit;
      branchMap[key].transactions += 1;
    });

    // ── Payment method breakdown ───────────────────────────────────────────
    const methodMap = {};
    productSaleMeta.forEach(({ sale, total, paid, credit }) => {
      const method    = (sale.payment_method || 'CASH').toUpperCase();
      const payType   = (sale.payment_type   || '').toUpperCase();
      const payStatus = (sale.payment_status || '').toUpperCase();
      let key = method;
      if (payType === 'PARTIAL' || payStatus === 'PARTIAL') key = 'PARTIAL';
      if (!methodMap[key]) methodMap[key] = { method: key, count: 0, total: 0, collected: 0, credit: 0 };
      methodMap[key].count     += 1;
      methodMap[key].total     += total;
      methodMap[key].collected += paid;
      methodMap[key].credit    += credit;
    });

    // ── Recent rows (product portion only; exclude pure-clinic invoices) ───
    const productSaleIdSet = new Set(productSaleMeta.map((m) => m.sale.id));
    const productMetaById = Object.fromEntries(productSaleMeta.map((m) => [m.sale.id, m]));
    const recentSales = rows
      .filter(s => !isRefundRow(s) && (isSettlementRow(s) || productSaleIdSet.has(s.id)))
      .slice(0, 20)
      .map(sale => {
        const meta = productMetaById[sale.id];
        const total = meta ? meta.total : parseFloat(sale.total || 0);
        const payment_amount = meta ? meta.paid : parseFloat(sale.payment_amount || 0);
        const credit_amount = meta ? meta.credit : parseFloat(sale.credit_amount || 0);
        return {
          id:              sale.id,
          invoice_no:      sale.invoice_no     || 'N/A',
          created_at:      sale.created_at,
          date:            sale.created_at ? new Date(sale.created_at).toLocaleDateString() : '—',
          customer_name:   sale.customer_name  || 'Walk-in',
          customer_phone:  sale.customer_phone || '',
          cashier_name:    sale.user_name      || `User ${sale.user_id}`,
          total,
          payment_amount,
          credit_amount,
          payment_method:  sale.payment_method || 'CASH',
          payment_type:    sale.payment_type   || null,
          payment_status:  sale.payment_status || sale.credit_status || 'COMPLETED',
          is_settlement:   isSettlementRow(sale),
          scope_id:        sale.scope_id,
          running_balance: ledgerMigrationDone
            ? (sale.snapshot_final_balance != null
                ? parseFloat(sale.snapshot_final_balance)
                : null)
            : parseFloat(sale.running_balance || 0),
          sales:           total,
          total_amount:    total,
        };
      });

    // ── Top products (inventory lines only — clinic excluded) ──────────────
    let topProducts = [];
    try {
      const saleIds = productSaleMeta.map(r => r.sale.id).filter(Boolean);
      if (saleIds.length > 0) {
        const placeholders = saleIds.map(() => '?').join(',');
        const [itemRows] = await pool.execute(
          `SELECT
             COALESCE(ii.name, si.name) AS product_name,
             SUM(si.quantity)                          AS total_qty,
             SUM(si.total)                             AS total_revenue,
             SUM(si.quantity * COALESCE(ii.cost_price, 0))              AS total_cost,
             SUM(si.total - (si.quantity * COALESCE(ii.cost_price, 0))) AS gross_profit
           FROM sale_items si
           LEFT JOIN inventory_items ii ON si.inventory_item_id = ii.id
           WHERE si.sale_id IN (${placeholders})
             AND ${PRODUCT_LINE_SQL}
           GROUP BY COALESCE(ii.name, si.name)
           ORDER BY total_qty DESC
           LIMIT 25`,
          saleIds
        );
        topProducts = itemRows.map(r => ({
          name:        r.product_name  || 'Unknown',
          sold:        parseFloat(r.total_qty || 0),
          revenue:     parseFloat(r.total_revenue || 0),
          cost:        parseFloat(r.total_cost    || 0),
          grossProfit: parseFloat(r.gross_profit  || 0),
        }));
      }
    } catch (err) {
      console.error('topProducts query failed:', err.message);
    }

    // ── GROSS PROFIT (COGS-based, inventory lines only) ─────────────────────
    let grossProfit      = 0;
    let totalCostOfGoods = 0;
    let costPriceWarning = false;
    try {
      const saleIds = productSaleMeta.map(r => r.sale.id).filter(Boolean);
      if (saleIds.length > 0) {
        const placeholders = saleIds.map(() => '?').join(',');
        const [profitRows] = await pool.execute(
          `SELECT
             SUM(si.quantity * COALESCE(ii.cost_price, 0))                    AS total_cost,
             SUM(CASE WHEN COALESCE(ii.cost_price, 0) = 0 THEN 1 ELSE 0 END) AS zero_cost_count
           FROM sale_items si
           LEFT JOIN inventory_items ii ON si.inventory_item_id = ii.id
           WHERE si.sale_id IN (${placeholders})
             AND ${PRODUCT_LINE_SQL}`,
          saleIds
        );
        totalCostOfGoods = parseFloat(profitRows[0]?.total_cost    ?? 0);
        grossProfit      = totalRevenue - totalCostOfGoods;
        costPriceWarning = parseInt(profitRows[0]?.zero_cost_count ?? 0) > 0;
      }
    } catch (err) {
    }

    const grossProfitMargin = totalRevenue > 0 ? (grossProfit / totalRevenue) * 100 : 0;

    res.json({
      success: true,
      data: {
        // ── KPI ──
        totalSales:        productSaleMeta.length,
        totalTransactions: productSaleMeta.length,
        totalRevenue,
        averageTicket:     productSaleMeta.length > 0 ? totalRevenue / productSaleMeta.length : 0,

        // ── Profit (COGS-based) ──
        grossProfit,
        totalCostOfGoods,
        grossProfitMargin,
        costPriceWarning,

        // ── Payment breakdown ──
        cashSalesAmount,
        cardSalesAmount,
        fullyCreditTotal,
        partialTotal,
        partialCollected,
        partialCredit,

        // ── Cash flow ──
        totalCashReceived,
        totalCreditGiven,
        totalOutstanding,
        realisedRevenue,

        // ── Recovery ──
        outstandingSettled,
        outstandingSettlementCount,

        // ── Refunds ──
        refundTotal,
        refundCount,
        refunds: refundTotal,

        // ── Counts ──
        fullyPaidCount,
        fullyCreditCount,
        partialCount,

        // ── Other ──
        discounts,
        taxCollected,

        // ── Legacy compat ──
        cashSales: cashSalesAmount,
        cardSales: cardSalesAmount,

        // ── Chart / table data ──
        salesByDate,
        salesByCashier:         cashierMap,
        salesByCashierList:     Object.values(cashierMap),
        salesByBranch:          branchMap,
        salesByBranchList:      Object.values(branchMap),
        paymentMethodBreakdown: Object.values(methodMap),
        recentSales,
        topProducts,
      },
    });

  } catch (error) {
    res.status(500).json({ success: false, message: 'Error retrieving sales reports', error: error.message });
  }
};

// @desc    Clinic services sales report (separate from product sales)
// @route   GET /api/reports/clinic
// @access  Private
const getClinicSalesReports = async (req, res) => {
  try {
    const user = req.user;
    const { branch, cashier, startDate, endDate, category } = req.query;

    const { whereClause, params } = await buildSalesReportWhere(user, {
      branch, cashier, startDate, endDate,
    });

    // Only completed non-settlement / non-refund parent sales — clinic lines only
    let itemWhere = `${whereClause}
      AND ${CLINIC_LINE_SQL}
      AND (s.payment_type IS NULL OR s.payment_type NOT IN ('OUTSTANDING_SETTLEMENT','CASH_REFUND','REFUND','BILTY_CHARGE','CREDIT_REFUND_SETTLEMENT'))
      AND (s.payment_method IS NULL OR s.payment_method NOT IN ('CASH_REFUND','REFUND'))`;
    const itemParams = [...params];

    if (category && category !== 'all') {
      itemWhere += ' AND COALESCE(cs.category_id, cs2.category_id) = ?';
      itemParams.push(category);
    }

    const [lines] = await pool.execute(
      `SELECT
         si.id AS line_id,
         si.sale_id,
         si.clinic_service_id,
         si.name AS service_name,
         si.sku,
         si.quantity,
         si.unit_price,
         si.total AS line_total,
         si.discount AS line_discount,
         s.invoice_no,
         s.created_at,
         s.customer_name,
         s.customer_phone,
         s.scope_id,
         s.payment_method,
         s.payment_type,
         s.payment_status,
         u.username AS cashier_name,
         cs.code AS service_code,
         COALESCE(cs.category_id, (
           SELECT cs2.category_id FROM clinic_services cs2
           WHERE cs2.id = CAST(SUBSTRING_INDEX(si.sku, '-', -1) AS UNSIGNED)
             AND UPPER(si.sku) LIKE 'CLINIC-%'
           LIMIT 1
         )) AS category_id,
         COALESCE(csc.name, csc2.name, 'Uncategorized') AS category_name
       FROM sale_items si
       INNER JOIN sales s ON s.id = si.sale_id
       LEFT JOIN users u ON s.user_id = u.id
       LEFT JOIN clinic_services cs ON cs.id = si.clinic_service_id
       LEFT JOIN clinic_service_categories csc ON csc.id = cs.category_id
       LEFT JOIN clinic_services cs2
         ON si.clinic_service_id IS NULL
        AND UPPER(COALESCE(si.sku, '')) LIKE 'CLINIC-%'
        AND cs2.id = CAST(SUBSTRING_INDEX(si.sku, '-', -1) AS UNSIGNED)
       LEFT JOIN clinic_service_categories csc2 ON csc2.id = cs2.category_id
       ${itemWhere}
       ORDER BY s.created_at DESC, si.id ASC`,
      itemParams
    );

    let totalRevenue = 0;
    let totalQty = 0;
    const categoryMap = {};
    const serviceMap = {};
    const dateMap = {};
    const branchMap = {};

    lines.forEach((row) => {
      const revenue = parseFloat(row.line_total || 0);
      const qty = parseFloat(row.quantity || 0);
      totalRevenue += revenue;
      totalQty += qty;

      const catKey = row.category_id != null ? String(row.category_id) : 'none';
      if (!categoryMap[catKey]) {
        categoryMap[catKey] = {
          categoryId: row.category_id,
          category: row.category_name || 'Uncategorized',
          revenue: 0,
          quantity: 0,
          lines: 0,
        };
      }
      categoryMap[catKey].revenue += revenue;
      categoryMap[catKey].quantity += qty;
      categoryMap[catKey].lines += 1;

      const svcKey = row.clinic_service_id != null
        ? `id:${row.clinic_service_id}`
        : `name:${row.service_name || 'Unknown'}`;
      if (!serviceMap[svcKey]) {
        serviceMap[svcKey] = {
          clinicServiceId: row.clinic_service_id,
          name: row.service_name || 'Clinic service',
          code: row.service_code || row.sku || null,
          categoryId: row.category_id,
          category: row.category_name || 'Uncategorized',
          revenue: 0,
          quantity: 0,
          lines: 0,
        };
      }
      serviceMap[svcKey].revenue += revenue;
      serviceMap[svcKey].quantity += qty;
      serviceMap[svcKey].lines += 1;

      const date = row.created_at ? new Date(row.created_at).toISOString().split('T')[0] : 'Unknown';
      if (!dateMap[date]) dateMap[date] = { date, revenue: 0, quantity: 0, lines: 0 };
      dateMap[date].revenue += revenue;
      dateMap[date].quantity += qty;
      dateMap[date].lines += 1;

      const br = row.scope_id || 'Unknown';
      if (!branchMap[br]) branchMap[br] = { branch: br, revenue: 0, quantity: 0, lines: 0 };
      branchMap[br].revenue += revenue;
      branchMap[br].quantity += qty;
      branchMap[br].lines += 1;
    });

    const byCategory = Object.values(categoryMap).sort((a, b) => b.revenue - a.revenue);
    const byService = Object.values(serviceMap).sort((a, b) => b.revenue - a.revenue);
    const byDate = Object.values(dateMap).sort((a, b) => a.date.localeCompare(b.date));
    const byBranch = Object.values(branchMap).sort((a, b) => b.revenue - a.revenue);

    const recentLines = lines.slice(0, 50).map((row) => ({
      id: row.line_id,
      saleId: row.sale_id,
      invoiceNo: row.invoice_no || 'N/A',
      createdAt: row.created_at,
      date: row.created_at ? new Date(row.created_at).toLocaleDateString() : '—',
      customerName: row.customer_name || 'Walk-in',
      customerPhone: row.customer_phone || '',
      cashierName: row.cashier_name || '—',
      branch: row.scope_id || '—',
      serviceName: row.service_name || 'Clinic service',
      serviceCode: row.service_code || row.sku || null,
      categoryId: row.category_id,
      category: row.category_name || 'Uncategorized',
      quantity: parseFloat(row.quantity || 0),
      unitPrice: parseFloat(row.unit_price || 0),
      total: parseFloat(row.line_total || 0),
      paymentMethod: row.payment_method || 'CASH',
    }));

    // Category filter options (all active categories + any seen in period)
    let categories = [];
    try {
      const [catRows] = await pool.execute(
        `SELECT id, name FROM clinic_service_categories ORDER BY name ASC`
      );
      categories = catRows.map((c) => ({ id: c.id, name: c.name }));
    } catch (err) {
      categories = byCategory
        .filter((c) => c.categoryId != null)
        .map((c) => ({ id: c.categoryId, name: c.category }));
    }

    const invoiceIds = new Set(lines.map((l) => l.sale_id));

    res.json({
      success: true,
      data: {
        totalRevenue,
        totalQuantity: totalQty,
        totalLines: lines.length,
        totalInvoices: invoiceIds.size,
        averageTicket: invoiceIds.size > 0 ? totalRevenue / invoiceIds.size : 0,
        byCategory,
        byService,
        byDate,
        byBranch,
        recentLines,
        categories,
        topServices: byService.slice(0, 15),
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error retrieving clinic sales reports',
      error: error.message,
    });
  }
};

// @desc    Get inventory reports
// @route   GET /api/reports/inventory
// @access  Private
const getInventoryReports = async (req, res) => {
  try {
    const user = req.user;
    const inventoryData = {
      summary: { totalItems: 0, totalValue: 0, turnoverRate: 0, stockStatusCounts: { 'In Stock': 0, 'Low Stock': 0, 'Out of Stock': 0 }, categoryCounts: {} },
      lowStockItems: [], topSellingItems: [], movementData: [],
    };

    try {
      let query = `
        SELECT i.*, COALESCE(l.qty, 0) AS ledger_stock
        FROM inventory_items i
        LEFT JOIN (
          SELECT le.inventory_item_id, SUM(le.quantity_in - le.quantity_out) AS qty
          FROM inventory_ledger_entries le
          INNER JOIN inventory_items ix ON ix.id = le.inventory_item_id
            AND le.scope_type = ix.scope_type
            AND (CAST(le.scope_id AS CHAR) COLLATE utf8mb4_bin = CAST(ix.scope_id AS CHAR) COLLATE utf8mb4_bin)
          GROUP BY le.inventory_item_id
        ) l ON l.inventory_item_id = i.id
      `;
      const params = [];
      if (user?.role === 'WAREHOUSE_KEEPER' && user?.warehouseId) {
        query += ` WHERE i.scope_type = 'WAREHOUSE' AND (
          CAST(i.scope_id AS UNSIGNED) = ? OR CAST(i.scope_id AS CHAR) COLLATE utf8mb4_bin = CAST(? AS CHAR) COLLATE utf8mb4_bin
        )`;
        params.push(user.warehouseId, String(user.warehouseId));
      } else if (user?.role === 'CASHIER' && user?.branchId) {
        query += ` WHERE i.scope_type = 'BRANCH' AND (
          CAST(i.scope_id AS UNSIGNED) = ? OR CAST(i.scope_id AS CHAR) COLLATE utf8mb4_bin = CAST(? AS CHAR) COLLATE utf8mb4_bin
        )`;
        params.push(user.branchId, String(user.branchId));
      }
      const [items] = await pool.execute(query, params);
      inventoryData.summary.totalItems = items.length;
      inventoryData.summary.totalValue = items.reduce(
        (sum, item) => sum + (parseFloat(item.ledger_stock) || 0) * parseFloat(item.cost_price || 0),
        0
      );
      items.forEach((item) => {
        const stock = parseFloat(item.ledger_stock) || 0;
        const min = item.min_stock_level || 0;
        if (stock <= 0) inventoryData.summary.stockStatusCounts['Out of Stock'] += 1;
        else if (min > 0 && stock <= min) inventoryData.summary.stockStatusCounts['Low Stock'] += 1;
        else inventoryData.summary.stockStatusCounts['In Stock'] += 1;
        const cat = item.category || 'Uncategorized';
        inventoryData.summary.categoryCounts[cat] = (inventoryData.summary.categoryCounts[cat] || 0) + 1;
      });
      const tv = inventoryData.summary.totalValue;
      const ti = inventoryData.summary.totalItems;
      inventoryData.summary.turnoverRate = ti > 0 && tv > 0 ? parseFloat((tv / ti / 1000).toFixed(1)) : 0;
      inventoryData.lowStockItems = items
        .filter(
          (i) =>
            (parseFloat(i.ledger_stock) || 0) > 0 &&
            (i.min_stock_level || 0) > 0 &&
            (parseFloat(i.ledger_stock) || 0) <= (i.min_stock_level || 0)
        )
        .slice(0, 10)
        .map((i) => ({
          name: i.name,
          item_name: i.name,
          current_stock: parseFloat(i.ledger_stock) || 0,
          min_stock_level: i.min_stock_level || 0,
          category: i.category || 'Uncategorized',
          sku: i.sku || '',
        }));
    } catch (e) {
    }

    try {
      let movementSql = `
        SELECT DATE(COALESCE(le.entry_date, le.created_at)) AS date,
          SUM(CASE WHEN le.event_type IN ('PURCHASE','TRANSFER_IN','RESTOCK','OPENING') THEN le.quantity_in ELSE 0 END) AS received,
          SUM(CASE WHEN le.event_type = 'SALE' THEN le.quantity_out ELSE 0 END) AS sold,
          SUM(CASE WHEN le.event_type = 'RETURN' THEN le.quantity_in ELSE 0 END) AS returned
        FROM inventory_ledger_entries le
        INNER JOIN inventory_items i ON i.id = le.inventory_item_id
          AND le.scope_type = i.scope_type
          AND (CAST(le.scope_id AS CHAR) COLLATE utf8mb4_bin = CAST(i.scope_id AS CHAR) COLLATE utf8mb4_bin)
        WHERE COALESCE(le.entry_date, le.created_at) >= DATE_SUB(NOW(), INTERVAL 7 DAY)
      `;
      const movementParams = [];
      if (user?.role === 'WAREHOUSE_KEEPER' && user?.warehouseId) {
        movementSql += ` AND i.scope_type = 'WAREHOUSE' AND (
          CAST(i.scope_id AS UNSIGNED) = ? OR CAST(i.scope_id AS CHAR) COLLATE utf8mb4_bin = CAST(? AS CHAR) COLLATE utf8mb4_bin
        )`;
        movementParams.push(user.warehouseId, String(user.warehouseId));
      } else if (user?.role === 'CASHIER' && user?.branchId) {
        movementSql += ` AND i.scope_type = 'BRANCH' AND (
          CAST(i.scope_id AS UNSIGNED) = ? OR CAST(i.scope_id AS CHAR) COLLATE utf8mb4_bin = CAST(? AS CHAR) COLLATE utf8mb4_bin
        )`;
        movementParams.push(user.branchId, String(user.branchId));
      }
      movementSql += ` GROUP BY DATE(COALESCE(le.entry_date, le.created_at)) ORDER BY date`;
      const [mr] = await pool.execute(movementSql, movementParams);
      inventoryData.movementData = mr.map(r => ({ date: r.date, received: r.received || 0, sold: r.sold || 0, returned: r.returned || 0 }));
    } catch { inventoryData.movementData = []; }

    try {
      let topSql = `
        SELECT i.name,
               SUM(le.quantity_out) AS sold,
               SUM(le.quantity_out * COALESCE(i.selling_price, 0)) AS revenue
        FROM inventory_ledger_entries le
        INNER JOIN inventory_items i ON i.id = le.inventory_item_id
          AND le.scope_type = i.scope_type
          AND (CAST(le.scope_id AS CHAR) COLLATE utf8mb4_bin = CAST(i.scope_id AS CHAR) COLLATE utf8mb4_bin)
        WHERE le.event_type = 'SALE'
          AND COALESCE(le.entry_date, le.created_at) >= DATE_SUB(NOW(), INTERVAL 30 DAY)
      `;
      const topParams = [];
      if (user?.role === 'WAREHOUSE_KEEPER' && user?.warehouseId) {
        topSql += ` AND i.scope_type = 'WAREHOUSE' AND (
          CAST(i.scope_id AS UNSIGNED) = ? OR CAST(i.scope_id AS CHAR) COLLATE utf8mb4_bin = CAST(? AS CHAR) COLLATE utf8mb4_bin
        )`;
        topParams.push(user.warehouseId, String(user.warehouseId));
      } else if (user?.role === 'CASHIER' && user?.branchId) {
        topSql += ` AND i.scope_type = 'BRANCH' AND (
          CAST(i.scope_id AS UNSIGNED) = ? OR CAST(i.scope_id AS CHAR) COLLATE utf8mb4_bin = CAST(? AS CHAR) COLLATE utf8mb4_bin
        )`;
        topParams.push(user.branchId, String(user.branchId));
      }
      topSql += ' GROUP BY i.id, i.name ORDER BY sold DESC LIMIT 5';
      const [tr] = await pool.execute(topSql, topParams);
      inventoryData.topSellingItems = tr.map((i) => ({
        name: i.name,
        item_name: i.name,
        sold: i.sold || 0,
        quantity_sold: i.sold || 0,
        revenue: parseFloat(i.revenue || 0),
      }));
    } catch {
      inventoryData.topSellingItems = [];
    }

    res.json({ success: true, data: inventoryData });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error retrieving inventory reports', error: error.message });
  }
};

// @desc    Get ledger reports
// @route   GET /api/reports/ledger
// @access  Private
const getLedgerReports = async (req, res) => {
  try {
    const user = req.user;
    const { startDate, endDate, account, transactionType } = req.query;
    const ledgerData = { totalEntries: 0, totalTransactions: 0, totalDebit: 0, totalCredit: 0, balance: 0, recentTransactions: [], trendData: [], accountSummary: [] };

    try {
      let query = 'SELECT * FROM ledger WHERE 1=1'; const params = [];
      if (user?.role === 'WAREHOUSE_KEEPER' && user?.warehouseId) { query += ' AND scope_type = "WAREHOUSE" AND scope_id = ?'; params.push(user.warehouseId); }
      if (startDate) { query += ' AND DATE(created_at) >= ?'; params.push(startDate); }
      if (endDate)   { query += ' AND DATE(created_at) <= ?'; params.push(endDate); }
      if (account && account !== 'all')                 { query += ' AND account_type = ?';     params.push(account); }
      if (transactionType && transactionType !== 'all') { query += ' AND transaction_type = ?'; params.push(transactionType); }
      query += ' ORDER BY created_at DESC';
      const [entries] = await pool.execute(query, params);
      ledgerData.totalEntries = ledgerData.totalTransactions = entries.length;
      ledgerData.totalDebit  = entries.filter(e => e.transaction_type === 'DEBIT').reduce((s, e)  => s + parseFloat(e.amount || 0), 0);
      ledgerData.totalCredit = entries.filter(e => e.transaction_type === 'CREDIT').reduce((s, e) => s + parseFloat(e.amount || 0), 0);
      ledgerData.balance = ledgerData.totalCredit - ledgerData.totalDebit;
      ledgerData.recentTransactions = entries.slice(0, 10).map(e => ({ ...e, debit_amount: e.transaction_type === 'DEBIT' ? parseFloat(e.amount || 0) : 0, credit_amount: e.transaction_type === 'CREDIT' ? parseFloat(e.amount || 0) : 0 }));
      const trendMap = {};
      entries.forEach(e => { const d = e.created_at ? new Date(e.created_at).toISOString().split('T')[0] : 'Unknown'; if (!trendMap[d]) trendMap[d] = { date: d, debit: 0, credit: 0 }; if (e.transaction_type === 'DEBIT') trendMap[d].debit += parseFloat(e.amount || 0); if (e.transaction_type === 'CREDIT') trendMap[d].credit += parseFloat(e.amount || 0); });
      ledgerData.trendData = Object.values(trendMap).sort((a, b) => a.date.localeCompare(b.date)).map(d => ({ ...d, balance: d.credit - d.debit }));
      const accountMap = {};
      entries.forEach(e => { const k = e.account_type || 'General'; if (!accountMap[k]) accountMap[k] = { account: k, debit: 0, credit: 0, entries: 0 }; if (e.transaction_type === 'DEBIT') accountMap[k].debit += parseFloat(e.amount || 0); if (e.transaction_type === 'CREDIT') accountMap[k].credit += parseFloat(e.amount || 0); accountMap[k].entries += 1; });
      ledgerData.accountSummary = Object.values(accountMap).map(a => ({ ...a, balance: a.credit - a.debit }));
    } catch (e) { /* optional */ }

    res.json({ success: true, data: ledgerData });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error retrieving ledger reports', error: error.message });
  }
};

// @desc    Get financial reports
// @route   GET /api/reports/financial
// @access  Private
const getFinancialReports = async (req, res) => {
  try {
    const { year, dateFrom, dateTo, branch } = req.query;
    const user = req.user;

    // Sales often store BRANCH/WAREHOUSE *name* in scope_id; vouchers store numeric id.
    // Match both. Expenses: include APPROVED + PENDING (cashiers create PENDING).

    const dateParams = [];
    let dateFilter = '';
    if (dateFrom && dateTo) { dateFilter = ' AND DATE(created_at) BETWEEN ? AND ?'; dateParams.push(dateFrom, dateTo); }
    else if (year)          { dateFilter = ' AND YEAR(created_at) = ?';             dateParams.push(year); }

    const scopeParams = [];
    let scopeFilter = '';
    let scopedScopeFilter = '';

    const pushBranchScope = (branchName, branchId) => {
      const ids = [...new Set([branchName, branchId != null ? String(branchId) : null].filter(Boolean))];
      if (ids.length === 0) {
        scopeFilter = ' AND scope_type = "BRANCH"';
        scopedScopeFilter = ' AND s.scope_type = "BRANCH"';
        return;
      }
      if (ids.length === 1) {
        scopeFilter = ' AND scope_type = "BRANCH" AND scope_id = ?';
        scopedScopeFilter = ' AND s.scope_type = "BRANCH" AND s.scope_id = ?';
        scopeParams.push(ids[0]);
        return;
      }
      scopeFilter = ' AND scope_type = "BRANCH" AND scope_id IN (?, ?)';
      scopedScopeFilter = ' AND s.scope_type = "BRANCH" AND s.scope_id IN (?, ?)';
      scopeParams.push(ids[0], ids[1]);
    };

    const pushWarehouseScope = (warehouseName, warehouseId) => {
      const ids = [...new Set([warehouseName, warehouseId != null ? String(warehouseId) : null].filter(Boolean))];
      if (ids.length === 0) {
        scopeFilter = ' AND scope_type = "WAREHOUSE"';
        scopedScopeFilter = ' AND s.scope_type = "WAREHOUSE"';
        return;
      }
      if (ids.length === 1) {
        scopeFilter = ' AND scope_type = "WAREHOUSE" AND scope_id = ?';
        scopedScopeFilter = ' AND s.scope_type = "WAREHOUSE" AND s.scope_id = ?';
        scopeParams.push(ids[0]);
        return;
      }
      scopeFilter = ' AND scope_type = "WAREHOUSE" AND scope_id IN (?, ?)';
      scopedScopeFilter = ' AND s.scope_type = "WAREHOUSE" AND s.scope_id IN (?, ?)';
      scopeParams.push(ids[0], ids[1]);
    };

    if (user?.role === 'WAREHOUSE_KEEPER') {
      let warehouseName = user.warehouseName;
      const warehouseId = user.warehouseId;
      if (!warehouseName && warehouseId) {
        const [wrows] = await pool.execute('SELECT name FROM warehouses WHERE id = ?', [warehouseId]);
        warehouseName = wrows[0]?.name || null;
      }
      pushWarehouseScope(warehouseName, warehouseId);
    } else if (user?.role === 'CASHIER') {
      let branchName = user.branchName;
      const branchId = user.branchId;
      if (!branchName && branchId) {
        const [brows] = await pool.execute('SELECT name FROM branches WHERE id = ?', [branchId]);
        branchName = brows[0]?.name || null;
      }
      pushBranchScope(branchName, branchId);
    } else if (user?.role === 'ADMIN' && branch && branch !== 'all') {
      const [brows] = await pool.execute(
        'SELECT id, name FROM branches WHERE id = ? OR name = ? LIMIT 1',
        [branch, branch]
      );
      if (brows[0]) pushBranchScope(brows[0].name, brows[0].id);
      else pushBranchScope(branch, branch);
    }

    const allParams = [...dateParams, ...scopeParams];

    let scopedDateFilter = '';
    if (dateFrom && dateTo) { scopedDateFilter = ' AND DATE(s.created_at) BETWEEN ? AND ?'; }
    else if (year)          { scopedDateFilter = ' AND YEAR(s.created_at) = ?'; }

    const voucherStatusSql = `AND status IN ('APPROVED', 'PENDING')`;

    const financialData = {
      totalRevenue: 0,
      totalCostOfGoods: 0,
      grossProfit: 0,
      grossProfitMargin: 0,
      totalExpenses: 0,
      netProfit: 0,
      netProfitMargin: 0,
      zakatDue: 0,
      operatingCashFlow: 0,
      profitMargin: 0,
      revenueByPeriod: [], expensesByPeriod: [], cashFlowData: [],
      expenseBreakdown: [], profitabilityMetrics: [], financialRatios: [], topRevenueSources: [],
    };

    const realSalesFilter = `AND (payment_type IS NULL OR payment_type NOT IN ('OUTSTANDING_SETTLEMENT','CASH_REFUND','REFUND'))
                             AND (payment_method IS NULL OR payment_method NOT IN ('CASH_REFUND','REFUND'))`;

    try {
      const [sr] = await pool.execute(
        `SELECT SUM(total) AS total FROM sales
         WHERE status = 'COMPLETED' ${realSalesFilter} ${dateFilter} ${scopeFilter}`,
        allParams
      );
      financialData.totalRevenue = parseFloat(sr[0]?.total || 0);

      const [saleIdRows] = await pool.execute(
        `SELECT id FROM sales
         WHERE status = 'COMPLETED' ${realSalesFilter} ${dateFilter} ${scopeFilter}`,
        allParams
      );
      const saleIds = saleIdRows.map(r => r.id).filter(Boolean);

      if (saleIds.length > 0) {
        const ph = saleIds.map(() => '?').join(',');
        const [cogsRows] = await pool.execute(
          `SELECT
             SUM(si.quantity * COALESCE(ii.cost_price, 0)) AS total_cost
           FROM sale_items si
           LEFT JOIN inventory_items ii ON si.inventory_item_id = ii.id
           WHERE si.sale_id IN (${ph})`,
          saleIds
        );
        financialData.totalCostOfGoods = parseFloat(cogsRows[0]?.total_cost ?? 0);
        financialData.grossProfit      = financialData.totalRevenue - financialData.totalCostOfGoods;
      }

      financialData.grossProfitMargin = financialData.totalRevenue > 0
        ? (financialData.grossProfit / financialData.totalRevenue) * 100
        : 0;

      const [vr] = await pool.execute(
        `SELECT SUM(CASE WHEN type='INCOME' THEN amount ELSE 0 END) AS total_income,
                SUM(CASE WHEN type='EXPENSE' THEN amount ELSE 0 END) AS total_expenses
         FROM financial_vouchers WHERE 1=1 ${voucherStatusSql} ${dateFilter} ${scopeFilter}`,
        allParams
      );
      financialData.totalExpenses     = parseFloat(vr[0]?.total_expenses || 0);
      financialData.operatingCashFlow = parseFloat(vr[0]?.total_income   || 0);

      financialData.netProfit       = financialData.grossProfit - financialData.totalExpenses;
      financialData.netProfitMargin = financialData.totalRevenue > 0
        ? (financialData.netProfit / financialData.totalRevenue) * 100
        : 0;
      financialData.profitMargin = financialData.netProfitMargin;

      financialData.zakatDue = financialData.netProfit > 0
        ? financialData.netProfit * 0.025
        : 0;

      const [rbp] = await pool.execute(
        `SELECT DATE_FORMAT(s.created_at,'%Y-%m') AS period,
                SUM(s.total) AS revenue,
                COUNT(*) AS sales_count
         FROM sales s
         WHERE s.status='COMPLETED' ${realSalesFilter} ${scopedDateFilter} ${scopedScopeFilter}
         GROUP BY DATE_FORMAT(s.created_at,'%Y-%m')
         ORDER BY period ASC LIMIT 12`,
        allParams
      );

      const [cogsByMonth] = await pool.execute(
        `SELECT DATE_FORMAT(s.created_at,'%Y-%m') AS period,
                SUM(si.quantity * COALESCE(ii.cost_price, 0)) AS total_cogs
         FROM sales s
         JOIN sale_items si ON si.sale_id = s.id
         LEFT JOIN inventory_items ii ON ii.id = si.inventory_item_id
         WHERE s.status='COMPLETED' ${realSalesFilter} ${scopedDateFilter} ${scopedScopeFilter}
         GROUP BY DATE_FORMAT(s.created_at,'%Y-%m')
         ORDER BY period ASC LIMIT 12`,
        allParams
      );

      const cogsMap = {};
      cogsByMonth.forEach(r => { cogsMap[r.period] = parseFloat(r.total_cogs || 0); });

      financialData.revenueByPeriod = rbp.map(r => {
        const rev  = parseFloat(r.revenue || 0);
        const cogs = cogsMap[r.period]   || 0;
        return {
          month:    r.period,
          revenue:  rev,
          cogs,
          expenses: 0,
          profit:   rev - cogs,
        };
      });

      const [ebp] = await pool.execute(
        `SELECT DATE_FORMAT(created_at,'%Y-%m') AS period, SUM(amount) AS expenses
         FROM financial_vouchers WHERE type='EXPENSE' ${voucherStatusSql} ${dateFilter} ${scopeFilter}
         GROUP BY DATE_FORMAT(created_at,'%Y-%m') ORDER BY period ASC LIMIT 12`,
        allParams
      );
      ebp.forEach(exp => {
        const item = financialData.revenueByPeriod.find(r => r.month === exp.period);
        if (item) {
          item.expenses = parseFloat(exp.expenses || 0);
          item.profit   = item.revenue - item.cogs - item.expenses;
        }
      });
      financialData.expensesByPeriod = ebp.map((r) => ({
        month: r.period,
        expenses: parseFloat(r.expenses || 0),
      }));

      const [cfr] = await pool.execute(
        `SELECT DATE_FORMAT(created_at,'%Y-%m') AS period,
                SUM(CASE WHEN type='INCOME' THEN amount ELSE 0 END) AS operating,
                SUM(CASE WHEN type='EXPENSE' THEN amount ELSE 0 END) AS investing
         FROM financial_vouchers WHERE 1=1 ${voucherStatusSql} ${dateFilter} ${scopeFilter}
         GROUP BY DATE_FORMAT(created_at,'%Y-%m') ORDER BY period ASC LIMIT 12`,
        allParams
      );
      financialData.cashFlowData = cfr.map(r => ({
        month:     r.period,
        operating: parseFloat(r.operating || 0),
        investing: -parseFloat(r.investing || 0),
        financing: 0,
      }));

      const [eb] = await pool.execute(
        `SELECT COALESCE(expense_category, category) AS label, SUM(amount) AS amount, COUNT(*) AS count
         FROM financial_vouchers WHERE type='EXPENSE' ${voucherStatusSql} ${dateFilter} ${scopeFilter}
         GROUP BY COALESCE(expense_category, category) ORDER BY amount DESC LIMIT 10`,
        allParams
      );
      const totalExp = eb.reduce((s, i) => s + parseFloat(i.amount || 0), 0);
      const colors   = ['#10b981','#06b6d4','#f59e0b','#a855f7','#ef4444','#3b82f6','#ec4899','#14b8a6','#f97316','#8b5cf6'];
      financialData.expenseBreakdown = eb.map((item, i) => ({
        category:   item.label || 'Other',
        amount:     parseFloat(item.amount || 0),
        percentage: totalExp > 0 ? parseFloat(((item.amount / totalExp) * 100).toFixed(1)) : 0,
        color:      colors[i % colors.length],
      }));

      const cogsRatio = financialData.totalRevenue > 0
        ? ((financialData.totalCostOfGoods / financialData.totalRevenue) * 100).toFixed(1)
        : '0.0';
      const expRatio = financialData.totalRevenue > 0
        ? ((financialData.totalExpenses / financialData.totalRevenue) * 100).toFixed(1)
        : '0.0';

      financialData.profitabilityMetrics = [
        { metric: 'Gross Profit Margin', value: `${financialData.grossProfitMargin.toFixed(1)}%`, status: financialData.grossProfitMargin >= 30 ? 'excellent' : 'good' },
        { metric: 'Net Profit Margin',   value: `${financialData.netProfitMargin.toFixed(1)}%`,  status: financialData.netProfitMargin  >= 10 ? 'excellent' : 'good' },
        { metric: 'COGS Ratio',          value: `${cogsRatio}%`, status: 'good' },
        { metric: 'Expense Ratio',       value: `${expRatio}%`,  status: 'good' },
        { metric: 'Zakat Rate',          value: '2.5%',          status: 'good' },
      ];
      financialData.financialRatios = [
        { ratio: 'Current Ratio',     value: '2.4', benchmark: '2.0', status: 'good' },
        { ratio: 'Quick Ratio',       value: '1.8', benchmark: '1.0', status: 'excellent' },
        { ratio: 'Debt-to-Equity',    value: '0.3', benchmark: '0.5', status: 'excellent' },
        { ratio: 'Interest Coverage', value: '8.5', benchmark: '2.5', status: 'excellent' },
      ];

      const [trs] = await pool.execute(
        `SELECT payment_method AS source, SUM(total) AS revenue, COUNT(*) AS count
         FROM sales WHERE status='COMPLETED' ${realSalesFilter} ${dateFilter} ${scopeFilter}
         GROUP BY payment_method ORDER BY revenue DESC LIMIT 10`,
        allParams
      );
      financialData.topRevenueSources = trs.map(item => ({
        source:  item.source || 'Unknown',
        revenue: parseFloat(item.revenue || 0),
        count:   item.count || 0,
      }));

    } catch (err) {
      financialData._error = err.message;
    }

    res.json({ success: true, data: financialData });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error retrieving financial reports', error: error.message });
  }
};


module.exports = {
  getReportsSummary,
  getSalesReports,
  getClinicSalesReports,
  getInventoryReports,
  getLedgerReports,
  getFinancialReports,
};