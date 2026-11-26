const Sale = require('../../models/Sale');
const CustomerLedgerEntries = require('../../services/customerLedgerEntriesService');
const { isLedgerMigrationComplete } = require('../../services/ledgerMigrationMeta');
const InvoiceNumberService = require('../invoiceNumberService');

function money(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

async function validateExchangeItems(connection, exchangeItems, originalSale) {
  if (!Array.isArray(exchangeItems) || !exchangeItems.length) {
    throw Object.assign(new Error('At least one replacement item is required for an exchange'), {
      statusCode: 400,
    });
  }

  const normalized = [];
  const seen = new Map();

  for (const input of exchangeItems) {
    const inventoryItemId = Number(input.inventoryItemId);
    const quantity = Number(input.quantity);
    if (!Number.isInteger(inventoryItemId) || inventoryItemId <= 0) {
      throw Object.assign(new Error('Replacement item must reference a valid inventory item'), {
        statusCode: 400,
      });
    }
    if (!(quantity > 0)) {
      throw Object.assign(new Error('Replacement quantity must be greater than 0'), {
        statusCode: 400,
      });
    }

    seen.set(inventoryItemId, (seen.get(inventoryItemId) || 0) + quantity);
    normalized.push({ inventoryItemId, quantity, input });
  }

  const ids = [...seen.keys()];
  const placeholders = ids.map(() => '?').join(',');
  const [rows] = await connection.execute(
    `SELECT id, name, sku, barcode, category, selling_price, cost_price,
            current_stock, scope_type, scope_id, deleted_at
     FROM inventory_items
     WHERE id IN (${placeholders}) FOR UPDATE`,
    ids
  );
  const byId = new Map(rows.map((row) => [Number(row.id), row]));

  const originalScopeType = originalSale.scopeType || originalSale.scope_type;
  const originalScopeId = originalSale.scopeId || originalSale.scope_id;
  const originalScopeKey = String(originalScopeId);
  let originalScopeName = originalScopeKey;
  let originalScopeNumericId = null;
  if (originalScopeType === 'BRANCH') {
    const [branches] = await connection.execute(
      'SELECT id, name FROM branches WHERE id = ? OR name = ? LIMIT 1',
      [originalScopeId, originalScopeKey]
    );
    if (branches[0]) {
      originalScopeName = branches[0].name;
      originalScopeNumericId = branches[0].id;
    }
  } else if (originalScopeType === 'WAREHOUSE') {
    const [warehouses] = await connection.execute(
      'SELECT id, name FROM warehouses WHERE id = ? OR name = ? LIMIT 1',
      [originalScopeId, originalScopeKey]
    );
    if (warehouses[0]) {
      originalScopeName = warehouses[0].name;
      originalScopeNumericId = warehouses[0].id;
    }
  }
  const allowedScopeIds = new Set(
    [originalScopeKey, originalScopeName, originalScopeNumericId]
      .filter((value) => value != null && value !== '')
      .map(String)
  );

  for (const [inventoryItemId, totalQty] of seen.entries()) {
    const inventory = byId.get(inventoryItemId);
    if (!inventory || inventory.deleted_at) {
      throw Object.assign(new Error(`Replacement item ${inventoryItemId} no longer exists`), {
        statusCode: 409,
      });
    }
    const available = Number(inventory.current_stock) || 0;
    if (totalQty > available) {
      throw Object.assign(
        new Error(`Insufficient stock for "${inventory.name}" (available: ${available})`),
        { statusCode: 409 }
      );
    }
    if (inventory.scope_type && inventory.scope_type !== originalScopeType) {
      throw Object.assign(new Error(`Replacement item "${inventory.name}" belongs to another scope`), {
        statusCode: 409,
      });
    }
    if (inventory.scope_type && !allowedScopeIds.has(String(inventory.scope_id))) {
      throw Object.assign(new Error(`Replacement item "${inventory.name}" belongs to another branch`), {
        statusCode: 409,
      });
    }
  }

  return normalized.map(({ inventoryItemId, quantity, input }) => {
    const inventory = byId.get(inventoryItemId);
    const unitPrice = money(inventory.selling_price);
    return {
      inventoryItemId,
      itemName: inventory.name,
      sku: inventory.sku || 'N/A',
      barcode: inventory.barcode || null,
      category: inventory.category || null,
      quantity,
      unitPrice,
      lineTotal: money(quantity * unitPrice),
      costPrice: Number(inventory.cost_price) || 0,
      scopeType: inventory.scope_type,
      scopeId: inventory.scope_id,
    };
  });
}

async function createExchangeReplacementSale({
  connection,
  originalSale,
  returnData,
  exchangeItems,
  actor,
  returnedTotal,
  returnOldBalance,
  postReturnBalanceFromCore,
}) {
  const originalScopeType = originalSale.scopeType || originalSale.scope_type;
  const originalScopeId = originalSale.scopeId || originalSale.scope_id;
  const normalizedItems = await validateExchangeItems(connection, exchangeItems, originalSale);
  const replacementTotal = money(normalizedItems.reduce((sum, item) => sum + item.lineTotal, 0));
  const priceDifference = money(replacementTotal - returnedTotal);

  const scopeType = returnData.scope_type;
  const scopeId = String(returnData.scope_id);
  let numericScopeId = typeof scopeId === 'string' ? parseInt(scopeId) : scopeId;
  if (!Number.isInteger(numericScopeId) || numericScopeId <= 0) {
    const table = scopeType === 'WAREHOUSE' ? 'warehouses' : 'branches';
    const [scopeRows] = await connection.execute(
      `SELECT id FROM ${table} WHERE name = ? LIMIT 1`,
      [scopeId]
    );
    numericScopeId = scopeRows[0]?.id || numericScopeId;
  }
  let invoiceNo;
  try {
    invoiceNo = await InvoiceNumberService.generateInvoiceNumber(scopeType, numericScopeId);
  } catch (invoiceError) {
    invoiceNo = await InvoiceNumberService.generateInvoiceNumber(scopeType, numericScopeId);
  }

  const ledgerParty = {
    scopeType,
    scopeId,
    retailerId: returnData.retailer_id ?? originalSale.retailer_id ?? null,
    customerName: returnData.customer_name,
    customerPhone: returnData.customer_phone,
  };
  const migrationDone = await isLedgerMigrationComplete(connection);
  const postReturnBalance = migrationDone
    ? await CustomerLedgerEntries.getCustomerBalance(connection, ledgerParty)
    : money(postReturnBalanceFromCore ?? ((Number(returnOldBalance) || 0) - returnedTotal));

  const saleItems = normalizedItems.map((item) => ({
    inventoryItemId: item.inventoryItemId,
    itemName: item.itemName,
    name: item.itemName,
    sku: item.sku,
    barcode: item.barcode,
    category: item.category,
    quantity: item.quantity,
    unitPrice: item.unitPrice,
    originalPrice: item.unitPrice,
    total: item.lineTotal,
    costPrice: item.costPrice,
    discount: 0,
    discountType: null,
  }));

  await Sale.create({
    invoiceNo,
    scopeType,
    scopeId,
    userId: actor.id || null,
    shiftId: null,
    items: saleItems,
    subtotal: replacementTotal,
    tax: 0,
    discount: 0,
    total: replacementTotal,
    paymentMethod: 'EXCHANGE',
    paymentType: 'EXCHANGE',
    paymentStatus: 'CASH',
    customerInfo: null,
    notes: returnData.notes,
    status: 'COMPLETED',
    customerName: returnData.customer_name,
    customerPhone: returnData.customer_phone,
    paymentAmount: 0,
    creditAmount: replacementTotal,
    oldBalance: postReturnBalance,
    runningBalance: money(postReturnBalance + replacementTotal),
    creditStatus: null,
    creditDueDate: null,
    customerId: returnData.customer_id ?? originalSale.customer_id ?? null,
    retailerId: returnData.retailer_id ?? originalSale.retailer_id ?? null,
  }, connection);

  const [replacementRows] = await connection.execute(
    'SELECT * FROM sales WHERE invoice_no = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 1',
    [invoiceNo]
  );
  const replacementSale = replacementRows[0];
  if (!replacementSale) throw new Error('Failed to load replacement sale');

  if (migrationDone) {
    const finalBalance = await CustomerLedgerEntries.getCustomerBalance(connection, ledgerParty);
    await CustomerLedgerEntries.insertInvoiceSnapshot(connection, {
      sale_id: replacementSale.id,
      customer_id: replacementSale.customer_id,
      retailer_id: replacementSale.retailer_id,
      scope_type: replacementSale.scope_type,
      scope_id: replacementSale.scope_id,
      invoice_no: replacementSale.invoice_no,
      old_balance: postReturnBalance,
      total: replacementTotal,
      payment: 0,
      final_balance: finalBalance,
    });
  } else {
    const { recalculateCustomerLedger } = require('../../services/ledgerRecalcService');
    await recalculateCustomerLedger({
      retailerId: originalSale.retailerId ?? originalSale.retailer_id,
      customerPhone: originalSale.customerPhone ?? originalSale.customer_phone,
      customerName: originalSale.customerName ?? originalSale.customer_name,
      scopeType: originalScopeType,
      scopeName: String(originalScopeId),
      connection,
    });
  }

  return { normalizedItems, replacementSale, replacementTotal, priceDifference };
}

async function finalizeExchangeReturn(connection, returnId, result) {
  await connection.execute(
    `UPDATE sales_returns
     SET replacement_sale_id = ?, replacement_total = ?, price_difference = ?, updated_at = NOW()
     WHERE id = ?`,
    [
      result.replacementSale.id,
      result.replacementTotal,
      result.priceDifference,
      returnId,
    ]
  );

  for (const item of result.normalizedItems) {
    await connection.execute(
      `INSERT INTO sales_exchange_items (
        return_id, inventory_item_id, item_name, sku, barcode, category,
        quantity, unit_price, line_total
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        returnId,
        item.inventoryItemId,
        item.itemName,
        item.sku,
        item.barcode,
        item.category,
        item.quantity,
        item.unitPrice,
        item.lineTotal,
      ]
    );
  }
}

module.exports = {
  createExchangeReplacementSale,
  finalizeExchangeReturn,
};
