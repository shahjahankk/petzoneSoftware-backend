const express = require('express');
const router = express.Router();
const { formatReceipt, formatReceiptJSON, formatReceiptPDF } = require('../utils/receiptFormatter');
// auth is already applied globally in server.js — do NOT add it here

// Helper to resolve scope details (branch or warehouse)
const getScopeDetails = async (scopeType, scopeId) => {
  if (scopeType === 'BRANCH') {
    const Branch = require('../models/Branch');
    const branch = await Branch.findById(scopeId);
    return { name: branch?.name || 'Branch', location: branch?.address || '', contact: branch?.phone || '' };
  }
  if (scopeType === 'WAREHOUSE') {
    const Warehouse = require('../models/Warehouse');
    const warehouse = await Warehouse.findById(scopeId);
    return { name: warehouse?.name || 'Warehouse', location: warehouse?.address || '', contact: warehouse?.phone || '' };
  }
  return {};
};

router.post('/format', async (req, res) => {
  try {
    const { sale, scopeType, scopeId } = req.body;
    if (!sale) return res.status(400).json({ error: 'Sale data is required' });
    const scopeDetails = await getScopeDetails(scopeType, scopeId);
    const receiptText = await formatReceipt(sale, scopeDetails, scopeType);
    res.setHeader('Content-Type', 'text/plain');
    res.send(receiptText);
  } catch { res.status(500).json({ error: 'Failed to format receipt' }); }
});

router.post('/format/json', async (req, res) => {
  try {
    const { sale, scopeType, scopeId } = req.body;
    if (!sale) return res.status(400).json({ error: 'Sale data is required' });
    const scopeDetails = await getScopeDetails(scopeType, scopeId);
    const receiptJSON = await formatReceiptJSON(sale, scopeDetails, scopeType);
    res.json(JSON.parse(receiptJSON));
  } catch { res.status(500).json({ error: 'Failed to format receipt JSON' }); }
});

router.post('/format/pdf', async (req, res) => {
  try {
    const { sale, scopeType, scopeId } = req.body;
    if (!sale) return res.status(400).json({ error: 'Sale data is required' });
    const scopeDetails = await getScopeDetails(scopeType, scopeId);
    const receiptHTML = await formatReceiptPDF(sale, scopeDetails, scopeType);
    res.setHeader('Content-Type', 'text/html');
    res.send(receiptHTML);
  } catch { res.status(500).json({ error: 'Failed to format receipt PDF' }); }
});

module.exports = router;