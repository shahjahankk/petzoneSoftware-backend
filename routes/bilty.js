const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { rbac } = require('../middleware/rbac');
const biltyController = require('../controllers/biltyController');

router.get('/', auth, rbac('ADMIN', 'WAREHOUSE_KEEPER'), biltyController.getBilties);
router.get('/:id', auth, rbac('ADMIN', 'WAREHOUSE_KEEPER'), biltyController.getBilty);
router.post('/', auth, rbac('ADMIN', 'WAREHOUSE_KEEPER'), biltyController.createBilty);
router.put('/:id', auth, rbac('ADMIN'), biltyController.updateBilty);
router.delete('/:id', auth, rbac('ADMIN'), biltyController.deleteBilty);

module.exports = router;
