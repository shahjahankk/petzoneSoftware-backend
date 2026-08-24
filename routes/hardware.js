const express = require('express');
const router = express.Router();
const { rbac } = require('../middleware/rbac');
const { validateHardwareOperation } = require('../middleware/validation');
const {
  scanBarcode, printReceipt, openCashDrawer, getWeight, getHardwareDevices,
  registerDevice, updateDeviceStatus, deleteDevice, getHardwareSessions,
  getLatestEvents, getEventsSince, getHardwareStatus
} = require('../controllers/hardwareController');
// auth is already applied globally in server.js — do NOT add router.use(auth) here

// Barcode & Receipt (rbac temporarily disabled per original)
router.post('/scan', validateHardwareOperation, scanBarcode);
router.post('/print-receipt', validateHardwareOperation, printReceipt);

// Cash Drawer & Scale
router.post('/open-cashdrawer', rbac('ADMIN', 'WAREHOUSE_KEEPER', 'CASHIER'), validateHardwareOperation, openCashDrawer);
router.post('/scale', rbac('ADMIN', 'WAREHOUSE_KEEPER', 'CASHIER'), validateHardwareOperation, getWeight);

// Test routes
router.get('/test-auth', (req, res) => res.json({ success: true, message: 'Auth middleware working', user: req.user }));
router.get('/test-rbac', rbac('ADMIN', 'WAREHOUSE_KEEPER'), (req, res) => res.json({ success: true, message: 'RBAC middleware working', user: req.user }));

// Device management
router.get('/devices/all', rbac('ADMIN'), getHardwareDevices);
router.get('/devices/:scopeType/:scopeId', getHardwareDevices);
router.post('/devices/register', validateHardwareOperation, registerDevice);
router.put('/devices/:deviceId/status', rbac('ADMIN', 'WAREHOUSE_KEEPER'), validateHardwareOperation, updateDeviceStatus);
router.delete('/devices/:id', rbac('ADMIN'), deleteDevice);

// Sessions & events
router.get('/sessions', getHardwareSessions);
router.get('/events/latest', rbac('ADMIN', 'WAREHOUSE_KEEPER', 'CASHIER'), getLatestEvents);
router.get('/events/since', rbac('ADMIN', 'WAREHOUSE_KEEPER', 'CASHIER'), getEventsSince);
router.get('/status', getHardwareStatus);

module.exports = router;