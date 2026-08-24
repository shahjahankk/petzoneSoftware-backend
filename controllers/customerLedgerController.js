const { pool } = require('../config/database');
const { enrichLedgerTransactionRow } = require('../utils/ledgerRowDates');
const { LEDGER_SORT_AT_S, LEDGER_SORT_AT_S2 } = require('../utils/ledgerSortAtSql');
const { isLedgerMigrationComplete } = require('../services/ledgerMigrationMeta');
const ImmRead = require('../services/customerLedgerImmutableReadService');
const {
  attachLedgerTransactionItems,
} = require('../services/ledgerTransactionItemsService');

function ledgerInstantMs(row) {
  if (row == null) return 0;
  if (row.sort_at != null) {
    const t = new Date(row.sort_at).getTime();
    if (!Number.isNaN(t)) return t;
  }
  if (row.created_at != null) {
    const t = new Date(row.created_at).getTime();
    if (!Number.isNaN(t)) return t;
  }
  return new Date(row.transaction_date || 0).getTime();
}

function compareLedgerAsc(a, b) {
  const ta = ledgerInstantMs(a);
  const tb = ledgerInstantMs(b);
  if (ta !== tb) return ta - tb;
  return (a.transaction_id || a.id || 0) - (b.transaction_id || b.id || 0);
}

function compareLedgerDesc(a, b) {
  return compareLedgerAsc(b, a);
}

/** Rows from customer_ledger_entries join already carry balances — skip legacy normalize. */
function ledgerRowsAlreadyNormalized(rows) {
  return (
    Array.isArray(rows) &&
    rows.length > 0 &&
    rows[0].ledger_entry_id != null
  );
}

const buildCustomerKey = (name, phone) => {
  const safeName = name ?? '';
  const safePhone = phone ?? '';
  return `${safeName}|${safePhone}`;
};

