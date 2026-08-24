const express = require('express');
const router = express.Router();
const { rbac } = require('../middleware/rbac');
const {
  transferValidation,
  transferStatusValidation,
  handleValidation
} = require('../middleware/validation');
const {
  createTransfer, getTransfers, getTransfer, updateTransferStatus,
  getLocationTransferSettings, getTransferSettings, updateTransferSettings,
  completeTransfer, getTransferLogs, getTransferMovements, getTransferStatistics
} = require('../controllers/transferController');
// auth is already applied globally in server.js

router.route('/')
  .get(rbac('ADMIN', 'CASHIER', 'WAREHOUSE_KEEPER'), getTransfers)
  .post(rbac('ADMIN', 'CASHIER', 'WAREHOUSE_KEEPER'), transferValidation, handleValidation, createTransfer);

router.route('/logs').get(rbac('ADMIN'), getTransferLogs);
router.route('/statistics').get(rbac('ADMIN', 'WAREHOUSE_KEEPER'), getTransferStatistics);
router.route('/settings')
  .get(rbac('ADMIN'), getTransferSettings)
  .put(rbac('ADMIN'), updateTransferSettings);
router.route('/settings/:type/:id').get(rbac('ADMIN', 'CASHIER', 'WAREHOUSE_KEEPER'), getLocationTransferSettings);

router.route('/:id').get(rbac('ADMIN', 'CASHIER', 'WAREHOUSE_KEEPER'), getTransfer);
router.route('/:id/status').put(rbac('ADMIN', 'CASHIER', 'WAREHOUSE_KEEPER'), transferStatusValidation, handleValidation, updateTransferStatus);
router.route('/:id/complete').put(rbac('ADMIN', 'WAREHOUSE_KEEPER'), completeTransfer);
router.route('/:id/movements').get(rbac('ADMIN', 'WAREHOUSE_KEEPER'), getTransferMovements);

module.exports = router;