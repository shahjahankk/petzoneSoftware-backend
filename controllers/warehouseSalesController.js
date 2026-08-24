const { validationResult } = require('express-validator');
const WarehouseSale = require('../models/WarehouseSale');
const Retailer = require('../models/Retailer');
const InventoryItem = require('../models/InventoryItem');
const { pool } = require('../config/database');
const { LEDGER_SORT_AT_S } = require('../utils/ledgerSortAtSql');
const InvoiceNumberService = require('../services/invoiceNumberService');
const CustomerLedgerEntries = require('../services/customerLedgerEntriesService');
const { getPosCustomerBalance } = require('../services/posCustomerBalanceService');
const { isLedgerMigrationComplete } = require('../services/ledgerMigrationMeta');
const {
  getIdempotentResponse,
  setIdempotentResponse,
} = require('../utils/idempotencyMemoryCache');
const { resolveSaleTimestamps } = require('../utils/saleDateUtils');

// @desc    Create warehouse sale to retailer
// @route   POST /api/warehouse-sales
// @access  Private (Warehouse Keeper, Admin)
const createWarehouseSale = async (req, res, next) => {
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

    const parseNumber = (value, fallback = 0) => {
      if (value === undefined || value === null || value === '') {
        return fallback;
      }
      const parsed = parseFloat(value);
      return Number.isNaN(parsed) ? fallback : parsed;
    };

    const {
      retailerId,
      items = [],
      subtotal,
      taxAmount,
      tax,
      discountAmount,
      discount,
      billAmount,
      totalWithOutstanding,
      paymentMethod = 'CASH',
      paymentType,
      paymentTerms,
      notes,
      paymentAmount,
      creditAmount,
      paymentStatus,
      salespersonId,
      salespersonName,
      salespersonPhone,
      outstandingPayments = [],
      customerInfo,
      isRefund = false,
      refundType = null, // 'FULL_REFUND', 'PARTIAL_REFUND', 'CREDIT_NOTE'
      refundAmount = 0,
      saleDate = null
    } = req.body;

    // ========== INPUT VALIDATIONS ==========
    if (!retailerId) {
      return res.status(400).json({
        success: false,
        message: 'Retailer ID is required'
      });
    }

    const normalizedRetailerId = (retailerId !== undefined && retailerId !== null && retailerId !== '')
      ? (Number.isNaN(Number(retailerId)) ? retailerId : Number(retailerId))
      : null;

    const retailer = await Retailer.findById(normalizedRetailerId);
    if (!retailer) {
      return res.status(404).json({
        success: false,
        message: 'Retailer not found'
      });
    }

    // Get current retailer credit balance
    const currentCreditBalance = parseNumber(retailer.creditBalance || 0);

    // ========== CREDIT REFUND VALIDATION AND PROCESSING ==========
    const isCreditRefund = isRefund && (refundType === 'FULL_REFUND' || refundType === 'PARTIAL_REFUND' || refundType === 'CREDIT_NOTE');
    
    if (isCreditRefund) {
      
      // Validate refund type
      const validRefundTypes = ['FULL_REFUND', 'PARTIAL_REFUND', 'CREDIT_NOTE'];
      if (!validRefundTypes.includes(refundType)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid refund type. Must be FULL_REFUND, PARTIAL_REFUND, or CREDIT_NOTE'
        });
      }

      // Validate refund amount based on type
      const requestedRefundAmount = parseNumber(refundAmount || 0);
      
      if (refundType === 'FULL_REFUND') {
        // Validate that there's a balance to refund
        if (currentCreditBalance === 0) {
          return res.status(400).json({
            success: false,
            message: 'Cannot process full refund: Credit balance is already 0'
          });
        }
      } else if (refundType === 'PARTIAL_REFUND') {
        // Validate partial refund amount
        if (requestedRefundAmount <= 0) {
          return res.status(400).json({
            success: false,
            message: 'Partial refund amount must be greater than 0'
          });
        }
        
        if (currentCreditBalance >= 0) {
          return res.status(400).json({
            success: false,
            message: 'Partial refund only applicable for negative credit balances'
          });
        }
        
        if (requestedRefundAmount > Math.abs(currentCreditBalance)) {
          return res.status(400).json({
            success: false,
            message: `Partial refund amount (${requestedRefundAmount}) cannot exceed current credit balance (${Math.abs(currentCreditBalance)})`
          });
        }
      } else if (refundType === 'CREDIT_NOTE') {
        // Validate credit note amount
        if (requestedRefundAmount === 0) {
          return res.status(400).json({
            success: false,
            message: 'Credit note amount cannot be 0'
          });
        }
        
        // For negative balances, credit note should be positive to reduce the debt
        if (currentCreditBalance < 0 && requestedRefundAmount < 0) {
          return res.status(400).json({
            success: false,
            message: 'For negative balances, credit note amount should be positive to reduce the debt'
          });
        }
        
        // For positive balances, credit note can be negative to reduce credit
        if (currentCreditBalance > 0 && requestedRefundAmount > 0) {
          return res.status(400).json({
            success: false,
            message: 'For positive balances, credit note amount should be negative to reduce available credit'
          });
        }
      }

      // Calculate actual refund amount and new balance
      let actualRefundAmount = 0;
      let newBalance = currentCreditBalance;
      let refundDescription = '';
      let cashAmount = 0;
      
      if (refundType === 'FULL_REFUND') {
        actualRefundAmount = Math.abs(currentCreditBalance);
        newBalance = 0;
        cashAmount = actualRefundAmount;
        refundDescription = `Full refund of ${actualRefundAmount}`;
      } else if (refundType === 'PARTIAL_REFUND') {
        actualRefundAmount = requestedRefundAmount;
        newBalance = currentCreditBalance + actualRefundAmount;
        cashAmount = actualRefundAmount;
        refundDescription = `Partial refund of ${actualRefundAmount}`;
      } else if (refundType === 'CREDIT_NOTE') {
        actualRefundAmount = requestedRefundAmount;
        newBalance = currentCreditBalance + actualRefundAmount;
        cashAmount = 0; // No cash transaction for credit note
        refundDescription = `Credit note adjustment of ${actualRefundAmount}`;
      }
      

      // Create refund transaction record
      const refundTransaction = {
        retailerId: normalizedRetailerId,
        warehouseKeeperId: req.user.id,
        type: 'CREDIT_REFUND',
        refundType: refundType,
        previousBalance: currentCreditBalance,
        refundAmount: actualRefundAmount,
        cashAmount: cashAmount,
        newBalance: newBalance,
        notes: notes || `${refundDescription}. Balance updated from ${currentCreditBalance} to ${newBalance}`,
        transactionDate: new Date(),
        processedBy: req.user.id,
        status: 'COMPLETED'
      };

      // Update retailer's credit balance using update method
      await retailer.update({ creditBalance: newBalance });
      retailer.creditBalance = newBalance; // Update local object

      // Create a sale record for the refund (for audit trail)
      const refundSaleData = {
        retailerId: normalizedRetailerId,
        warehouseKeeperId: req.user.id,
        items: [],
        subtotal: 0,
        taxAmount: 0,
        discountAmount: 0,
        billAmount: 0,
        totalWithOutstanding: -cashAmount, // Negative for refund
        paymentMethod: refundType === 'CREDIT_NOTE' ? 'CREDIT_NOTE' : 'CASH',
        paymentType: 'REFUND',
        paymentStatus: 'COMPLETED',
        paymentAmount: -cashAmount, // Negative payment (money going out)
        creditAmount: 0,
        notes: refundTransaction.notes,
        customerInfo: {
          id: normalizedRetailerId,
          name: retailer.name,
          phone: retailer.phone
        },
        isRefund: true,
        refundType: refundType,
        refundTransaction: refundTransaction
      };

      const warehouseSale = await WarehouseSale.create(
        refundSaleData,
        retailer.name,
        refundSaleData.paymentMethod,
        paymentTerms
      );

      // Return success response
      return res.status(201).json({
        success: true,
        message: `Credit refund processed successfully. ${refundDescription}.`,
        data: {
          ...warehouseSale,
          invoice_no: warehouseSale.invoiceNumber || warehouseSale.invoice_no || `REF-${Date.now()}`,
          refundDetails: refundTransaction,
          newCreditBalance: newBalance,
          cashRefunded: cashAmount
        }
      });
    }

    // ========== REGULAR SALE PROCESSING WITH VALIDATIONS ==========
    // Validate items
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Sale must contain at least one item'
      });
    }

    // Process and validate items
    const normalizedItems = [];
    for (const item of items) {
      const inventoryItemId = item.inventoryItemId || item.itemId || item.id || null;
      
      if (!inventoryItemId) {
        return res.status(400).json({
          success: false,
          message: 'Each item must have an inventoryItemId'
        });
      }

      const quantity = parseNumber(item.quantity, 0);
      if (quantity <= 0) {
        return res.status(400).json({
          success: false,
          message: `Item ${item.name || inventoryItemId} must have quantity greater than 0`
        });
      }

      const unitPrice = parseNumber(
        item.unitPrice !== undefined ? item.unitPrice : (item.customPrice !== undefined ? item.customPrice : item.price),
        0
      );
      
      if (unitPrice < 0) {
        return res.status(400).json({
          success: false,
          message: `Item ${item.name || inventoryItemId} cannot have negative price`
        });
      }

      const discountValue = parseNumber(item.discount, 0);
      if (discountValue < 0) {
        return res.status(400).json({
          success: false,
          message: `Item ${item.name || inventoryItemId} cannot have negative discount`
        });
      }

      const lineTotal = parseNumber(item.total !== undefined ? item.total : item.totalPrice, (unitPrice * quantity) - discountValue);
      
      if (lineTotal < 0) {
        return res.status(400).json({
          success: false,
          message: `Item ${item.name || inventoryItemId} cannot have negative total`
        });
      }

      // Check inventory item exists
      const inventoryItem = await InventoryItem.findById(inventoryItemId);
      if (!inventoryItem) {
        return res.status(404).json({
          success: false,
          message: `Inventory item with ID ${inventoryItemId} not found`
        });
      }

      normalizedItems.push({
        itemId: inventoryItemId,
        inventoryItemId,
        sku: item.sku || inventoryItem.sku || '',
        name: item.name || inventoryItem.name || '',
        quantity,
        unitPrice,
        discount: discountValue,
        totalPrice: lineTotal
      });
    }

    // Calculate totals with validation
    const calculatedSubtotal = normalizedItems.reduce((sum, item) => sum + item.totalPrice, 0);
    const normalizedSubtotal = parseNumber(subtotal, calculatedSubtotal);
    
    // Validate subtotal matches calculated subtotal (allow small rounding differences)
    if (Math.abs(normalizedSubtotal - calculatedSubtotal) > 0.01) {
    }

    const normalizedTaxAmount = parseNumber(taxAmount, parseNumber(tax, 0));
    if (normalizedTaxAmount < 0) {
      return res.status(400).json({
        success: false,
        message: 'Tax amount cannot be negative'
      });
    }

    const normalizedDiscountAmount = parseNumber(discountAmount, parseNumber(discount, 0));
    if (normalizedDiscountAmount < 0) {
      return res.status(400).json({
        success: false,
        message: 'Discount amount cannot be negative'
      });
    }

    const calculatedBillAmount = normalizedSubtotal + normalizedTaxAmount - normalizedDiscountAmount;
    const normalizedBillAmount = parseNumber(billAmount, calculatedBillAmount);
    
    // Validate bill amount
    if (Math.abs(normalizedBillAmount - calculatedBillAmount) > 0.01) {
    }

    const normalizedTotalWithOutstanding = parseNumber(
      totalWithOutstanding,
      parseNumber(req.body.finalTotal, normalizedBillAmount)
    );

    // Check for negative totals (returns/refunds)
    const isNegativeTotal = normalizedTotalWithOutstanding < 0;
    const isReturnTransaction = isNegativeTotal;

    // Validate return transactions
    if (isReturnTransaction) {
      if (normalizedTotalWithOutstanding > 0) {
        return res.status(400).json({
          success: false,
          message: 'Return/refund transactions must have negative total amount'
        });
      }
      
      // For returns, check if retailer has enough purchase history
      // (You might want to implement more sophisticated validation here)
    }

    const outstandingPortion = parseFloat((normalizedTotalWithOutstanding - normalizedBillAmount).toFixed(2));

    // ========== PAYMENT PROCESSING WITH VALIDATIONS ==========
    let normalizedPaymentMethod = (paymentMethod || 'CASH').toUpperCase();
    let paymentTypeValue = paymentType || null;
    
    // Validate payment method
    const validPaymentMethods = ['CASH', 'CARD', 'BANK_TRANSFER', 'FULLY_CREDIT', 'MIXED', 'REFUND'];
    if (!validPaymentMethods.includes(normalizedPaymentMethod)) {
      return res.status(400).json({
        success: false,
        message: `Invalid payment method. Must be one of: ${validPaymentMethods.join(', ')}`
      });
    }

    // For return transactions, ensure payment method is appropriate
    if (isReturnTransaction && normalizedPaymentMethod === 'CASH') {
      normalizedPaymentMethod = 'REFUND';
    }

    const providedPaymentAmount = (paymentAmount !== undefined && paymentAmount !== null && paymentAmount !== '')
      ? parseNumber(paymentAmount, 0)
      : null;
    const providedCreditAmount = (creditAmount !== undefined && creditAmount !== null && creditAmount !== '')
      ? parseNumber(creditAmount, 0)
      : null;

    // Validate payment amounts
    if (providedPaymentAmount !== null && providedPaymentAmount < 0 && !isReturnTransaction) {
      return res.status(400).json({
        success: false,
        message: 'Payment amount cannot be negative for regular sales'
      });
    }

    // if (providedCreditAmount !== null && providedCreditAmount < 0) {
    //   return res.status(400).json({
    //     success: false,
    //     message: 'Credit amount cannot be negative'
    //   });
    // }

    const isBalancePayment = paymentTypeValue === 'BALANCE_PAYMENT';
    const isFullyCredit = normalizedPaymentMethod === 'FULLY_CREDIT' || paymentTypeValue === 'FULLY_CREDIT';
    const totalForValidation = isBalancePayment ? normalizedBillAmount : normalizedTotalWithOutstanding;

    let finalPaymentAmount = providedPaymentAmount;
    let finalCreditAmount = providedCreditAmount;

    // Calculate payment distribution
    if (isFullyCredit) {
      finalPaymentAmount = 0;
      finalCreditAmount = totalForValidation;
    } else if (isBalancePayment) {
      finalPaymentAmount = 0;
      finalCreditAmount = normalizedBillAmount;
    } else {
      if (finalPaymentAmount === null && finalCreditAmount === null) {
        finalPaymentAmount = totalForValidation;
        finalCreditAmount = 0;
      } else if (finalPaymentAmount === null) {
        finalPaymentAmount = totalForValidation - finalCreditAmount;
      } else if (finalCreditAmount === null) {
        finalCreditAmount = totalForValidation - finalPaymentAmount;
      }
    }

    finalPaymentAmount = parseFloat((finalPaymentAmount ?? 0).toFixed(2));
    finalCreditAmount = parseFloat((finalCreditAmount ?? 0).toFixed(2));

    // Adjust for return/refund transactions
    if (isReturnTransaction) {
      // For returns, payment amount should be negative (money going out to customer)
      if (finalPaymentAmount > 0 && normalizedTotalWithOutstanding < 0) {
        finalPaymentAmount = normalizedTotalWithOutstanding;
        finalCreditAmount = 0;
      }
      
      // For returns with credit, it reduces what customer owes
      if (finalCreditAmount > 0 && normalizedTotalWithOutstanding < 0) {
        // Validate credit amount doesn't exceed return amount
        if (finalCreditAmount > Math.abs(normalizedTotalWithOutstanding)) {
          return res.status(400).json({
            success: false,
            message: `Credit amount (${finalCreditAmount}) cannot exceed return amount (${Math.abs(normalizedTotalWithOutstanding)})`
          });
        }
      }
    }

    // Determine payment type if not provided
    if (!paymentTypeValue) {
      if (isBalancePayment) {
        paymentTypeValue = 'BALANCE_PAYMENT';
      } else if (isFullyCredit) {
        paymentTypeValue = 'FULLY_CREDIT';
      } else if (finalCreditAmount > 0) {
        paymentTypeValue = 'PARTIAL_PAYMENT';
      } else if (isReturnTransaction) {
        paymentTypeValue = 'REFUND';
      } else {
        paymentTypeValue = 'FULL_PAYMENT';
      }
    }

   
