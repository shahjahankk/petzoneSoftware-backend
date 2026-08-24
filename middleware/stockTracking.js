/**
 * stock_reports: LEGACY audit copy only — NOT used for stock calculation.
 * On-hand quantity is always from inventory_ledger_entries + projection cache.
 */
const { pool } = require('../config/database');
const { getCurrentStock } = require('../services/inventoryLedgerService');

/**
 * Create a stock report entry in inventory_transactions table
 * This function logs all inventory changes for audit and reporting purposes
 * @param {object} transactionData - The transaction data
 * @param {object} connection - Optional database connection (for transactions)
 */
const createStockReportEntry = async (transactionData, connection = null) => {
  try {
    const {
      inventoryItemId,
      transactionType,
      quantityChange,
      previousQuantity,
      newQuantity,
      unitPrice = 0,
      totalValue = 0,
      userId,
      userName,
      userRole,
      saleId = null,
      returnId = null,
      transferId = null,
      adjustmentReason = null
    } = transactionData;

    // Validate required fields
    if (!inventoryItemId || !transactionType || !userId || !userName || !userRole) {
      return;
    }

    const dbConnection = connection || pool;

    // Get inventory item details
    const [items] = await dbConnection.execute(
      'SELECT * FROM inventory_items WHERE id = ?',
      [inventoryItemId]
    );
    
    if (items.length === 0) {
      return;
    }

    const item = items[0];

    // Use provided scope if available (for returns), otherwise use item's scope
    const finalScopeType = transactionData.scopeType || item.scope_type;
    const finalScopeId = transactionData.scopeId !== null && transactionData.scopeId !== undefined ? transactionData.scopeId : item.scope_id;
    const finalScopeName = transactionData.scopeId !== null && transactionData.scopeId !== undefined ? String(transactionData.scopeId) : String(item.scope_id);


    // stock_reports: LEGACY audit / UI only — NOT used for on-hand stock (ledger is truth).
    await dbConnection.execute(`
      INSERT INTO stock_reports (
        inventory_item_id, 
        item_name, 
        item_sku, 
        item_category,
        scope_type, 
        scope_id, 
        scope_name, 
        transaction_type,
        quantity_change, 
        previous_quantity, 
        new_quantity,
        unit_price, 
        total_value, 
        user_id, 
        user_name, 
        user_role,
        sale_id, 
        return_id, 
        transfer_id, 
        adjustment_reason,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
    `, [
      inventoryItemId, 
      item.name, 
      item.sku, 
      item.category,
      finalScopeType, 
      finalScopeId, 
      finalScopeName, // scope_name is same as scope_id in current implementation
      transactionType,
      quantityChange, 
      previousQuantity, 
      newQuantity,
      unitPrice, 
      totalValue, 
      userId, 
      userName, 
      userRole,
      saleId, 
      returnId, 
      transferId, 
      adjustmentReason
    ]);

    
  } catch (error) {
    throw error; // Re-throw to ensure transaction rollback
  }
};

/**
 * Create transaction record for sale
 * @param {number} inventoryItemId - The inventory item ID
 * @param {number} quantity - The quantity sold (positive value)
 * @param {number} unitPrice - The unit price
 * @param {number} userId - The user ID who made the sale
 * @param {string} userName - The user name
 * @param {string} userRole - The user role
 * @param {number} saleId - The sale ID
 * @param {object} connection - Optional database connection (for transactions)
 */
const createSaleTransaction = async (inventoryItemId, quantity, unitPrice, userId, userName, userRole, saleId, connection = null) => {
  try {
    
    const quantityChange = -Math.abs(quantity); // Sales reduce stock
    const dbConnection = connection || pool;
    const [exists] = await dbConnection.execute('SELECT id FROM inventory_items WHERE id = ?', [inventoryItemId]);
    if (exists.length === 0) {
      return;
    }

    const newQuantity = await getCurrentStock(inventoryItemId, dbConnection);
    const previousQuantity = newQuantity + Math.abs(quantity);
    const totalValue = Math.abs(quantity) * unitPrice;


    await createStockReportEntry({
      inventoryItemId,
      transactionType: 'SALE',
      quantityChange,
      previousQuantity,
      newQuantity,
      unitPrice,
      totalValue,
      userId,
      userName,
      userRole,
      saleId
    }, connection);
    
  } catch (error) {
    throw error; // Re-throw to see what's failing
  }
};

/**
 * Create transaction record for return
 * @param {number} inventoryItemId - The inventory item ID
 * @param {number} quantity - The quantity returned (positive value)
 * @param {number} unitPrice - The unit price
 * @param {number} userId - The user ID who processed the return
 * @param {string} userName - The user name
 * @param {string} userRole - The user role
 * @param {number} returnId - The return ID
 * @param {object} connection - Optional database connection (for transactions)
 * @param {string} scopeType - The scope type (BRANCH or WAREHOUSE) from the original sale
 * @param {string|number} scopeId - The scope ID from the original sale
 */
const createReturnTransaction = async (
  inventoryItemId,
  quantity,
  unitPrice,
  userId,
  userName,
  userRole,
  returnId,
  connection = null,
  scopeType = null,
  scopeId = null,
  affectStock = true // when false, we log the return without changing stock levels
) => {
  try {
    
    const quantityChange = Math.abs(quantity); // Returns increase stock when affectStock is true
    const dbConnection = connection || pool;
    const [rex] = await dbConnection.execute('SELECT id FROM inventory_items WHERE id = ?', [inventoryItemId]);
    if (rex.length === 0) {
      return;
    }

    const newQuantity = await getCurrentStock(inventoryItemId, dbConnection);
    let previousQuantity = newQuantity - Math.abs(quantity);
    if (!affectStock) {
      previousQuantity = newQuantity;
    }
    const totalValue = Math.abs(quantity) * unitPrice;


    await createStockReportEntry({
      inventoryItemId,
      transactionType: 'RETURN',
      quantityChange,
      previousQuantity,
      newQuantity,
      unitPrice,
      totalValue,
      userId,
      userName,
      userRole,
      returnId,
      scopeType,
      scopeId
    }, connection);
    
  } catch (error) {
    throw error; // Re-throw to see what's failing
  }
};

/**
 * Create transaction record for stock adjustment
 * @param {number} inventoryItemId - The inventory item ID
 * @param {number} previousQuantity - The previous stock quantity
 * @param {number} newQuantity - The new stock quantity
 * @param {number} userId - The user ID who made the adjustment
 * @param {string} userName - The user name
 * @param {string} userRole - The user role
 * @param {string} reason - The reason for adjustment
 * @param {object} connection - Optional database connection (for transactions)
 */
const createAdjustmentTransaction = async (inventoryItemId, previousQuantity, newQuantity, userId, userName, userRole, reason, connection = null) => {
  const quantityChange = newQuantity - previousQuantity;
  const unitPrice = 0; // Adjustments don't have unit price
  const totalValue = 0;

  await createStockReportEntry({
    inventoryItemId,
    transactionType: 'ADJUSTMENT',
    quantityChange,
    previousQuantity,
    newQuantity,
    unitPrice,
    totalValue,
    userId,
    userName,
    userRole,
    adjustmentReason: reason
  }, connection);
};

module.exports = { 
  createStockReportEntry,
  createSaleTransaction,
  createReturnTransaction,
  createAdjustmentTransaction
};