// @desc    Get comprehensive customer ledger
// @route   GET /api/customer-ledger/:customerId
// @access  Private (Admin, Cashier, Warehouse Keeper)
const getCustomerLedger = async (req, res) => {
  try {
    const { customerId } = req.params;
    const { 
      startDate, 
      endDate, 
      transactionType, 
      paymentMethod,
      limit: limitQuery = 1000,
      offset = 0,
      detailed = false
    } = req.query;

    const { parseLedgerLimit } = require('../utils/customerLedgerPartyFilter');
    const parsedLimit = parseLedgerLimit(limitQuery, 1000, 5000);

    // ✅ FIX: Handle "all" customers case - when customerId is "all" or special value
    const isAllCustomers = customerId === 'all' || 
                          customerId === 'All Customers' || 
                          customerId === 'all-customers' || 
                          customerId === 'all_customers' ||
                          customerId === '__all__';

    // Build WHERE conditions for role-based access
    let whereConditions = [];
    let params = [];

    // Role-based filtering - handle both branch_id and branchId for backward compatibility
    const userBranchId = req.user.branch_id || req.user.branchId;
    const userWarehouseId = req.user.warehouse_id || req.user.warehouseId;
    
    if (req.user.role === 'CASHIER' && userBranchId) {
      // For cashiers, we need to match by branch name since sales store scope_id as string
      // First get the branch name from the branch_id
      const [branches] = await pool.execute('SELECT name FROM branches WHERE id = ?', [userBranchId]);
      if (branches.length > 0) {
      whereConditions.push('(s.scope_type = ? AND s.scope_id = ?)');
        params.push('BRANCH', branches[0].name);
      }
    } else if (req.user.role === 'WAREHOUSE_KEEPER' && userWarehouseId) {
      // For warehouse keepers, we need to match by warehouse name since sales store scope_id as string
      // First get the warehouse name from the warehouse_id
      const [warehouses] = await pool.execute('SELECT name FROM warehouses WHERE id = ?', [userWarehouseId]);
      if (warehouses.length > 0) {
      whereConditions.push('(s.scope_type = ? AND s.scope_id = ?)');
        params.push('WAREHOUSE', warehouses[0].name);
      }
    }
    // Admin can see all transactions (no scope restrictions)

    // Date filtering — use sale_date when set, else fall back to created_at
    if (startDate) {
      whereConditions.push('DATE(COALESCE(s.sale_date, s.created_at)) >= ?');
      params.push(startDate);
    }
    if (endDate) {
      whereConditions.push('DATE(COALESCE(s.sale_date, s.created_at)) <= ?');
      params.push(endDate);
    }

    // Transaction type filtering
    // Map frontend values to database payment_status values
    if (transactionType && transactionType !== 'all') {
      let paymentStatusFilter = transactionType;
      
      // Map frontend display values to database values
      const statusMapping = {
        'Paid': 'COMPLETED',
        'Credit': 'PENDING',
        'Partial': 'PARTIAL',
        'Pending': 'PENDING',
        'Completed': 'COMPLETED'
      };
      
      // Use mapped value if available, otherwise use the original value
      paymentStatusFilter = statusMapping[transactionType] || transactionType;
      
      whereConditions.push('s.payment_status = ?');
      params.push(paymentStatusFilter);
      
    }

    // Payment method filtering
    if (paymentMethod && paymentMethod !== 'all') {
      whereConditions.push('s.payment_method = ?');
      params.push(paymentMethod);
    }

    // Exclude soft-deleted sales from every ledger view
    whereConditions.push('s.deleted_at IS NULL');

    // Snapshot before per-customer filter (used for immutable "all customers" grouping)
    const whereBeforeCustomer = [...whereConditions];
    const paramsBeforeCustomer = [...params];

    // Customer filtering - skip if viewing all customers
    if (!isAllCustomers) {
      const { appendCustomerPartyFilter } = require('../utils/customerLedgerPartyFilter');
      appendCustomerPartyFilter(whereConditions, params, customerId, { sales: 's', entry: 'e' });
    }

    const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

    if (await isLedgerMigrationComplete(pool)) {
      return serveImmutableCustomerLedger(req, res, {
        whereClause,
        params,
        whereScopeOnly:
          whereBeforeCustomer.length > 0 ? `WHERE ${whereBeforeCustomer.join(' AND ')}` : '',
        paramsScopeOnly: paramsBeforeCustomer,
        customerId,
        isAllCustomers,
        limitN: parsedLimit,
      });
    }

    // Build WHERE conditions for returns (with scope filtering)
    // Returns are now stored as sale records, so use s_return alias
    let returnsWhereConditions = [];
    let returnsParams = [];

    // Apply scope filtering for returns (same as sales)
    if (req.user.role === 'CASHIER' && userBranchId) {
      const [branches] = await pool.execute('SELECT name FROM branches WHERE id = ?', [userBranchId]);
      if (branches.length > 0) {
        returnsWhereConditions.push('(s_return.scope_type = ? AND s_return.scope_id = ?)');
        returnsParams.push('BRANCH', branches[0].name);
      }
    } else if (req.user.role === 'WAREHOUSE_KEEPER' && userWarehouseId) {
      const [warehouses] = await pool.execute('SELECT name FROM warehouses WHERE id = ?', [userWarehouseId]);
      if (warehouses.length > 0) {
        returnsWhereConditions.push('(s_return.scope_type = ? AND s_return.scope_id = ?)');
        returnsParams.push('WAREHOUSE', warehouses[0].name);
      }
    }

    if (!isAllCustomers) {
      const { appendCustomerPartyFilter } = require('../utils/customerLedgerPartyFilter');
      appendCustomerPartyFilter(returnsWhereConditions, returnsParams, customerId, {
        sales: 's_return',
      });
    }

    // Date filtering for returns (use s_return.created_at)
    if (startDate) {
      returnsWhereConditions.push('DATE(s_return.created_at) >= ?');
      returnsParams.push(startDate);
    }
    if (endDate) {
      returnsWhereConditions.push('DATE(s_return.created_at) <= ?');
      returnsParams.push(endDate);
    }

    returnsWhereConditions.push('s_return.deleted_at IS NULL');

    const returnsWhereClause = returnsWhereConditions.length > 0 ? `AND ${returnsWhereConditions.join(' AND ')}` : '';

    
    // Debug: Check if returns exist for this customer (with case-insensitive matching)
    if (!isAllCustomers) {
      const [debugReturns] = await pool.execute(`
        SELECT 
          s.id,
          s.invoice_no,
          s.payment_method,
          s.payment_type,
          s.customer_name,
          s.customer_phone,
          s.created_at,
          sr.id as return_id,
          sr.return_no,
          s.old_balance,
          s.running_balance
        FROM sales s
        LEFT JOIN sales_returns sr ON sr.original_sale_id = s.id OR sr.return_no = s.invoice_no
        WHERE s.payment_method = 'REFUND' 
          AND s.payment_type = 'REFUND'
          AND s.deleted_at IS NULL
          AND (LOWER(TRIM(s.customer_name)) = LOWER(TRIM(?)) OR s.customer_phone = ? OR LOWER(TRIM(JSON_EXTRACT(s.customer_info, "$.name"))) = LOWER(TRIM(?)) OR JSON_EXTRACT(s.customer_info, "$.phone") = ?)
        ORDER BY s.created_at DESC
        LIMIT 10
      `, [customerId, customerId, customerId, customerId]);
      if (debugReturns.length > 0) {
      } else {
        // Also check all returns to see if any exist
        const [allReturns] = await pool.execute(`
          SELECT 
            s.id,
            s.invoice_no,
            s.customer_name,
            s.customer_phone,
            sr.return_no
          FROM sales s
          LEFT JOIN sales_returns sr ON sr.original_sale_id = s.id OR sr.return_no = s.invoice_no
          WHERE s.payment_method = 'REFUND' AND s.payment_type = 'REFUND'
          AND s.deleted_at IS NULL
          ORDER BY s.created_at DESC
          LIMIT 5
        `);
      }
    }

    // Full transaction set (no LIMIT) for summary stats — same filters as paginated list
    const [allForBalance] = await pool.execute(`
      SELECT 
        s.id as transaction_id,
        s.invoice_no,
        s.sale_date AS sale_date,
        COALESCE(s.sale_date, s.created_at) as transaction_date,
        s.created_at as created_at,
        ${LEDGER_SORT_AT_S} as sort_at,
        s.payment_method, s.payment_type, s.payment_amount,
        s.credit_amount, s.subtotal, s.total,
        s.old_balance, s.running_balance,
        CASE 
          WHEN s.payment_type = 'OUTSTANDING_SETTLEMENT' THEN 'SETTLEMENT'
          WHEN s.payment_type = 'BILTY_CHARGE' THEN 'BILTY'
          WHEN s.payment_method = 'REFUND' AND s.payment_type = 'REFUND' THEN 'RETURN'
          ELSE 'SALE'
        END as transaction_type,
        s.payment_amount as paid_amount,
        s.subtotal as amount,
        sr.id as return_id
      FROM sales s
      LEFT JOIN sales_returns sr ON sr.original_sale_id = s.id OR sr.return_no = s.invoice_no
      ${whereClause}
      ORDER BY ${LEDGER_SORT_AT_S} ASC, s.id ASC
    `, params);

    const normalizedForSummary = normalizeLedgerTransactions(allForBalance);
    const summaryStats = computeLedgerSummary(normalizedForSummary);

    // Main query to get all customer transactions (sales + returns)
    // Returns are now stored as sale records with payment_method = 'REFUND'
    const [transactions] = await pool.execute(`
      SELECT 
        s.id as transaction_id,
        s.invoice_no,
        s.scope_type,
        s.scope_id,
        s.sale_date AS sale_date,
        COALESCE(s.sale_date, s.created_at) as transaction_date,
        s.created_at as created_at,
        ${LEDGER_SORT_AT_S} as sort_at,
        s.payment_method,
        s.payment_type,
        s.payment_status,
        s.payment_amount,
        s.credit_amount,
        s.old_balance, 
        s.running_balance,
        s.subtotal,
        s.total,
        s.customer_name,
        s.customer_phone,
        s.customer_info,
        s.notes,
        s.status,
        u.username as cashier_name,
        b.name as branch_name,
        w.name as warehouse_name,
        CASE 
          WHEN s.payment_type = 'OUTSTANDING_SETTLEMENT' THEN 'SETTLEMENT'
          WHEN s.payment_type = 'BILTY_CHARGE' THEN 'BILTY'
          WHEN s.payment_method = 'REFUND' AND s.payment_type = 'REFUND' THEN 'RETURN'
          ELSE 'SALE'
        END as transaction_type,
        -- Use actual payment_amount and credit_amount from database
        s.payment_amount as paid_amount,
        s.credit_amount as credit_amount,
        -- Amount is the current bill subtotal only
        s.subtotal as amount,
        sr.id as return_id,
        sr.reason as return_reason,
        CASE 
          WHEN s.payment_method = 'REFUND' THEN ABS(s.total)
          ELSE NULL
        END as return_refund_amount
      FROM sales s
      LEFT JOIN sales_returns sr ON sr.original_sale_id = s.id OR sr.return_no = s.invoice_no
      LEFT JOIN users u ON s.user_id = u.id
      LEFT JOIN branches b ON s.scope_type = 'BRANCH' AND s.scope_id = b.name
      LEFT JOIN warehouses w ON s.scope_type = 'WAREHOUSE' AND s.scope_id = w.name
      ${whereClause}

      ORDER BY ${LEDGER_SORT_AT_S} DESC, s.id DESC
      LIMIT ? OFFSET ?
    `, [...params, parseInt(limit), parseInt(offset)]);

    const returnTransactions = transactions.filter(t => t.transaction_type === 'RETURN' || (t.payment_method === 'REFUND' && t.payment_type === 'REFUND'));
    if (returnTransactions.length > 0) {
    }

    // Get total count for pagination (sales + returns)
    // Returns are now included in the main sales query, so just count sales
    const [countResult] = await pool.execute(`
      SELECT COUNT(*) as total FROM sales s
      LEFT JOIN sales_returns sr ON sr.original_sale_id = s.id OR sr.return_no = s.invoice_no
      ${whereClause}
    `, params);

    // Chronological order uses posting time (created_at) only; sale_date is display/reporting only
    const sortedTransactions = [...transactions].sort(compareLedgerAsc);
    
    
    const normalizedAsc = normalizeLedgerTransactions(sortedTransactions).map(transaction => ({
      ...transaction,
      transaction_type_display: getTransactionTypeDisplay(transaction),
      payment_status_display: getPaymentStatusDisplay(transaction.payment_status)
    }));

    // Newest first by actual instant (seconds), not invoice number
    const finalTransactions = [...normalizedAsc].sort(compareLedgerDesc);

    // If detailed is requested, fetch items for each transaction
    let detailedTransactions = finalTransactions;
    if (detailed === 'true' || detailed === true) {
      detailedTransactions = await attachImmutableLedgerItems(finalTransactions);
    }

    // Get customer summary
    const customerSummary = await getCustomerSummary(customerId, req.user);

    const totalCredit = normalizedAsc.reduce((sum, t) => {
      if (t.transaction_type === 'SALE') {
        return sum + parseFloat(t.credit_amount || 0);
      }
      return sum;
    }, 0);

    // ✅ FIX: Group transactions by customer when viewing all customers
    let responseData = {
      customer: customerSummary,
      transactions: detailedTransactions,
      pagination: {
        total: countResult[0].total,
        limit: parseInt(limit),
        offset: parseInt(offset),
        hasMore: (parseInt(offset) + transactions.length) < countResult[0].total
      },
      summary: {
        totalTransactions: summaryStats.totalTransactions,
        totalAmount: summaryStats.totalAmount, // Sum of Amount column only (sales - returns)
        totalPaid: summaryStats.totalPaid, // Sum of positive payments
        totalRefunded: summaryStats.totalRefunded,
        netPaid: summaryStats.netPaid,
        totalCredit: totalCredit, // Sum of Credit amounts
        outstandingBalance: summaryStats.outstandingBalance // Final running balance from last transaction
      }
    };

    // If viewing all customers, group transactions by customer
if (isAllCustomers) {
  // Step 1: Get all distinct customers (paginated at customer level)
  const [distinctCustomers] = await pool.execute(`
    SELECT 
      s.customer_name,
      s.customer_phone,
      MIN(${LEDGER_SORT_AT_S}) as first_transaction_date
    FROM sales s
    ${whereConditions.length > 0 ? 'WHERE ' + whereConditions.join(' AND ') : ''}
    GROUP BY s.customer_name, s.customer_phone
    ORDER BY first_transaction_date ASC, s.customer_name ASC, s.customer_phone ASC
    LIMIT ? OFFSET ?
  `, [...params, parseInt(limit), parseInt(offset)]);

  // Step 2: Count total distinct customers for pagination
  const [customerCount] = await pool.execute(`
    SELECT COUNT(DISTINCT CONCAT(IFNULL(s.customer_name,''), '|', IFNULL(s.customer_phone,''))) as total
    FROM sales s
    ${whereConditions.length > 0 ? 'WHERE ' + whereConditions.join(' AND ') : ''}
  `, params);

  // Step 3: For each customer, fetch ALL their transactions with items
  const groupedLedgers = await Promise.all(
    distinctCustomers.map(async (customer) => {
      // Build customer-specific conditions
      const custParams = [...params];
      const custConditions = [...whereConditions];
      
      custConditions.push('(s.customer_name = ? AND s.customer_phone = ?)');
      custParams.push(customer.customer_name, customer.customer_phone);
      
      const custWhere = custConditions.length > 0 
        ? 'WHERE ' + custConditions.join(' AND ') 
        : '';

      // Fetch all transactions for this customer
      const [custTransactions] = await pool.execute(`
        SELECT 
          s.id as transaction_id,
          s.invoice_no,
          s.scope_type,
          s.scope_id,
          s.sale_date AS sale_date,
          COALESCE(s.sale_date, s.created_at) as transaction_date,
          s.created_at as created_at,
          ${LEDGER_SORT_AT_S} as sort_at,
          s.payment_method,
          s.payment_type,
          s.payment_status,
          s.payment_amount,
          s.credit_amount,
          s.old_balance,
          s.running_balance,
          s.subtotal,
          s.total,
          s.customer_name,
          s.customer_phone,
          s.customer_info,
          s.notes,
          s.status,
          u.username as cashier_name,
          CASE 
            WHEN s.payment_type = 'OUTSTANDING_SETTLEMENT' THEN 'SETTLEMENT'
            WHEN s.payment_type = 'BILTY_CHARGE' THEN 'BILTY'
            WHEN s.payment_method = 'REFUND' AND s.payment_type = 'REFUND' THEN 'RETURN'
            ELSE 'SALE'
          END as transaction_type,
          s.payment_amount as paid_amount,
          s.credit_amount as credit_amount,
          s.subtotal as amount,
          sr.id as return_id,
          sr.reason as return_reason,
          CASE 
            WHEN s.payment_method = 'REFUND' THEN ABS(s.total)
            ELSE NULL
          END as return_refund_amount
        FROM sales s
        LEFT JOIN sales_returns sr ON sr.original_sale_id = s.id OR sr.return_no = s.invoice_no
        LEFT JOIN users u ON s.user_id = u.id
        ${custWhere}
        ORDER BY ${LEDGER_SORT_AT_S} ASC, s.id ASC
      `, custParams);

      // Fetch items for each transaction
      const transactionsWithItems = await Promise.all(
        custTransactions.map(async (transaction) => {
          let items = [];
          try {
            if (transaction.transaction_type === 'RETURN' || transaction.return_id) {
              const [returnItems] = await pool.execute(`
                SELECT sri.*, ii.name as item_name, ii.sku, ii.selling_price as catalog_price, ii.cost_price, ii.category
                FROM sales_return_items sri
                LEFT JOIN inventory_items ii ON sri.inventory_item_id = ii.id
                WHERE sri.return_id = ?
                ORDER BY sri.id
              `, [transaction.return_id || transaction.transaction_id]);
              
              items = returnItems.map(item => ({
                ...item,
                item_name: item.item_name || 'Unknown Item',
                name: item.item_name || 'Unknown Item',
                quantity: parseFloat(item.quantity) || 0,
                unit_price: parseFloat(item.unit_price) || 0,
                total: parseFloat(item.refund_amount) || 0,
              }));
            } else {
              const [saleItems] = await pool.execute(`
                SELECT si.*, ii.name as item_name, ii.sku, ii.selling_price as catalog_price, ii.cost_price, ii.category
                FROM sale_items si
                LEFT JOIN inventory_items ii ON si.inventory_item_id = ii.id
                WHERE si.sale_id = ?
                ORDER BY si.id
              `, [transaction.transaction_id]);
              items = saleItems;
            }
          } catch (e) {
          }
          return { ...transaction, items };
        })
      );

      // Normalize and compute summary
      const normalized = normalizeLedgerTransactions(transactionsWithItems).map(t => ({
        ...t,
        transaction_type_display: getTransactionTypeDisplay(t),
        payment_status_display: getPaymentStatusDisplay(t.payment_status)
      }));

      const groupSummary = computeLedgerSummary(normalized);
      const groupTotalCredit = normalized.reduce((sum, t) => {
        if (t.transaction_type === 'SALE') return sum + parseFloat(t.credit_amount || 0);
        return sum;
      }, 0);

      return {
        customer: {
          name: customer.customer_name || 'Unknown Customer',
          phone: customer.customer_phone || '',
          key: buildCustomerKey(customer.customer_name, customer.customer_phone)
        },
        transactions: normalized,
        summary: {
          totalTransactions: groupSummary.totalTransactions,
          totalAmount: groupSummary.totalAmount,
          totalPaid: groupSummary.totalPaid,
          totalRefunded: groupSummary.totalRefunded,
          netPaid: groupSummary.netPaid,
          totalCredit: groupTotalCredit,
          outstandingBalance: groupSummary.outstandingBalance,
          completedTransactions: groupSummary.completedTransactions
        }
      };
    })
  );

  // Replace the old groupedLedgers assignment
  responseData.groupedLedgers = groupedLedgers;
  responseData.customer = {
    ...customerSummary,
    unique_customers: customerCount[0].total
  };
  responseData.pagination = {
    total: customerCount[0].total,  // now paginating by CUSTOMER count
    limit: parseInt(limit),
    offset: parseInt(offset),
    hasMore: (parseInt(offset) + distinctCustomers.length) < customerCount[0].total
  };
}
    // Add debug info to response (only in development or if explicitly requested)
    const includeDebug = req.query.debug === 'true' || process.env.NODE_ENV === 'development';
    const responseWithDebug = {
      ...responseData,
      ...(includeDebug ? {
        debug: {
          customerId,
          totalTransactions: transactions.length,
          returnTransactionsCount: returnTransactions.length,
          returnTransactions: returnTransactions.map(t => ({
            invoice: t.invoice_no,
            return_id: t.return_id,
            customer_name: t.customer_name,
            customer_phone: t.customer_phone,
            old_balance: t.old_balance,
            running_balance: t.running_balance
          })),
          whereClause,
          paramsCount: params.length
        }
      } : {})
    };

    res.json({
      success: true,
      data: responseWithDebug
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error retrieving customer ledger',
      error: error.message
    });
  }
};
// @desc    Get all customers with their transaction summaries (FIXED VERSION)
// @route   GET /api/customer-ledger/customers
// @access  Private (Admin, Cashier, Warehouse Keeper)
const getAllCustomersWithSummaries = async (req, res) => {
  try {
    const { 
      search, 
      customerType,
      hasBalance,
      limit = 50,
      offset = 0,
      scopeType: queryScopeType,
      scopeId: queryScopeId,
    } = req.query;

    const { resolveActingScope } = require('../utils/resolveActingScope');
    const actingScope = await resolveActingScope(req, {
      scopeType: queryScopeType,
      scopeId: queryScopeId,
    });

    // Build base conditions
    let baseWhereConditions = [];
    let baseParams = [];

    // Scope filtering — cashiers/warehouse keepers are locked; admin uses query scope on POS
    if (actingScope.scopeType && actingScope.scopeName) {
      baseWhereConditions.push('s.scope_type = ? AND s.scope_id = ?');
      baseParams.push(actingScope.scopeType, actingScope.scopeName);
    } else if (req.user.role !== 'ADMIN') {
      return res.json({
        success: true,
        data: {
          customers: [],
          pagination: {
            total: 0,
            limit: parseInt(limit),
            offset: parseInt(offset),
            hasMore: false,
          },
        },
      });
    }

    // Search filtering
    if (search) {
      baseWhereConditions.push('(s.customer_name LIKE ? OR s.customer_phone LIKE ?)');
      const searchTerm = `%${search}%`;
      baseParams.push(searchTerm, searchTerm);
    }

    baseWhereConditions.push('s.deleted_at IS NULL');

    const baseWhereClause = baseWhereConditions.length > 0 ? `WHERE ${baseWhereConditions.join(' AND ')}` : '';

    const migrationDone = await isLedgerMigrationComplete(pool);
    const currentBalanceSql = migrationDone
      ? `(
          SELECT COALESCE(SUM(e.debit - e.credit), 0)
          FROM customer_ledger_entries e
          WHERE e.scope_type = s.scope_type
            AND e.scope_id = s.scope_id
            AND LOWER(TRIM(IFNULL(e.customer_name,''))) = LOWER(TRIM(IFNULL(s.customer_name,'')))
            AND TRIM(IFNULL(e.customer_phone,'')) <=> TRIM(IFNULL(s.customer_phone,''))
        )`
      : `(
          SELECT s2.running_balance
          FROM sales s2
          WHERE s2.customer_name = s.customer_name
            AND s2.customer_phone = s.customer_phone
            AND s2.deleted_at IS NULL
            ORDER BY ${LEDGER_SORT_AT_S2} DESC, s2.id DESC
          LIMIT 1
        )`;

    // SIMPLIFIED QUERY - Remove the complex subquery that's causing the issue
    const query = `
      SELECT 
        s.customer_name,
        s.customer_phone,
        COUNT(*) as total_transactions,
        -- Sum of actual payment amounts (excluding FULLY_CREDIT, but including negative for returns)
        -- Note: This is recalculated later using computeLedgerSummary, so this is just for initial grouping
        SUM(CASE 
          WHEN s.payment_method = 'FULLY_CREDIT' THEN 0 
          WHEN s.payment_method = 'REFUND' THEN 0  -- Returns will be handled in computeLedgerSummary
          ELSE GREATEST(s.payment_amount, 0) 
        END) as total_paid,
        -- Sum of subtotal amounts (actual bill amounts, includes negative for returns)
        SUM(s.subtotal) as total_amount,
        ${currentBalanceSql} as current_balance,
        MAX(${LEDGER_SORT_AT_S}) as last_transaction_date,
        MIN(${LEDGER_SORT_AT_S}) as first_transaction_date
      FROM sales s
      ${baseWhereClause}
      GROUP BY s.customer_name, s.customer_phone
      HAVING total_transactions > 0
      ORDER BY last_transaction_date DESC
      LIMIT ? OFFSET ?
    `;

    const [customers] = await pool.execute(query, [...baseParams, parseInt(limit), parseInt(offset)]);

    // Count query
    const countQuery = `
      SELECT COUNT(DISTINCT CONCAT(customer_name, '|', customer_phone)) as total
      FROM sales s
      ${baseWhereClause}
    `;
    
    const [countResult] = await pool.execute(countQuery, baseParams);

    if (customers.length === 0) {
      return res.json({
        success: true,
        data: {
          customers: [],
          pagination: {
            total: countResult[0].total,
            limit: parseInt(limit),
            offset: parseInt(offset),
            hasMore: false
          }
        }
      });
    }

    const customerKeys = customers.map(customer =>
      buildCustomerKey(customer.customer_name, customer.customer_phone)
    );

    const keyPlaceholders = customerKeys.map(() => '?').join(', ');

    let transactionsByCustomer = new Map();

    if (customerKeys.length > 0) {
      const baseConditionString = baseWhereConditions.join(' AND ');
      const scopedSalesCondition = baseWhereConditions.length > 0
        ? `${baseConditionString} AND CONCAT(IFNULL(s.customer_name,''),'|',IFNULL(s.customer_phone,'')) IN (${keyPlaceholders})`
        : `CONCAT(IFNULL(s.customer_name,''),'|',IFNULL(s.customer_phone,'')) IN (${keyPlaceholders})`;

      const transactionsParams = [...baseParams, ...customerKeys];

      if (migrationDone) {
        const immWhere = `WHERE ${scopedSalesCondition}`;
        const immRows = await ImmRead.queryLedgerTransactions(
          pool,
          immWhere,
          transactionsParams,
          { orderDesc: false }
        );
        transactionsByCustomer = immRows.reduce((map, row) => {
          const key = buildCustomerKey(row.customer_name, row.customer_phone);
          if (!map.has(key)) map.set(key, []);
          map.get(key).push(row);
          return map;
        }, new Map());
      } else {
      // For returns, we query from sales s_return, so use s_return alias
      const returnsScopeCondition = baseWhereConditions.length > 0
        ? `${baseConditionString.replace(/s\./g, 's_return.')} AND CONCAT(IFNULL(s_return.customer_name,''),'|',IFNULL(s_return.customer_phone,'')) IN (${keyPlaceholders})`
        : `CONCAT(IFNULL(s_return.customer_name,''),'|',IFNULL(s_return.customer_phone,'')) IN (${keyPlaceholders})`;

      // ✅ FIXED: Returns are already stored in sales table, so we don't need UNION ALL
      // Just query sales table and exclude returns from the first part, or include them once
      // Since returns are in sales table with payment_method='REFUND', we can query them directly
      const transactionsQuery = `
        SELECT
          CASE 
            WHEN s.payment_method = 'REFUND' AND s.payment_type = 'REFUND' THEN 'RETURN'
            ELSE 'SALE'
          END as source,
          s.id as transaction_id,
          s.invoice_no,
          s.sale_date AS sale_date,
          s.subtotal as amount,
          s.total as total,
          s.payment_amount,
          s.credit_amount,
          s.payment_method,
          s.payment_type,
          s.payment_status,
          s.running_balance,
          COALESCE(s.sale_date, s.created_at) as transaction_date,
          s.created_at as created_at,
          ${LEDGER_SORT_AT_S} as sort_at,
          s.customer_name,
          s.customer_phone,
          CONCAT(IFNULL(s.customer_name,''),'|',IFNULL(s.customer_phone,'')) as customer_key
        FROM sales s
        WHERE ${scopedSalesCondition}

        ORDER BY sort_at ASC, transaction_id ASC
      `;

      const [transactionRows] = await pool.execute(transactionsQuery, transactionsParams);

      // ✅ FIXED: Remove duplicate transactions (returns can appear multiple times due to JOIN)
      // Use a Set to track unique transaction IDs per customer
      const seenTransactions = new Map(); // Map<customer_key, Set<transaction_id>>
      
      transactionsByCustomer = transactionRows.reduce((map, row) => {
        const key = row.customer_key;
        if (!map.has(key)) {
          map.set(key, []);
          seenTransactions.set(key, new Set());
        }

        // Check if we've already seen this transaction for this customer
        const transactionId = `${row.transaction_id}_${row.invoice_no}`;
        const seenSet = seenTransactions.get(key);
        
        if (seenSet.has(transactionId)) {
          // Skip duplicate transaction
          return map;
        }
        
        seenSet.add(transactionId);

        const isReturn = row.source === 'RETURN' || row.payment_method === 'REFUND' || row.payment_type === 'REFUND';
        
        map.get(key).push({
          ...row,
          transaction_type: isReturn ? 'RETURN' : 'SALE',
          subtotal: row.amount,
          total: row.total ?? row.amount,
          amount: row.amount,
          paid_amount: row.payment_amount,
          payment_amount: row.payment_amount, // Ensure both fields are present
          payment_method: isReturn ? 'REFUND' : (row.payment_method || 'CASH'),
          payment_type: isReturn ? 'REFUND' : (row.payment_type || 'FULL_PAYMENT')
        });
        return map;
      }, new Map());
      }
    }

    // Process customers with normalized ledger data (includes returns and settlements)
    const customersWithBalance = customers.map(customer => {
      const key = buildCustomerKey(customer.customer_name, customer.customer_phone);
      const customerTransactions = transactionsByCustomer.get(key) || [];

      const normalizedTransactions = migrationDone
        ? customerTransactions
        : normalizeLedgerTransactions(customerTransactions);
      const summaryStats = computeLedgerSummary(normalizedTransactions);

      const totalCredit = normalizedTransactions.reduce((sum, transaction) => {
        if (transaction.transaction_type === 'SALE') {
          const creditValue = parseFloat(transaction.credit_amount || 0);
          return sum + (Number.isFinite(creditValue) ? creditValue : 0);
        }
        return sum;
      }, 0);

      const lastTransactionDate = normalizedTransactions.length > 0
        ? normalizedTransactions[normalizedTransactions.length - 1].transaction_date || normalizedTransactions[normalizedTransactions.length - 1].created_at
        : customer.last_transaction_date;

      const firstTransactionDate = normalizedTransactions.length > 0
        ? normalizedTransactions[0].transaction_date || normalizedTransactions[0].created_at
        : customer.first_transaction_date;

      // Debug logging for summary calculation
      if (customer.customer_name === 'rab nawaz' || customer.customer_name === 'Latif') {
        const returnTransactions = normalizedTransactions.filter(t => t.transaction_type === 'RETURN');
        const saleTransactions = normalizedTransactions.filter(t => t.transaction_type === 'SALE');
        const numeric = (value) => {
          const num = parseFloat(value);
          return Number.isFinite(num) ? num : 0;
        };
        
      }

      // Add debug info for specific customers (can be removed later)
      const debugInfo = (customer.customer_name === 'rab nawaz' || customer.customer_name === 'Latif') ? {
        _debug: {
          transactionCount: normalizedTransactions.length,
          returnCount: normalizedTransactions.filter(t => t.transaction_type === 'RETURN').length,
          saleCount: normalizedTransactions.filter(t => t.transaction_type === 'SALE').length,
          transactionAmounts: normalizedTransactions.map(t => ({
            invoice: t.invoice_no,
            type: t.transaction_type,
            amount: t.amount,
            subtotal: t.subtotal
          }))
        }
      } : {};

      const ledgerCurrentBalance = migrationDone
        ? (normalizedTransactions.length > 0
            ? summaryStats.outstandingBalance
            : (parseFloat(customer.current_balance) || 0))
        : summaryStats.outstandingBalance;

      return {
        customer_id: customer.customer_name,
        customer_name: customer.customer_name,
        customer_phone: customer.customer_phone,
        total_transactions: summaryStats.totalTransactions || customer.total_transactions,
        total_amount: summaryStats.totalAmount,
        total_paid: summaryStats.totalPaid,
        net_paid: summaryStats.netPaid,
        total_refunded: summaryStats.totalRefunded,
        total_credit: totalCredit,
        current_balance: ledgerCurrentBalance,
        last_transaction_date: lastTransactionDate,
        first_transaction_date: firstTransactionDate,
        has_outstanding_balance: Math.abs(ledgerCurrentBalance) > 0.01,
        ...debugInfo
      };
    });

    // Filter by balance if requested
    let filteredCustomers = customersWithBalance;
    if (hasBalance === 'true') {
      filteredCustomers = customersWithBalance.filter(c => Math.abs(c.current_balance) > 0.01);
    } else if (hasBalance === 'false') {
      filteredCustomers = customersWithBalance.filter(c => Math.abs(c.current_balance) <= 0.01);
    }

    res.json({
      success: true,
      data: {
        customers: filteredCustomers,
        pagination: {
          total: countResult[0].total,
          limit: parseInt(limit),
          offset: parseInt(offset),
          hasMore: (parseInt(offset) + customers.length) < countResult[0].total
        }
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error retrieving customers',
      error: error.message
    });
  }
};

// @desc    Export customer ledger to PDF
// @route   GET /api/customer-ledger/:customerId/export
// @access  Private (Admin, Cashier, Warehouse Keeper)
// @desc    Export customer ledger to PDF
// @route   GET /api/customer-ledger/:customerId/export
// @access  Private (Admin, Cashier, Warehouse Keeper)
const exportCustomerLedger = async (req, res) => {
  try {
    const { customerId } = req.params;
    const { startDate, endDate, format = 'pdf', detailed = 'false' } = req.query;

    // Get customer ledger data (same as getCustomerLedger but without pagination)
    const ledgerData = await getCustomerLedgerData(customerId, req.user, { startDate, endDate, limit: 1000 });
    const processedLedgerAsc = (
      ledgerRowsAlreadyNormalized(ledgerData)
        ? ledgerData
        : normalizeLedgerTransactions(ledgerData)
    ).map((transaction) => ({
      ...transaction,
      transaction_type_display: transaction.transaction_type_display || getTransactionTypeDisplay(transaction),
      payment_status_display: transaction.payment_status_display || getPaymentStatusDisplay(transaction.payment_status)
    }));
const processedLedgerDesc = [...processedLedgerAsc].sort(compareLedgerDesc);

    // If detailed export is requested, fetch items for each transaction
    if (detailed === 'true') {
      
      // Use the FIXED function for detailed data
      const detailedLedgerData = await getDetailedCustomerLedgerData(customerId, req.user, { startDate, endDate, limit: 1000 });
      
      
      const normalizedTransactions = ledgerRowsAlreadyNormalized(detailedLedgerData)
        ? detailedLedgerData
        : normalizeLedgerTransactions(detailedLedgerData);
      
      // Add display fields
      const processedWithDisplay = normalizedTransactions.map((transaction) => ({
        ...transaction,
        transaction_type_display: getTransactionTypeDisplay(transaction),
        payment_status_display: getPaymentStatusDisplay(transaction.payment_status)
      }));
      
      // Sort back to descending order for display
      const processedDetailedDesc = [...processedWithDisplay].sort(compareLedgerDesc);

      if (format === 'pdf') {
        // Generate HTML content for detailed PDF
        const htmlContent = generateDetailedCustomerLedgerPDF(processedWithDisplay);
        
        res.setHeader('Content-Type', 'text/html');
        res.setHeader('Content-Disposition', `inline; filename="detailed-customer-ledger-${customerId}-${new Date().toISOString().split('T')[0]}.html"`);
        res.send(htmlContent);
      } else {
        // Return detailed JSON data for other formats
        res.json({
          success: true,
          data: {
            customer: await getCustomerSummary(customerId, req.user),
            transactions: processedDetailedDesc,
            pagination: {
              total: processedDetailedDesc.length,
              limit: 1000,
              offset: 0
            }
          }
        });
      }
    } else {
      // Original export functionality for non-detailed exports
      if (format === 'pdf') {
        // Generate HTML content for PDF (frontend will handle PDF generation)
        const htmlContent = generateCustomerLedgerPDF(processedLedgerAsc);
        
        res.setHeader('Content-Type', 'text/html');
        res.setHeader('Content-Disposition', `inline; filename="customer-ledger-${customerId}-${new Date().toISOString().split('T')[0]}.html"`);
        res.send(htmlContent);
      } else {
        // Return JSON data for other formats
        res.json({
          success: true,
          data: processedLedgerDesc
        });
      }
    }
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error exporting customer ledger',
      error: error.message
    });
  }
};

