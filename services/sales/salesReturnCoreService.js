const SalesReturn = require('../../models/SalesReturn');
const {
  createReturnTransaction,
  createAdjustmentTransaction,
} = require('../../middleware/stockTracking');
const LedgerService = require('../../services/ledgerService');
const InventoryProjection = require('../../services/inventoryProjectionService');
const { normalizeScope } = require('../../services/inventoryLedgerService');
const CustomerLedgerEntries = require('../../services/customerLedgerEntriesService');
const { isLedgerMigrationComplete } = require('../../services/ledgerMigrationMeta');
const { validateAndNormalizeReturnItems } = require('./returnValidationService');

async function createSalesReturnCore({
  connection,
  requestItems,
  originalSale,
  originalSaleItems,
  returnData,
  actor,
}) {
  const money = (value) => Math.round((Number(value) || 0) * 100) / 100;
  const originalScopeType = originalSale.scopeType || originalSale.scope_type;
  const originalScopeId = originalSale.scopeId || originalSale.scope_id;
  const originalCustomerId = originalSale.customerId ?? originalSale.customer_id ?? null;
  const originalRetailerId = originalSale.retailerId ?? originalSale.retailer_id ?? null;
  const previousRunningBalance = money(originalSale.runningBalance ?? originalSale.running_balance);
  const autoOldBalance = money(originalSale.oldBalance ?? originalSale.old_balance);
  const returnOldBalance = returnData.old_balance != null
    ? money(returnData.old_balance)
    : autoOldBalance;

  let validated;
  try {
    validated = await validateAndNormalizeReturnItems(
      originalSale.id,
      requestItems,
      originalSaleItems,
      originalSale,
      connection
    );
  } catch (validationError) {
    throw Object.assign(validationError, { statusCode: 400 });
  }

  const enrichedItems = [];
  for (const item of validated.normalizedItems) {
    const sourceItem = originalSaleItems.find((saleItem) => {
      if (item.inventoryItemId != null && saleItem.inventory_item_id != null) {
        return Number(item.inventoryItemId) === Number(saleItem.inventory_item_id);
      }
      return String(item.productName || '').trim().toLowerCase() ===
        String(saleItem.item_name || saleItem.name || '').trim().toLowerCase();
    });
    if (!sourceItem) {
      throw Object.assign(
        new Error(`Item "${item.productName}" was not found on the original sale`),
        { statusCode: 400 }
      );
    }

    const inventoryItemId = sourceItem.inventory_item_id ?? null;
    let inventory = null;
    if (inventoryItemId != null) {
      const [inventoryRows] = await connection.execute(
        `SELECT id, name, sku, barcode, category, cost_price, scope_type, scope_id
         FROM inventory_items WHERE id = ? FOR UPDATE`,
        [inventoryItemId]
      );
      inventory = inventoryRows[0] || null;
      if (!inventory) {
        throw Object.assign(
          new Error(`Inventory item ${inventoryItemId} no longer exists`),
          { statusCode: 409 }
        );
      }
    }

    enrichedItems.push({
      inventoryItemId,
      itemName: sourceItem.item_name || sourceItem.name || item.productName,
      sku: sourceItem.sku || inventory?.sku || 'N/A',
      barcode: inventory?.barcode || null,
      category: inventory?.category || null,
      quantity: Number(item.quantity),
      originalQuantity: Number(sourceItem.quantity) || 0,
      unitPrice: Number(item.unitPrice) || 0,
      refundAmount: Number(item.refundAmount) || 0,
      costPrice: Number(inventory?.cost_price) || 0,
      scopeType: inventory?.scope_type || originalScopeType,
      scopeId: inventory?.scope_id ?? originalScopeId,
    });
  }

  const totalRefund = money(validated.totalRefund);
  const legacyPostReturnBalance = money(previousRunningBalance - totalRefund);
  const returnType = String(returnData.type || 'REFUND').toUpperCase();
  const refundMethod = String(
    returnType === 'EXCHANGE' ? 'EXCHANGE' : (returnData.refund_method || 'CASH')
  ).toUpperCase();

  const salesReturn = await SalesReturn.create({
    originalSaleId: originalSale.id,
    userId: actor.id || null,
    reason: returnData.reason,
    notes: returnData.notes,
    totalRefund,
    items: enrichedItems,
    processedBy: actor.id || null,
    type: returnType,
    refundMethod,
  }, connection);

  const migrationDoneForInsert = await isLedgerMigrationComplete(connection);
  const returnNotes = returnData.notes || returnData.reason ||
    `Return for sale ${originalSale.invoiceNo || originalSale.invoice_no || originalSale.id}`;
  const [returnSaleResult] = await connection.execute(
    `INSERT INTO sales (
      invoice_no, scope_type, scope_id, user_id, shift_id,
      subtotal, tax, discount, total,
      payment_method, payment_type, payment_status,
      customer_info, notes, status,
      customer_name, customer_phone,
      payment_amount, credit_amount,
      old_balance, running_balance,
      credit_status, credit_due_date, customer_id, retailer_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      salesReturn.returnNo,
      returnData.scope_type || originalScopeType,
      String(returnData.scope_id ?? originalScopeId ?? ''),
      actor.id || null,
      null,
      -totalRefund,
      0,
      0,
      -totalRefund,
      refundMethod,
      'REFUND',
      'COMPLETED',
      null,
      returnNotes,
      'COMPLETED',
      returnData.customer_name || null,
      returnData.customer_phone || null,
      -totalRefund,
      0,
      migrationDoneForInsert ? 0 : returnOldBalance,
      migrationDoneForInsert ? 0 : legacyPostReturnBalance,
      'NONE',
      null,
      originalCustomerId,
      originalRetailerId,
    ]
  );

  const [returnSaleRows] = await connection.execute('SELECT * FROM sales WHERE id = ?', [returnSaleResult.insertId]);
  const returnSale = returnSaleRows[0];
  if (!returnSale) {
    throw Object.assign(new Error('Failed to load refund sale row'), { statusCode: 409 });
  }

  const actorName = actor.name || actor.username || actor.email || 'System';
  const actorRole = actor.role || 'ADMIN';
  for (const item of enrichedItems) {
    if (item.inventoryItemId == null) continue;
    await InventoryProjection.applyEvent(connection, {
      event_type: 'RETURN',
      inventory_item_id: item.inventoryItemId,
      scope_type: normalizeScope(item.scopeType || originalScopeType),
      scope_id: String(item.scopeId ?? originalScopeId),
      quantity_in: Number(item.quantity),
      quantity_out: 0,
      reference_type: 'sales_return',
      reference_id: String(salesReturn.id),
      unit_cost: Number(item.costPrice) || 0,
      entry_date: new Date(),
      created_by: actor.id || null,
    });
    await createReturnTransaction(
      item.inventoryItemId,
      Number(item.quantity),
      Number(item.unitPrice) || 0,
      actor.id || null,
      actorName,
      actorRole,
      Number(salesReturn.id),
      connection,
      originalScopeType,
      originalScopeId,
      true
    );
  }

  await LedgerService.recordReturnTransaction({
    returnId: Number(salesReturn.id),
    returnNo: salesReturn.returnNo,
    originalSaleId: originalSale.id,
    originalSale,
    scopeType: returnData.scope_type || originalScopeType,
    scopeId: returnData.scope_id ?? originalScopeId,
    totalRefund,
    items: enrichedItems,
    userId: actor.id || null,
    refundMethod,
  }, connection);

  if (await isLedgerMigrationComplete(connection)) {
    await CustomerLedgerEntries.appendFromSalesRow(connection, returnSale);
    const ledgerParty = {
      scopeType: returnSale.scope_type,
      scopeId: returnSale.scope_id,
      retailerId: returnSale.retailer_id,
      customerName: returnSale.customer_name,
      customerPhone: returnSale.customer_phone,
    };
    const finalBalance = await CustomerLedgerEntries.getCustomerBalance(connection, ledgerParty);
    const { debit, credit } = CustomerLedgerEntries.debitCreditForSaleRow(returnSale);
    await CustomerLedgerEntries.insertInvoiceSnapshot(connection, {
      sale_id: returnSale.id,
      customer_id: returnSale.customer_id,
      retailer_id: returnSale.retailer_id,
      scope_type: returnSale.scope_type,
      scope_id: returnSale.scope_id,
      invoice_no: returnSale.invoice_no,
      old_balance: finalBalance - (debit - credit),
      total: totalRefund,
      payment: 0,
      final_balance: finalBalance,
    });
  } else {
    const { recalculateCustomerLedger } = require('../../services/ledgerRecalcService');
    await recalculateCustomerLedger({
      retailerId: originalRetailerId,
      customerPhone: originalSale.customerPhone ?? originalSale.customer_phone,
      customerName: originalSale.customerName ?? originalSale.customer_name,
      scopeType: originalScopeType,
      scopeName: String(originalScopeId),
      connection,
    });
  }

  return {
    salesReturn,
    returnSale,
    enrichedItems,
    totalRefund,
    previousRunningBalance,
    returnOldBalance,
    legacyPostReturnBalance,
  };
}

module.exports = { createSalesReturnCore };
