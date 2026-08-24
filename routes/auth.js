const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const auth = require('../middleware/auth');
const { loginValidation, refreshValidation } = require('../middleware/validation');

// auth routes are PUBLIC by default — server.js skips global auth for /api/auth/*
// BUT logout and /me still need auth, so we apply it manually ONLY on those routes

// POST /api/auth/login — public
router.post('/login', loginValidation, authController.login);

// POST /api/auth/logout — needs auth (user must be logged in to logout)
router.post('/logout', auth, authController.logout);

// POST /api/auth/refresh — public (no token yet, getting a new one)
router.post('/refresh', refreshValidation, authController.refresh);

// GET /api/auth/me — needs auth
router.get('/me', auth, authController.getMe);

module.exports = router;