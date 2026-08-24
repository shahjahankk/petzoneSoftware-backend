const express = require('express');
const router = express.Router();
const {
  getWarehouseLedgerAccounts,
  createWarehouseLedgerAccount,
  updateWarehouseLedgerAccount,
  deleteWarehouseLedgerAccount,
  getWarehouseLedgerEntries,
  createWarehouseLedgerEntry,
  updateWarehouseLedgerEntry,
  deleteWarehouseLedgerEntry,
  getWarehouseBalanceSummary,
} = require('../controllers/warehouseLedgerController');
const { requireWarehouseKeeper } = require('../middleware/rbac');
const { enforceWarehouseLedgerTarget } = require('../middleware/warehouseLedgerAccess');
// auth is already applied globally in server.js — do NOT add it here

router.get(
  '/accounts/:warehouseId',
  requireWarehouseKeeper,
  enforceWarehouseLedgerTarget,
  getWarehouseLedgerAccounts
);
router.post(
  '/accounts',
  requireWarehouseKeeper,
  enforceWarehouseLedgerTarget,
  createWarehouseLedgerAccount
);
router.put('/accounts/:id', requireWarehouseKeeper, updateWarehouseLedgerAccount);
router.delete('/accounts/:id', requireWarehouseKeeper, deleteWarehouseLedgerAccount);

router.get(
  '/entries/:warehouseId',
  requireWarehouseKeeper,
  enforceWarehouseLedgerTarget,
  getWarehouseLedgerEntries
);
router.post(
  '/entries',
  requireWarehouseKeeper,
  enforceWarehouseLedgerTarget,
  createWarehouseLedgerEntry
);
router.put('/entries/:id', requireWarehouseKeeper, updateWarehouseLedgerEntry);
router.delete('/entries/:id', requireWarehouseKeeper, deleteWarehouseLedgerEntry);

router.get(
  '/balance-summary/:warehouseId',
  requireWarehouseKeeper,
  enforceWarehouseLedgerTarget,
  getWarehouseBalanceSummary
);

module.exports = router;