// Validate payment covers total
const coverageSum = parseFloat((finalPaymentAmount + finalCreditAmount).toFixed(2));
if (Math.abs(coverageSum - totalForValidation) > 0.01) {
  return res.status(400).json({
    success: false,
    message: `Payment amount (${finalPaymentAmount}) and credit amount (${finalCreditAmount}) must equal total amount (${totalForValidation}). Difference: ${Math.abs(coverageSum - totalForValidation)}`
  });
}

    // Validate credit amount against retailer's credit limit (if applicable)
 if (finalCreditAmount > 0 && retailer.creditLimit && retailer.creditLimit > 0) {
  const availableCredit = retailer.creditLimit + currentCreditBalance;
  if (finalCreditAmount > availableCredit) {
    return res.status(400).json({
      success: false,
      message: `Credit amount (${finalCreditAmount}) exceeds available credit limit. Available: ${availableCredit}`
    });
  }
}

    // Determine payment status
    let finalPaymentStatus = paymentStatus || null;
    if (!finalPaymentStatus) {
      if (paymentTypeValue === 'BALANCE_PAYMENT') {
        finalPaymentStatus = 'COMPLETED';
      } else if (normalizedPaymentMethod === 'FULLY_CREDIT') {
        finalPaymentStatus = 'PENDING';
      } else if (finalCreditAmount > 0) {
        finalPaymentStatus = 'PENDING';
      } else if (isReturnTransaction) {
        finalPaymentStatus = 'REFUNDED';
      } else {
        finalPaymentStatus = 'COMPLETED';
      }
    }

    // ========== PREPARE SALE DATA ==========
    const finalCustomerInfo = {
      id: normalizedRetailerId,
      name: customerInfo?.name || retailer.name || `Retailer ${normalizedRetailerId}`,
      phone: customerInfo?.phone || retailer.phone || '',
      email: customerInfo?.email || retailer.email || '',
      address: customerInfo?.address || retailer.address || '',
      ...(customerInfo || {})
    };

    // Fetch salesperson details if needed
    let resolvedSalespersonName = salespersonName || null;
    let resolvedSalespersonPhone = salespersonPhone || null;

    if (salespersonId && (!resolvedSalespersonName || !resolvedSalespersonPhone)) {
      try {
        const [salespersonRows] = await pool.execute(
          'SELECT name, phone FROM salespeople WHERE id = ?',
          [salespersonId]
        );
        if (salespersonRows.length > 0) {
          resolvedSalespersonName = resolvedSalespersonName || salespersonRows[0].name || null;
          resolvedSalespersonPhone = resolvedSalespersonPhone || salespersonRows[0].phone || null;
        }
      } catch (salespersonError) {
      }
    }

    const saleData = {
      retailerId: normalizedRetailerId,
      warehouseKeeperId: req.user.id,
      salespersonId,
      salespersonName: resolvedSalespersonName,
      salespersonPhone: resolvedSalespersonPhone,
      items: normalizedItems,
      subtotal: normalizedSubtotal,
      taxAmount: normalizedTaxAmount,
      discountAmount: normalizedDiscountAmount,
      billAmount: normalizedBillAmount,
      totalWithOutstanding: normalizedTotalWithOutstanding,
      paymentMethod: normalizedPaymentMethod,
      paymentType: paymentTypeValue,
      paymentStatus: finalPaymentStatus,
      paymentAmount: finalPaymentAmount,
      creditAmount: finalCreditAmount,
      notes,
      saleDate: saleDate || null,
      outstandingPayments,
      customerInfo: finalCustomerInfo,
      paymentTerms,
     scopeWarehouseId: (req.user.role === 'ADMIN' && req.headers['x-simulate-scope-id'])
            ? parseInt(req.headers['x-simulate-scope-id'])
            : req.body.scopeId || 
              req.body.scopeWarehouseId || 
              req.user.warehouseId || 
              null,    
                  outstandingPortion,
      isRefund: isRefund || isReturnTransaction,
      refundType: isReturnTransaction ? 'SALE_REFUND' : refundType,
      previousCreditBalance: currentCreditBalance // Store previous balance for audit
    };

