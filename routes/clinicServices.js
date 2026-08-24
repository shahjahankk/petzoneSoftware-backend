const express = require('express');
const { body } = require('express-validator');
const { requireAdmin, rbac } = require('../middleware/rbac');
const controller = require('../controllers/clinicServiceController');

const router = express.Router();

const categoryValidation = [
  body('name').trim().isLength({ min: 1, max: 100 }).withMessage('Name required (max 100 chars)'),
  body('description').optional().trim().isLength({ max: 500 }),
  body('status').optional().isIn(['ACTIVE', 'INACTIVE']),
  body('sortOrder').optional().isInt({ min: 0 }),
];

const serviceValidation = [
  body('name').trim().isLength({ min: 1, max: 200 }).withMessage('Service name required'),
  body('categoryId').optional({ nullable: true }).isInt({ min: 1 }),
  body('description').optional().trim().isLength({ max: 500 }),
  body('defaultPrice').isFloat({ min: 0 }).withMessage('Default price must be >= 0'),
  body('code').optional().trim().isLength({ max: 50 }),
  body('status').optional().isIn(['ACTIVE', 'INACTIVE']),
  body('sortOrder').optional().isInt({ min: 0 }),
];

router.get('/billing', rbac('ADMIN', 'CASHIER', 'WAREHOUSE_KEEPER'), controller.listActiveForBilling);

router.get('/categories', rbac('ADMIN', 'CASHIER', 'WAREHOUSE_KEEPER'), controller.listCategories);
router.post('/categories', requireAdmin, categoryValidation, controller.createCategory);
router.put('/categories/:id', requireAdmin, categoryValidation, controller.updateCategory);
router.delete('/categories/:id', requireAdmin, controller.deleteCategory);

router.get('/', rbac('ADMIN', 'CASHIER', 'WAREHOUSE_KEEPER'), controller.listServices);
router.post('/', requireAdmin, serviceValidation, controller.createService);
router.put('/:id', requireAdmin, serviceValidation, controller.updateService);
router.delete('/:id', requireAdmin, controller.deleteService);

module.exports = router;
