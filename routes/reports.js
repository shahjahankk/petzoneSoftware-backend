const express = require('express');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const router = express.Router();
const reportsController = require('../controllers/reportsController');

// auth is already applied globally in server.js — do NOT add it here

// ─────────────────────────────────────────────────────────────────────────────
// Reporting lives in the standalone data-warehouse service (petzone-data-warehouse).
// The POS backend only proxies the five analytics endpoints so the existing
// frontend keeps the same /api/reports/* URLs. There is deliberately NO legacy
// fallback: if the warehouse is unreachable the request fails instead of
// silently returning numbers computed from OLTP with different date rules.
// ─────────────────────────────────────────────────────────────────────────────

const WAREHOUSE_SERVICE_URL = (process.env.WAREHOUSE_SERVICE_URL || 'http://127.0.0.1:4100').replace(/\/+$/, '');
const WAREHOUSE_PROXY_TIMEOUT_MS = Number(process.env.WAREHOUSE_PROXY_TIMEOUT_MS || 8000);

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
]);

function proxyToWarehouse(req, res) {
  let target;
  try {
    target = new URL(`${WAREHOUSE_SERVICE_URL}${req.originalUrl}`);
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Invalid WAREHOUSE_SERVICE_URL', error: error.message });
  }

  const transport = target.protocol === 'https:' ? https : http;

  const headers = {};
  Object.entries(req.headers).forEach(([key, value]) => {
    if (!HOP_BY_HOP.has(key.toLowerCase()) && value !== undefined) headers[key] = value;
  });
  headers.host = target.host;

  const proxyReq = transport.request(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      method: req.method,
      path: `${target.pathname}${target.search}`,
      headers,
      timeout: WAREHOUSE_PROXY_TIMEOUT_MS,
    },
    (proxyRes) => {
      res.status(proxyRes.statusCode || 502);
      Object.entries(proxyRes.headers).forEach(([key, value]) => {
        if (!HOP_BY_HOP.has(key.toLowerCase()) && value !== undefined) res.setHeader(key, value);
      });
      proxyRes.pipe(res);
    }
  );

  proxyReq.on('timeout', () => {
    proxyReq.destroy(new Error(`Warehouse request timed out after ${WAREHOUSE_PROXY_TIMEOUT_MS}ms`));
  });

  proxyReq.on('error', (error) => {
    if (res.headersSent) return res.destroy();
    res.status(502).json({
      success: false,
      message: 'Reporting service unavailable. Start petzone-data-warehouse and check WAREHOUSE_SERVICE_URL.',
      error: error.message,
    });
  });

  req.pipe(proxyReq);
}

// Dashboard counters are cheap OLTP counts, not analytics reports.
router.get('/summary', reportsController.getReportsSummary);

// Analytics reports are served exclusively by the warehouse service.
router.use(['/sales', '/clinic', '/inventory', '/ledger', '/financial'], proxyToWarehouse);

module.exports = router;
