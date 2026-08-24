/**
 * Keep customer sub-ledger, invoice snapshots, and GL in sync for sales/settlements.
 */
const LedgerService = require('./ledgerService');
const CustomerLedgerEntries = require('./customerLedgerEntriesService');
const { isLedgerMigrationComplete } = require('./ledgerMigrationMeta');

/**
 * Post customer ledger + snapshot + GL for an existing settlement sale row.
 * @param {import('mysql2/promise').PoolConnection} connection
 * @param {number} settlementId
 */
async function finalizeSettlementSale(connection, settlementId) {
  const [rows] = await connection.execute('SELECT * FROM sales WHERE id = ?', [settlementId]);
  if (!rows.length) return null;

  const sr = rows[0];
  const migrated = await isLedgerMigrationComplete(connection);

  if (migrated) {
    await CustomerLedgerEntries.appendFromSalesRow(connection, sr);
    const balAfter = await CustomerLedgerEntries.getCustomerBalance(connection, {
      scopeType: sr.scope_type,
      scopeId: sr.scope_id,
      retailerId: sr.retailer_id,
      customerName: sr.customer_name,
      customerPhone: sr.customer_phone,
    });
    const { debit, credit } = CustomerLedgerEntries.debitCreditForSaleRow(sr);
    const oldSnap = balAfter - (debit - credit);
    const pay = Math.abs(parseFloat(sr.payment_amount) || 0);
    await CustomerLedgerEntries.insertInvoiceSnapshot(connection, {
      sale_id: settlementId,
      customer_id: sr.customer_id,
      retailer_id: sr.retailer_id,
      scope_type: sr.scope_type,
      scope_id: sr.scope_id,
      invoice_no: sr.invoice_no,
      old_balance: oldSnap,
      total: 0,
      payment: pay,
      final_balance: balAfter,
    });
  }

  const isCreditRefund = sr.payment_type === 'CREDIT_REFUND_SETTLEMENT';
  const payAmt = Math.abs(parseFloat(sr.payment_amount) || parseFloat(sr.total) || 0);

  await LedgerService.recordSaleTransaction(
    {
      saleId: settlementId,
      invoiceNo: sr.invoice_no,
      scopeType: sr.scope_type,
      scopeId: sr.scope_id,
      totalAmount: Math.abs(parseFloat(sr.total) || payAmt),
      paymentAmount: isCreditRefund ? 0 : payAmt,
      creditAmount: isCreditRefund ? payAmt : 0,
      paymentMethod: sr.payment_method,
      customerInfo: {
        name: sr.customer_name,
        phone: sr.customer_phone,
        isCreditRefund,
      },
      userId: sr.user_id,
      items: [],
      isSettlement: true,
      isCreditRefund,
    },
    connection
  );

  return sr;
}

/**
 * Remove AR + GL postings for a sale (used on soft-delete).
 */
async function removeSaleFromLedgers(connection, saleId, saleRow = null) {
  let row = saleRow;
  if (!row) {
    const [rows] = await connection.execute('SELECT * FROM sales WHERE id = ?', [saleId]);
    row = rows[0];
  }
  if (!row) return;

  const migrated = await isLedgerMigrationComplete(connection);
  if (migrated) {
    await connection.execute('DELETE FROM customer_ledger_entries WHERE ref_id = ?', [saleId]);
    await connection.execute('DELETE FROM invoice_snapshots WHERE sale_id = ?', [saleId]);
  }

  await LedgerService.removeEntriesForSaleReference(connection, saleId);
}

/**
 * Re-post GL after sale row changed (customer ledger uses upsert via appendFromSalesRow).
 */
async function syncSaleGlFromRow(connection, saleRow, items = []) {
  await LedgerService.removeEntriesForSaleReference(connection, saleRow.id);

  const glItems = (items || []).map((item) => ({
    quantity: parseFloat(item.quantity) || 0,
    costPrice: parseFloat(item.cost_price ?? item.costPrice ?? 0) || 0,
  }));

  await LedgerService.recordSaleTransaction(
    {
      saleId: saleRow.id,
      invoiceNo: saleRow.invoice_no,
      scopeType: saleRow.scope_type,
      scopeId: saleRow.scope_id,
      totalAmount: parseFloat(saleRow.total) || 0,
      paymentAmount: parseFloat(saleRow.payment_amount) || 0,
      creditAmount: parseFloat(saleRow.credit_amount) || 0,
      paymentMethod: saleRow.payment_method,
      customerInfo: {
        name: saleRow.customer_name,
        phone: saleRow.customer_phone,
      },
      userId: saleRow.user_id,
      items: glItems,
    },
    connection
  );
}

module.exports = {
  finalizeSettlementSale,
  removeSaleFromLedgers,
  syncSaleGlFromRow,
};
