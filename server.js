process.on('uncaughtException', (error) => {
  process.stderr.write(`Uncaught Exception: ${error.message}\n${error.stack}\n`);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  process.stderr.write(`Unhandled Rejection: ${reason}\n`);
  process.exit(1);
});

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
require('dotenv').config();

const errorHandler = require('./middleware/errorHandler');
const { connectDB, closeDB } = require('./config/database');
const auth = require('./middleware/auth');
const adminSimulation = require('./middleware/adminSimulation');

// Import routes
const authRoutes = require('./routes/auth');
const branchRoutes = require('./routes/branches');
const warehouseRoutes = require('./routes/warehouses');
const inventoryRoutes = require('./routes/inventory');
const companyRoutes = require('./routes/companies');
const salesRoutes = require('./routes/sales');
const posRoutes = require('./routes/pos');
const ledgerRoutes = require('./routes/ledger');
const transferRoutes = require('./routes/transfers');
const dashboardRoutes = require('./routes/dashboard');
const hardwareRoutes = require('./routes/hardware');
const billingRoutes = require('./routes/billing');
const adminRoutes = require('./routes/admin');
const shiftRoutes = require('./routes/shifts');
const warehouseSalesRoutes = require('./routes/warehouseSales');
const retailerRoutes = require('./routes/retailers');
const warehouseSalesAnalyticsRoutes = require('./routes/warehouseSalesAnalytics');
const customerRoutes = require('./routes/customers');
const warehouseLedgerRoutes = require('./routes/warehouseLedger');
const companyLedgerRoutes = require('./routes/companyLedger');
const customerLedgerRoutes = require('./routes/customerLedger');
const receiptRoutes = require('./routes/receipt');
const reportsRoutes = require('./routes/reports');
const stockReportRoutes = require('./routes/stockReportRoutes');
const financialVoucherRoutes = require('./routes/financialVoucherRoutes');
const salespeopleRoutes = require('./routes/salespeople');
const returnsRoutes = require('./routes/returns');
const purchaseOrdersRoutes = require('./routes/purchaseOrders');
const categoriesRoutes = require('./routes/categories');
const clinicServicesRoutes = require('./routes/clinicServices');
const trashRoutes = require('./routes/trash');
const settlementRoutes = require('./routes/settlements');
const biltyRoutes = require('./routes/bilty');
const creditDebitRoutes = require('./routes/creditDebit');
const barcodeRoutes = require('./routes/barcode');
const qmsRoutes = require('./routes/qms');
const { startTrashScheduler } = require('./services/trashScheduler');
const { startInventoryReconciliationJob } = require('./services/inventoryReconciliationJob');

const app = express();

// Connect to MySQL
if (process.env.NODE_ENV !== 'test') {
  connectDB().catch(err => {
    process.stderr.write(`DB connection failed at startup: ${err.message}\n`);
  });
}

// Security middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https:"],
    },
  },
}));

// CORS
app.use(cors({
  origin: [
    'http://localhost:3000',
    'http://localhost:3001',
    process.env.CORS_ORIGIN
  ].filter(Boolean),
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'Idempotency-Key',
    'idempotency-key',
    'x-simulate-scope-type',
    'x-simulate-scope-id'
  ]
}));

// ─────────────────────────────────────────────────────────────
// RATE LIMITING — fixed for multi-branch/warehouse usage
// ─────────────────────────────────────────────────────────────

// Auth routes — strict (prevent brute force login attempts)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,   // 15 minutes
  max: 30,                      // 30 login attempts per IP per 15 min
  keyGenerator: (req) => req.ip,
  message: { success: false, message: 'Too many login attempts, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path === '/refresh' // don't limit token refresh
});

