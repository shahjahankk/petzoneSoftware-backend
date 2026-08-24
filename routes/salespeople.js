const express = require('express');
const router = express.Router();
const { rbac } = require('../middleware/rbac');
const {
  getSalespeople, getSalesperson, createSalesperson, updateSalesperson,
  deleteSalesperson, getSalespersonPerformance, getSalespeopleForWarehouseBilling
} = require('../controllers/salespersonController');
// auth is already applied globally in server.js — do NOT add it here

router.route('/')
  .get(rbac('ADMIN', 'WAREHOUSE_KEEPER'), getSalespeople)
  .post(rbac('ADMIN', 'WAREHOUSE_KEEPER'), createSalesperson);

router.route('/warehouse-billing')
  .get(rbac('ADMIN', 'WAREHOUSE_KEEPER'), getSalespeopleForWarehouseBilling);

router.route('/:id')
  .get(rbac('ADMIN', 'WAREHOUSE_KEEPER'), getSalesperson)
  .put(rbac('ADMIN', 'WAREHOUSE_KEEPER'), updateSalesperson)
  .delete(rbac('ADMIN', 'WAREHOUSE_KEEPER'), deleteSalesperson);

router.route('/:id/performance')
  .get(rbac('ADMIN', 'WAREHOUSE_KEEPER'), getSalespersonPerformance);

module.exports = router;