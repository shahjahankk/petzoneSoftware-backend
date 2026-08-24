const { pool } = require('../config/database');

// @desc    Get all salespeople
// @route   GET /api/salespeople
// @access  Private (Admin, Warehouse Keeper)
const getSalespeople = async (req, res, next) => {
  try {
    const { warehouseId, search } = req.query;
    
    let whereConditions = [];
    let params = [];
    
    // Apply role-based filtering
    if (req.user.role === 'WAREHOUSE_KEEPER') {
      // Warehouse keepers can only see salespeople from their warehouse
      if (req.user.warehouseId) {
        whereConditions.push('s.warehouse_id = ?');
        params.push(req.user.warehouseId);
      } else {
        return res.status(403).json({
          success: false,
          message: 'Warehouse keeper must be assigned to a warehouse'
        });
      }
    } else if (req.user.role === 'ADMIN') {
      // Admin can filter by warehouse if provided
      if (warehouseId) {
        whereConditions.push('s.warehouse_id = ?');
        params.push(warehouseId);
      }
    }
    
    // Search by name or phone
    if (search) {
      whereConditions.push('(s.name LIKE ? OR s.phone LIKE ?)');
      params.push(`%${search}%`, `%${search}%`);
    }
    
    // Only show active salespeople
    whereConditions.push('s.status = ?');
    params.push('ACTIVE');
    whereConditions.push('s.deleted_at IS NULL');
    
    const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';
    
    const [salespeople] = await pool.execute(`
      SELECT 
        s.id,
        s.name,
        s.phone,
        s.email,
        s.warehouse_id,
        s.status,
        s.created_at,
        s.updated_at,
        w.name as warehouse_name,
        w.code as warehouse_code
      FROM salespeople s
      LEFT JOIN warehouses w ON s.warehouse_id = w.id
      ${whereClause}
      ORDER BY s.name ASC
    `, params);
    
    res.json({
      success: true,
      count: salespeople.length,
      data: salespeople
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error retrieving salespeople',
      error: error.message
    });
  }
};

// @desc    Get single salesperson
// @route   GET /api/salespeople/:id
// @access  Private (Admin, Warehouse Keeper)
const getSalesperson = async (req, res, next) => {
  try {
    const { id } = req.params;
    
    const [salespeople] = await pool.execute(`
      SELECT 
        s.*,
        w.name as warehouse_name,
        w.code as warehouse_code
      FROM salespeople s
      LEFT JOIN warehouses w ON s.warehouse_id = w.id
      WHERE s.id = ?
    `, [id]);
    
    if (salespeople.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Salesperson not found'
      });
    }
    
    res.json({
      success: true,
      data: salespeople[0]
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error retrieving salesperson',
      error: error.message
    });
  }
};

// @desc    Create new salesperson
// @route   POST /api/salespeople
// @access  Private (Admin, Warehouse Keeper)
const createSalesperson = async (req, res, next) => {
  try {
    const { name, phone, email, warehouseId, status = 'ACTIVE' } = req.body;
    
    // Validate required fields
    if (!name || !phone || !warehouseId) {
      return res.status(400).json({
        success: false,
        message: 'Name, phone, and warehouse ID are required'
      });
    }
    
    // Check warehouse keeper permissions
    if (req.user.role === 'WAREHOUSE_KEEPER') {
      if (!req.user.warehouseId) {
        return res.status(403).json({
          success: false,
          message: 'Warehouse keeper must be assigned to a warehouse'
        });
      }
      
      // Warehouse keepers can only create salespeople for their own warehouse
      if (warehouseId !== req.user.warehouseId) {
        return res.status(403).json({
          success: false,
          message: 'You can only create salespeople for your own warehouse'
        });
      }
    }
    
    // Check if warehouse exists
    const [warehouses] = await pool.execute('SELECT id FROM warehouses WHERE id = ?', [warehouseId]);
    if (warehouses.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Warehouse not found'
      });
    }
    
    // Check if phone already exists
    const [existingPhone] = await pool.execute('SELECT id FROM salespeople WHERE phone = ?', [phone]);
    if (existingPhone.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'Phone number already exists'
      });
    }
    
    // Create salesperson
    const [result] = await pool.execute(`
      INSERT INTO salespeople (name, phone, email, warehouse_id, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, NOW(), NOW())
    `, [name, phone, email, warehouseId, status]);
    
    // Get the created salesperson
    const [newSalesperson] = await pool.execute(`
      SELECT 
        s.*,
        w.name as warehouse_name,
        w.code as warehouse_code
      FROM salespeople s
      LEFT JOIN warehouses w ON s.warehouse_id = w.id
      WHERE s.id = ?
    `, [result.insertId]);
    
    res.status(201).json({
      success: true,
      message: 'Salesperson created successfully',
      data: newSalesperson[0]
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error creating salesperson',
      error: error.message
    });
  }
};

