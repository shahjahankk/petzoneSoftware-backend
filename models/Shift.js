const { pool } = require('../config/database');

class Shift {
  constructor(data) {
    this.id = data.id;
    this.name = data.name;
    this.startTime = data.start_time;
    this.endTime = data.end_time;
    this.scopeType = data.scope_type;
    this.scopeId = data.scope_id;
    this.createdBy = data.created_by;
    this.createdAt = data.created_at;
    this.updatedAt = data.updated_at;
  }

  // Static method to create a new shift
  static async create(shiftData) {
    const { name, startTime, endTime, scopeType, scopeId, createdBy } = shiftData;
    
    const [result] = await pool.execute(
      `INSERT INTO shifts (name, start_time, end_time, scope_type, scope_id, created_by) 
       VALUES (?, ?, ?, ?, ?, ?)`,
      [name, startTime, endTime, scopeType, scopeId, createdBy]
    );
    
    return await Shift.findById(result.insertId);
  }

  // Static method to find shift by ID
  static async findById(id) {
    const [rows] = await pool.execute(
      'SELECT * FROM shifts WHERE id = ?',
      [id]
    );
    
    if (rows.length === 0) return null;
    return new Shift(rows[0]);
  }

  // Static method to find shift
  static async findOne(conditions) {
    let query = 'SELECT * FROM shifts WHERE ';
    const params = [];
    const conditionsArray = [];

    if (conditions.name) {
      conditionsArray.push('name = ?');
      params.push(conditions.name);
    }

    if (conditions._id) {
      conditionsArray.push('id = ?');
      params.push(conditions._id);
    }

    if (conditions.id) {
      conditionsArray.push('id = ?');
      params.push(conditions.id);
    }

    if (conditions.scopeType && conditions.scopeId) {
      conditionsArray.push('scope_type = ? AND scope_id = ?');
      params.push(conditions.scopeType, conditions.scopeId);
    }

    if (conditionsArray.length === 0) return null;

    query += conditionsArray.join(' AND ');
    query += ' LIMIT 1';

    const [rows] = await pool.execute(query, params);
    
    if (rows.length === 0) return null;
    return new Shift(rows[0]);
  }

  // Instance method to save shift
  async save() {
    if (this.id) {
      // Update existing shift
      await pool.execute(
        `UPDATE shifts SET name = ?, start_time = ?, end_time = ?, scope_type = ?, scope_id = ?, created_by = ? 
         WHERE id = ?`,
        [this.name, this.startTime, this.endTime, this.scopeType, this.scopeId, this.createdBy, this.id]
      );
    } else {
      // Create new shift
      const result = await pool.execute(
        `INSERT INTO shifts (name, start_time, end_time, scope_type, scope_id, created_by) 
         VALUES (?, ?, ?, ?, ?, ?)`,
        [this.name, this.startTime, this.endTime, this.scopeType, this.scopeId, this.createdBy]
      );
      this.id = result[0].insertId;
    }
    return this;
  }

  // Static method to find shifts with pagination
  static async find(conditions = {}, options = {}) {
    let query = 'SELECT * FROM shifts WHERE 1=1';
    const params = [];

    if (conditions.name) {
      query += ' AND name LIKE ?';
      params.push(`%${conditions.name}%`);
    }

    if (conditions.scopeType) {
      query += ' AND scope_type = ?';
      params.push(conditions.scopeType);
    }

    if (conditions.scopeId) {
      query += ' AND scope_id = ?';
      params.push(conditions.scopeId);
    }

    if (conditions.createdBy) {
      query += ' AND created_by = ?';
      params.push(conditions.createdBy);
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
    return rows.map(row => new Shift(row));
  }

  // Static method to count shifts
  static async count(conditions = {}) {
    let query = 'SELECT COUNT(*) as count FROM shifts WHERE 1=1';
    const params = [];

    if (conditions.name) {
      query += ' AND name LIKE ?';
      params.push(`%${conditions.name}%`);
    }

    if (conditions.scopeType) {
      query += ' AND scope_type = ?';
      params.push(conditions.scopeType);
    }

    if (conditions.scopeId) {
      query += ' AND scope_id = ?';
      params.push(conditions.scopeId);
    }

    if (conditions.createdBy) {
      query += ' AND created_by = ?';
      params.push(conditions.createdBy);
    }

    const [rows] = await pool.execute(query, params);
    return rows[0].count;
  }

  // Static method to update shift
  static async updateOne(conditions, updateData) {
    let query = 'UPDATE shifts SET ';
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
    if (conditions.name) {
      whereClauses.push('name = ?');
      params.push(conditions.name);
    }

    if (whereClauses.length === 0) return { modifiedCount: 0 };

    query += whereClauses.join(' AND ');

    const [result] = await pool.execute(query, params);
    return { modifiedCount: result.affectedRows };
  }

  // Static method to delete shift
  static async deleteOne(conditions) {
    let query = 'DELETE FROM shifts WHERE ';
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
    if (conditions.name) {
      whereClauses.push('name = ?');
      params.push(conditions.name);
    }

    if (whereClauses.length === 0) return { deletedCount: 0 };

    query += whereClauses.join(' AND ');

    const [result] = await pool.execute(query, params);
    return { deletedCount: result.affectedRows };
  }

  // Method to check if current time falls within shift
  isCurrentTimeInShift() {
    const now = new Date();
    const currentTime = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');
    
    const startTime = this.startTime;
    const endTime = this.endTime;
    
    // Handle shifts that cross midnight (e.g., 22:00 to 06:00)
    if (startTime > endTime) {
      return currentTime >= startTime || currentTime <= endTime;
    } else {
      return currentTime >= startTime && currentTime <= endTime;
    }
  }

  // Static method to find active shifts for a scope
  static async findActiveShiftsForScope(scopeType, scopeId) {
    const [rows] = await pool.execute(
      'SELECT * FROM shifts WHERE scope_type = ? AND scope_id = ? ORDER BY created_at DESC',
      [scopeType, scopeId]
    );
    
    return rows.map(row => new Shift(row));
  }

  // Static method to find current shift for a scope
  static async findCurrentShiftForScope(scopeType, scopeId) {
    const shifts = await Shift.findActiveShiftsForScope(scopeType, scopeId);
    return shifts.find(shift => shift.isCurrentTimeInShift());
  }

  // Static method to find shifts assigned to a user
  static async findShiftsForUser(userId) {
    const [rows] = await pool.execute(`
      SELECT s.* FROM shifts s
      WHERE s.user_id = ? AND s.is_active = 1
    `, [userId]);
    
    return rows.map(row => new Shift(row));
  }
}

module.exports = Shift;