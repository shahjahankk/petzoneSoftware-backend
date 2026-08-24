const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { rbac } = require('../middleware/rbac');
const settlementController = require('../controllers/settlementController');

router.get('/', auth, settlementController.getSettlements);
router.get('/:id', auth, settlementController.getSettlement);
router.post('/', auth, settlementController.createSettlement);
router.put('/:id', auth, rbac('ADMIN'), settlementController.updateSettlement);
router.delete('/:id', auth, rbac('ADMIN'), settlementController.deleteSettlement);

module.exports = router;