// @desc    Update salesperson
// @route   PUT /api/salespeople/:id
// @access  Private (Admin, Warehouse Keeper)
const updateSalesperson = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, phone, email, warehouseId, status } = req.body;
    
    // Check if salesperson exists
    const [existing] = await pool.execute('SELECT id, warehouse_id FROM salespeople WHERE id = ?', [id]);
    if (existing.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Salesperson not found'
      });
    }
    
    // Check warehouse keeper permissions
    if (req.user.role === 'WAREHOUSE_KEEPER') {
      if (!req.user.warehouseId) {
        return res.status(403).json({
          success: false,
          message: 'Warehouse keeper must be assigned to a warehouse'
        });
      }
      
      // Warehouse keepers can only update salespeople from their own warehouse
      if (existing[0].warehouse_id !== req.user.warehouseId) {
        return res.status(403).json({
          success: false,
          message: 'You can only update salespeople from your own warehouse'
        });
      }
      
      // If trying to change warehouse, ensure it's still their warehouse
      if (warehouseId && warehouseId !== req.user.warehouseId) {
        return res.status(403).json({
          success: false,
          message: 'You can only assign salespeople to your own warehouse'
        });
      }
    }
    
    // Check if phone already exists (excluding current salesperson)
    if (phone) {
      const [existingPhone] = await pool.execute('SELECT id FROM salespeople WHERE phone = ? AND id != ?', [phone, id]);
      if (existingPhone.length > 0) {
        return res.status(400).json({
          success: false,
          message: 'Phone number already exists'
        });
      }
    }
    
    // Check if warehouse exists (if provided)
    if (warehouseId) {
      const [warehouses] = await pool.execute('SELECT id FROM warehouses WHERE id = ?', [warehouseId]);
      if (warehouses.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'Warehouse not found'
        });
      }
    }
    
    // Build update query
    const updateFields = [];
    const params = [];
    
    if (name !== undefined) {
      updateFields.push('name = ?');
      params.push(name);
    }
    if (phone !== undefined) {
      updateFields.push('phone = ?');
      params.push(phone);
    }
    if (email !== undefined) {
      updateFields.push('email = ?');
      params.push(email);
    }
    if (warehouseId !== undefined) {
      updateFields.push('warehouse_id = ?');
      params.push(warehouseId);
    }
    if (status !== undefined) {
      updateFields.push('status = ?');
      params.push(status);
    }
    
    if (updateFields.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No fields to update'
      });
    }
    
    updateFields.push('updated_at = NOW()');
    params.push(id);
    
    // Update salesperson
    await pool.execute(`
      UPDATE salespeople 
      SET ${updateFields.join(', ')} 
      WHERE id = ?
    `, params);
    
    // Get updated salesperson
    const [updatedSalesperson] = await pool.execute(`
      SELECT 
        s.*,
        w.name as warehouse_name,
        w.code as warehouse_code
      FROM salespeople s
      LEFT JOIN warehouses w ON s.warehouse_id = w.id
      WHERE s.id = ?
    `, [id]);
    
    res.json({
      success: true,
      message: 'Salesperson updated successfully',
      data: updatedSalesperson[0]
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error updating salesperson',
      error: error.message
    });
  }
};

// @desc    Delete salesperson
// @route   DELETE /api/salespeople/:id
// @access  Private (Admin, Warehouse Keeper)
const deleteSalesperson = async (req, res, next) => {
  try {
    const { id } = req.params;
    
    // Check if salesperson exists
    const [existing] = await pool.execute('SELECT id, warehouse_id FROM salespeople WHERE id = ?', [id]);
    if (existing.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Salesperson not found'
      });
    }
    
    // Check warehouse keeper permissions
    if (req.user.role === 'WAREHOUSE_KEEPER') {
      if (!req.user.warehouseId) {
        return res.status(403).json({
          success: false,
          message: 'Warehouse keeper must be assigned to a warehouse'
        });
      }
      
      // Warehouse keepers can only delete salespeople from their own warehouse
      if (existing[0].warehouse_id !== req.user.warehouseId) {
        return res.status(403).json({
          success: false,
          message: 'You can only delete salespeople from your own warehouse'
        });
      }
    }
    
    // Soft-delete salesperson (restore from trash)
    const trashService = require('../services/trashService');
    await trashService.softDelete('salesperson', id, req.user.id);
    
    res.json({
      success: true,
      message: 'Salesperson moved to trash successfully'
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error deleting salesperson',
      error: error.message
    });
  }
};