// ========== HANDLE OUTSTANDING SETTLEMENT BEFORE CREATING SALE ==========
const outstandingAmount = normalizedTotalWithOutstanding - normalizedBillAmount;

if (outstandingAmount > 0.01 && finalCustomerInfo.name && finalCustomerInfo.phone && paymentTypeValue !== 'BALANCE_PAYMENT') {
  try {
    // Get warehouse scope name FIRST
    const [whRows] = await pool.execute('SELECT name FROM warehouses WHERE id = ?', [saleData.scopeWarehouseId]);
    const whScopeName = whRows[0]?.name || String(saleData.scopeWarehouseId);

    const ledgerMigratedWh = await isLedgerMigrationComplete(pool);
    const balanceBeforeSettlement = normalizedRetailerId
      ? await getPosCustomerBalance(pool, {
          scopeType: 'WAREHOUSE',
          scopeId: whScopeName,
          retailerId: parseInt(normalizedRetailerId, 10),
          customerName: '',
          customerPhone: '',
        })
      : await getPosCustomerBalance(pool, {
          scopeType: 'WAREHOUSE',
          scopeId: whScopeName,
          retailerId: null,
          customerName: finalCustomerInfo.name,
          customerPhone: finalCustomerInfo.phone,
        });

    const settlementAmount = Math.min(outstandingAmount, balanceBeforeSettlement);

    if (settlementAmount > 0.01) {
      const settlementOldBalance = balanceBeforeSettlement;
      const settlementNewBalance = settlementOldBalance - settlementAmount;
      const settlementStatus = Math.abs(settlementNewBalance) <= 0.01 ? 'COMPLETED' : 'PARTIAL';

      let settlementInvoiceNo;
      try {
        settlementInvoiceNo = await InvoiceNumberService.generateSettlementNumber('WAREHOUSE', saleData.scopeWarehouseId);
      } catch (e) {
        settlementInvoiceNo = `SETTLE-${Date.now()}-${Math.random().toString(36).substr(2, 5).toUpperCase()}`;
      }

      const persistOld = ledgerMigratedWh ? 0 : settlementOldBalance;
      const persistRun = ledgerMigratedWh ? 0 : settlementNewBalance;

      const settlementTimestamps = resolveSaleTimestamps(saleDate);

const [settlementInsert] = await pool.execute(`
  INSERT INTO sales (
    invoice_no, scope_type, scope_id, user_id, subtotal, tax, discount, total,
    payment_method, payment_type, payment_status, customer_info, customer_name,
    customer_phone, payment_amount, credit_amount, old_balance, running_balance,
    credit_status, notes, status, retailer_id, sale_date, created_at, updated_at
  ) VALUES (?, 'WAREHOUSE', ?, ?, 0, 0, 0, ?, ?, 'OUTSTANDING_SETTLEMENT', ?, ?, ?, ?, ?, 0, ?, ?, 'NONE', ?, 'COMPLETED', ?, ?, ?, ?)
`, [
  settlementInvoiceNo,
  whScopeName,
  req.user.id,
  settlementAmount,
  normalizedPaymentMethod,
  settlementStatus,
  JSON.stringify({ name: finalCustomerInfo.name, phone: finalCustomerInfo.phone }),
  finalCustomerInfo.name,
  finalCustomerInfo.phone,
  settlementAmount,
  persistOld,
  persistRun,
  [notes, `Outstanding settlement before sale - retailer ${saleData.retailerId}`].filter(Boolean).join(' | '),
  normalizedRetailerId || null,
  settlementTimestamps.saleDateSql,
  settlementTimestamps.createdAt,
  settlementTimestamps.updatedAt,
]);

      const autoSettlementId = settlementInsert.insertId;
      const [autoSettlementRows] = await pool.execute('SELECT * FROM sales WHERE id = ?', [autoSettlementId]);
      if (autoSettlementRows[0]) {
        const ar = autoSettlementRows[0];
        await CustomerLedgerEntries.appendFromSalesRow(pool, ar);
        const balAfterSettle = await CustomerLedgerEntries.getCustomerBalance(pool, {
          scopeType: ar.scope_type,
          scopeId: ar.scope_id,
          retailerId: ar.retailer_id,
          customerName: ar.customer_name,
          customerPhone: ar.customer_phone,
        });
        const { debit: dS, credit: cS } = CustomerLedgerEntries.debitCreditForSaleRow(ar);
        const oldSnapSettle = balAfterSettle - (dS - cS);
        await CustomerLedgerEntries.insertInvoiceSnapshot(pool, {
          sale_id: autoSettlementId,
          customer_id: ar.customer_id,
          retailer_id: ar.retailer_id,
          scope_type: 'WAREHOUSE',
          scope_id: whScopeName,
          invoice_no: settlementInvoiceNo,
          old_balance: oldSnapSettle,
          total: 0,
          payment: settlementAmount,
          final_balance: balAfterSettle,
        });
      }

      // Post-settlement party balance for in-request logic (ledger truth when migrated)
      saleData.previousRunningBalance = ledgerMigratedWh
        ? await getPosCustomerBalance(pool, {
            scopeType: 'WAREHOUSE',
            scopeId: whScopeName,
            retailerId: normalizedRetailerId ? parseInt(normalizedRetailerId, 10) : null,
            customerName: normalizedRetailerId ? '' : finalCustomerInfo.name,
            customerPhone: normalizedRetailerId ? '' : finalCustomerInfo.phone,
          })
        : settlementNewBalance;

    } else {
    }
  } catch (settlementError) {
    // Don't fail the sale if settlement fails
  }
}

