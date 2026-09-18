const { pool } = require('../config/database');

let schemaReady;

const ensureSchema = async () => {
  if (!schemaReady) {
    schemaReady = (async () => {
      await pool.execute(`
        CREATE TABLE IF NOT EXISTS company_ledger_entries (
          id INT AUTO_INCREMENT PRIMARY KEY,
          company_id INT NOT NULL,
          scope_type VARCHAR(30) NULL,
          scope_id VARCHAR(100) NULL,
          entry_type VARCHAR(30) NOT NULL,
          reference_type VARCHAR(40) NULL,
          reference_id VARCHAR(100) NULL,
          payment_method VARCHAR(40) NULL,
          debit_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
          credit_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
          description VARCHAR(500) NOT NULL,
          entry_date DATE NOT NULL,
          created_by INT NULL,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY uq_company_ledger_reference (reference_type, reference_id, entry_type),
          INDEX idx_company_ledger_company_date (company_id, entry_date, id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
    })().catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  return schemaReady;
};

const addEntry = async ({
  companyId, scopeType = null, scopeId = null, entryType, referenceType = null,
  referenceId = null, paymentMethod = null, debitAmount = 0, creditAmount = 0,
  description, entryDate, createdBy = null
}) => {
  await ensureSchema();
  const [result] = await pool.execute(`
    INSERT INTO company_ledger_entries (
      company_id, scope_type, scope_id, entry_type, reference_type, reference_id,
      payment_method, debit_amount, credit_amount, description, entry_date, created_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_DATE), ?)
    ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)
  `, [
    companyId, scopeType, scopeId, entryType, referenceType, referenceId,
    paymentMethod, Number(debitAmount) || 0, Number(creditAmount) || 0,
    description, entryDate || null, createdBy
  ]);
  return result.insertId;
};

const recordPurchaseOrder = async ({ purchaseOrder, paymentMethod = 'CREDIT', paidAmount = 0, createdBy }) => {
  const total = Number(purchaseOrder.totalAmount) || 0;
  const paid = Math.max(0, Math.min(Number(paidAmount) || 0, total));
  await addEntry({
    companyId: purchaseOrder.supplierId,
    scopeType: purchaseOrder.scopeType,
    scopeId: purchaseOrder.scopeId,
    entryType: 'PURCHASE',
    referenceType: 'PURCHASE_ORDER',
    referenceId: String(purchaseOrder.id),
    debitAmount: total,
    description: `Purchase ${purchaseOrder.orderNumber}`,
    entryDate: purchaseOrder.orderDate,
    createdBy
  });

  if (paid > 0) {
    await addEntry({
      companyId: purchaseOrder.supplierId,
      scopeType: purchaseOrder.scopeType,
      scopeId: purchaseOrder.scopeId,
      entryType: 'PAYMENT',
      referenceType: 'PURCHASE_ORDER',
      referenceId: String(purchaseOrder.id),
      paymentMethod,
      creditAmount: paid,
      description: `Payment for ${purchaseOrder.orderNumber}`,
      entryDate: purchaseOrder.orderDate,
      createdBy
    });
  }
};

module.exports = { ensureSchema, addEntry, recordPurchaseOrder };
