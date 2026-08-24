const express = require('express');
const router = express.Router();
const branchController = require('../controllers/branchController');
const { getBranchSettings, updateBranchSettings } = require('../controllers/simplifiedBranchSettingsController');
const { requireAdmin, requireCashier, requireBranchSettingsAccess } = require('../middleware/rbac');
const { branchValidation } = require('../middleware/validation');
// auth is already applied globally in server.js — do NOT import or use it here

// GET /api/branches
router.get('/', requireCashier, branchController.getBranches);

// POST /api/branches/remap-scope  (must be before /:id routes)
router.post('/remap-scope', requireAdmin, branchController.repairBranchScopeName);

// GET /api/branches/:id
router.get('/:id', requireCashier, branchController.getBranch);

// POST /api/branches
router.post('/', requireAdmin, branchValidation, branchController.createBranch);

// PUT /api/branches/:id
router.put('/:id', requireAdmin, branchValidation, branchController.updateBranch);

// GET /api/branches/:id/settings
router.get('/:id/settings', requireBranchSettingsAccess, getBranchSettings);

// PUT /api/branches/:id/settings
router.put('/:id/settings', requireAdmin, updateBranchSettings);

// DELETE /api/branches/:id
router.delete('/:id', requireAdmin, branchController.deleteBranch);

module.exports = router;