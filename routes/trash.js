const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { rbac } = require('../middleware/rbac');
const trashController = require('../controllers/trashController');

router.get('/', auth, rbac('ADMIN'), trashController.getTrashList);
router.get('/stats', auth, rbac('ADMIN'), trashController.getStats);
router.post('/:id/restore', auth, rbac('ADMIN'), trashController.restoreItem);
router.delete('/:id', auth, rbac('ADMIN'), trashController.permanentDelete);

module.exports = router;
