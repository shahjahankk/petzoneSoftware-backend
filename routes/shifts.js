const express = require('express');
const router = express.Router();
const shiftController = require('../controllers/shiftController');
const { requireAdmin, requireWarehouseKeeper, requireCashier } = require('../middleware/rbac');
const { validateShift, validateShiftUpdate, validateShiftAssignment } = require('../middleware/validation');
// auth is already applied globally in server.js — do NOT add it here

router.get('/', requireCashier, shiftController.getShifts);
router.get('/current', shiftController.getCurrentShift);
router.get('/validate-pos-access', shiftController.validatePOSAccess);
router.get('/branch/:branchId', requireWarehouseKeeper, shiftController.getShifts);
router.get('/recent-sessions', requireCashier, shiftController.getRecentShiftSessions);
router.get('/active/:cashierId', shiftController.getActiveShift);
router.get('/:id', requireWarehouseKeeper, shiftController.getShift);
router.post('/:id/assign-user', requireWarehouseKeeper, shiftController.assignUserToShift);
router.delete('/:id/assign-user/:userId', requireWarehouseKeeper, shiftController.removeUserFromShift);

module.exports = router;