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
 * Server-side return validation: qty caps vs prior returns, refund = qty × original unit price.
 */
async function validateAndNormalizeReturnItems(saleId, requestItems, originalSaleItems) {
  const [priorRows] = await pool.execute(
    `SELECT sri.inventory_item_id, sri.item_name, SUM(sri.quantity) AS qty_returned
     FROM sales_return_items sri
     INNER JOIN sales_returns sr ON sr.id = sri.return_id
     WHERE sr.original_sale_id = ?
       AND sr.status NOT IN ('CANCELLED', 'REJECTED')
     GROUP BY sri.inventory_item_id, sri.item_name`,
    [saleId]
  );

  const returnedByInvId = new Map();
  const returnedByName = new Map();
  for (const row of priorRows) {
    const qty = parseFloat(row.qty_returned) || 0;
    if (row.inventory_item_id != null) {
      returnedByInvId.set(row.inventory_item_id, qty);
    } else if (row.item_name) {
      returnedByName.set(String(row.item_name).trim().toLowerCase(), qty);
    }
  }

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
    const alreadyReturned = invId != null
      ? (returnedByInvId.get(invId) || 0)
      : (returnedByName.get(nameKey) || 0);

    if (reqQty + alreadyReturned > origQty + 0.001) {
      throw new Error(
        `Cannot return ${reqQty} of "${saleItemLabel(originalSaleItem)}" — ` +
          `sold ${origQty}, already returned ${alreadyReturned}`
      );
    }

    const unitPrice = parseFloat(originalSaleItem.unit_price) || 0;
    const lineRefund = Math.round(unitPrice * reqQty * 100) / 100;
    const clientRefund = parseFloat(item.refundAmount);
    if (Number.isFinite(clientRefund) && Math.abs(clientRefund - lineRefund) > MONEY_EPS) {
      throw new Error(
        `Refund for "${saleItemLabel(originalSaleItem)}" must be ${lineRefund} (${reqQty} × ${unitPrice}), not ${clientRefund}`
      );
    }

    totalRefund += lineRefund;
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
