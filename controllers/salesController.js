'use strict';

const { createSale } = require('./sales/createSaleController');
        const {
  getSales,
  getSale,
  updateSale,
  deleteSale,
} = require('./sales/salesCrudController');
    const { 
  createSalesReturn,
  getSalesReturns,
  getSalesReturn,
  updateSalesReturn,
} = require('./sales/salesReturnsController');
const {
  getCompanySalesHistory,
  getInvoiceDetails,
} = require('./sales/salesHistoryController');
const {
  searchProducts,
  searchSales,
} = require('./sales/salesSearchController');
const {
  getInvoiceStats,
  getSalespersonInvoiceStats,
  getNextInvoiceNumber,
} = require('./sales/salesInvoiceStatsController');
const {
  searchOutstandingPayments,
  clearOutstandingPayment,
} = require('./sales/salesOutstandingController');
    
    module.exports = {
      createSale,
      getSales,
      getSale,
      updateSale,
      deleteSale,
      createSalesReturn,
      getSalesReturns,
      getSalesReturn,
      updateSalesReturn,
      getCompanySalesHistory,
      getInvoiceDetails,
      searchProducts,
      searchSales,
      getInvoiceStats,
      getNextInvoiceNumber,
      getSalespersonInvoiceStats,
      searchOutstandingPayments,
  clearOutstandingPayment,
    };
