const express = require('express');
const router = express.Router();
const { rbac } = require('../middleware/rbac');
const { validateSale, validateSaleUpdate, validateReturn } = require('../middleware/validation');
const { requireShiftAccessForSales } = require('../middleware/shiftAccess');
const { checkCashierSalesPermission } = require('../middleware/salesPermissions');
const { getInvoiceSnapshotBySaleId } = require('../controllers/invoiceSnapshotController');
const {
  createSale, getSales, getSale, updateSale, deleteSale,
  createSalesReturn, getSalesReturns, getSalesReturn, updateSalesReturn,
  getCompanySalesHistory, getInvoiceDetails, searchProducts, searchSales,
  getInvoiceStats, getNextInvoiceNumber, getSalespersonInvoiceStats,
  searchOutstandingPayments, clearOutstandingPayment
} = require('../controllers/salesController');
// auth is already applied globally in server.js — do NOT add it here

router.route('/')
  .get(rbac('ADMIN', 'CASHIER', 'WAREHOUSE_KEEPER'), getSales)
  .post(rbac('ADMIN', 'CASHIER'), requireShiftAccessForSales, checkCashierSalesPermission, validateSale, createSale);

router.route('/returns')
  .get(rbac('ADMIN', 'CASHIER', 'WAREHOUSE_KEEPER'), getSalesReturns)
  .post(rbac('ADMIN', 'CASHIER', 'WAREHOUSE_KEEPER'), validateReturn, createSalesReturn);

router.route('/returns/:id')
  .get(rbac('ADMIN', 'CASHIER', 'WAREHOUSE_KEEPER'), getSalesReturn)
  .put(rbac('ADMIN', 'CASHIER', 'WAREHOUSE_KEEPER'), updateSalesReturn);

router.route('/company/:companyId')
  .get(rbac('ADMIN', 'CASHIER', 'WAREHOUSE_KEEPER'), getCompanySalesHistory);

router.route('/invoice/:invoiceId')
  .get(rbac('ADMIN', 'CASHIER', 'WAREHOUSE_KEEPER'), getInvoiceDetails);

router.route('/products/search')
  .get(rbac('ADMIN', 'CASHIER', 'WAREHOUSE_KEEPER'), searchProducts);

router.route('/search')
  .get((req, res, next) => {
    next();
  }, rbac('ADMIN', 'CASHIER', 'WAREHOUSE_KEEPER'), searchSales);

router.route('/invoice-stats/:scopeType/:scopeId')
  .get(rbac('ADMIN', 'CASHIER', 'WAREHOUSE_KEEPER'), getInvoiceStats);

router.route('/next-invoice/:scopeType/:scopeId')
  .get(rbac('ADMIN', 'CASHIER', 'WAREHOUSE_KEEPER'), getNextInvoiceNumber);

router.route('/salesperson-stats/:warehouseId/:userId')
  .get(rbac('ADMIN', 'WAREHOUSE_KEEPER'), getSalespersonInvoiceStats);

router.route('/outstanding')
  .get(rbac('ADMIN', 'CASHIER', 'WAREHOUSE_KEEPER'), searchOutstandingPayments);

router.route('/clear-outstanding')
  .post(rbac('ADMIN', 'CASHIER', 'WAREHOUSE_KEEPER'), clearOutstandingPayment);

router.get(
  '/:id/invoice-snapshot',
  rbac('ADMIN', 'CASHIER', 'WAREHOUSE_KEEPER'),
  getInvoiceSnapshotBySaleId
);

router.route('/:id')
  .get(rbac('ADMIN', 'CASHIER', 'WAREHOUSE_KEEPER'), getSale)
  .put(rbac('ADMIN', 'CASHIER', 'WAREHOUSE_KEEPER'), checkCashierSalesPermission, validateSaleUpdate, updateSale)
  .delete(rbac('ADMIN', 'CASHIER', 'WAREHOUSE_KEEPER'), checkCashierSalesPermission, deleteSale);

module.exports = router;