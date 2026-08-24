const Sale = require('../../models/Sale');

/**
 * Customer balance helper used by sale/return controllers.
 * Post-migration: SUM(debit - credit) on customer_ledger_entries.
 * Pre-migration: latest sales.running_balance for the party in scope.
 */
async function getCustomerRunningBalance(customerName, customerPhone, scopeType, scopeName) {
  return Sale.getCustomerRunningBalance(customerName, customerPhone, scopeType, scopeName);
}

module.exports = { getCustomerRunningBalance };
