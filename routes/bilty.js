const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { rbac } = require('../middleware/rbac');
const biltyController = require('../controllers/biltyController');

router.get('/', auth, biltyController.getBilties);
router.get('/:id', auth, biltyController.getBilty);
router.post('/', auth, biltyController.createBilty);
router.put('/:id', auth, rbac('ADMIN'), biltyController.updateBilty);
router.delete('/:id', auth, rbac('ADMIN'), biltyController.deleteBilty);

module.exports = router;
