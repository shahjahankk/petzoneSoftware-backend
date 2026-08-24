const InventoryCategory = require('../models/InventoryCategory');
const { validationResult } = require('express-validator');

const listCategories = async (req, res) => {
  try {
    const { status } = req.query;
    const categories = await InventoryCategory.findAll({ status });
    res.json({ success: true, data: categories });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error fetching categories', error: error.message });
  }
};

const createCategory = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: 'Validation error', errors: errors.array() });
    }
    const { name, description, status } = req.body;
    const category = await InventoryCategory.create({ name, description, status });
    res.status(201).json({ success: true, message: 'Category created successfully', data: category });
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
    const { id } = req.params;
    const { modifiedCount } = await InventoryCategory.updateById(id, req.body);
    if (modifiedCount === 0) {
      return res.status(404).json({ success: false, message: 'Category not found' });
    }
    const updated = await InventoryCategory.findById(id);
    res.json({ success: true, message: 'Category updated successfully', data: updated });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error updating category', error: error.message });
  }
};

const deleteCategory = async (req, res) => {
  try {
    const { id } = req.params;
    const trashService = require('../services/trashService');
    await trashService.softDelete('inventory_category', id, req.user.id);
    res.json({ success: true, message: 'Category moved to trash successfully' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error deleting category', error: error.message });
  }
};

module.exports = {
  listCategories,
  createCategory,
  updateCategory,
  deleteCategory
};

