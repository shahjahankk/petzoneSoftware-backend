const { pool } = require('../config/database');

class HardwareSession {
  constructor(data) {
    this.id = data.id;
    this.sessionId = data.session_id;
    this.userId = data.user_id;
    this.scopeType = data.scope_type;
    this.scopeId = data.scope_id;
    this.terminalId = data.terminal_id;
    this.deviceId = data.device_id;
    this.operation = data.operation;
    this.status = data.status;
    this.data = data.data ? JSON.parse(data.data) : {};
    this.startTime = data.start_time;
    this.endTime = data.end_time;
    this.errorMessage = data.error_message;
    this.createdAt = data.created_at;
    this.updatedAt = data.updated_at;
  }

  // Static method to create a new hardware session
  static async create(sessionData) {
    const { 
      sessionId, userId, scopeType, scopeId, terminalId, deviceId, 
      operation, data = {}, status = 'ACTIVE' 
    } = sessionData;
    
    const [result] = await pool.execute(
      `INSERT INTO hardware_sessions (session_id, user_id, scope_type, scope_id, terminal_id, 
       device_id, operation, status, data, start_time) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [sessionId, userId, scopeType, scopeId, terminalId, deviceId, 
       operation, status, JSON.stringify(data)]
    );
    
    return await HardwareSession.findById(result.insertId);
  }

  // Static method to find hardware session by ID
  static async findById(id) {
    const [rows] = await pool.execute(
      'SELECT * FROM hardware_sessions WHERE id = ?',
      [id]
    );
    
    if (rows.length === 0) return null;
    return new HardwareSession(rows[0]);
  }

  // Static method to find hardware session by session ID
  static async findBySessionId(sessionId) {
    const [rows] = await pool.execute(
      'SELECT * FROM hardware_sessions WHERE session_id = ?',
      [sessionId]
    );
    
    if (rows.length === 0) return null;
    return new HardwareSession(rows[0]);
  }

  // Static method to find hardware session
  static async findOne(conditions) {
    let query = 'SELECT * FROM hardware_sessions WHERE ';
    const params = [];
    const conditionsArray = [];

    if (conditions.sessionId) {
      conditionsArray.push('session_id = ?');
      params.push(conditions.sessionId);
    }

    if (conditions._id) {
      conditionsArray.push('id = ?');
      params.push(conditions._id);
    }

    if (conditions.id) {
      conditionsArray.push('id = ?');
      params.push(conditions.id);
    }

    if (conditions.userId) {
      conditionsArray.push('user_id = ?');
      params.push(conditions.userId);
    }

    if (conditions.scopeType && conditions.scopeId) {
      conditionsArray.push('scope_type = ? AND scope_id = ?');
      params.push(conditions.scopeType, conditions.scopeId);
    }

    if (conditions.terminalId) {
      conditionsArray.push('terminal_id = ?');
      params.push(conditions.terminalId);
    }

    if (conditions.deviceId) {
      conditionsArray.push('device_id = ?');
      params.push(conditions.deviceId);
    }

    if (conditions.status) {
      conditionsArray.push('status = ?');
      params.push(conditions.status);
    }

    if (conditionsArray.length === 0) return null;

    query += conditionsArray.join(' AND ');
    query += ' LIMIT 1';

    const [rows] = await pool.execute(query, params);
    
    if (rows.length === 0) return null;
    return new HardwareSession(rows[0]);
  }

  // Instance method to save hardware session
  async save() {
    if (this.id) {
      // Update existing hardware session
      await pool.execute(
        `UPDATE hardware_sessions SET session_id = ?, user_id = ?, scope_type = ?, scope_id = ?, 
         terminal_id = ?, device_id = ?, operation = ?, status = ?, data = ?, 
         start_time = ?, end_time = ?, error_message = ? 
         WHERE id = ?`,
        [this.sessionId, this.userId, this.scopeType, this.scopeId, this.terminalId, 
         this.deviceId, this.operation, this.status, JSON.stringify(this.data), 
         this.startTime, this.endTime, this.errorMessage, this.id]
      );
    } else {
      // Create new hardware session
      const result = await pool.execute(
        `INSERT INTO hardware_sessions (session_id, user_id, scope_type, scope_id, terminal_id, 
         device_id, operation, status, data, start_time, end_time, error_message) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [this.sessionId, this.userId, this.scopeType, this.scopeId, this.terminalId, 
         this.deviceId, this.operation, this.status, JSON.stringify(this.data), 
         this.startTime, this.endTime, this.errorMessage]
      );
      this.id = result[0].insertId;
    }
    return this;
  }

  // Method to complete session
  async complete(data) {
    this.status = 'COMPLETED';
    this.endTime = new Date();
    if (data) {
      this.data = { ...this.data, ...data };
    }
    return await this.save();
  }

  // Method to fail session
  async fail(errorMessage) {
    this.status = 'FAILED';
    this.endTime = new Date();
    this.errorMessage = errorMessage;
    return await this.save();
  }

  // Method to cancel session
  async cancel() {
    this.status = 'CANCELLED';
    this.endTime = new Date();
    return await this.save();
  }

  // Static method to create session
  static async createSession(userId, scopeType, scopeId, terminalId, deviceId, operation, data) {
    const sessionId = `HW_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    return await HardwareSession.create({
      sessionId,
      userId,
      scopeType,
      scopeId,
      terminalId,
      deviceId,
      operation,
      data
    });
  }

  // Static method to find active sessions
  static async findActiveSessions(scopeType, scopeId, terminalId) {
    let query = 'SELECT * FROM hardware_sessions WHERE status = ?';
    const params = ['ACTIVE'];

    if (scopeType && scopeId) {
      query += ' AND scope_type = ? AND scope_id = ?';
      params.push(scopeType, scopeId);
    }

    if (terminalId) {
      query += ' AND terminal_id = ?';
      params.push(terminalId);
    }

    query += ' ORDER BY start_time DESC';

    const [rows] = await pool.execute(query, params);
    return rows.map(row => new HardwareSession(row));
  }

  // Static method to find hardware sessions with pagination
  static async find(conditions = {}, options = {}) {
    let query = 'SELECT * FROM hardware_sessions WHERE 1=1';
    const params = [];

    if (conditions.userId) {
      query += ' AND user_id = ?';
      params.push(conditions.userId);
    }

    if (conditions.scopeType) {
      query += ' AND scope_type = ?';
      params.push(conditions.scopeType);
    }

    if (conditions.scopeId) {
      query += ' AND scope_id = ?';
      params.push(conditions.scopeId);
    }

    if (conditions.terminalId) {
      query += ' AND terminal_id = ?';
      params.push(conditions.terminalId);
    }

    if (conditions.deviceId) {
      query += ' AND device_id = ?';
      params.push(conditions.deviceId);
    }

    if (conditions.operation) {
      query += ' AND operation = ?';
      params.push(conditions.operation);
    }

    if (conditions.status) {
      query += ' AND status = ?';
      params.push(conditions.status);
    }

    if (conditions.createdAfter) {
      query += ' AND created_at > ?';
      params.push(new Date(conditions.createdAfter));
    }

    // Add sorting
    if (options.sort) {
      const raw = String(options.sort);
      const sortField = raw.replace(/^-/, '').replace(/([A-Z])/g, '_$1').toLowerCase();
      const sortOrder = raw.startsWith('-') ? 'DESC' : 'ASC';
      const allowed = ['created_at', 'start_time', 'updated_at', 'id'];
      const col = allowed.includes(sortField) ? sortField : 'created_at';
      query += ` ORDER BY ${col} ${sortOrder}`;
    } else {
      query += ' ORDER BY start_time DESC';
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
    return rows.map(row => new HardwareSession(row));
  }

  // Static method to count hardware sessions
  static async count(conditions = {}) {
    let query = 'SELECT COUNT(*) as count FROM hardware_sessions WHERE 1=1';
    const params = [];

    if (conditions.userId) {
      query += ' AND user_id = ?';
      params.push(conditions.userId);
    }

    if (conditions.scopeType) {
      query += ' AND scope_type = ?';
      params.push(conditions.scopeType);
    }

    if (conditions.scopeId) {
      query += ' AND scope_id = ?';
      params.push(conditions.scopeId);
    }

    if (conditions.terminalId) {
      query += ' AND terminal_id = ?';
      params.push(conditions.terminalId);
    }

    if (conditions.deviceId) {
      query += ' AND device_id = ?';
      params.push(conditions.deviceId);
    }

    if (conditions.operation) {
      query += ' AND operation = ?';
      params.push(conditions.operation);
    }

    if (conditions.status) {
      query += ' AND status = ?';
      params.push(conditions.status);
    }

    const [rows] = await pool.execute(query, params);
    return rows[0].count;
  }

  // Static method to update hardware session
  static async updateOne(conditions, updateData) {
    let query = 'UPDATE hardware_sessions SET ';
    const params = [];
    const setClauses = [];

    Object.keys(updateData).forEach(key => {
      if (key !== 'id') {
        if (key === 'data') {
          setClauses.push('data = ?');
          params.push(JSON.stringify(updateData[key]));
        } else {
          setClauses.push(`${key} = ?`);
          params.push(updateData[key]);
        }
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
    if (conditions.sessionId) {
      whereClauses.push('session_id = ?');
      params.push(conditions.sessionId);
    }

    if (whereClauses.length === 0) return { modifiedCount: 0 };

    query += whereClauses.join(' AND ');

    const [result] = await pool.execute(query, params);
    return { modifiedCount: result.affectedRows };
  }

  // Static method to delete hardware session
  static async deleteOne(conditions) {
    let query = 'DELETE FROM hardware_sessions WHERE ';
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
    if (conditions.sessionId) {
      whereClauses.push('session_id = ?');
      params.push(conditions.sessionId);
    }

    if (whereClauses.length === 0) return { deletedCount: 0 };

    query += whereClauses.join(' AND ');

    const [result] = await pool.execute(query, params);
    return { deletedCount: result.affectedRows };
  }
}

module.exports = HardwareSession;
