const express = require('express');
const router = express.Router();
const { getRetailers, getRetailer, createRetailer, updateRetailer, deleteRetailer } = require('../controllers/retailersController');
const { rbac, requireAdmin, requireWarehouseKeeper } = require('../middleware/rbac');
const { validateRetailer, handleValidation } = require('../middleware/validation');
const { checkWarehouseKeeperRetailerCreatePermission, checkWarehouseKeeperRetailerEditPermission } = require('../middleware/branchPermissions');

// ── Specific routes before /:id ───────────────────────────────
router.get('/stats/summary', rbac('ADMIN', 'WAREHOUSE_KEEPER'), async (req, res) => {
  try {
    const { getRetailerStats } = require('../controllers/retailersController');
    return getRetailerStats(req, res);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/warehouse', requireWarehouseKeeper, (req, res, next) => {
  req.query.warehouseId = req.user.warehouseId;
  return getRetailers(req, res, next);
});

router.get('/warehouse/:warehouseId', requireAdmin, (req, res, next) => {
  req.query.warehouseId = req.params.warehouseId;
  return getRetailers(req, res, next);
});

router.post('/warehouse',
  requireWarehouseKeeper,
  checkWarehouseKeeperRetailerCreatePermission,
  validateRetailer, handleValidation,
  (req, res, next) => { req.body.warehouseId = req.user.warehouseId; return createRetailer(req, res, next); }
);

router.put('/warehouse/:id',
  requireWarehouseKeeper,
  checkWarehouseKeeperRetailerEditPermission,
  validateRetailer, handleValidation,
  updateRetailer
);

router.delete('/warehouse/:id', requireAdmin, deleteRetailer);

// ── Main CRUD ─────────────────────────────────────────────────
router.get('/', rbac('ADMIN', 'WAREHOUSE_KEEPER'), getRetailers);

router.get('/:id', async (req, res, next) => {
  if (req.user.role === 'ADMIN') return getRetailer(req, res, next);
  if (req.user.role === 'WAREHOUSE_KEEPER') {
    try {
      const Retailer = require('../models/Retailer');
      const retailer = await Retailer.findById(req.params.id);
      if (!retailer) return res.status(404).json({ success: false, message: 'Retailer not found' });
      if (Number(retailer.warehouseId) !== Number(req.user.warehouseId))
        return res.status(403).json({ success: false, message: 'Access denied - This retailer does not belong to your warehouse' });
      return getRetailer(req, res, next);
    } catch (error) {
      return res.status(500).json({ success: false, message: error.message });
    }
  }
  return res.status(403).json({ success: false, message: 'Unauthorized' });
});

router.post('/',
  (req, res, next) => {
    if (req.user.role === 'ADMIN') return next();
    if (req.user.role === 'WAREHOUSE_KEEPER') {
      req.body.warehouseId = req.user.warehouseId;
      return checkWarehouseKeeperRetailerCreatePermission(req, res, next);
    }
    return res.status(403).json({ success: false, message: 'Unauthorized' });
  },
  validateRetailer, handleValidation,
  createRetailer
);

router.put('/:id',
  async (req, res, next) => {
    if (req.user.role === 'ADMIN') return next();
    if (req.user.role === 'WAREHOUSE_KEEPER') {
      try {
        const Retailer = require('../models/Retailer');
        const retailer = await Retailer.findById(req.params.id);
        if (!retailer) return res.status(404).json({ success: false, message: 'Retailer not found' });
        req.retailer = retailer;
        if (Number(retailer.warehouseId) !== Number(req.user.warehouseId))
          return res.status(403).json({ success: false, message: 'Access denied' });
        return checkWarehouseKeeperRetailerEditPermission(req, res, next);
      } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
      }
    }
    return res.status(403).json({ success: false, message: 'Unauthorized' });
  },
  validateRetailer, handleValidation,
  updateRetailer
);

router.delete('/:id', requireAdmin, deleteRetailer);

module.exports = router;