// Helper function to get customer summary
const getCustomerSummary = async (customerId, user) => {
  try {
    // Try to find customer in customers table first
    const [customers] = await pool.execute(
      'SELECT * FROM customers WHERE name = ? OR phone = ?',
      [customerId, customerId]
    );

    if (customers.length > 0) {
      return customers[0];
    }

    // If not found, get summary from sales data (with scope filtering)
    let summaryWhereConditions = ['(s.customer_name = ? OR s.customer_phone = ? OR JSON_EXTRACT(s.customer_info, "$.name") = ? OR JSON_EXTRACT(s.customer_info, "$.phone") = ?)'];
    let summaryParams = [customerId, customerId, customerId, customerId];

    // Apply scope filtering if user is not admin
    const userBranchId = user.branch_id || user.branchId;
    const userWarehouseId = user.warehouse_id || user.warehouseId;
    
    if (user.role === 'CASHIER' && userBranchId) {
      const [branches] = await pool.execute('SELECT name FROM branches WHERE id = ?', [userBranchId]);
      if (branches.length > 0) {
        summaryWhereConditions.push('(s.scope_type = ? AND s.scope_id = ?)');
        summaryParams.push('BRANCH', branches[0].name);
      }
    } else if (user.role === 'WAREHOUSE_KEEPER' && userWarehouseId) {
      const [warehouses] = await pool.execute('SELECT name FROM warehouses WHERE id = ?', [userWarehouseId]);
      if (warehouses.length > 0) {
        summaryWhereConditions.push('(s.scope_type = ? AND s.scope_id = ?)');
        summaryParams.push('WAREHOUSE', warehouses[0].name);
      }
    }

    summaryWhereConditions.push('s.deleted_at IS NULL');

    const summaryWhereClause = `WHERE ${summaryWhereConditions.join(' AND ')}`;

    if (await isLedgerMigrationComplete(pool)) {
      const [balRows] = await pool.execute(
        `
        SELECT COALESCE(SUM(e.debit - e.credit), 0) AS current_balance
        FROM customer_ledger_entries e
        INNER JOIN sales s ON s.id = e.ref_id AND s.deleted_at IS NULL
        ${summaryWhereClause}
      `,
        summaryParams
      );
      const [agg] = await pool.execute(
        `
        SELECT 
          COALESCE(s.customer_name, JSON_EXTRACT(s.customer_info, "$.name")) AS name,
          COALESCE(s.customer_phone, JSON_EXTRACT(s.customer_info, "$.phone")) AS phone,
          COUNT(*) AS total_transactions,
          SUM(s.total) AS total_sales,
          MAX(s.created_at) AS last_transaction
        FROM sales s
        ${summaryWhereClause}
        GROUP BY name, phone
        LIMIT 1
      `,
        summaryParams
      );
      const row = agg[0] || {
        name: customerId,
        phone: '',
        total_transactions: 0,
        total_sales: 0,
        last_transaction: null,
      };
      return {
        ...row,
        current_balance: parseFloat(balRows[0]?.current_balance) || 0,
      };
    }

    const [sales] = await pool.execute(`
      SELECT 
        COALESCE(s.customer_name, JSON_EXTRACT(s.customer_info, "$.name")) as name,
        COALESCE(s.customer_phone, JSON_EXTRACT(s.customer_info, "$.phone")) as phone,
        COUNT(*) as total_transactions,
        SUM(s.total) as total_sales,
        SUM(s.credit_amount) as current_balance, -- Fallback: sum of credit_amount
        MAX(s.created_at) as last_transaction
      FROM sales s
      ${summaryWhereClause}
      GROUP BY name, phone
      LIMIT 1
    `, summaryParams);

    // Attempt to find the latest running_balance from sales for this customer - this provides
    // a more accurate 'outstanding' / current balance than simple aggregates.
    try {
      const [latestRows] = await pool.execute(`
        SELECT s.running_balance
        FROM sales s
        ${summaryWhereClause}
        ORDER BY ${LEDGER_SORT_AT_S} DESC, s.id DESC
        LIMIT 1
      `, summaryParams);

      const latestRunningBalance = latestRows && latestRows.length > 0 ? latestRows[0].running_balance : null;

      if (latestRunningBalance !== null && latestRunningBalance !== undefined) {
        // If we have an aggregated sales summary row, override its current_balance with the latest running balance
        if (sales && sales[0]) {
          sales[0].current_balance = latestRunningBalance;
        }

        // Return with running balance if no aggregate row was found
        if (!sales || sales.length === 0) {
          return { name: customerId, phone: '', total_transactions: 0, current_balance: latestRunningBalance };
        }
      }
    } catch (rbError) {
    }

    return sales[0] || { name: customerId, phone: '', total_transactions: 0, current_balance: 0 };
  } catch (error) {
    return { name: customerId, phone: '', total_transactions: 0, current_balance: 0 };
  }
};

