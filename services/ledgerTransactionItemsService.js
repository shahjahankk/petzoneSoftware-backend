/**
 * Batch-load sale / return / bilty line items for ledger rows.
 */
const { pool } = require('../config/database');

function normalizeSaleItemRow(item) {
  const itemName = item.item_name || item.name || 'Unknown Item';
  return {
    ...item,
    item_name: itemName,
    name: itemName,
    quantity: parseFloat(item.quantity) || 0,
    unit_price: parseFloat(item.unit_price) || 0,
    total: parseFloat(item.total) || 0,
  };
}

function fallbackLineItems(transaction) {
  const pt = transaction.payment_type || '';
  const pm = transaction.payment_method || '';
  const type = transaction.transaction_type || '';

  if (pt === 'OUTSTANDING_SETTLEMENT' || type === 'SETTLEMENT') {
    const amt =
      parseFloat(transaction.payment_amount || transaction.total || 0) || 0;
    return [
      {
        item_name: 'Outstanding settlement',
        name: 'Outstanding settlement',
        quantity: 1,
        unit_price: amt,
        total: amt,
      },
    ];
  }

  if (type === 'RETURN' || pm === 'REFUND' || pt === 'REFUND') {
    const amt =
      parseFloat(
        transaction.return_refund_amount ||
          transaction.total ||
          transaction.amount ||
          0
      ) || 0;
    return [
      {
        item_name: 'Return / refund',
        name: 'Return / refund',
        quantity: 1,
        unit_price: amt,
        total: amt,
      },
    ];
  }

  const amt =
    parseFloat(
      transaction.amount || transaction.subtotal || transaction.total || 0
    ) || 0;
  if (amt > 0) {
    return [
      {
        item_name: 'Invoice total (line items not stored in database)',
        name: 'Invoice total (line items not stored in database)',
        quantity: 1,
        unit_price: amt,
        total: amt,
      },
    ];
  }

  return [];
}

async function loadSaleItemsMap(saleIds) {
  const map = new Map();
  if (!saleIds.length) return map;

  const unique = [...new Set(saleIds.map((id) => Number(id)).filter(Boolean))];
  const ph = unique.map(() => '?').join(',');
  const [rows] = await pool.execute(
    `
    SELECT si.*, ii.name AS item_name, ii.sku, ii.selling_price AS catalog_price,
           ii.cost_price, ii.category
    FROM sale_items si
    LEFT JOIN inventory_items ii ON si.inventory_item_id = ii.id
    WHERE si.sale_id IN (${ph})
    ORDER BY si.sale_id, si.id
  `,
    unique
  );

  for (const row of rows) {
    const sid = row.sale_id;
    if (!map.has(sid)) map.set(sid, []);
    map.get(sid).push(normalizeSaleItemRow(row));
  }
  return map;
}

async function loadReturnItemsMap(returnIds) {
  const map = new Map();
  if (!returnIds.length) return map;

  const unique = [...new Set(returnIds.map((id) => Number(id)).filter(Boolean))];
  const ph = unique.map(() => '?').join(',');
  const [rows] = await pool.execute(
    `
    SELECT sri.*, ii.name AS item_name, ii.sku
    FROM sales_return_items sri
    LEFT JOIN inventory_items ii ON sri.inventory_item_id = ii.id
    WHERE sri.return_id IN (${ph})
    ORDER BY sri.return_id, sri.id
  `,
    unique
  );

  for (const row of rows) {
    const rid = row.return_id;
    if (!map.has(rid)) map.set(rid, []);
    const itemName = row.item_name || row.name || 'Unknown Item';
    map.get(rid).push({
      ...row,
      item_name: itemName,
      name: itemName,
      quantity: parseFloat(row.quantity) || 0,
      unit_price: parseFloat(row.unit_price) || 0,
      total: parseFloat(row.refund_amount || row.total) || 0,
    });
  }
  return map;
}

async function loadBiltyItemsMap(saleIds) {
  const map = new Map();
  if (!saleIds.length) return map;

  const unique = [...new Set(saleIds.map((id) => Number(id)).filter(Boolean))];
  const ph = unique.map(() => '?').join(',');
  const [rows] = await pool.execute(
    `SELECT * FROM bilty_items WHERE sale_id IN (${ph}) ORDER BY sale_id, id`,
    unique
  );

  for (const item of rows) {
    const sid = item.sale_id;
    if (!map.has(sid)) map.set(sid, []);
    map.get(sid).push({
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
      category: 'Transport',
    });
  }
  return map;
}

/** Resolve return_id for refund sale rows when join did not populate it. */
async function resolveReturnIdsForSales(saleIds) {
  const map = new Map();
  if (!saleIds.length) return map;

  const unique = [...new Set(saleIds.map((id) => Number(id)).filter(Boolean))];
  const ph = unique.map(() => '?').join(',');
  const [rows] = await pool.execute(
    `
    SELECT s.id AS sale_id, sr.id AS return_id
    FROM sales s
    INNER JOIN sales_returns sr ON sr.return_no = s.invoice_no OR sr.original_sale_id = s.id
    WHERE s.id IN (${ph})
  `,
    unique
  );

  for (const row of rows) {
    if (row.return_id) map.set(row.sale_id, row.return_id);
  }
  return map;
}

/**
 * @param {Array<object>} transactions
 * @returns {Promise<Array<object>>}
 */
async function attachLedgerTransactionItems(transactions) {
  if (!transactions?.length) return [];

  const saleIds = [];
  const returnIds = [];
  const biltyIds = [];
  const returnSaleIds = [];

  for (const t of transactions) {
    const id = Number(t.transaction_id);
    if (!id) continue;

    if (t.transaction_type === 'BILTY') {
      biltyIds.push(id);
    } else if (t.transaction_type === 'RETURN' || t.return_id) {
      if (t.return_id) returnIds.push(Number(t.return_id));
      else returnSaleIds.push(id);
    } else {
      saleIds.push(id);
    }
  }

  const extraReturnMap = await resolveReturnIdsForSales(returnSaleIds);
  for (const rid of extraReturnMap.values()) returnIds.push(rid);

  const [saleMap, returnMap, biltyMap] = await Promise.all([
    loadSaleItemsMap([...saleIds, ...returnSaleIds]),
    loadReturnItemsMap(returnIds),
    loadBiltyItemsMap(biltyIds),
  ]);

  return transactions.map((transaction) => {
    const saleId = Number(transaction.transaction_id);
    let items = [];

    try {
      if (transaction.transaction_type === 'BILTY') {
        items = biltyMap.get(saleId) || [];
      } else if (
        transaction.transaction_type === 'RETURN' ||
        transaction.return_id ||
        extraReturnMap.has(saleId)
      ) {
        const rid =
          Number(transaction.return_id) ||
          extraReturnMap.get(saleId) ||
          null;
        items = rid ? returnMap.get(rid) || [] : [];
        if (!items.length) items = saleMap.get(saleId) || [];
      } else {
        items = saleMap.get(saleId) || [];
      }

      if (!items.length) items = fallbackLineItems(transaction);
    } catch (error) {
      items = fallbackLineItems(transaction);
    }

    return { ...transaction, items };
  });
}

module.exports = {
  attachLedgerTransactionItems,
  fallbackLineItems,
  normalizeSaleItemRow,
};
