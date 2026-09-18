const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { rbac } = require('../middleware/rbac');
const settlementController = require('../controllers/settlementController');

router.get('/', auth, rbac('ADMIN', 'CASHIER', 'WAREHOUSE_KEEPER'), settlementController.getSettlements);
router.get('/:id', auth, rbac('ADMIN', 'CASHIER', 'WAREHOUSE_KEEPER'), settlementController.getSettlement);
router.post('/', auth, rbac('ADMIN', 'CASHIER', 'WAREHOUSE_KEEPER'), settlementController.createSettlement);
router.put('/:id', auth, rbac('ADMIN'), settlementController.updateSettlement);
router.delete('/:id', auth, rbac('ADMIN'), settlementController.deleteSettlement);

module.exports = router;