// Helper function to get customer ledger data
const getCustomerLedgerData = async (customerId, user, options = {}) => {
  const { startDate, endDate, limit = 1000 } = options;
  
  // Build WHERE conditions (same logic as getCustomerLedger)
  let whereConditions = [];
  let params = [];

  // Handle both branch_id and branchId for backward compatibility
  const userBranchId = user.branch_id || user.branchId;
  const userWarehouseId = user.warehouse_id || user.warehouseId;
  
  if (user.role === 'CASHIER' && userBranchId) {
    // For cashiers, we need to match by branch name since sales store scope_id as string
    const [branches] = await pool.execute('SELECT name FROM branches WHERE id = ?', [userBranchId]);
    if (branches.length > 0) {
    whereConditions.push('(s.scope_type = ? AND s.scope_id = ?)');
      params.push('BRANCH', branches[0].name);
    }
  } else if (user.role === 'WAREHOUSE_KEEPER' && userWarehouseId) {
    // For warehouse keepers, we need to match by warehouse name since sales store scope_id as string
    const [warehouses] = await pool.execute('SELECT name FROM warehouses WHERE id = ?', [userWarehouseId]);
    if (warehouses.length > 0) {
    whereConditions.push('(s.scope_type = ? AND s.scope_id = ?)');
      params.push('WAREHOUSE', warehouses[0].name);
    }
  }

  whereConditions.push('(s.customer_name = ? OR s.customer_phone = ? OR JSON_EXTRACT(s.customer_info, "$.name") = ? OR JSON_EXTRACT(s.customer_info, "$.phone") = ?)');
  params.push(customerId, customerId, customerId, customerId);

  whereConditions.push('s.deleted_at IS NULL');

  if (startDate) {
    whereConditions.push('DATE(COALESCE(s.sale_date, s.created_at)) >= ?');
    params.push(startDate);
  }
  if (endDate) {
    whereConditions.push('DATE(COALESCE(s.sale_date, s.created_at)) <= ?');
    params.push(endDate);
  }

  const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

  if (await isLedgerMigrationComplete(pool)) {
    return ImmRead.queryLedgerTransactions(pool, whereClause, params, {
      limit: parseInt(limit, 10) || 1000,
      offset: 0,
      orderDesc: false,
    });
  }

const [transactions] = await pool.execute(`
    SELECT
      s.id as transaction_id,
      s.invoice_no,
      s.scope_type,
      s.scope_id,
      COALESCE(s.sale_date, s.created_at) as transaction_date,
      s.created_at as created_at,
      ${LEDGER_SORT_AT_S} as sort_at,
      s.payment_method,
      s.payment_status,
      s.payment_type,
      s.payment_amount,
      s.credit_amount,
      s.old_balance,
      s.running_balance,
      s.subtotal,
      s.total,
      s.customer_name,
      s.customer_phone,
      s.customer_info,
      s.notes,
      s.status,
      u.username as cashier_name,
      b.name as branch_name,
      w.name as warehouse_name,
      CASE
        WHEN s.payment_type = 'OUTSTANDING_SETTLEMENT' THEN 'SETTLEMENT'
        WHEN s.payment_type = 'BILTY_CHARGE' THEN 'BILTY'
        WHEN s.payment_method = 'REFUND' AND s.payment_type = 'REFUND' THEN 'RETURN'
        ELSE 'SALE'
      END as transaction_type,
      s.payment_amount as paid_amount,
      s.subtotal as amount,
      sr.id as return_id,
      sr.reason as return_reason
    FROM sales s
    LEFT JOIN sales_returns sr ON sr.original_sale_id = s.id OR sr.return_no = s.invoice_no
    LEFT JOIN users u ON s.user_id = u.id
    LEFT JOIN branches b ON s.scope_type = 'BRANCH' AND s.scope_id = b.name
    LEFT JOIN warehouses w ON s.scope_type = 'WAREHOUSE' AND s.scope_id = w.name
    ${whereClause}
    ORDER BY ${LEDGER_SORT_AT_S} ASC, s.id ASC
    LIMIT ?
  `, [...params, limit]);
  // Map payment_amount to paid_amount for PDF generation compatibility
  return transactions.map(t => ({
    ...t,
    paid_amount: t.payment_amount,
    amount: t.subtotal // Add amount field for consistency
  }));
};

