const { pool } = require('../config/database');

class POS {
  constructor(data) {
    this.id = data.id;
    this.name = data.name;
    this.code = data.code;
    this.scopeType = data.scope_type;
    this.scopeId = data.scope_id;
    this.createdBy = data.created_by;
    this.createdAt = data.created_at;
    this.updatedAt = data.updated_at;
  }

  // Static method to create a new POS
  static async create(posData) {
    const { name, code, scopeType, scopeId, createdBy } = posData;
    
    const [result] = await pool.execute(
      `INSERT INTO pos (name, code, scope_type, scope_id, created_by) 
       VALUES (?, ?, ?, ?, ?)`,
      [name, code, scopeType, scopeId, createdBy]
    );
    
    return await POS.findById(result.insertId);
  }

  // Static method to find POS by ID
  static async findById(id) {
    const [rows] = await pool.execute(
      'SELECT * FROM pos WHERE id = ?',
      [id]
    );
    
    if (rows.length === 0) return null;
    return new POS(rows[0]);
  }

  // Static method to find POS
  static async findOne(conditions) {
    let query = 'SELECT * FROM pos WHERE ';
    const params = [];
    const conditionsArray = [];

    if (conditions.code) {
      conditionsArray.push('code = ?');
      params.push(conditions.code);
    }

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
    return new POS(rows[0]);
  }

  // Instance method to save POS
  async save() {
    if (this.id) {
      // Update existing POS
      await pool.execute(
        `UPDATE pos SET name = ?, code = ?, scope_type = ?, scope_id = ?, created_by = ? 
         WHERE id = ?`,
        [this.name, this.code, this.scopeType, this.scopeId, this.createdBy, this.id]
      );
    } else {
      // Create new POS
      const result = await pool.execute(
        `INSERT INTO pos (name, code, scope_type, scope_id, created_by) 
         VALUES (?, ?, ?, ?, ?)`,
        [this.name, this.code, this.scopeType, this.scopeId, this.createdBy]
      );
      this.id = result[0].insertId;
    }
    return this;
  }

  // Static method to find POS with pagination
  static async find(conditions = {}, options = {}) {
    let query = 'SELECT * FROM pos WHERE 1=1';
    const params = [];

    if (conditions.name) {
      query += ' AND name LIKE ?';
      params.push(`%${conditions.name}%`);
    }

    if (conditions.code) {
      query += ' AND code LIKE ?';
      params.push(`%${conditions.code}%`);
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
    return rows.map(row => new POS(row));
  }

  // Static method to count POS
  static async count(conditions = {}) {
    let query = 'SELECT COUNT(*) as count FROM pos WHERE 1=1';
    const params = [];

    if (conditions.name) {
      query += ' AND name LIKE ?';
      params.push(`%${conditions.name}%`);
    }

    if (conditions.code) {
      query += ' AND code LIKE ?';
      params.push(`%${conditions.code}%`);
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

  // Static method to update POS
  static async updateOne(conditions, updateData) {
    let query = 'UPDATE pos SET ';
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
    if (conditions.code) {
      whereClauses.push('code = ?');
      params.push(conditions.code);
    }

    if (whereClauses.length === 0) return { modifiedCount: 0 };

    query += whereClauses.join(' AND ');

    const [result] = await pool.execute(query, params);
    return { modifiedCount: result.affectedRows };
  }

  // Static method to delete POS
  static async deleteOne(conditions) {
    let query = 'DELETE FROM pos WHERE ';
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
    if (conditions.code) {
      whereClauses.push('code = ?');
      params.push(conditions.code);
    }

    if (whereClauses.length === 0) return { deletedCount: 0 };

    query += whereClauses.join(' AND ');

    const [result] = await pool.execute(query, params);
    return { deletedCount: result.affectedRows };
  }

  // Static method to find POS by terminal ID
  static async findByTerminalId(terminalId) {
    const [rows] = await pool.execute(
      'SELECT * FROM pos_terminals WHERE terminal_id = ?',
      [terminalId]
    );
    
    if (rows.length === 0) return null;
    return new POS(rows[0]);
  }
}

module.exports = POS;