// ========== CREATE SALE AND UPDATE BALANCE ==========
const warehouseSale = await WarehouseSale.create(
      saleData,
      finalCustomerInfo.name,
      saleData.paymentMethod,
      paymentTerms
    );

    // Update retailer credit balance if credit was used
    if (finalCreditAmount !== 0) {
      let newBalance = currentCreditBalance;
      
      if (isReturnTransaction) {
        // For returns, credit amount reduces what retailer owes (negative becomes less negative)
        newBalance = currentCreditBalance + finalCreditAmount;
      } else {
        // For sales, credit amount increases what retailer owes
        newBalance = currentCreditBalance - finalCreditAmount;
      }
      
      // Use the update method instead of save
      await retailer.update({ creditBalance: newBalance });
      retailer.creditBalance = newBalance; // Update local object
      
    }

    // Prepare response
    const saleResponse = {
      ...warehouseSale,
      invoice_no: warehouseSale.invoiceNumber || warehouseSale.invoice_no || null,
      payment_status: saleData.paymentStatus,
      payment_type: saleData.paymentType,
      retailerCreditBalance: retailer.creditBalance,
      previousCreditBalance: currentCreditBalance
    };

    const responseBody = {
      success: true,
      message: isReturnTransaction ? 'Return transaction processed successfully' : 'Warehouse sale created successfully',
      data: saleResponse
    };
    if (idempotencyKey) {
      setIdempotentResponse(idempotencyKey, responseBody);
    }
    res.status(201).json(responseBody);

  } catch (error) {
    next(error);
  }
};
// @route   GET /api/warehouse-sales
// @access  Private (Warehouse Keeper, Admin)
const getWarehouseSales = async (req, res, next) => {
  try {
    const {
      retailerId,
      status,
      startDate,
      endDate,
      page = 1,
      limit = 10
    } = req.query;

    const filters = {
      retailerId,
      status,
      startDate,
      endDate,
      limit: parseInt(limit),
      offset: (parseInt(page) - 1) * parseInt(limit)
    };

    // If user is warehouse keeper, filter by their sales
    if (req.user.role === 'WAREHOUSE_KEEPER') {
      filters.warehouseKeeperId = req.user.id;
    }

    const sales = await WarehouseSale.findAll(filters);

    res.json({
      success: true,
      count: sales.length,
      data: sales
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get single warehouse sale
// @route   GET /api/warehouse-sales/:id
// @access  Private (Warehouse Keeper, Admin)
const getWarehouseSale = async (req, res, next) => {
  try {
    const sale = await WarehouseSale.findById(req.params.id);

    if (!sale) {
      return res.status(404).json({
        success: false,
        message: 'Warehouse sale not found'
      });
    }

    // Check if user can access this sale
    if (req.user.role === 'WAREHOUSE_KEEPER' && sale.warehouseKeeperId !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: 'Access denied to this warehouse sale'
      });
    }

    res.json({
      success: true,
      data: sale
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Update warehouse sale
// @route   PUT /api/warehouse-sales/:id
// @access  Private (Admin only)
const updateWarehouseSale = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation error',
        errors: errors.array()
      });
    }

    const sale = await WarehouseSale.findById(req.params.id);

    if (!sale) {
      return res.status(404).json({
        success: false,
        message: 'Warehouse sale not found'
      });
    }

    const updatedSale = await sale.update(req.body);

    res.json({
      success: true,
      message: 'Warehouse sale updated successfully',
      data: updatedSale
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Delete warehouse sale
// @route   DELETE /api/warehouse-sales/:id
// @access  Private (Admin only)
const deleteWarehouseSale = async (req, res, next) => {
  try {
    const sale = await WarehouseSale.findById(req.params.id);

    if (!sale) {
      return res.status(404).json({
        success: false,
        message: 'Warehouse sale not found'
      });
    }

    const trashService = require('../services/trashService');
    await trashService.softDelete('sale', req.params.id, req.user.id);

    res.json({
      success: true,
      message: 'Warehouse sale moved to trash successfully'
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get warehouse sales summary
// @route   GET /api/warehouse-sales/summary
// @access  Private (Warehouse Keeper, Admin)
const getWarehouseSalesSummary = async (req, res, next) => {
  try {
    const { startDate, endDate } = req.query;

    const conditions = ['s.scope_type = ?', 's.deleted_at IS NULL'];
    const params = ['WAREHOUSE'];

    if (req.user.role === 'WAREHOUSE_KEEPER') {
      const wid = req.user.warehouse_id || req.user.warehouseId;
      if (!wid) {
        return res.status(403).json({ success: false, message: 'Warehouse context required' });
      }
      const [wh] = await pool.execute('SELECT name FROM warehouses WHERE id = ?', [wid]);
      if (!wh.length) {
        return res.json({
          success: true,
          data: {
            totalSales: 0,
            totalRevenue: 0,
            totalRetailers: 0,
            averageOrderValue: 0,
            topSellingItems: [],
            salesByRetailer: []
          }
        });
      }
      conditions.push('s.scope_id = ?');
      params.push(wh[0].name);
    } else if (req.user.role !== 'ADMIN') {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    if (startDate) {
      conditions.push('DATE(COALESCE(s.sale_date, s.created_at)) >= ?');
      params.push(startDate);
    }
    if (endDate) {
      conditions.push('DATE(COALESCE(s.sale_date, s.created_at)) <= ?');
      params.push(endDate);
    }

    const whereSql = `WHERE ${conditions.join(' AND ')}`;

    const [aggRows] = await pool.execute(
      `SELECT COUNT(*) AS totalSales,
              COALESCE(SUM(CASE WHEN s.total IS NOT NULL THEN s.total ELSE 0 END), 0) AS totalRevenue
       FROM sales s
       ${whereSql}`,
      params
    );

    const [retailerRows] = await pool.execute(
      `SELECT COUNT(DISTINCT COALESCE(s.retailer_id, CONCAT('k:', s.customer_name, '|', s.customer_phone))) AS totalRetailers
       FROM sales s
       ${whereSql}`,
      params
    );

    const totalSales = Number(aggRows[0]?.totalSales) || 0;
    const totalRevenue = parseFloat(aggRows[0]?.totalRevenue) || 0;
    const totalRetailers = Number(retailerRows[0]?.totalRetailers) || 0;
    const averageOrderValue =
      totalSales > 0 ? Math.round((totalRevenue / totalSales) * 100) / 100 : 0;

    res.json({
      success: true,
      data: {
        totalSales,
        totalRevenue,
        totalRetailers,
        averageOrderValue,
        topSellingItems: [],
        salesByRetailer: []
      }
    });
  } catch (error) {
    next(error);
  }
};

const getLastCustomerItemPrice = async (req, res, next) => {
  try {
    const { retailerId, inventoryItemId, customerName, customerPhone } = req.query;

    if (!inventoryItemId) {
      return res.status(400).json({ success: false, message: 'inventoryItemId is required' });
    }

    let customerCondition = '';
    const params = [];

    if (retailerId) {
      customerCondition = `AND (
        s.retailer_id = ?
        OR JSON_UNQUOTE(JSON_EXTRACT(s.customer_info, '$.id')) = ?
        OR CAST(JSON_UNQUOTE(JSON_EXTRACT(s.customer_info, '$.id')) AS UNSIGNED) = ?
      )`;
      params.push(Number(retailerId), String(retailerId), Number(retailerId));
    } else if (customerPhone) {
      customerCondition = 'AND s.customer_phone = ?';
      params.push(customerPhone);
    } else if (customerName) {
      customerCondition = 'AND LOWER(TRIM(s.customer_name)) = LOWER(TRIM(?))';
      params.push(customerName);
    } else {
      return res.status(400).json({ success: false, message: 'retailerId, customerPhone, or customerName required' });
    }

    const [rows] = await pool.execute(`
      SELECT si.unit_price, s.invoice_no, COALESCE(s.sale_date, s.created_at) as sale_date
      FROM sale_items si
      JOIN sales s ON si.sale_id = s.id
      WHERE si.inventory_item_id = ?
        ${customerCondition}
        AND s.deleted_at IS NULL
        AND s.scope_type = 'WAREHOUSE'
      ORDER BY ${LEDGER_SORT_AT_S} DESC, s.id DESC
      LIMIT 1
    `, [inventoryItemId, ...params]);

    if (rows.length === 0) {
      return res.json({ success: true, data: null, message: 'No previous price found' });
    }

    res.json({
      success: true,
      data: {
        lastPrice: parseFloat(rows[0].unit_price),
        lastInvoice: rows[0].invoice_no,
        lastDate: rows[0].sale_date
      }
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  createWarehouseSale,
  getWarehouseSales,
  getWarehouseSale,
  updateWarehouseSale,
  deleteWarehouseSale,
  getWarehouseSalesSummary,
  getLastCustomerItemPrice
};