// Helper function to get detailed customer ledger data with items
// Helper function to get detailed customer ledger data with items (FIXED VERSION)
// Helper function to get detailed customer ledger data with items (FIXED VERSION)
// Helper function to get detailed customer ledger data with items (FIXED VERSION)
const getDetailedCustomerLedgerData = async (customerId, user, options = {}) => {
  const { startDate, endDate, limit = 1000 } = options;
  
  // Build WHERE conditions (same logic as getCustomerLedger)
  let whereConditions = [];
  let params = [];

  // Handle both branch_id and branchId for backward compatibility
  const userBranchId = user.branch_id || user.branchId;
  const userWarehouseId = user.warehouse_id || user.warehouseId;
  
  if (user.role === 'CASHIER' && userBranchId) {
    const [branches] = await pool.execute('SELECT name FROM branches WHERE id = ?', [userBranchId]);
    if (branches.length > 0) {
      whereConditions.push('(s.scope_type = ? AND s.scope_id = ?)');
      params.push('BRANCH', branches[0].name);
    }
  } else if (user.role === 'WAREHOUSE_KEEPER' && userWarehouseId) {
    const [warehouses] = await pool.execute('SELECT name FROM warehouses WHERE id = ?', [userWarehouseId]);
    if (warehouses.length > 0) {
      whereConditions.push('(s.scope_type = ? AND s.scope_id = ?)');
      params.push('WAREHOUSE', warehouses[0].name);
    }
  }

  whereConditions.push('(s.customer_name = ? OR s.customer_phone = ? OR JSON_EXTRACT(s.customer_info, "$.name") = ? OR JSON_EXTRACT(s.customer_info, "$.phone") = ?)');
  params.push(customerId, customerId, customerId, customerId);

  whereConditions.push('s.deleted_at IS NULL');

  if (startDate) {
    whereConditions.push('DATE(COALESCE(s.sale_date, s.created_at)) >= ?');
    params.push(startDate);
  }
  if (endDate) {
    whereConditions.push('DATE(COALESCE(s.sale_date, s.created_at)) <= ?');
    params.push(endDate);
  }

  const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

  if (await isLedgerMigrationComplete(pool)) {
    const transactions = await ImmRead.queryLedgerTransactions(
      pool,
      whereClause,
      params,
      { limit: parseInt(limit, 10) || 1000, offset: 0, orderDesc: false }
    );
    transactions.sort(compareLedgerAsc);
    return attachImmutableLedgerItems(transactions);
  }

  // ✅ FIXED: USE EXACT SAME QUERY AS getCustomerLedger (including the LEFT JOIN sales_returns)
  const [transactions] = await pool.execute(`
    SELECT
      s.id as transaction_id,
      s.invoice_no,
      s.scope_type,
      s.scope_id,
      s.sale_date AS sale_date,
      COALESCE(s.sale_date, s.created_at) as transaction_date,
      s.created_at as created_at,
      ${LEDGER_SORT_AT_S} as sort_at,
      s.payment_method,
      s.payment_type,
      s.payment_status,
      s.payment_amount,
      s.credit_amount,
      s.old_balance, 
      s.running_balance,
      s.subtotal,
      s.total,
      s.customer_name,
      s.customer_phone,
      s.customer_info,
      s.notes,
      s.status,
      u.username as cashier_name,
      b.name as branch_name,
      w.name as warehouse_name,
      CASE 
        WHEN s.payment_type = 'OUTSTANDING_SETTLEMENT' THEN 'SETTLEMENT'
        WHEN s.payment_type = 'BILTY_CHARGE' THEN 'BILTY'
        WHEN s.payment_method = 'REFUND' AND s.payment_type = 'REFUND' THEN 'RETURN'
        ELSE 'SALE'
      END as transaction_type,
      -- Use actual payment_amount and credit_amount from database
      s.payment_amount as paid_amount,
      s.credit_amount as credit_amount,
      -- Amount is the current bill subtotal only
      s.subtotal as amount,
      sr.id as return_id,
      sr.reason as return_reason,
      CASE 
        WHEN s.payment_method = 'REFUND' THEN ABS(s.total)
        ELSE NULL
      END as return_refund_amount
    FROM sales s
    LEFT JOIN sales_returns sr ON sr.original_sale_id = s.id OR sr.return_no = s.invoice_no  -- ✅ CRITICAL: This was missing!
    LEFT JOIN users u ON s.user_id = u.id
    LEFT JOIN branches b ON s.scope_type = 'BRANCH' AND s.scope_id = b.name
    LEFT JOIN warehouses w ON s.scope_type = 'WAREHOUSE' AND s.scope_id = w.name
    ${whereClause}
    ORDER BY ${LEDGER_SORT_AT_S} ASC, s.id ASC
    LIMIT ?
  `, [...params, limit]);

  transactions.sort(compareLedgerAsc);

  // For each transaction, get the detailed items
  const detailedTransactions = await Promise.all(
    transactions.map(async (transaction) => {
      try {
        
        let items = [];
        
        // Check if this is a return transaction - use the CORRECT condition
        if (transaction.transaction_type === 'BILTY') {
          const [biltyItems] = await pool.execute(
            `SELECT * FROM bilty_items WHERE sale_id = ? ORDER BY id ASC`,
            [transaction.transaction_id]
          );
          items = biltyItems.map(item => ({
            id: item.id,
            sale_id: item.sale_id,
            item_name: item.description,
            name: item.description,
            sku: item.vehicle_number || '—',
            quantity: parseFloat(item.quantity) || 1,
            unit_price: parseFloat(item.amount) || 0,
            discount: 0,
            total: parseFloat(item.total) || 0,
            vehicle_number: item.vehicle_number || null,
            category: 'Transport'
          }));
        } else if (transaction.transaction_type === 'RETURN' || transaction.return_id) {
          // For returns, fetch from sales_return_items
          
          const [returnItems] = await pool.execute(`
            SELECT 
              sri.*,
              ii.name as item_name,
              ii.sku,
              ii.selling_price as catalog_price,
              ii.cost_price,
              ii.category
            FROM sales_return_items sri
            LEFT JOIN inventory_items ii ON sri.inventory_item_id = ii.id
            WHERE sri.return_id = ? OR sri.sale_id = ?
            ORDER BY sri.created_at ASC, sri.id ASC  -- ✅ Order items chronologically
          `, [transaction.return_id || transaction.transaction_id, transaction.transaction_id]);
          
          // Transform return items to match sale_items format
          items = returnItems.map(item => ({
            id: item.id,
            sale_id: transaction.transaction_id,
            inventory_item_id: item.inventory_item_id,
            item_name: item.item_name || item.name || 'Unknown Item',
            name: item.item_name || item.name || 'Unknown Item',
            sku: item.sku || 'N/A',
            quantity: parseFloat(item.quantity) || 0,
            unit_price: parseFloat(item.unit_price) || 0,
            original_price: parseFloat(item.unit_price) || 0,
            discount: 0,
            total: parseFloat(item.refund_amount) || 0,
            refund_amount: parseFloat(item.refund_amount) || 0,
            catalog_price: parseFloat(item.catalog_price) || 0,
            cost_price: parseFloat(item.cost_price) || 0,
            category: item.category || null,
            created_at: item.created_at || transaction.transaction_date  // Preserve item creation time
          }));
          
        } else {
          // Fetch sale items from sale_items
          
          const [saleItems] = await pool.execute(`
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
            ORDER BY si.created_at ASC, si.id ASC  -- ✅ Order items chronologically
          `, [transaction.transaction_id]);
          
          items = saleItems.map(item => ({
            ...item,
            created_at: item.created_at || transaction.transaction_date  // Preserve item creation time
          }));
        }

        // Sort items within each transaction by creation date (oldest first)
        items.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
        
        // Return transaction with items - DO NOT RECALCULATE BALANCES HERE
        // The normalizeLedgerTransactions function will handle balance calculations
        return {
          ...transaction,
          items: items || []
        };
      } catch (error) {
        return {
          ...transaction,
          items: []
        };
      }
    })
  );

  detailedTransactions.sort(compareLedgerAsc);
  // ✅ CRITICAL: DO NOT RECALCULATE BALANCES HERE!
  // Just return the transactions with items, let normalizeLedgerTransactions handle the balances
  // This ensures consistency with getCustomerLedger
  
  // Optional: Log the date range for verification
  if (detailedTransactions.length > 0) {
  }
  
  return detailedTransactions;
};/**
 * Normalize ledger transactions: recalculate running balances sequentially.
 * Seeds the chain from the first row's DB old_balance, then walks forward
 * (does not trust potentially stale running_balance values).
 */
