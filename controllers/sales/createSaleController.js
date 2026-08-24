
const { validationResult } = require('express-validator');
const Sale = require('../../models/Sale');
const InventoryItem = require('../../models/InventoryItem');
const FinancialVoucher = require('../../models/FinancialVoucher');
const { pool } = require('../../config/database');
const InvoiceNumberService = require('../../services/invoiceNumberService');
const { isLedgerMigrationComplete } = require('../../services/ledgerMigrationMeta');
const {
  getIdempotentResponse,
  setIdempotentResponse,
} = require('../../utils/idempotencyMemoryCache');
const { getCustomerRunningBalance } = require('../../services/sales/customerRunningBalance');
const { applyOutstandingSettlement } = require('../../services/outstandingSettlementService');
const CustomerLedgerEntries = require('../../services/customerLedgerEntriesService');
const { allowsNegativeStock } = require('../../config/inventory');

const createSale = async (req, res, next) => {
  
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation error',
        errors: errors.array()
      });
    }

    const idempotencyKey = req.get('Idempotency-Key') || req.get('idempotency-key');
    const replayBody = getIdempotentResponse(idempotencyKey);
    if (replayBody) {
      res.set('X-Idempotent-Replay', 'true');
      return res.status(200).json(replayBody);
    }

    const { items, scopeType, scopeId, paymentMethod, paymentType, customerInfo, notes, subtotal, tax, discount, total, paymentStatus, status, paymentAmount, creditAmount, creditStatus, outstandingPayments, selectedOutstandingPayments, saleDate } = req.body;

    // Debug: Log the received payment method

    // Validate items
    if (!items || items.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'At least one item is required'
      });
    }

    // Validate inventory items and enrich item data (skip clinic / manual items)
    const { normalizeSaleLineIdentity } = require('../../utils/clinicSaleItem');
    const enrichedItems = [];
    for (const item of items) {
      const identity = normalizeSaleLineIdentity(item);

      if (identity.isClinic || !identity.inventoryItemId) {
        // Clinic service or manual line (no inventory validation / stock)
        const enrichedItem = {
          ...item,
          inventoryItemId: null,
          clinicServiceId: identity.clinicServiceId,
          isService: identity.isClinic,
          sku: identity.sku || item.sku || (identity.clinicServiceId ? `CLINIC-${identity.clinicServiceId}` : `MANUAL-${Date.now()}`),
          name: item.name || item.itemName,
          unitPrice: item.unitPrice || 0,
          originalPrice: item.originalPrice != null ? item.originalPrice : item.unitPrice || 0,
        };
        enrichedItems.push(enrichedItem);
        continue;
      }
      
      // Validate inventory items
      const inventoryItem = await InventoryItem.findById(identity.inventoryItemId);
      if (!inventoryItem) {
        return res.status(400).json({
          success: false,
          message: `Inventory item with ID ${identity.inventoryItemId} not found`
        });
      }
      
      // Enrich item with inventory data
      const enrichedItem = {
        ...item,
        inventoryItemId: identity.inventoryItemId,
        clinicServiceId: null,
        isService: false,
        sku: item.sku || inventoryItem.sku || `SKU-${identity.inventoryItemId}`,
        name: item.name || inventoryItem.name,
        unitPrice: item.unitPrice || inventoryItem.sellingPrice || 0
      };
      
      // Ensure SKU is never null
      if (!enrichedItem.sku) {
        enrichedItem.sku = `SKU-${identity.inventoryItemId}`;
      }
      
      
      enrichedItems.push(enrichedItem);
    }

    // Use provided totals or calculate them from items
    let finalSubtotal = parseFloat(subtotal) || 0;
    let finalTax = parseFloat(tax) || 0;
    let finalDiscount = parseFloat(discount) || 0;
    let finalTotal = parseFloat(total) || 0;
    
    // IMPORTANT: Store the bill amount (items total) separately from the net total (which includes credit)
    const billAmount = finalSubtotal + finalTax - finalDiscount; // The actual bill amount

    // Always validate stock for every inventory item regardless of whether totals were provided.
    for (const item of enrichedItems) {
      if (!item.inventoryItemId) continue; // manual items skip stock check
      const inventoryItem = await InventoryItem.findById(item.inventoryItemId);
      if (!inventoryItem) {
        return res.status(400).json({ success: false, message: `Inventory item ${item.inventoryItemId} not found` });
      }
      if (!allowsNegativeStock() && inventoryItem.currentStock < item.quantity) {
        return res.status(400).json({
          success: false,
          message: `Insufficient stock for ${inventoryItem.name}. Available: ${inventoryItem.currentStock}`
        });
      }
    }

    // If totals are not provided, calculate them from enriched items
    if (subtotal === undefined || subtotal === null || subtotal === '' || tax === undefined || tax === null || tax === '' || total === undefined || total === null || total === '') {
      let calculatedSubtotal = 0;
      let calculatedDiscount = 0;

      for (const item of enrichedItems) {
        const itemTotal = (item.unitPrice * item.quantity) - (item.discount || 0);
        calculatedSubtotal += itemTotal;
        calculatedDiscount += item.discount || 0;
      }

      // No tax applied server-side — POS sends pre-calculated tax; 0 avoids hardcoded 10% mismatch.
      const calculatedTax = parseFloat(tax) || 0;
      const calculatedTotal = calculatedSubtotal + calculatedTax - calculatedDiscount;

      finalSubtotal = calculatedSubtotal;
      finalTax = calculatedTax;
      finalDiscount = calculatedDiscount;
      finalTotal = calculatedTotal;
    }

    // Generate invoice number using branch/warehouse code
    let invoiceNo;
    try {
      // Convert scopeId to number for InvoiceNumberService if it's a string
      const numericScopeId = typeof scopeId === 'string' ? parseInt(scopeId) : scopeId;
      
      // Debug: Check if branch exists and has code
      if (scopeType === 'BRANCH') {
        const [branches] = await pool.execute('SELECT id, name, code FROM branches WHERE id = ?', [numericScopeId]);
        if (branches.length === 0) {
          throw new Error(`Branch not found with ID: ${numericScopeId}`);
        }
        const branch = branches[0];
      }
      
      invoiceNo = await InvoiceNumberService.generateInvoiceNumber(scopeType, numericScopeId);
    } catch (invoiceError) {
      // Fallback to old method if new method fails
      invoiceNo = `INV-${Date.now()}-${Math.random().toString(36).substr(2, 5).toUpperCase()}`;
    }

    // Extract customer name and phone from customerInfo
    // trim values to avoid accidental spaces
    let customerName = customerInfo?.name ? customerInfo.name.trim() : '';
    let customerPhone = customerInfo?.phone ? customerInfo.phone.trim() : '';

    // If the POS terminal puts the phone number into the name field and phone field
    // is blank, treat that value as the phone. Many terminals allow typing the phone
    // directly into the "name" input so we detect numeric-only strings and move
    // them to the phone variable.
    if (!customerPhone && customerName && /^\d+$/.test(customerName)) {
      customerPhone = customerName;
      // clear the name so that the customer record uses a generic name
      // (Walk-in Customer) instead of a numeric string
      customerName = '';
    }

    // Get branch/warehouse name for scope_id
    let scopeName = '';
    if (scopeType === 'BRANCH' && scopeId) {
      const numericScopeId = typeof scopeId === 'string' ? parseInt(scopeId) : scopeId;
      const [branches] = await pool.execute('SELECT name FROM branches WHERE id = ?', [numericScopeId]);
      scopeName = branches[0]?.name || scopeId;
    } else if (scopeType === 'WAREHOUSE' && scopeId) {
      const numericScopeId = typeof scopeId === 'string' ? parseInt(scopeId) : scopeId;
      const [warehouses] = await pool.execute('SELECT name FROM warehouses WHERE id = ?', [numericScopeId]);
      scopeName = warehouses[0]?.name || scopeId;
    } else {
      scopeName = scopeId || '';
    }
    
    // ========== PAYMENT + OUTSTANDING (warehouse-parity) ==========
    // POS sends total = bill + selected outstanding. Same rules as warehouseSalesController
    // + WarehouseSale.create:
    //   1) validate payment+credit against totalWithOutstanding
    //   2) apply cash to outstanding first (settleAmount = min(outstanding, cash))
    //   3) remaining cash/credit apply to this invoice (must equal billAmount for GL)
    const outstandingPortion = Math.max(0, parseFloat((finalTotal - billAmount).toFixed(2)));
    let settlementCreated = false;
    let settlementAmount = 0;
    let settlementId = null;

    const parseNumber = (value, fallback = 0) => {
      if (value === undefined || value === null || value === '') return fallback;
      const parsed = parseFloat(value);
      return Number.isNaN(parsed) ? fallback : parsed;
    };

    let normalizedPaymentMethod = (paymentMethod || 'CASH').toUpperCase();
    let paymentTypeValue = paymentType || null;

    const providedPaymentAmount = (paymentAmount !== undefined && paymentAmount !== null && paymentAmount !== '')
      ? parseNumber(paymentAmount, 0)
      : null;
    const providedCreditAmount = (creditAmount !== undefined && creditAmount !== null && creditAmount !== '')
      ? parseNumber(creditAmount, 0)
      : null;

    const isBalancePayment = paymentTypeValue === 'BALANCE_PAYMENT';
    const isFullyCredit = normalizedPaymentMethod === 'FULLY_CREDIT' || paymentTypeValue === 'FULLY_CREDIT';
    // Warehouse: validate against cart+outstanding (except balance payment uses bill only)
    const totalForValidation = isBalancePayment ? billAmount : finalTotal;

    let combinedPaymentAmount = providedPaymentAmount;
    let combinedCreditAmount = providedCreditAmount;

    if (isFullyCredit) {
      combinedPaymentAmount = 0;
      combinedCreditAmount = totalForValidation;
    } else if (isBalancePayment) {
      combinedPaymentAmount = 0;
      combinedCreditAmount = billAmount;
    } else if (combinedPaymentAmount === null && combinedCreditAmount === null) {
      combinedPaymentAmount = totalForValidation;
      combinedCreditAmount = 0;
    } else if (combinedPaymentAmount === null) {
      combinedPaymentAmount = totalForValidation - combinedCreditAmount;
    } else if (combinedCreditAmount === null) {
      combinedCreditAmount = totalForValidation - combinedPaymentAmount;
    }

    combinedPaymentAmount = parseFloat((combinedPaymentAmount ?? 0).toFixed(2));
    combinedCreditAmount = parseFloat((combinedCreditAmount ?? 0).toFixed(2));

    if (!paymentTypeValue) {
      if (isBalancePayment) paymentTypeValue = 'BALANCE_PAYMENT';
      else if (isFullyCredit) paymentTypeValue = 'FULLY_CREDIT';
      else if (combinedCreditAmount > 0) paymentTypeValue = 'PARTIAL_PAYMENT';
      else paymentTypeValue = 'FULL_PAYMENT';
    }

    // Combined coverage (what cashier sees on POS)
    const coverageSum = parseFloat((combinedPaymentAmount + combinedCreditAmount).toFixed(2));
    if (Math.abs(coverageSum - totalForValidation) > 0.01) {
      return res.status(400).json({
        success: false,
        message: `Payment amount (${combinedPaymentAmount}) and credit amount (${combinedCreditAmount}) must equal total amount (${totalForValidation}). Difference: ${Math.abs(coverageSum - totalForValidation)}`
      });
    }

    // WarehouseSale.create allocation: settle cash against outstanding first
    let settleAmount = outstandingPortion;
    if (!(settleAmount > 0)) settleAmount = 0;
    // Fully credit / balance payment: do not invent a cash settlement
    if (isFullyCredit || isBalancePayment) {
      settleAmount = 0;
    } else {
      settleAmount = Math.min(settleAmount, Math.max(0, combinedPaymentAmount));
    }

    let settlementRan = false;
    let balanceForSaleOld = null;

    if (
      settleAmount > 0.01 &&
      customerName &&
      customerPhone &&
      String(customerPhone).trim().length > 0
    ) {
      const settlementConn = await pool.getConnection();
      try {
        await settlementConn.beginTransaction();
        const numericScopeIdForInvoice = typeof scopeId === 'string' && /^\d+$/.test(scopeId)
          ? parseInt(scopeId, 10)
          : (typeof scopeId === 'number' ? scopeId : scopeId);

        const settlementResult = await applyOutstandingSettlement(settlementConn, {
          scopeType,
          scopeName,
          applyScopeFilter: true,
          userId: req.user.id,
          userName: req.user.name || req.user.username || 'Cashier',
          userRole: req.user.role || 'CASHIER',
          customerName,
          phone: String(customerPhone).trim(),
          paymentAmount: settleAmount,
          paymentMethod: normalizedPaymentMethod,
          notes: `Outstanding settlement before branch invoice ${invoiceNo || ''}`.trim(),
          numericScopeIdForInvoice,
          retailerId: null,
          saleDate: saleDate || null,
        });

        await settlementConn.commit();
        settlementRan = true;
        settlementCreated = true;
        settlementId = settlementResult.settlementId;
        settlementAmount = settlementResult.settlementAmount || settleAmount;
        balanceForSaleOld = settlementResult.remainingOutstanding;
      } catch (settlementError) {
        try { await settlementConn.rollback(); } catch (_) { /* ignore */ }
        return res.status(settlementError.statusCode || 400).json({
          success: false,
          message: settlementError.message || 'Failed to record outstanding settlement before sale',
        });
      } finally {
        settlementConn.release();
      }
    }

    // Invoice split for GL (Sale.create total = billAmount)
    // Mirror WarehouseSale: after settlement, paymentForSale = cash - settle; credit = bill - paymentForSale
    let finalPaymentAmount;
    let finalCreditAmount;

    if (isFullyCredit) {
      finalPaymentAmount = 0;
      finalCreditAmount = billAmount;
    } else if (isBalancePayment) {
      finalPaymentAmount = 0;
      finalCreditAmount = billAmount;
    } else if (settlementRan) {
      finalPaymentAmount = Math.max(0, parseFloat((combinedPaymentAmount - settlementAmount).toFixed(2)));
      finalCreditAmount = parseFloat((billAmount - finalPaymentAmount).toFixed(2));
    } else if (outstandingPortion > 0.01) {
      // Outstanding was included in POS total but no cash applied to it (e.g. pay 0)
      finalPaymentAmount = Math.max(0, combinedPaymentAmount);
      finalCreditAmount = parseFloat((billAmount - finalPaymentAmount).toFixed(2));
    } else {
      // No outstanding: use combined amounts as-is (already validated against bill)
      finalPaymentAmount = combinedPaymentAmount;
      finalCreditAmount = combinedCreditAmount;
    }

    finalPaymentAmount = parseFloat((finalPaymentAmount ?? 0).toFixed(2));
    finalCreditAmount = parseFloat((finalCreditAmount ?? 0).toFixed(2));

    // Fresh ledger balance for this sale's old_balance (after optional settlement)
    const previousRunningBalance = (balanceForSaleOld !== null && Number.isFinite(balanceForSaleOld))
      ? balanceForSaleOld
      : await getCustomerRunningBalance(customerName, customerPhone, scopeType, scopeName);
    const oldBalance = previousRunningBalance;

    // Warehouse-style running balance: old + this invoice - cash on this invoice
    const creditUsedFromPreviousBalance = 0;
    const runningBalance = oldBalance + billAmount - finalPaymentAmount;

    // GL assertPaymentSplit requires payment + credit === billAmount
    const amountToCover = billAmount;
    const invoiceCoverage = parseFloat((finalPaymentAmount + finalCreditAmount).toFixed(2));
    if (Math.abs(invoiceCoverage - amountToCover) > 0.01) {
      return res.status(400).json({
        success: false,
        message: `Payment amount (${finalPaymentAmount}) and credit amount (${finalCreditAmount}) must equal invoice total (${amountToCover}). Difference: ${Math.abs(invoiceCoverage - amountToCover)}`
      });
    }

    // Payment status from allocated invoice amounts (warehouse-parity; ignore stale POS status)
    let finalPaymentStatus;
    if (isBalancePayment) {
      finalPaymentStatus = 'COMPLETED';
    } else if (isFullyCredit || normalizedPaymentMethod === 'FULLY_CREDIT') {
      finalPaymentStatus = 'PENDING';
    } else if (finalCreditAmount > 0) {
      finalPaymentStatus = 'PENDING';
    } else if (finalCreditAmount < 0) {
      finalPaymentStatus = 'COMPLETED';
    } else {
      finalPaymentStatus = paymentStatus || 'COMPLETED';
    }

    
    // Determine credit status
    // Credit status should be 'PENDING' if credit exists (positive or negative)
    const finalCreditStatus = creditStatus || ((finalCreditAmount > 0 || finalCreditAmount < 0) ? 'PENDING' : 'NONE');
    
    // Validate payment amounts (allow negative for overpayments creating advance credit)
    // Only block invalid scenarios: paymentAmount is negative but total is positive
    if (finalPaymentAmount < 0 && finalTotal > 0) {
        return res.status(400).json({
            success: false,
            message: 'Payment amount cannot be negative when total is positive'
        });
    }
    
    // Validate partial payment logic
    if (finalPaymentStatus === 'PARTIAL' && finalCreditAmount <= 0) {
        return res.status(400).json({
            success: false,
            message: 'Partial payment requires a credit amount greater than 0'
        });
    }
    
    if (finalPaymentStatus === 'COMPLETED' && finalCreditAmount > 0) {
        return res.status(400).json({
            success: false,
            message: 'Completed payment cannot have a credit amount'
        });
    }
    
    
    // Create customer record if customer name/phone is provided and doesn't exist
