const { pool, executeQuery } = require('../config/database');
const bcrypt = require('bcrypt');

class User {
  constructor(data) {
    this.id = data.id;
    this.username = data.username;
    this.email = data.email;
    this.password = data.password;
    this.role = data.role;
    this.branchId = data.branch_id;
    this.warehouseId = data.warehouse_id;
    this.shift = data.shift;
    this.status = data.status;
    this.refreshToken = data.refresh_token;
    this.createdAt = data.created_at;
    this.updatedAt = data.updated_at;
  }

  // Static method to create a new user
  static async create(userData) {
    const { username, email, password, role, branchId, warehouseId, shift } = userData;
    
    // Hash password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);
    
    const result = await executeQuery(
      `INSERT INTO users (username, email, password, role, branch_id, warehouse_id, shift) 
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [username, email, hashedPassword, role, branchId || null, warehouseId || null, shift || null]
    );
    
    // For MySQL, we can get the last inserted ID from the result
    const lastId = result.insertId;
    
    return await User.findById(lastId);
  }

  // Static method to find user by ID
  static async findById(id) {
    try {
      const rows = await executeQuery(
        'SELECT * FROM users WHERE id = ? AND deleted_at IS NULL',
        [id]
      );
      
      if (rows.length === 0) return null;
      return new User(rows[0]);
    } catch (error) {
      throw error;
    }
  }

  // Static method to find user by email
  static async findOne(conditions) {
    let query = 'SELECT * FROM users WHERE ';
    const params = [];
    const conditionsArray = [];

    if (conditions.email) {
      conditionsArray.push('email = ?');
      params.push(conditions.email);
    }

    if (conditions.username) {
      conditionsArray.push('username = ?');
      params.push(conditions.username);
    }

    if (conditions.$or) {
      // Handle MongoDB-style $or queries
      const orConditions = conditions.$or.map(condition => {
        if (condition.email) {
          params.push(condition.email);
          return 'email = ?';
        }
        if (condition.username) {
          params.push(condition.username);
          return 'username = ?';
        }
        return null;
      }).filter(Boolean);
      
      if (orConditions.length > 0) {
        conditionsArray.push(`(${orConditions.join(' OR ')})`);
      }
    }

    if (conditionsArray.length === 0) return null;

    query += conditionsArray.join(' AND ');
    query += ' AND deleted_at IS NULL LIMIT 1';

    const rows = await executeQuery(query, params);
    
    if (rows.length === 0) return null;
    return new User(rows[0]);
  }

  // Instance method to save user
  async save() {
    if (this.id) {
      // Update existing user
      await executeQuery(
        `UPDATE users SET username = ?, email = ?, password = ?, role = ?, 
         branch_id = ?, warehouse_id = ?, shift = ?, status = ?, refresh_token = ? 
         WHERE id = ?`,
        [this.username, this.email, this.password, this.role, this.branchId, 
         this.warehouseId, this.shift, this.status, this.refreshToken, this.id]
      );
    } else {
      // Create new user
      const result = await executeQuery(
        `INSERT INTO users (username, email, password, role, branch_id, warehouse_id, shift, status, refresh_token) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [this.username, this.email, this.password, this.role, this.branchId, 
         this.warehouseId, this.shift, this.status, this.refreshToken]
      );
      this.id = result.insertId;
    }
    return this;
  }

  // Instance method to compare password
  async comparePassword(candidatePassword) {
    return await bcrypt.compare(candidatePassword, this.password);
  }

  // Instance method to get user without sensitive data
  async toJSON() {
    const user = { ...this };
    delete user.password;
    delete user.refreshToken;
    
    // Add branch and warehouse names
    if (this.branchId) {
      try {
        const [branches] = await pool.execute('SELECT name FROM branches WHERE id = ?', [this.branchId]);
        user.branchName = branches[0]?.name || null;
      } catch (error) {
        user.branchName = null;
      }
    }
    
    if (this.warehouseId) {
      try {
        const [warehouses] = await pool.execute('SELECT name FROM warehouses WHERE id = ?', [this.warehouseId]);
        user.warehouseName = warehouses[0]?.name || null;
      } catch (error) {
        user.warehouseName = null;
      }
    }
    
    return user;
  }

  // Static method to find users with pagination
  static async find(conditions = {}, options = {}) {
    let query = 'SELECT * FROM users WHERE 1=1 AND deleted_at IS NULL';
    const params = [];

    if (conditions.role) {
      query += ' AND role = ?';
      params.push(conditions.role);
    }

    if (conditions.status) {
      query += ' AND status = ?';
      params.push(conditions.status);
    }

    if (conditions.branchId) {
      query += ' AND branch_id = ?';
      params.push(conditions.branchId);
    }

    if (conditions.warehouseId) {
      query += ' AND warehouse_id = ?';
      params.push(conditions.warehouseId);
    }

    // Add sorting
    if (options.sort) {
      const sortField = options.sort.replace(/^-/, ''); // Remove minus sign
      const sortOrder = options.sort.startsWith('-') ? 'DESC' : 'ASC';
      query += ` ORDER BY ${sortField} ${sortOrder}`;
    } else {
      query += ' ORDER BY created_at DESC';
    }

    // Add pagination
    if (options.limit) {
      query += ' LIMIT ?';
      params.push(options.limit);
      
      if (options.skip) {
        query += ' OFFSET ?';
        params.push(options.skip);
      }
    }

    const [rows] = await pool.execute(query, params);
    return rows.map(row => new User(row));
  }

  // Static method to count users
  static async count(conditions = {}) {
    let query = 'SELECT COUNT(*) as count FROM users WHERE 1=1';
    const params = [];

    if (conditions.role) {
      query += ' AND role = ?';
      params.push(conditions.role);
    }

    if (conditions.status) {
      query += ' AND status = ?';
      params.push(conditions.status);
    }

    if (conditions.branchId) {
      query += ' AND branch_id = ?';
      params.push(conditions.branchId);
    }

    if (conditions.warehouseId) {
      query += ' AND warehouse_id = ?';
      params.push(conditions.warehouseId);
    }

    const [rows] = await pool.execute(query, params);
    return rows[0].count;
  }

  // Static method to update user
  static async updateOne(conditions, updateData) {
    let query = 'UPDATE users SET ';
    const params = [];
    const setClauses = [];

    Object.keys(updateData).forEach(key => {
      if (key !== 'id') {
        setClauses.push(`${key} = ?`);
        params.push(updateData[key]);
      }
    });

    if (setClauses.length === 0) return { modifiedCount: 0 };

    query += setClauses.join(', ');
    query += ' WHERE ';

    const whereClauses = [];
    if (conditions._id) {
      whereClauses.push('id = ?');
      params.push(conditions._id);
    }
    if (conditions.id) {
      whereClauses.push('id = ?');
      params.push(conditions.id);
    }
    if (conditions.email) {
      whereClauses.push('email = ?');
      params.push(conditions.email);
    }

    if (whereClauses.length === 0) return { modifiedCount: 0 };

    query += whereClauses.join(' AND ');

    const [result] = await pool.execute(query, params);
    return { modifiedCount: result.affectedRows };
  }

  // Static method to delete user
  static async deleteOne(conditions) {
    let query = 'DELETE FROM users WHERE ';
    const params = [];
    const whereClauses = [];

    if (conditions._id) {
      whereClauses.push('id = ?');
      params.push(conditions._id);
    }
    if (conditions.id) {
      whereClauses.push('id = ?');
      params.push(conditions.id);
    }
    if (conditions.email) {
      whereClauses.push('email = ?');
      params.push(conditions.email);
    }

    if (whereClauses.length === 0) return { deletedCount: 0 };

    query += whereClauses.join(' AND ');

    const [result] = await pool.execute(query, params);
    return { deletedCount: result.affectedRows };
  }

  // Static method to find user by email or username
  static async findByEmailOrUsername(email, username) {
    const rows = await executeQuery(
      'SELECT * FROM users WHERE (email = ? OR username = ?) AND deleted_at IS NULL',
      [email, username]
    );
    
    if (rows.length === 0) return null;
    return new User(rows[0]);
  }

  // Static method to find user by email
  static async findByEmail(email) {
    try {
      const rows = await executeQuery(
        'SELECT * FROM users WHERE email = ? AND deleted_at IS NULL',
        [email]
      );
      
      if (rows.length === 0) return null;
      return new User(rows[0]);
    } catch (error) {
      throw error;
    }
  }

  // Static method to update refresh token
  static async updateRefreshToken(id, refreshToken) {
    await executeQuery(
      'UPDATE users SET refresh_token = ? WHERE id = ?',
      [refreshToken, id]
    );
  }
}

module.exports = User;