/**
 * Legacy sequential balance walk for sales-based reads (pre–ledger-migration safety mode).
 * Do not use for production reads when ledger_migration_completed = 1.
 */
const normalizeLedgerTransactions = (transactions = []) => {
  if (!Array.isArray(transactions) || transactions.length === 0) {
    return [];
  }

  const sortedTransactions = [...transactions].sort(compareLedgerAsc);

  const normalized = [];
  let previousBalance = null;

  for (let i = 0; i < sortedTransactions.length; i++) {
    const transaction = sortedTransactions[i];

    // Seed previousBalance from DB old_balance on the very first row only
    if (previousBalance === null) {
      const dbOld = parseFloat(transaction.old_balance ?? transaction.oldBalance ?? 0);
      previousBalance = Number.isFinite(dbOld) ? dbOld : 0;
    }

    const paymentMethod = transaction.payment_method;
    const paymentType = transaction.payment_type || transaction.paymentType || null;
    const rawTransactionType = (transaction.transaction_type || transaction.transactionType || '').toUpperCase();

    // Extract payment amount
    const paid = parseFloat(
      transaction.corrected_paid ??
      transaction.paid_amount ??
      transaction.payment_amount ??
      0
    ) || 0;

    // Extract amount (bill amount for this transaction)
    const amount = parseFloat(
      transaction.amount ??
      transaction.subtotal ??
      transaction.total ??
      0
    ) || 0;

    // Determine transaction type (prefer DB payment_type when CASE labels row as generic SALE)
    let normalizedType = rawTransactionType;
    if (paymentType === 'CREDIT_REFUND_SETTLEMENT') {
      normalizedType = 'CREDIT_REFUND_SETTLEMENT';
    } else if (paymentType === 'BILTY_CHARGE') {
      normalizedType = 'BILTY';
    } else if (paymentType === 'OUTSTANDING_SETTLEMENT') {
      normalizedType = 'SETTLEMENT';
    }
    if (!normalizedType) {
      if (paymentMethod === 'REFUND' && paymentType === 'REFUND') {
        normalizedType = 'RETURN';
      } else {
        normalizedType = 'SALE';
      }
    }

    // Calculate old_balance from previous row's running_balance
    const oldBalance = previousBalance ?? 0;

    // Calculate values based on transaction type
    let currentBillAmount = amount;
    let actualPayment = paid;
    let newBalance;

    if (paymentType === 'OUTSTANDING_SETTLEMENT' || normalizedType === 'SETTLEMENT') {
      // Settlement: amount = 0, payment reduces balance
      currentBillAmount = 0;
      if (paymentMethod === 'FULLY_CREDIT') {
        actualPayment = 0;
        }
      newBalance = oldBalance - actualPayment;
    } else if (paymentType === 'BILTY_CHARGE' || normalizedType === 'BILTY') {
      // Align with ledgerRecalcService: balance increases by total (charge amount)
      const biltyTotal =
        parseFloat(transaction.total) ||
        parseFloat(transaction.amount) ||
        parseFloat(transaction.subtotal) ||
        0;
      currentBillAmount = biltyTotal;
      actualPayment = 0;
      newBalance = oldBalance + biltyTotal;
    } else if (paymentType === 'CREDIT_REFUND_SETTLEMENT' || normalizedType === 'CREDIT_REFUND_SETTLEMENT') {
      currentBillAmount = 0;
      newBalance = oldBalance - paid;
    } else if (normalizedType === 'RETURN' || (paymentMethod === 'REFUND' && paymentType === 'REFUND')) {
      // Return: amount is negative, reduces balance
      currentBillAmount = amount; // Already negative
      actualPayment = 0; // Returns typically have no payment
      newBalance = oldBalance + currentBillAmount; // old_balance + (negative return)
    } else {
      // Sale: use net invoice total (matches ledger / AR), not subtotal when discount splits them
      if (normalizedType === 'SALE') {
        const totalNum = parseFloat(transaction.total);
        currentBillAmount =
          Number.isFinite(totalNum) && Math.abs(totalNum) > 1e-9 ? totalNum : amount;
      } else {
        currentBillAmount = amount;
      }
      if (paymentMethod === 'FULLY_CREDIT' && paymentType !== 'OUTSTANDING_SETTLEMENT') {
        actualPayment = 0;
      }
      // ✅ RULE 4: new_balance = old_balance + amount - payment
      newBalance = oldBalance + currentBillAmount - actualPayment;
    }

    // Calculate total_amount for display
    const totalAmountDue = oldBalance + currentBillAmount;

    // Remove any existing calculated fields to avoid conflicts
    const {
      old_balance: _,
      total_amount: __,
      corrected_paid: ___,
      balance: ____,
      ...transactionBase
    } = transaction;

    // Create normalized transaction for new row
    normalized.push({
      ...transactionBase,
      payment_type: paymentType,
      transaction_type: normalizedType,
      old_balance: oldBalance, // Previous row's running_balance
      amount: currentBillAmount, // Bill amount for this transaction
      total_amount: totalAmountDue, // old_balance + amount
      corrected_paid: actualPayment, // Payment amount
      paid_amount: actualPayment, // Alias for compatibility
      running_balance: newBalance, // ✅ Calculated new balance
      balance: newBalance // Alias for compatibility
    });
    
    // Update previousBalance for next iteration
    previousBalance = newBalance;
  }

  return normalized.map(enrichLedgerTransactionRow);
};

const isSettlementLedgerRow = (transaction) => {
  const type = String(transaction.transaction_type || '').toUpperCase();
  const pt = transaction.payment_type || '';
  return (
    type === 'SETTLEMENT' ||
    pt === 'OUTSTANDING_SETTLEMENT' ||
    pt === 'CREDIT_REFUND_SETTLEMENT'
  );
};

/** Invoice/bill amount for summary totals — excludes settlements; falls back to total/subtotal when amount is 0. */
const billAmountForSummary = (transaction) => {
  const numeric = (value) => {
    const num = parseFloat(value);
    return Number.isFinite(num) ? num : 0;
  };
  if (isSettlementLedgerRow(transaction)) return 0;

  const type = String(transaction.transaction_type || '').toUpperCase();
  const amount = numeric(transaction.amount);
  const total = numeric(transaction.total);
  const subtotal = numeric(transaction.subtotal);

  if (
    type === 'RETURN' ||
    (transaction.payment_method === 'REFUND' && transaction.payment_type === 'REFUND')
  ) {
    const mag =
      Math.abs(amount) > 0.01
        ? Math.abs(amount)
        : Math.abs(total) > 0.01
          ? Math.abs(total)
          : Math.abs(subtotal);
    return -mag;
  }

  if (Math.abs(amount) > 0.01) return amount;

  if (type === 'SALE' || type === 'BILTY' || type === 'EXPENSE') {
    return Math.abs(total) > 0.01 ? total : subtotal;
  }
  return amount;
};

const computeLedgerSummary = (transactions = []) => {
  const numeric = (value) => {
    const num = parseFloat(value);
    return Number.isFinite(num) ? num : 0;
  };

  const totalTransactions = transactions.length;
  
  // Sum invoice amounts (sales/returns/bilty) — never settlements; supports fully-paid sales (debit=credit).
  const totalAmount = transactions.reduce(
    (sum, transaction) => sum + billAmountForSummary(transaction),
    0
  );

  let totalPaid = 0;
  let totalRefunded = 0;

  transactions.forEach((transaction) => {
    // For returns, payment_amount is negative (represents refund)
    // For sales, payment_amount is positive (represents payment received)
    const payment = numeric(transaction.corrected_paid ?? transaction.paid_amount ?? transaction.payment_amount);
    const isReturn = transaction.transaction_type === 'RETURN' || 
                     transaction.payment_method === 'REFUND' || 
                     transaction.payment_type === 'REFUND';

    if (isReturn) {
      // Returns have negative payment_amount, add to refunded
      totalRefunded += Math.abs(payment);
    } else if (payment > 0) {
      // Regular payments (positive)
      totalPaid += payment;
    } else if (payment < 0) {
      // Negative payments (shouldn't happen for sales, but handle it)
      totalRefunded += Math.abs(payment);
    }
  });

  // Net paid = total paid - total refunded
  const netPaid = totalPaid - totalRefunded;
  
  // Outstanding balance = balance after the latest transaction by posting time (created_at, id)
  let outstandingBalance = 0;
  if (totalTransactions > 0) {
    const latest = transactions.reduce((best, t) => {
      const tTime = ledgerInstantMs(t);
      const bTime = ledgerInstantMs(best);
      if (tTime > bTime) return t;
      if (tTime < bTime) return best;
      const tid = t.transaction_id || t.id || 0;
      const bid = best.transaction_id || best.id || 0;
      return tid >= bid ? t : best;
    });
    outstandingBalance = numeric(latest.balance ?? latest.running_balance);
  }

  const completedTransactions = transactions.filter((transaction) => {
    const balance = numeric(transaction.balance ?? transaction.running_balance);
    return balance <= 0;
  }).length;

  const pendingTransactions = transactions.filter((transaction) => {
    const balance = numeric(transaction.balance ?? transaction.running_balance);
    const payment = numeric(transaction.corrected_paid ?? transaction.paid_amount ?? transaction.payment_amount);
    if (balance <= 0) {
      return false;
    }
    if (transaction.payment_method === 'FULLY_CREDIT') {
      return true;
    }
    return payment === 0;
  }).length;

  const partialTransactions = transactions.filter((transaction) => {
    const balance = numeric(transaction.balance ?? transaction.running_balance);
    const payment = numeric(transaction.corrected_paid ?? transaction.paid_amount ?? transaction.payment_amount);
    return balance > 0 && payment > 0 && transaction.payment_method !== 'FULLY_CREDIT';
  }).length;

  return {
    totalTransactions,
    totalAmount,
    totalPaid,
    totalRefunded,
    netPaid,
    outstandingBalance,
    completedTransactions,
    pendingTransactions,
    partialTransactions
  };
};

