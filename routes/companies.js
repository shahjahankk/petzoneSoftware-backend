const express = require('express');
const router = express.Router();
const companyController = require('../controllers/companyController');
const { requireAdmin, requireWarehouseKeeper, requireCashier } = require('../middleware/rbac');
const { companyValidation } = require('../middleware/validation');
const { 
  checkWarehouseKeeperCompanyCreatePermission, checkWarehouseKeeperCompanyEditPermission,
  checkWarehouseKeeperCompanyDeletePermission, checkBranchCompanyCreatePermission,
  checkBranchCompanyEditPermission, checkBranchCompanyDeletePermission,
  checkBranchCompanyViewPermission,
} = require('../middleware/branchPermissions');

// ── Basic routes ──────────────────────────────────────────────
router.get('/', companyController.getCompanies);
router.get('/export', companyController.exportCompanies);
router.get('/:id', companyController.getCompany);
router.get('/:id/details', checkBranchCompanyViewPermission, companyController.getCompanyDetails);
router.get('/:id/export', checkBranchCompanyViewPermission, companyController.exportCompanyDetails);

// ── Warehouse-specific ────────────────────────────────────────
router.get('/warehouse', requireWarehouseKeeper, companyController.getCompanies);
router.post('/warehouse', requireWarehouseKeeper, checkWarehouseKeeperCompanyCreatePermission, companyValidation, companyController.createCompany);
router.put('/warehouse/:id', requireWarehouseKeeper, checkWarehouseKeeperCompanyEditPermission, companyValidation, companyController.updateCompany);
router.delete('/warehouse/:id', requireAdmin, companyController.deleteCompany);

// ── Branch-specific ───────────────────────────────────────────
router.get('/branch', requireCashier, companyController.getCompanies);
router.post('/branch', requireCashier, checkBranchCompanyCreatePermission, companyValidation, companyController.createCompany);
router.put('/branch/:id', requireCashier, checkBranchCompanyEditPermission, companyValidation, companyController.updateCompany);
router.delete('/branch/:id', requireAdmin, companyController.deleteCompany);

// ── Admin only ────────────────────────────────────────────────
router.get('/scope/:scopeType/:scopeId', requireAdmin, companyController.getCompanies);

// ── Legacy routes (auto-detect scope) ────────────────────────
router.post('/', (req, res, next) => {
  if (req.user.role === 'ADMIN') return next();
  if (req.user.role === 'WAREHOUSE_KEEPER') {
    req.body.scopeType = 'WAREHOUSE';
    req.body.scopeId = req.user.warehouseId;
    return checkWarehouseKeeperCompanyCreatePermission(req, res, next);
  }
  if (req.user.role === 'CASHIER') {
    req.body.scopeType = 'BRANCH';
    req.body.scopeId = req.user.branchId;
    return checkBranchCompanyCreatePermission(req, res, next);
  }
  return res.status(403).json({ success: false, message: 'Unauthorized' });
}, companyValidation, companyController.createCompany);

router.put('/:id', async (req, res, next) => {
  if (req.user.role === 'ADMIN') return next();
  try {
    const Company = require('../models/Company');
    const company = await Company.findById(req.params.id);
    if (!company) return res.status(404).json({ success: false, message: 'Company not found' });
    req.company = company;
    if (company.scopeType === 'WAREHOUSE') {
      if (req.user.role !== 'WAREHOUSE_KEEPER' || company.scopeId != req.user.warehouseId)
        return res.status(403).json({ success: false, message: 'Access denied' });
      return checkWarehouseKeeperCompanyEditPermission(req, res, next);
    }
    if (company.scopeType === 'BRANCH') {
      if (req.user.role !== 'CASHIER' || company.scopeId != req.user.branchId)
        return res.status(403).json({ success: false, message: 'Access denied' });
      return checkBranchCompanyEditPermission(req, res, next);
    }
    return next();
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
}, companyValidation, companyController.updateCompany);

router.delete('/:id', requireAdmin, companyController.deleteCompany);

module.exports = router;