// General API — generous, per-user (not per-IP shared)
const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,    // 1 minute window
  max: 1200,                    // allow high-volume POS bursts per user/session
  // Key by user token if available, otherwise by IP
  // This means Branch 1 flooding won't affect Branch 2
  keyGenerator: (req) => {
    const auth = req.headers.authorization
    if (auth && auth.startsWith('Bearer ')) {
      // Use first 20 chars of token as key (unique per user session)
      return auth.substring(7, 27)
    }
    return req.ip
  },
  message: { success: false, message: 'Too many requests, please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Export/heavy endpoints — separate bucket so exports don't eat general quota
const heavyLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,    // 1 minute
  max: 20,                      // 20 exports per minute per user
  keyGenerator: (req) => {
    const auth = req.headers.authorization
    if (auth && auth.startsWith('Bearer ')) return auth.substring(7, 27)
    return req.ip
  },
  message: { success: false, message: 'Too many export requests, please wait a moment.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Apply rate limiters
app.use('/api/auth', authLimiter);
app.use('/api/customer-ledger/:id/export', heavyLimiter);
app.use('/api/reports', heavyLimiter);
app.use('/api/stock-reports', heavyLimiter);
app.use('/api', apiLimiter);

// HTTP request logging
app.use(morgan('combined'));

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());

// Health check
app.get('/api/health', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'Server is running',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV,
    uptime: process.uptime()
  });
});

// ─────────────────────────────────────────────────────────────
// AUTH MIDDLEWARE — runs ONCE per request, not twice
// ─────────────────────────────────────────────────────────────
// Apply auth + adminSimulation globally here so individual
// route files do NOT need to apply auth again
app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/auth')) return next();      // skip auth routes
  if (req.path === '/health') return next();             // skip health check
  if (!req.headers.authorization) {
    return res.status(401).json({
      success: false,
      message: 'Access token required'
    });
  }
  auth(req, res, () => adminSimulation(req, res, next));
});

// ─────────────────────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/branches', branchRoutes);
app.use('/api/warehouses', warehouseRoutes);
app.use('/api/inventory', inventoryRoutes);
app.use('/api/companies', companyRoutes);
app.use('/api/sales', salesRoutes);
app.use('/api/pos', posRoutes);
app.use('/api/ledger', ledgerRoutes);
app.use('/api/transfers', transferRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/hardware', hardwareRoutes);
app.use('/api/billing', billingRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/shifts', shiftRoutes);
app.use('/api/warehouse-sales', warehouseSalesRoutes);
app.use('/api/retailers', retailerRoutes);
app.use('/api/warehouse-sales-analytics', warehouseSalesAnalyticsRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/warehouse-ledger', warehouseLedgerRoutes);
app.use('/api/company-ledger', companyLedgerRoutes);
app.use('/api/customer-ledger', customerLedgerRoutes);
app.use('/api/credit-debit', creditDebitRoutes);
app.use('/api/receipt', receiptRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/stock-reports', stockReportRoutes);
app.use('/api/financial-vouchers', financialVoucherRoutes);
app.use('/api/salespeople', salespeopleRoutes);
app.use('/api/returns', returnsRoutes);
app.use('/api/purchase-orders', purchaseOrdersRoutes);
app.use('/api/categories', categoriesRoutes);
app.use('/api/clinic-services', clinicServicesRoutes);
app.use('/api/trash', trashRoutes);
app.use('/api/settlements', settlementRoutes);
app.use('/api/bilty', biltyRoutes);
app.use('/api/barcode', barcodeRoutes);
app.use('/api/qms', qmsRoutes);

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    message: `Route ${req.originalUrl} not found`
  });
});

// Error handler (must be last)
app.use(errorHandler);

// Graceful shutdown
process.on('SIGTERM', async () => { await closeDB(); process.exit(0); });
process.on('SIGINT', async () => { await closeDB(); process.exit(0); });

const parsedPort = Number.parseInt(process.env.PORT, 10);
const PORT = Number.isInteger(parsedPort) && parsedPort >= 0 && parsedPort < 65536
  ? parsedPort
  : 5000;

if (process.env.NODE_ENV !== 'test') {
  try {
    startTrashScheduler();
    startInventoryReconciliationJob();
    const server = app.listen(PORT, '0.0.0.0', () => {
      const address = server.address();
      process.stdout.write(`Server running on http://${address.address}:${address.port} [${process.env.NODE_ENV || 'development'}]\n`);
      process.stdout.write(`Started at: ${new Date().toISOString()}\n`);
    });

    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        process.stderr.write(`Port ${PORT} is already in use\n`);
      } else {
        process.stderr.write(`Server error: ${err.message}\n`);
      }
      process.exit(1);
    });
  } catch (error) {
    process.stderr.write(`Failed to start: ${error.message}\n`);
    process.exit(1);
  }
}

module.exports = app;