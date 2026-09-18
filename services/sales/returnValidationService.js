const { pool } = require('../../config/database');

const MONEY_EPS = 0.02;

function saleItemLabel(si) {
  return String(si.item_name || si.name || '').trim();
}

function normalizeKey(value) {
  return String(value || '').trim().toLowerCase();
}

function matchOriginalSaleItem(requestItem, originalSaleItems) {
  if (requestItem.inventoryItemId != null && requestItem.inventoryItemId !== '') {
    const id = parseInt(requestItem.inventoryItemId, 10);
    if (Number.isFinite(id)) {
      const byId = originalSaleItems.find(
        (si) => si.inventory_item_id != null && parseInt(si.inventory_item_id, 10) === id
      );
      if (byId) return byId;
    }
  }

  if (requestItem.sku) {
    const skuKey = normalizeKey(requestItem.sku);
    const bySku = originalSaleItems.find((si) => normalizeKey(si.sku) === skuKey);
    if (bySku) return bySku;
  }

  if (requestItem.productName) {
    const nameKey = normalizeKey(requestItem.productName);
    const byName = originalSaleItems.find((si) => normalizeKey(saleItemLabel(si)) === nameKey);
    if (byName) return byName;
  }

  return null;
}

/**
 * Server-side return validation: qty caps vs prior returns and refund allocation
 * from the original sale's discounted, tax-inclusive line values.
 */
async function validateAndNormalizeReturnItems(saleId, requestItems, originalSaleItems, originalSale = {}, connection = null) {
  const executor = connection || pool
  const [priorRows] = await executor.execute(
    `SELECT sri.inventory_item_id, sri.item_name, sri.quantity
     FROM sales_return_items sri
     INNER JOIN sales_returns sr ON sr.id = sri.return_id
     WHERE sr.original_sale_id = ?
       AND sr.status NOT IN ('CANCELLED', 'REJECTED')
     FOR UPDATE`,
    [saleId]
  );

  const returnedByInvId = new Map();
  const returnedByName = new Map();
  for (const row of priorRows) {
    const qty = parseFloat(row.quantity) || 0;
    if (row.inventory_item_id != null) {
      returnedByInvId.set(row.inventory_item_id, (returnedByInvId.get(row.inventory_item_id) || 0) + qty);
    } else if (row.item_name) {
      const key = String(row.item_name).trim().toLowerCase();
      returnedByName.set(key, (returnedByName.get(key) || 0) + qty);
    }
  }

  const requestedByKey = new Map();
  const saleTax = Number(originalSale.tax) || 0;
  const saleDiscount = Number(originalSale.discount) || 0;
  const saleLinesGross = originalSaleItems.reduce((sum, item) => {
    return sum + (Number(item.unit_price) || 0) * (Number(item.quantity) || 0);
  }, 0);
  const saleLinesNet = originalSaleItems.reduce((sum, item) => {
    const gross = (Number(item.unit_price) || 0) * (Number(item.quantity) || 0);
    return sum + Math.max(0, gross - (Number(item.discount) || 0));
  }, 0);

  let totalRefund = 0;
  const normalizedItems = [];

  for (const item of requestItems) {
    const reqQty = parseFloat(item.quantity) || 0;
    if (reqQty <= 0) {
      throw new Error(`Return quantity must be greater than 0 for ${item.productName || 'item'}`);
    }

    const originalSaleItem = matchOriginalSaleItem(item, originalSaleItems);

    if (!originalSaleItem) {
      throw new Error(
        `Item "${item.productName || item.inventoryItemId}" was not found on the original sale`
      );
    }

    const origQty = parseFloat(originalSaleItem.quantity) || 0;
    const invId = originalSaleItem.inventory_item_id;
    const nameKey = normalizeKey(saleItemLabel(originalSaleItem));
    const itemKey = invId != null ? `id:${invId}` : `name:${nameKey}`;
    const alreadyReturned = invId != null
      ? (returnedByInvId.get(invId) || 0)
      : (returnedByName.get(nameKey) || 0);
    const requestedQty = requestedByKey.get(itemKey) || 0;

    if (reqQty + requestedQty + alreadyReturned > origQty + 0.001) {
      throw new Error(
        `Cannot return ${reqQty} of "${saleItemLabel(originalSaleItem)}" — ` +
          `sold ${origQty}, already returned ${alreadyReturned + requestedQty}`
      );
    }

    const unitPrice = parseFloat(originalSaleItem.unit_price) || 0;
    const lineGross = unitPrice * origQty;
    const lineDiscount = Number(originalSaleItem.discount) || 0;
    const lineNet = Math.max(0, lineGross - lineDiscount);
    const returnedShare = origQty > 0 ? reqQty / origQty : 0;
    const allocatedSaleDiscount = saleLinesGross > 0
      ? saleDiscount * (lineGross / saleLinesGross) * returnedShare
      : 0;
    const allocatedTax = saleLinesNet > 0
      ? saleTax * (lineNet / saleLinesNet) * returnedShare
      : 0;
    const lineRefund = Math.round(
      Math.max(0, (lineNet * returnedShare) - allocatedSaleDiscount + allocatedTax) * 100
    ) / 100;
    totalRefund += lineRefund;
    requestedByKey.set(itemKey, requestedQty + reqQty);
    normalizedItems.push({
      ...item,
      quantity: reqQty,
      refundAmount: lineRefund,
      unitPrice,
      inventoryItemId: invId ?? item.inventoryItemId ?? null,
      productName: item.productName || saleItemLabel(originalSaleItem),
    });
  }

  totalRefund = Math.round(totalRefund * 100) / 100;
  if (totalRefund <= 0) {
    throw new Error('Total refund must be greater than zero');
  }

  return { totalRefund, normalizedItems };
}

module.exports = {
  validateAndNormalizeReturnItems,
  MONEY_EPS,
};
