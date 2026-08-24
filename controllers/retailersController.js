const { validationResult } = require('express-validator');
const { pool } = require('../config/database');
const trashService = require('../services/trashService');

// @desc    Get all retailers
// @route   GET /api/retailers
// @access  Private (Admin, Warehouse Keeper)
const getRetailers = async (req, res) => {
  try {
    const { status, businessType, paymentTerms, warehouseId } = req.query;
    const whereConditions = [];
    const params = [];

    if (req.user.role === 'WAREHOUSE_KEEPER') {
      whereConditions.push('warehouse_id = ?');
      params.push(warehouseId || req.user.warehouseId);
    } else if (req.user.role === 'CASHIER') {
      return res.status(403).json({ success: false, message: 'Cashiers do not have access to retailers' });
    } else if (req.user.role === 'ADMIN' && warehouseId) {
      whereConditions.push('warehouse_id = ?');
      params.push(warehouseId);
    }

    if (status) { whereConditions.push('status = ?'); params.push(status); }
    if (businessType) { whereConditions.push('business_type = ?'); params.push(businessType); }
    if (paymentTerms) { whereConditions.push('payment_terms = ?'); params.push(paymentTerms); }

    const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';
    const baseWhereClause = whereClause ? `${whereClause} AND deleted_at IS NULL` : 'WHERE deleted_at IS NULL';
    const [retailers] = await pool.execute(`SELECT * FROM retailers ${baseWhereClause} ORDER BY name ASC`, params);

    res.json({ success: true, count: retailers.length, data: retailers });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error retrieving retailers', error: error.message });
  }
};

// @desc    Get single retailer
// @route   GET /api/retailers/:id
// @access  Private (Admin, Warehouse Keeper)
const getRetailer = async (req, res) => {
  try {
    const { id } = req.params;
    const [retailers] = await pool.execute('SELECT * FROM retailers WHERE id = ? AND deleted_at IS NULL', [id]);

    if (retailers.length === 0) return res.status(404).json({ success: false, message: 'Retailer not found' });
    res.json({ success: true, data: retailers[0] });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error retrieving retailer', error: error.message });
  }
};

