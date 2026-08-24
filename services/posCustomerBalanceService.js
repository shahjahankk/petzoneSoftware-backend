const CustomerLedgerEntries = require('./customerLedgerEntriesService');

async function getPosCustomerBalance(connection, params) {
  const hasRetailerId = params?.retailerId != null && params?.retailerId !== '';
  if (hasRetailerId) {
    return CustomerLedgerEntries.getScopePartyBalanceForRetailer(connection, params);
  }
  return CustomerLedgerEntries.getCustomerBalance(connection, params);
}

module.exports = {
  getPosCustomerBalance,
};