// @desc    Get salespeople for warehouse billing
// @route   GET /api/salespeople/warehouse-billing
// @access  Private (Admin, Warehouse Keeper)
const getSalespeopleForWarehouseBilling = async (req, res, next) => {
  try {
    let whereConditions = [];
    let params = [];
    
    // Apply role-based filtering
    if (req.user.role === 'WAREHOUSE_KEEPER') {
      // Warehouse keepers can only see salespeople from their warehouse
      if (req.user.warehouseId) {
        whereConditions.push('s.warehouse_id = ?');
        params.push(req.user.warehouseId);
      } else {
        return res.status(403).json({
          success: false,
          message: 'Warehouse keeper must be assigned to a warehouse'
        });
      }
    } else if (req.user.role === 'ADMIN') {
      // Admin can see all active salespeople
      // No additional filtering needed
    }
    
    // Only show active salespeople
    whereConditions.push('s.status = ?');
    params.push('ACTIVE');
    whereConditions.push('s.deleted_at IS NULL');
    
    const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';
    
    const [salespeople] = await pool.execute(`
      SELECT 
        s.id,
        s.name,
        s.phone,
        s.email,
        w.name as warehouse_name,
        w.code as warehouse_code,
        CONCAT(w.code, '-', UPPER(SUBSTRING(s.name, 1, 3))) as salesperson_code
      FROM salespeople s
      LEFT JOIN warehouses w ON s.warehouse_id = w.id
      ${whereClause}
      ORDER BY s.name ASC
    `, params);
    
    res.json({
      success: true,
      count: salespeople.length,
      data: salespeople
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error retrieving salespeople for warehouse billing',
      error: error.message
    });
  }
};

// @desc    Get salesperson performance statistics
// @route   GET /api/salespeople/:id/performance
// @access  Private (Admin, Warehouse Keeper)
const getSalespersonPerformance = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { startDate, endDate } = req.query;
    
    // Check if salesperson exists
    const [salesperson] = await pool.execute('SELECT * FROM salespeople WHERE id = ?', [id]);
    if (salesperson.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Salesperson not found'
      });
    }
    
    let whereConditions = ['JSON_EXTRACT(customer_info, "$.salesperson.id") = ?'];
    let params = [id];
    
    if (startDate) {
      whereConditions.push('created_at >= ?');
      params.push(startDate);
    }
    
    if (endDate) {
      whereConditions.push('created_at <= ?');
      params.push(endDate);
    }
    
    const whereClause = `WHERE ${whereConditions.join(' AND ')}`;
    
    // Get sales statistics
    const [stats] = await pool.execute(`
      SELECT 
        COUNT(*) as total_sales,
        SUM(total) as total_amount,
        AVG(total) as average_sale,
        MIN(total) as min_sale,
        MAX(total) as max_sale,
        MIN(created_at) as first_sale_date,
        MAX(created_at) as last_sale_date
      FROM sales 
      ${whereClause}
    `, params);
    
    // Get sales by payment method
    const [paymentMethods] = await pool.execute(`
      SELECT 
        payment_method,
        COUNT(*) as count,
        SUM(total) as amount
      FROM sales 
      ${whereClause}
      GROUP BY payment_method
    `, params);
    
    // Get recent sales
    const [recentSales] = await pool.execute(`
      SELECT 
        id,
        invoice_no,
        total,
        payment_method,
        created_at
      FROM sales 
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT 10
    `, params);
    
    const performance = {
      salesperson: salesperson[0],
      statistics: {
        totalSales: stats[0].total_sales || 0,
        totalAmount: parseFloat(stats[0].total_amount) || 0,
        averageSale: parseFloat(stats[0].average_sale) || 0,
        minSale: parseFloat(stats[0].min_sale) || 0,
        maxSale: parseFloat(stats[0].max_sale) || 0,
        firstSaleDate: stats[0].first_sale_date,
        lastSaleDate: stats[0].last_sale_date
      },
      paymentMethods: paymentMethods,
      recentSales: recentSales
    };
    
    res.json({
      success: true,
      data: performance
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error retrieving salesperson performance',
      error: error.message
    });
  }
};

module.exports = {
  getSalespeople,
  getSalesperson,
  createSalesperson,
  updateSalesperson,
  deleteSalesperson,
  getSalespersonPerformance,
  getSalespeopleForWarehouseBilling
};