// Helper function to generate PDF content
const generateCustomerLedgerPDF = (ledgerData = []) => {
  const transactionsWithBalance = (
    ledgerRowsAlreadyNormalized(ledgerData)
      ? ledgerData
      : normalizeLedgerTransactions(ledgerData)
  ).map((transaction) => ({
    ...transaction,
    transaction_type_display: transaction.transaction_type_display || getTransactionTypeDisplay(transaction),
    payment_status_display: transaction.payment_status_display || getPaymentStatusDisplay(transaction.payment_status)
  }));

  const summary = computeLedgerSummary(transactionsWithBalance);

  const customerName = transactionsWithBalance[0]?.customer_name || ledgerData[0]?.customer_name || 'Unknown Customer';

  const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <title>Customer Ledger Report</title>
        <style>
          body { 
            font-family: Arial, sans-serif; 
            margin: 20px; 
            font-size: 12px;
          }
          .header { 
            text-align: center; 
            margin-bottom: 30px; 
            border-bottom: 2px solid #333; 
            padding-bottom: 20px; 
          }
          .summary { 
            background: #f5f5f5; 
            padding: 15px; 
            margin-bottom: 20px; 
            border-radius: 5px;
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
            gap: 10px;
          }
          .summary-item {
            display: flex;
            justify-content: space-between;
            padding: 5px 0;
          }
          table { 
            width: 100%; 
            border-collapse: collapse; 
            margin-top: 20px; 
            font-size: 11px;
          }
          th, td { 
            border: 1px solid #ddd; 
            padding: 6px; 
            text-align: left; 
          }
          th { 
            background-color: #f2f2f2; 
            font-weight: bold;
          }
          .total-row { 
            font-weight: bold; 
            background-color: #e6f3ff; 
          }
          .status-completed { color: #28a745; }
          .status-pending { color: #ffc107; }
          .status-partial { color: #fd7e14; }
          .amount { text-align: right; }
          @media print {
            body { margin: 0; }
            .header { page-break-after: avoid; }
            table { page-break-inside: auto; }
            tr { page-break-inside: avoid; }
          }
        </style>
      </head>
      <body>
        <div class="header">
          <h1>Customer Ledger Report</h1>
          <p>Generated on: ${new Date().toLocaleDateString()}</p>
          <p>Customer: ${customerName}</p>
        </div>
        
        <div class="summary">
          <div class="summary-item">
            <span>Total Transactions:</span>
            <span>${summary.totalTransactions}</span>
          </div>
          <div class="summary-item">
            <span>Total Amount:</span>
            <span>${summary.totalAmount.toFixed(2)}</span>
          </div>
          <div class="summary-item">
            <span>Completed:</span>
            <span>${summary.completedTransactions}</span>
          </div>
          <div class="summary-item">
            <span>Pending:</span>
            <span>${summary.pendingTransactions}</span>
          </div>
          <div class="summary-item">
            <span>Partial:</span>
            <span>${summary.partialTransactions}</span>
          </div>
          <div class="summary-item">
            <span>Outstanding:</span>
            <span>${summary.outstandingBalance.toFixed(2)}</span>
          </div>
        </div>
        
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Invoice #</th>
              <th>Amount</th>
              <th>Old Balance</th>
              <th>Total Amount</th>
              <th>Payment</th>
              <th>Payment Method</th>
              <th>Status</th>
              <th>Balance</th>
            </tr>
          </thead>
          <tbody>
            ${transactionsWithBalance.map(transaction => `
              <tr>
                <td>${new Date(transaction.transaction_date || transaction.created_at).toLocaleDateString()}</td>
                <td>${transaction.invoice_no || 'N/A'}</td>
                <td class="amount">${parseFloat(transaction.amount || 0).toFixed(2)}</td>
                <td class="amount">${(transaction.old_balance || 0).toFixed(2)}</td>
                <td class="amount">${(transaction.total_amount || 0).toFixed(2)}</td>
                <td class="amount">${(transaction.corrected_paid || 0).toFixed(2)}</td>
                <td>${transaction.payment_method || 'N/A'}</td>
                <td class="status-${transaction.payment_method === 'FULLY_CREDIT' ? 'pending' : ((transaction.balance || 0) <= 0 ? 'completed' : 'partial')}">
                  ${transaction.payment_method === 'FULLY_CREDIT' ? 'Credit' : ((transaction.balance || 0) <= 0 ? 'Paid' : 'Partial')}
                </td>
                <td class="amount">${(transaction.balance || 0).toFixed(2)}</td>
              </tr>
            `).join('')}
            <tr class="total-row">
              <td colspan="3"><strong>Totals</strong></td>
              <td class="amount"><strong>-</strong></td>
              <td class="amount"><strong>${summary.totalAmount.toFixed(2)}</strong></td>
              <td class="amount"><strong>${summary.totalPaid.toFixed(2)}</strong></td>
              <td><strong>-</strong></td>
              <td><strong>-</strong></td>
              <td class="amount"><strong>${summary.outstandingBalance.toFixed(2)}</strong></td>
            </tr>
          </tbody>
        </table>
      </body>
    </html>
  `;
  
  return html;
};

// Helper function to generate detailed PDF content with items
const generateDetailedCustomerLedgerPDF = (detailedLedgerData = []) => {
  const transactionsWithBalance = (
    ledgerRowsAlreadyNormalized(detailedLedgerData)
      ? detailedLedgerData
      : normalizeLedgerTransactions(detailedLedgerData)
  ).map((transaction) => ({
    ...transaction,
    transaction_type_display: transaction.transaction_type_display || getTransactionTypeDisplay(transaction),
    payment_status_display: transaction.payment_status_display || getPaymentStatusDisplay(transaction.payment_status)
  }));

  const summary = computeLedgerSummary(transactionsWithBalance);
  const totalItems = transactionsWithBalance.reduce((sum, transaction) => sum + (transaction.items?.length || 0), 0);
  const customerName = transactionsWithBalance[0]?.customer_name || detailedLedgerData[0]?.customer_name || 'Unknown Customer';

  const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <title>Detailed Customer Ledger Report</title>
        <style>
          body { 
            font-family: Arial, sans-serif; 
            margin: 15px; 
            font-size: 10px;
          }
          .header { 
            text-align: center; 
            margin-bottom: 20px; 
            border-bottom: 2px solid #333; 
            padding-bottom: 15px; 
          }
          .summary { 
            background: #f5f5f5; 
            padding: 10px; 
            margin-bottom: 15px; 
            border-radius: 3px;
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
            gap: 8px;
            font-size: 9px;
          }
          .summary-item {
            display: flex;
            justify-content: space-between;
            padding: 2px 0;
          }
          .main-table {
            width: 100%;
            border-collapse: collapse;
            font-size: 9px;
          }
          .main-table th {
            background-color: #f2f2f2;
            font-weight: bold;
            padding: 6px 4px;
            border: 1px solid #ddd;
            text-align: left;
            font-size: 8px;
          }
          .main-table td {
            padding: 4px;
            border: 1px solid #ddd;
            vertical-align: top;
          }
          .transaction-row {
            background-color: #f8f9fa;
            border-bottom: 2px solid #dee2e6;
          }
          .item-row {
            background-color: #ffffff;
            font-size: 8px;
            border-bottom: 1px solid #e9ecef;
          }
          .items-cell {
            padding: 6px 8px;
            font-size: 7px;
            line-height: 1.3;
            vertical-align: top;
            min-width: 200px;
            max-width: 300px;
            word-wrap: break-word;
          }
          .item-line {
            margin-bottom: 3px;
            padding: 2px 0;
            border-bottom: 1px solid #f0f0f0;
          }
          .item-line:last-child {
            margin-bottom: 0;
            border-bottom: none;
          }
          .amount { 
            text-align: right; 
          }
          .status-completed { 
            color: green; 
            font-weight: bold; 
          }
          .status-pending { 
            color: red; 
            font-weight: bold; 
          }
          .status-partial { 
            color: orange; 
            font-weight: bold; 
          }
          .type-chip {
            display: inline-block;
            padding: 2px 6px;
            border-radius: 10px;
            font-size: 7px;
            font-weight: bold;
            color: white;
          }
          .type-walkin { background-color: #e91e63; }
          .type-retailer { background-color: #2196f3; }
          .status-chip {
            display: inline-block;
            padding: 2px 6px;
            border-radius: 10px;
            font-size: 7px;
            font-weight: bold;
            color: white;
          }
          .status-paid { background-color: #4caf50; }
          .status-credit { background-color: #f44336; }
          .status-partial { background-color: #ff9800; }
          .no-items {
            padding: 8px;
            text-align: center;
            color: #666;
            font-style: italic;
            font-size: 8px;
          }
          @media print {
            body { margin: 0; }
            .header { page-break-after: avoid; }
            .main-table { page-break-inside: auto; }
          }
        </style>
      </head>
      <body>
        <div class="header">
          <h1>Detailed Customer Ledger Report</h1>
          <p>Generated on: ${new Date().toLocaleDateString()}</p>
          <p>Customer: ${customerName}</p>
        </div>
        
        <div class="summary">
          <div class="summary-item">
            <span>Total Transactions:</span>
            <span>${summary.totalTransactions}</span>
          </div>
          <div class="summary-item">
            <span>Total Amount:</span>
            <span>${summary.totalAmount.toFixed(2)}</span>
          </div>
          <div class="summary-item">
            <span>Outstanding:</span>
            <span>${formatCurrency(summary.outstandingBalance)}</span>
          </div>
          <div class="summary-item">
            <span>Completed:</span>
            <span class="status-completed">${summary.completedTransactions}</span>
          </div>
          <div class="summary-item">
            <span>Pending:</span>
            <span class="status-pending">${summary.pendingTransactions}</span>
          </div>
          <div class="summary-item">
            <span>Partial:</span>
            <span class="status-partial">${summary.partialTransactions}</span>
          </div>
          <div class="summary-item">
            <span>Total Items:</span>
            <span>${totalItems}</span>
          </div>
        </div>
        
        <table class="main-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Invoice</th>
              <th>Items</th>
              <th>Amount</th>
              <th>Old Balance</th>
              <th>Total Amount</th>
              <th>Payment</th>
              <th>Payment Method</th>
              <th>Status</th>
              <th>Balance</th>
            </tr>
          </thead>
          <tbody>
            ${transactionsWithBalance.map(transaction => `
              <tr class="transaction-row">
                <td>${formatDate(transaction.transaction_date || transaction.created_at)}</td>
                <td><strong>${transaction.invoice_no || 'N/A'}</strong></td>
                <td class="items-cell">
                  ${transaction.items && transaction.items.length > 0 
                    ? transaction.items.map(item => {
                        const unitPrice = parseFloat(item.unit_price || 0);
                        const quantity = parseFloat(item.quantity || 0);
                        const discount = parseFloat(item.discount || 0);
                        const itemTotal = parseFloat(item.total || 0);
                        
                        // Format: Item Name (Qty x) @ UnitPrice = Total
                        let itemLine = `${item.item_name || item.name || 'N/A'} (${quantity}x) @ ${formatCurrency(unitPrice)}`;
                        
                        // Add discount if applicable
                        if (discount > 0) {
                          itemLine += ` - ${formatCurrency(discount)}`;
                        }
                        
                        itemLine += ` = ${formatCurrency(itemTotal)}`;
                        
                        return `<div class="item-line">${itemLine}</div>`;
                      }).join('')
                    : '<div class="item-line">No items</div>'
                  }
                </td>
                <td class="amount">${formatCurrency(transaction.amount || 0)}</td>
                <td class="amount">${formatCurrency(transaction.old_balance)}</td>
                <td class="amount"><strong>${formatCurrency(transaction.total_amount)}</strong></td>
                <td class="amount">${formatCurrency(transaction.corrected_paid)}</td>
                <td>${transaction.payment_method || 'N/A'}</td>
                <td>
                  <span class="status-chip status-${transaction.payment_method === 'FULLY_CREDIT' ? 'credit' : (transaction.balance < 0 ? 'credit' : (transaction.balance === 0 ? 'paid' : 'partial'))}">
                    ${transaction.payment_method === 'FULLY_CREDIT' ? 'Credit' : (transaction.balance < 0 ? 'Credit' : (transaction.balance === 0 ? 'Paid' : 'Partial'))}
                  </span>
                </td>
                <td class="amount">${formatCurrency(transaction.balance)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </body>
    </html>
  `;
  
  return html;
};

// Helper functions for display
const formatDate = (dateString) => {
  if (!dateString) return 'N/A';
  const date = new Date(dateString);
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = date.getFullYear();
  return `${day}/${month}/${year}`;
};

const formatCurrency = (amount) => {
  const num = parseFloat(amount || 0);
  if (num % 1 === 0) {
    return num.toString(); // No decimal places for whole numbers
  }
  return num.toFixed(2);
};

const getTransactionTypeDisplay = (transaction) => {
  if (transaction.payment_type === 'BILTY_CHARGE' || transaction.transaction_type === 'BILTY') {
    return 'Bilty / Transport';
  }
  if (transaction.payment_type === 'CREDIT_REFUND_SETTLEMENT' || transaction.transaction_type === 'CREDIT_REFUND_SETTLEMENT') {
    return 'Credit refund settlement';
  }
  if (transaction.payment_type === 'OUTSTANDING_SETTLEMENT' || transaction.transaction_type === 'SETTLEMENT') {
    return 'Settlement Payment';
  }
  if (transaction.transaction_type === 'RETURN') {
    return 'Return';
  } else if (transaction.scope_type === 'WAREHOUSE') {
    return 'Retailer Sale';
  } else if (transaction.scope_type === 'BRANCH') {
    return 'Walk-in Sale';
  }
  return 'Sale';
};

const getPaymentStatusDisplay = (status) => {
  const statusMap = {
    'COMPLETED': 'Paid',
    'PARTIAL': 'Partial Payment',
    'PENDING': 'Credit',
    'CANCELLED': 'Cancelled'
  };
  return statusMap[status] || status;
};

// @desc    Update customer info (name + phone) in ledger and linked tables
// @route   PUT /api/customer-ledger/:customerId/update-info
// @access  Private (Admin only)
const updateCustomerLedgerInfo = async (req, res) => {
  try {
    const { customerId } = req.params;
    const { name, phone } = req.body;

    if (!name && !phone) {
      return res.status(400).json({
        success: false,
        message: 'At least one of name or phone must be provided'
      });
    }

    // Build update fields for sales table
    const salesFields = [];
    const salesValues = [];
    if (name) {
      salesFields.push('customer_name = ?');
      salesValues.push(name);
    }
    if (phone) {
      salesFields.push('customer_phone = ?');
      salesValues.push(phone);
    }

    // 1. Find what type this customer is (branch customer or warehouse retailer)
    //    by looking at existing sales records
    const [existingSales] = await pool.execute(
      `SELECT DISTINCT customer_id, retailer_id, scope_type
       FROM sales
       WHERE deleted_at IS NULL
       AND (customer_name = ? OR customer_phone = ?)
       LIMIT 1`,
      [customerId, customerId]
    );

    let updatedCustomerRecord = null;
    let updatedRetailerRecord = null;

    if (existingSales.length > 0) {
      const { customer_id, retailer_id, scope_type } = existingSales[0];

      // 2a. If this is a branch customer, update the customers table
      if (customer_id) {
        const customerUpdateFields = [];
        const customerUpdateValues = [];
        if (name) { customerUpdateFields.push('name = ?'); customerUpdateValues.push(name); }
        if (phone) { customerUpdateFields.push('phone = ?'); customerUpdateValues.push(phone); }
        if (customerUpdateFields.length > 0) {
          customerUpdateValues.push(customer_id);
          await pool.execute(
            `UPDATE customers SET ${customerUpdateFields.join(', ')}, updated_at = NOW() WHERE id = ?`,
            customerUpdateValues
          );
          const [rows] = await pool.execute('SELECT * FROM customers WHERE id = ?', [customer_id]);
          updatedCustomerRecord = rows[0] || null;
        }
      }

      // 2b. If this is a warehouse retailer, update the retailers table
      if (retailer_id) {
        const retailerUpdateFields = [];
        const retailerUpdateValues = [];
        if (name) { retailerUpdateFields.push('name = ?'); retailerUpdateValues.push(name); }
        if (phone) { retailerUpdateFields.push('phone = ?'); retailerUpdateValues.push(phone); }
        if (retailerUpdateFields.length > 0) {
          retailerUpdateValues.push(retailer_id);
          await pool.execute(
            `UPDATE retailers SET ${retailerUpdateFields.join(', ')}, updated_at = NOW() WHERE id = ?`,
            retailerUpdateValues
          );
          const [rows] = await pool.execute('SELECT * FROM retailers WHERE id = ?', [retailer_id]);
          updatedRetailerRecord = rows[0] || null;
        }
      }
    }

    // 3. Always cascade update customer_name / customer_phone in sales
    const whereClause = 'customer_name = ? OR customer_phone = ?';
    salesValues.push(customerId, customerId);
    const [updateResult] = await pool.execute(
      `UPDATE sales SET ${salesFields.join(', ')} WHERE ${whereClause}`,
      salesValues
    );

    res.json({
      success: true,
      message: 'Customer info updated successfully',
      data: {
        salesUpdated: updateResult.affectedRows,
        customerRecord: updatedCustomerRecord,
        retailerRecord: updatedRetailerRecord
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error updating customer info',
      error: error.message
    });
  }
};

/** Attach line items to immutable ledger rows (batch load + fallbacks). */
async function attachImmutableLedgerItems(transactions) {
  return attachLedgerTransactionItems(transactions);
}

async function serveImmutableCustomerLedger(req, res, ctx) {
  const {
    whereClause,
    params,
    whereScopeOnly,
    paramsScopeOnly,
    customerId,
    isAllCustomers,
    limitN: limitFromCtx,
  } = ctx;
  const { parseLedgerLimit } = require('../utils/customerLedgerPartyFilter');
  const {
    limit: limitRaw,
    offset = 0,
    detailed = false,
  } = req.query;

  const limitN =
    limitFromCtx ??
    parseLedgerLimit(limitRaw, isAllCustomers ? 2000 : 1000, 5000);
  const offsetN = parseInt(offset, 10) || 0;
  const detailedB = String(detailed) === 'true' || detailed === true;

  try {
    if (!isAllCustomers) {
      const allAsc = await ImmRead.queryLedgerTransactions(
        pool,
        whereClause,
        params,
        { orderDesc: false }
      );
      const summaryStats = computeLedgerSummary(allAsc);
      const totalCredit = allAsc.reduce((sum, t) => {
        if (t.transaction_type === 'SALE') {
          return sum + parseFloat(t.credit_amount || 0);
        }
        return sum;
      }, 0);

      const pageDesc = await ImmRead.queryLedgerTransactions(
        pool,
        whereClause,
        params,
        { limit: limitN, offset: offsetN, orderDesc: true }
      );
      const count = await ImmRead.countLedgerTransactions(
        pool,
        whereClause,
        params
      );

      let detailedTransactions = pageDesc.map((t) => ({
        ...t,
        transaction_type_display: getTransactionTypeDisplay(t),
        payment_status_display: getPaymentStatusDisplay(t.payment_status),
      }));

      if (detailedB) {
        detailedTransactions = await attachImmutableLedgerItems(
          detailedTransactions
        );
      }

      const customerSummary = await getCustomerSummary(customerId, req.user);

      const responseData = {
        customer: customerSummary,
        transactions: detailedTransactions,
        pagination: {
          total: count,
          limit: limitN,
          offset: offsetN,
          hasMore: offsetN + pageDesc.length < count,
        },
        summary: {
          totalTransactions: summaryStats.totalTransactions,
          totalAmount: summaryStats.totalAmount,
          totalPaid: summaryStats.totalPaid,
          totalRefunded: summaryStats.totalRefunded,
          netPaid: summaryStats.netPaid,
          totalCredit,
          outstandingBalance: summaryStats.outstandingBalance,
        },
      };

      const includeDebug =
        req.query.debug === 'true' || process.env.NODE_ENV === 'development';
      res.json({
        success: true,
        data: {
          ...responseData,
          ...(includeDebug ? { debug: { immutableLedger: true } } : {}),
        },
      });
      return;
    }

    const [distinctCustomers] = await pool.execute(
      `
      SELECT 
        s.customer_name,
        s.customer_phone,
        MIN(COALESCE(e.entry_date, e.created_at)) AS first_transaction_date
      FROM customer_ledger_entries e
      INNER JOIN sales s ON s.id = e.ref_id AND s.deleted_at IS NULL
      ${whereScopeOnly || ''}
      GROUP BY s.customer_name, s.customer_phone
      ORDER BY first_transaction_date ASC, s.customer_name ASC, s.customer_phone ASC
      LIMIT ? OFFSET ?
    `,
      [...paramsScopeOnly, limitN, offsetN]
    );

    const [customerCount] = await pool.execute(
      `
      SELECT COUNT(*) AS total FROM (
        SELECT 1
        FROM customer_ledger_entries e
        INNER JOIN sales s ON s.id = e.ref_id AND s.deleted_at IS NULL
        ${whereScopeOnly || ''}
        GROUP BY s.customer_name, s.customer_phone
      ) t
    `,
      paramsScopeOnly
    );

    const parties = distinctCustomers.map((c) => ({
      name: c.customer_name || '',
      phone: c.customer_phone || '',
    }));
    const partyParams = [];
    const partyOr = ImmRead.buildPartyOrClause(parties, partyParams);
    const batchWhere = whereScopeOnly
      ? `${whereScopeOnly} AND ${partyOr.sql}`
      : `WHERE ${partyOr.sql}`;
    const batchParams = [...paramsScopeOnly, ...partyParams];

    const allAsc = await ImmRead.queryLedgerTransactions(
      pool,
      batchWhere,
      batchParams,
      { orderDesc: false }
    );

    const sourceRows =
      detailedB && allAsc.length > 0
        ? await attachImmutableLedgerItems(allAsc)
        : allAsc;

    const byKeyFilled = new Map();
    for (const row of sourceRows) {
      const key = ImmRead.customerKeyFromRow(row);
      if (!byKeyFilled.has(key)) byKeyFilled.set(key, []);
      byKeyFilled.get(key).push(row);
    }

    const groupedLedgers = distinctCustomers.map((customer) => {
      const key = buildCustomerKey(customer.customer_name, customer.customer_phone);
      const custAsc = byKeyFilled.get(key) || [];
      const normalized = custAsc.map((t) => ({
        ...t,
        transaction_type_display: getTransactionTypeDisplay(t),
        payment_status_display: getPaymentStatusDisplay(t.payment_status),
      }));

      const groupSummary = computeLedgerSummary(custAsc);
      const groupTotalCredit = custAsc.reduce((sum, t) => {
        if (t.transaction_type === 'SALE') {
          return sum + parseFloat(t.credit_amount || 0);
        }
        return sum;
      }, 0);

      return {
        customer: {
          name: customer.customer_name || 'Unknown Customer',
          phone: customer.customer_phone || '',
          key,
        },
        transactions: normalized,
        summary: {
          totalTransactions: groupSummary.totalTransactions,
          totalAmount: groupSummary.totalAmount,
          totalPaid: groupSummary.totalPaid,
          totalRefunded: groupSummary.totalRefunded,
          netPaid: groupSummary.netPaid,
          totalCredit: groupTotalCredit,
          outstandingBalance: groupSummary.outstandingBalance,
          completedTransactions: groupSummary.completedTransactions,
        },
      };
    });

    const customerSummary = await getCustomerSummary(customerId, req.user);

    const responseData = {
      groupedLedgers,
      customer: {
        ...customerSummary,
        unique_customers: customerCount[0].total,
      },
      pagination: {
        total: customerCount[0].total,
        limit: limitN,
        offset: offsetN,
        hasMore: offsetN + distinctCustomers.length < customerCount[0].total,
      },
    };

    res.json({ success: true, data: responseData });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error retrieving customer ledger',
      error: error.message,
    });
  }
}

module.exports = {
  getCustomerLedger,
  getAllCustomersWithSummaries,
  exportCustomerLedger,
  updateCustomerLedgerInfo
};
