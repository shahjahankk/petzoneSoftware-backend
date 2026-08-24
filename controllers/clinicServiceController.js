const { validationResult } = require('express-validator');
const ClinicServiceCategory = require('../models/ClinicServiceCategory');
const ClinicService = require('../models/ClinicService');

const serializeCategory = (c) =>
  c
    ? {
        id: c.id,
        name: c.name,
        description: c.description,
        status: c.status,
        sortOrder: c.sortOrder,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
      }
    : null;

const serializeService = (s) =>
  s
    ? {
        id: s.id,
        categoryId: s.categoryId,
        categoryName: s.categoryName,
        name: s.name,
        description: s.description,
        defaultPrice: s.defaultPrice,
        code: s.code,
        status: s.status,
        sortOrder: s.sortOrder,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
      }
    : null;

const listCategories = async (req, res) => {
  try {
    const { status } = req.query;
    const categories = await ClinicServiceCategory.findAll({ status });
    res.json({ success: true, data: categories.map(serializeCategory) });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error fetching clinic categories', error: error.message });
  }
};

const createCategory = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: 'Validation error', errors: errors.array() });
    }
    const { name, description, status, sortOrder } = req.body;
    const category = await ClinicServiceCategory.create({ name, description, status, sortOrder: sortOrder ?? 0 });
    res.status(201).json({ success: true, message: 'Category created', data: serializeCategory(category) });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error creating category', error: error.message });
  }
};

const updateCategory = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: 'Validation error', errors: errors.array() });
    }
    const { modifiedCount } = await ClinicServiceCategory.updateById(req.params.id, req.body);
    if (!modifiedCount) return res.status(404).json({ success: false, message: 'Category not found' });
    const updated = await ClinicServiceCategory.findById(req.params.id);
    res.json({ success: true, message: 'Category updated', data: serializeCategory(updated) });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error updating category', error: error.message });
  }
};

const deleteCategory = async (req, res) => {
  try {
    const trashService = require('../services/trashService');
    await trashService.softDelete('clinic_service_category', req.params.id, req.user.id);
    res.json({ success: true, message: 'Category moved to trash' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error deleting category', error: error.message });
  }
};

const listServices = async (req, res) => {
  try {
    const { status, categoryId } = req.query;
    const services = await ClinicService.findAll({ status, categoryId });
    res.json({ success: true, data: services.map(serializeService) });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error fetching clinic services', error: error.message });
  }
};

const listActiveForBilling = async (req, res) => {
  try {
    const services = await ClinicService.findAll({ status: 'ACTIVE' });
    const categories = await ClinicServiceCategory.findAll({ status: 'ACTIVE' });
    res.json({
      success: true,
      data: {
        categories: categories.map(serializeCategory),
        services: services.map(serializeService),
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error fetching billing services', error: error.message });
  }
};

const createService = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: 'Validation error', errors: errors.array() });
    }
    const service = await ClinicService.create(req.body);
    res.status(201).json({ success: true, message: 'Service created', data: serializeService(service) });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error creating service', error: error.message });
  }
};

const updateService = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: 'Validation error', errors: errors.array() });
    }
    const { modifiedCount } = await ClinicService.updateById(req.params.id, req.body);
    if (!modifiedCount) return res.status(404).json({ success: false, message: 'Service not found' });
    const updated = await ClinicService.findById(req.params.id);
    res.json({ success: true, message: 'Service updated', data: serializeService(updated) });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error updating service', error: error.message });
  }
};

const deleteService = async (req, res) => {
  try {
    const trashService = require('../services/trashService');
    await trashService.softDelete('clinic_service', req.params.id, req.user.id);
    res.json({ success: true, message: 'Service moved to trash' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error deleting service', error: error.message });
  }
};

module.exports = {
  listCategories,
  createCategory,
  updateCategory,
  deleteCategory,
  listServices,
  listActiveForBilling,
  createService,
  updateService,
  deleteService,
};