let customerId = null;
    if (customerName || customerPhone) {
        try {

            // ── Resolve the NUMERIC scope IDs ────────────────────────────────
            // customers table uses branch_id (int) and warehouse_id (int), NOT names.
            let resolvedBranchId    = null;
            let resolvedWarehouseId = null;

            if (scopeType === 'BRANCH') {
                // scopeId coming from POS is always the numeric branch ID
                if (typeof scopeId === 'number') {
                    resolvedBranchId = scopeId;
                } else if (typeof scopeId === 'string' && /^\d+$/.test(scopeId)) {
                    resolvedBranchId = parseInt(scopeId);
                } else {
                    // scopeId is a name string — resolve to ID
                    const [rows] = await pool.execute('SELECT id FROM branches WHERE name = ? LIMIT 1', [scopeId]);
                    resolvedBranchId = rows[0]?.id || null;
                }
            } else if (scopeType === 'WAREHOUSE') {
                if (typeof scopeId === 'number') {
                    resolvedWarehouseId = scopeId;
                } else if (typeof scopeId === 'string' && /^\d+$/.test(scopeId)) {
                    resolvedWarehouseId = parseInt(scopeId);
                } else {
                    const [rows] = await pool.execute('SELECT id FROM warehouses WHERE name = ? LIMIT 1', [scopeId]);
                    resolvedWarehouseId = rows[0]?.id || null;
                }
            }

            // ── Lookup strategy ──────────────────────────────────────────────
            // Uniqueness rule:  scope (branch_id OR warehouse_id)  +  phone
            // • Same phone in branch 1 and branch 2 → two DIFFERENT customers ✓
            // • Same name in same branch             → same customer (if phone matches) ✓
            // • No phone provided                    → fall back to name-only within scope
            let existingCustomers = [];

            if (customerPhone && (resolvedBranchId || resolvedWarehouseId)) {
                // PRIMARY lookup: scope + phone  (the true unique key)
                if (resolvedBranchId) {
                    const [rows] = await pool.execute(
                        'SELECT id, name, phone FROM customers WHERE phone = ? AND branch_id = ? LIMIT 1',
                        [customerPhone, resolvedBranchId]
                    );
                    existingCustomers = rows;
                } else {
                    const [rows] = await pool.execute(
                        'SELECT id, name, phone FROM customers WHERE phone = ? AND warehouse_id = ? LIMIT 1',
                        [customerPhone, resolvedWarehouseId]
                    );
                    existingCustomers = rows;
                }
            } else if (customerPhone) {
                // Phone provided but scope not resolved — fallback: phone only
                const [rows] = await pool.execute(
                    'SELECT id, name, phone FROM customers WHERE phone = ? LIMIT 1',
                    [customerPhone]
                );
                existingCustomers = rows;
            } else if (customerName && (resolvedBranchId || resolvedWarehouseId)) {
                // No phone — use name within scope as fallback
                if (resolvedBranchId) {
                    const [rows] = await pool.execute(
                        'SELECT id, name, phone FROM customers WHERE LOWER(TRIM(name)) = LOWER(TRIM(?)) AND branch_id = ? LIMIT 1',
                        [customerName, resolvedBranchId]
                    );
                    existingCustomers = rows;
                } else {
                    const [rows] = await pool.execute(
                        'SELECT id, name, phone FROM customers WHERE LOWER(TRIM(name)) = LOWER(TRIM(?)) AND warehouse_id = ? LIMIT 1',
                        [customerName, resolvedWarehouseId]
                    );
                    existingCustomers = rows;
                }
            }

            if (existingCustomers.length === 0) {
                // ── Create new customer ──────────────────────────────────────
                const customerData = {
                    name:            customerName || 'Walk-in Customer',
                    email:           customerInfo?.email   || '',
                    phone:           customerPhone         || '',
                    address:         customerInfo?.address || '',
                    city:            '',
                    state:           '',
                    zip_code:        '',
                    customer_type:   'INDIVIDUAL',
                    credit_limit:    0.00,
                    current_balance: finalCreditAmount || 0.00,
                    payment_terms:   'CASH',
                    branch_id:       resolvedBranchId,
                    warehouse_id:    resolvedWarehouseId,
                    status:          'ACTIVE',
                    notes:           'Auto-created from POS sale',
                    created_at:      new Date(),
                    updated_at:      new Date()
                };

                const [customerResult] = await pool.execute(`
                    INSERT INTO customers (
                        name, email, phone, address, city, state, zip_code,
                        customer_type, credit_limit, current_balance, payment_terms,
                        branch_id, warehouse_id, status, notes, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `, [
                    customerData.name,
                    customerData.email,
                    customerData.phone,
                    customerData.address,
                    customerData.city,
                    customerData.state,
                    customerData.zip_code,
                    customerData.customer_type,
                    customerData.credit_limit,
                    customerData.current_balance,
                    customerData.payment_terms,
                    customerData.branch_id,
                    customerData.warehouse_id,
                    customerData.status,
                    customerData.notes,
                    customerData.created_at,
                    customerData.updated_at
                ]);

                customerId = customerResult.insertId;
            } else {
                // ── Reuse existing customer ──────────────────────────────────
                customerId = existingCustomers[0].id;

                const migrationDoneForCustomer = await isLedgerMigrationComplete(pool);
                if (migrationDoneForCustomer && scopeType && scopeName) {
                  const ledgerBal = await CustomerLedgerEntries.getCustomerBalance(pool, {
                    scopeType,
                    scopeId: scopeName,
                    retailerId: null,
                    customerName: customerName || '',
                    customerPhone: customerPhone || '',
                  });
                  await pool.execute(
                    'UPDATE customers SET current_balance = ?, updated_at = NOW() WHERE id = ?',
                    [ledgerBal, customerId]
                  );
                } else if (finalCreditAmount > 0) {
                  await pool.execute(
                    'UPDATE customers SET current_balance = current_balance + ?, updated_at = NOW() WHERE id = ?',
                    [finalCreditAmount, customerId]
                  );
                }
            }
        } catch (customerError) {
            // Don't fail the sale if customer logic fails
        }
    }

    // Create sale
    const saleData = {
        invoiceNo: invoiceNo || null,
        scopeType: scopeType || null,
        scopeId: scopeName || scopeId || null,
        userId: req.user.id || null,
        userName: req.user.name || req.user.username || null,
        userRole: req.user.role || null,
        shiftId: req.body.shiftId || req.currentShift?.id || null,
        subtotal: finalSubtotal || 0,
        tax: finalTax || 0,
        discount: finalDiscount || 0,
        total: billAmount || 0, // ✅ Use bill amount, not final total with credit adjustments
        paymentMethod: normalizedPaymentMethod || null,
        paymentType: paymentTypeValue || null,
        paymentStatus: finalPaymentStatus || null,
        customerInfo: customerInfo ? JSON.stringify(customerInfo) : null,
        customerName: customerName || null,
        customerPhone: customerPhone || null,
        customerId: customerId,
        paymentAmount: finalPaymentAmount || 0,
        creditAmount: finalCreditAmount || 0,
        oldBalance: oldBalance || 0, // ✅ Save old_balance (previous row's running_balance)
        runningBalance: runningBalance || 0, // ✅ Save running_balance (old_balance + amount - payment)
        creditStatus: finalCreditStatus || 'NONE',
        creditDueDate: finalCreditAmount > 0 ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) : null,
        notes: notes || null,
        saleDate: saleDate || null,
        status: status || 'COMPLETED',
        items: enrichedItems.map(item => ({
            inventoryItemId: item.inventoryItemId || null,
            sku: item.sku || null,
            name: item.name || null,
            quantity: item.quantity || 0,
            unitPrice: item.unitPrice || 0,
            originalPrice: item.originalPrice || item.unitPrice || 0,
            discount: item.discount || 0,
            discountType: item.discountType || 'amount',
            total: (item.unitPrice * item.quantity) - (item.discount || 0)
        }))
    };

    // Validate required fields before creating sale
    if (!req.user.id) {
        return res.status(400).json({
            success: false,
            message: 'User ID is required'
        });
    }

    if (!scopeType) {
        return res.status(400).json({
            success: false,
            message: 'Scope type is required'
        });
    }

    if (!scopeName) {
        return res.status(400).json({
            success: false,
            message: 'Scope ID/Name is required'
        });
    }

    if (!normalizedPaymentMethod) {
        return res.status(400).json({
            success: false,
            message: 'Payment method is required'
        });
    }

    // Final validation - ensure no null SKUs
    for (const item of saleData.items) {
        if (!item.sku) {
            return res.status(400).json({
                success: false,
                message: `SKU is required for item ${item.inventoryItemId}`,
                item: item
            });
        }
    }

    
    let sale;
    try {
        sale = await Sale.create(saleData);
    } catch (saleError) {
        // If a settlement was committed before Sale.create, reverse it now so
        // the AR ledger stays consistent (settlement with no corresponding sale).
        if (settlementCreated && settlementId) {
          try {
            const { removeSaleFromLedgers } = require('../../services/saleLedgerSyncService');
            const cleanConn = await pool.getConnection();
            try {
              await cleanConn.beginTransaction();
              const [settlRow] = await cleanConn.execute('SELECT * FROM sales WHERE id = ? LIMIT 1', [settlementId]);
              if (settlRow.length) await removeSaleFromLedgers(cleanConn, settlementId, settlRow[0]);
              await cleanConn.execute('DELETE FROM sales WHERE id = ?', [settlementId]);
              await cleanConn.commit();
            } catch (_) {
              await cleanConn.rollback();
            } finally {
              cleanConn.release();
            }
          } catch (_) { /* best-effort */ }
        }
        throw saleError;
    }

    // Stock + GL chart-of-accounts: handled inside Sale.create (single transaction; GL failure rolls back sale)

    if (customerId && (await isLedgerMigrationComplete(pool)) && scopeType && scopeName) {
      try {
        const ledgerBal = await CustomerLedgerEntries.getCustomerBalance(pool, {
          scopeType,
          scopeId: scopeName,
          retailerId: sale?.retailerId ?? sale?.retailer_id ?? null,
          customerName: customerName || '',
          customerPhone: customerPhone || '',
        });
        await pool.execute(
          'UPDATE customers SET current_balance = ?, updated_at = NOW() WHERE id = ?',
          [ledgerBal, customerId]
        );
      } catch (syncErr) {
      }
    }

    // ✅ FIX: Clear/reduce old credit balance in previous sales when credit is used
    // Immutable ledger: never mutate historical sales.running_balance — ledger is source of truth.
    if (
      creditUsedFromPreviousBalance > 0 &&
      (customerName || customerPhone) &&
      !(await isLedgerMigrationComplete(pool))
    ) {
        try {
            
            // Get connection for transaction
            const connection = await pool.getConnection();
            try {
                await connection.beginTransaction();
                
                // Find sales with negative running balance (credit) for this customer
                let query = `
                    SELECT id, invoice_no, credit_amount, running_balance, payment_status, scope_type, scope_id
                    FROM sales 
                    WHERE (customer_name = ? OR customer_phone = ?)
                      AND running_balance < 0
                `;
                
                const queryParams = [customerName, customerPhone];
                
                // Add scope filtering for non-admin users
                if (req.user.role !== 'ADMIN' && scopeName && scopeType) {
                    query += ' AND scope_type = ? AND (scope_id = ? OR scope_id = CAST(? AS CHAR))';
                    queryParams.push(scopeType, scopeName, scopeName);
                }
                
                query += ' ORDER BY created_at ASC';
                
                const [creditSales] = await connection.execute(query, queryParams);
                
                let remainingCreditToClear = creditUsedFromPreviousBalance;
                const processedSales = [];
                
                // Process each credit sale to clear the credit
                for (const creditSale of creditSales) {
                    if (remainingCreditToClear <= 0) break;
                    
                    const currentCredit = Math.abs(parseFloat(creditSale.running_balance));
                    const creditToClear = Math.min(remainingCreditToClear, currentCredit);
                    
                    // Update the sale's running balance and credit amount
                    const newRunningBalance = parseFloat(creditSale.running_balance) + creditToClear;
                    const newCreditAmount = parseFloat(creditSale.credit_amount) + creditToClear;
                    const newPaymentStatus = newRunningBalance >= 0 ? 'COMPLETED' : creditSale.payment_status;
                    
                    await connection.execute(
                        `UPDATE sales 
                         SET credit_amount = ?, 
                             running_balance = ?,
                             payment_status = ?,
                             updated_at = NOW()
                         WHERE id = ?`,
                        [newCreditAmount, newRunningBalance, newPaymentStatus, creditSale.id]
                    );
                    
                    processedSales.push({
                        saleId: creditSale.id,
                        invoiceNo: creditSale.invoice_no,
                        creditCleared: creditToClear,
                        remainingRunningBalance: newRunningBalance,
                        newStatus: newPaymentStatus
                    });
                    
                    remainingCreditToClear -= creditToClear;
                    
                }
                
                await connection.commit();
                
            } catch (clearError) {
                await connection.rollback();
                // Don't fail the sale if credit clearing fails, but log it
            } finally {
                connection.release();
            }
        } catch (error) {
            // Don't fail the sale if credit clearing fails
        }
    }

    // Create financial voucher for the sale
    try {
        const voucherNo = `VCH-${Date.now()}-${Math.random().toString(36).substr(2, 5).toUpperCase()}`;
        const voucherData = {
            voucherNo: voucherNo,
            type: 'INCOME',
            category: 'SALES',
            paymentMethod: normalizedPaymentMethod,
            amount: billAmount, // ✅ Use bill amount for voucher
            description: `Sale from POS Terminal - ${scopeType}: ${scopeName}`,
            reference: invoiceNo,
            scopeType: scopeType,
            scopeId: scopeId,
            userId: req.user.id,
            userName: req.user.name,
            userRole: req.user.role,
            status: 'APPROVED', // Auto-approve sales from POS
            approvedBy: req.user.id,
            approvalNotes: null,
            rejectionReason: null
        };

        await FinancialVoucher.create(voucherData);
    } catch (voucherError) {
        // Don't fail the sale if voucher creation fails
    }

    const responseBody = {
        success: true,
        message: 'Sale created successfully',
        data: {
            ...sale,
            invoice_no: sale.invoiceNo  // Add snake_case version for frontend compatibility
        }
    };
    if (idempotencyKey) {
      setIdempotentResponse(idempotencyKey, responseBody);
    }
    res.status(201).json(responseBody);
  } catch (error) {
    const detail = error.sqlMessage || error.message || 'Unknown error';
    res.status(500).json({
        success: false,
        message: `Error creating sale: ${detail}`,
        error: error.message,
        errorCode: error.code,
        sqlMessage: error.sqlMessage,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
};
module.exports = { createSale };
