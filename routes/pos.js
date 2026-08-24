const express = require('express');
const router = express.Router();
const { rbac, requireBranchAccess } = require('../middleware/rbac');
const { requireShiftAccess, requireShiftAccessForSales } = require('../middleware/shiftAccess');
const {
  getBranchPOS, getAllPOS, getPOS, createPOS, updatePOS, deletePOS,
  getPOSStatus, updatePOSStatus, getPOSSales, getPOSInventory
} = require('../controllers/posController');
// auth is already applied globally in server.js — do NOT add it here

router.route('/')
  .get(rbac('ADMIN', 'WAREHOUSE_KEEPER', 'CASHIER'), getAllPOS)
  .post(rbac('ADMIN', 'WAREHOUSE_KEEPER'), createPOS);

router.route('/branch/:branchId')
  .get(rbac('ADMIN', 'WAREHOUSE_KEEPER', 'CASHIER'), requireBranchAccess, getBranchPOS);

router.route('/hold')
  .get(rbac('ADMIN', 'WAREHOUSE_KEEPER', 'CASHIER'), (req, res) => {
    res.json({ success: true, data: [], message: 'Held bills functionality not yet implemented' });
  });

router.route('/:id')
  .get(rbac('ADMIN', 'WAREHOUSE_KEEPER', 'CASHIER'), getPOS)
  .put(rbac('ADMIN', 'WAREHOUSE_KEEPER'), updatePOS)
  .delete(rbac('ADMIN'), deletePOS);

router.route('/:id/status')
  .get(rbac('ADMIN', 'WAREHOUSE_KEEPER', 'CASHIER'), getPOSStatus)
  .put(rbac('ADMIN', 'WAREHOUSE_KEEPER', 'CASHIER'), updatePOSStatus);

router.route('/:id/sales')
  .get(rbac('ADMIN', 'WAREHOUSE_KEEPER', 'CASHIER'), getPOSSales);

router.route('/:id/inventory')
  .get(rbac('ADMIN', 'WAREHOUSE_KEEPER', 'CASHIER'), getPOSInventory);

module.exports = router;