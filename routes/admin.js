const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const { requireAdmin } = require('../middleware/rbac');
const { inventoryItemValidation, userValidation, userUpdateValidation } = require('../middleware/validation');

router.get('/dashboard', requireAdmin, adminController.getSystemDashboard);
router.get('/branches', requireAdmin, adminController.getAllBranches);
router.put('/branches/:id/settings', requireAdmin, adminController.updateBranchSettings);
router.put('/branches/bulk-settings', requireAdmin, adminController.bulkUpdateBranchSettings);
router.get('/inventories', requireAdmin, adminController.getAllInventories);
router.put('/inventories/:id', requireAdmin, inventoryItemValidation, adminController.updateAnyInventory);
router.get('/companies', requireAdmin, adminController.getAllCompanies);
router.get('/sales', requireAdmin, adminController.getAllSales);
router.get('/ledgers', requireAdmin, adminController.getAllLedgers);
router.post('/users', requireAdmin, userValidation, adminController.createUser);
router.get('/users', requireAdmin, adminController.getAllUsers);
router.put('/users/:id', requireAdmin, userUpdateValidation, adminController.updateUser);
router.delete('/users/:id', requireAdmin, adminController.deleteUser);
router.put('/users/:id/reset-password', requireAdmin, adminController.resetUserPassword);
router.get('/users/:id/password', requireAdmin, adminController.getUserPassword);

module.exports = router;