// @desc    Create new retailer
// @route   POST /api/retailers
// @access  Private (Admin, Warehouse Keeper)
const createRetailer = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ success: false, message: 'Validation error', errors: errors.array() });

    const { name, email, phone, address, city, state, zipCode, businessType, taxId, creditLimit, paymentTerms, status, notes } = req.body;

    const normalize = (v) => (v === undefined || v === '' ? null : v);
    const normalizeId = (v) => (v === undefined || v === '' ? null : v);
    const safeNumber = (v, fallback = 0) => { const n = Number(v); return Number.isFinite(n) ? n : fallback; };

    let warehouseId = null;
    if (req.user.role === 'WAREHOUSE_KEEPER') warehouseId = normalizeId(req.user.warehouseId);
    else if (req.user.role === 'ADMIN') warehouseId = normalizeId(req.body.warehouseId);

    const payload = {
      warehouseId: normalizeId(warehouseId),
      name: name ?? null,
      email: normalize(email),
      phone: normalize(phone),
      address: normalize(address),
      city: normalize(city),
      state: normalize(state),
      zipCode: normalize(zipCode),
      businessType: normalize(businessType),
      taxId: normalize(taxId),
      creditLimit: (creditLimit !== undefined && creditLimit !== '') ? safeNumber(creditLimit, 0) : 0,
      paymentTerms: paymentTerms || 'CASH',
      status: status || 'ACTIVE',
      notes: normalize(notes)
    };

    const params = Object.values(payload).map(v => (v === undefined ? null : v));

    const [result] = await pool.execute(`
      INSERT INTO retailers (warehouse_id, name, email, phone, address, city, state, zip_code, business_type, tax_id, credit_limit, payment_terms, status, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, params);

    const [retailers] = await pool.execute('SELECT * FROM retailers WHERE id = ? AND deleted_at IS NULL', [result.insertId]);
    res.status(201).json({ success: true, message: 'Retailer created successfully', data: retailers[0] });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error creating retailer', error: error.message });
  }
};

// @desc    Update retailer
// @route   PUT /api/retailers/:id
// @access  Private (Admin, Warehouse Keeper)
const updateRetailer = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, email, phone, address, city, state, zipCode, businessType, taxId, creditLimit, paymentTerms, status, notes } = req.body;
    const normalize = (v) => (v === undefined || v === '' ? null : v);

    const [existing] = await pool.execute('SELECT * FROM retailers WHERE id = ? AND deleted_at IS NULL', [id]);
    if (existing.length === 0) return res.status(404).json({ success: false, message: 'Retailer not found' });

    const updateFields = [];
    const updateValues = [];

    const fieldMap = [
      ['name', name, name],
      ['email', email, normalize(email)],
      ['phone', phone, normalize(phone)],
      ['address', address, normalize(address)],
      ['city', city, normalize(city)],
      ['state', state, normalize(state)],
      ['zip_code', zipCode, normalize(zipCode)],
      ['business_type', businessType, normalize(businessType)],
      ['tax_id', taxId, normalize(taxId)],
      ['payment_terms', paymentTerms, paymentTerms || 'CASH'],
      ['status', status, status || 'ACTIVE'],
      ['notes', notes, normalize(notes)],
    ];

    for (const [col, raw, val] of fieldMap) {
      if (raw !== undefined) { updateFields.push(`${col} = ?`); updateValues.push(val); }
    }
    if (creditLimit !== undefined) {
      updateFields.push('credit_limit = ?');
      updateValues.push(creditLimit !== '' && creditLimit !== null ? Number(creditLimit) : 0);
    }

    if (updateFields.length === 0) return res.status(400).json({ success: false, message: 'No fields to update' });

    updateValues.push(id);
    await pool.execute(`UPDATE retailers SET ${updateFields.join(', ')} WHERE id = ?`, updateValues);

    const [retailers] = await pool.execute('SELECT * FROM retailers WHERE id = ? AND deleted_at IS NULL', [id]);

    // Cascade name/phone to linked sales records
    const saleCascadeFields = [];
    const saleCascadeValues = [];
    if (name !== undefined) { saleCascadeFields.push('customer_name = ?'); saleCascadeValues.push(name); }
    if (phone !== undefined) { saleCascadeFields.push('customer_phone = ?'); saleCascadeValues.push(phone); }
    if (saleCascadeFields.length > 0) {
      saleCascadeValues.push(id);
      await pool.execute(`UPDATE sales SET ${saleCascadeFields.join(', ')} WHERE retailer_id = ?`, saleCascadeValues);
    }

    res.json({ success: true, message: 'Retailer updated successfully', data: retailers[0] });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error updating retailer', error: error.message });
  }
};

// @desc    Delete retailer
// @route   DELETE /api/retailers/:id
// @access  Private (Admin only)
const deleteRetailer = async (req, res) => {
  try {
    const { id } = req.params;

    const [existing] = await pool.execute('SELECT * FROM retailers WHERE id = ? AND deleted_at IS NULL', [id]);
    if (existing.length === 0) return res.status(404).json({ success: false, message: 'Retailer not found' });

    const [sales] = await pool.execute('SELECT COUNT(*) as count FROM sales WHERE customer_info LIKE ?', [`%"id":${id}%`]);
    if (sales[0].count > 0) return res.status(400).json({ success: false, message: 'Cannot delete retailer with existing sales. Please deactivate instead.' });

    await trashService.softDelete('retailer', id, req.user.id);
    res.json({ success: true, message: 'Moved to trash' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error deleting retailer', error: error.message });
  }
};

module.exports = { getRetailers, getRetailer, createRetailer, updateRetailer, deleteRetailer };