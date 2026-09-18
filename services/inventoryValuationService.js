const { pool } = require('../config/database');

const getWeightedAverageValuation = async ({ scopeType, scopeId, asOfDate = null, executor = pool } = {}) => {
  const params = [];
  const where = [];
  if (scopeType) { where.push('i.scope_type = ?'); params.push(String(scopeType).toUpperCase()); }
  if (scopeId !== undefined && scopeId !== null && scopeId !== '') { where.push('CAST(i.scope_id AS CHAR) = CAST(? AS CHAR)'); params.push(String(scopeId)); }
  const ledgerDateClause = asOfDate ? 'AND le.entry_date <= ?' : '';
  const ledgerDateParams = asOfDate ? [asOfDate] : [];

  const [rows] = await executor.execute(`
    SELECT
      i.id AS inventory_item_id,
      i.name,
      i.sku,
      i.category,
      i.scope_type,
      i.scope_id,
      COALESCE(SUM(le.quantity_in - le.quantity_out), 0) AS quantity_on_hand,
      COALESCE(SUM(CASE WHEN le.quantity_in > 0 THEN le.quantity_in * COALESCE(le.unit_cost, 0) ELSE 0 END), 0) AS received_cost,
      COALESCE(SUM(CASE WHEN le.quantity_in > 0 THEN le.quantity_in ELSE 0 END), 0) AS received_quantity,
      COALESCE(SUM(CASE WHEN le.quantity_out > 0 THEN le.quantity_out ELSE 0 END), 0) AS issued_quantity,
      COALESCE(MAX(NULLIF(le.unit_cost, 0)), i.cost_price, 0) AS catalog_cost
    FROM inventory_items i
    LEFT JOIN inventory_ledger_entries le ON le.inventory_item_id = i.id
      AND le.scope_type = i.scope_type
      AND CAST(le.scope_id AS CHAR) = CAST(i.scope_id AS CHAR)
      ${ledgerDateClause}
    ${where.length ? `WHERE ${where.filter((clause) => clause !== 'le.entry_date <= ?').join(' AND ')}` : ''}
    GROUP BY i.id, i.name, i.sku, i.category, i.scope_type, i.scope_id, i.cost_price
    HAVING quantity_on_hand > 0
    ORDER BY i.name ASC
  `, [...ledgerDateParams, ...params]);

  return rows.map((row) => {
    const quantity = Number(row.quantity_on_hand) || 0;
    const receivedQuantity = Number(row.received_quantity) || 0;
    const receivedCost = Number(row.received_cost) || 0;
    const averageCost = receivedQuantity > 0
      ? receivedCost / receivedQuantity
      : Number(row.catalog_cost) || 0;
    return {
      inventoryItemId: row.inventory_item_id,
      name: row.name,
      sku: row.sku,
      category: row.category,
      scopeType: row.scope_type,
      scopeId: row.scope_id,
      quantityOnHand: quantity,
      averageCost,
      inventoryValue: quantity * averageCost,
      receivedQuantity,
      issuedQuantity: Number(row.issued_quantity) || 0,
      valuationMethod: 'WEIGHTED_AVERAGE'
    };
  });
};

module.exports = { getWeightedAverageValuation };
