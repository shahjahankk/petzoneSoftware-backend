const { pool } = require('../config/database');

class HardwareDevice {
  constructor(data) {
    this.id = data.id;
    this.deviceId = data.device_id;
    this.name = data.name;
    this.type = data.type;
    this.scopeType = data.scope_type;
    this.scopeId = data.scope_id;
    this.terminalId = data.terminal_id;
    this.status = data.status;
    this.settings = data.settings ? JSON.parse(data.settings) : {};
    this.lastActivity = data.last_activity;
    this.errorLog = data.error_log ? JSON.parse(data.error_log) : [];
    this.createdAt = data.created_at;
    this.updatedAt = data.updated_at;
  }

  // Static method to create a new hardware device
  static async create(deviceData) {
    const { 
      deviceId, name, type, scopeType, scopeId, terminalId, 
      status = 'OFFLINE', settings = {}, errorLog = [] 
    } = deviceData;
    
    const [result] = await pool.execute(
      `INSERT INTO hardware_devices (device_id, name, type, scope_type, scope_id, terminal_id, 
       status, settings, last_activity, error_log) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?)`,
      [deviceId, name, type, scopeType, scopeId, terminalId, 
       status, JSON.stringify(settings), JSON.stringify(errorLog)]
    );
    
    return await HardwareDevice.findById(result.insertId);
  }

  // Static method to find hardware device by ID
  static async findById(id) {
    const [rows] = await pool.execute(
      'SELECT * FROM hardware_devices WHERE id = ?',
      [id]
    );
    
    if (rows.length === 0) return null;
    return new HardwareDevice(rows[0]);
  }

  // Static method to find hardware device by device ID
  static async findByDeviceId(deviceId) {
    const [rows] = await pool.execute(
      'SELECT * FROM hardware_devices WHERE device_id = ?',
      [deviceId]
    );
    
    if (rows.length === 0) return null;
    return new HardwareDevice(rows[0]);
  }

  // Static method to find hardware device
  static async findOne(conditions) {
    let query = 'SELECT * FROM hardware_devices WHERE ';
    const params = [];
    const conditionsArray = [];

    if (conditions.deviceId) {
      conditionsArray.push('device_id = ?');
      params.push(conditions.deviceId);
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

    if (conditions.terminalId) {
      conditionsArray.push('terminal_id = ?');
      params.push(conditions.terminalId);
    }

    if (conditions.type) {
      conditionsArray.push('type = ?');
      params.push(conditions.type);
    }

    if (conditionsArray.length === 0) return null;

    query += conditionsArray.join(' AND ');
    query += ' LIMIT 1';

    const [rows] = await pool.execute(query, params);
    
    if (rows.length === 0) return null;
    return new HardwareDevice(rows[0]);
  }

  // Instance method to save hardware device
  async save() {
    if (this.id) {
      // Update existing hardware device
      await pool.execute(
        `UPDATE hardware_devices SET device_id = ?, name = ?, type = ?, scope_type = ?, 
         scope_id = ?, terminal_id = ?, status = ?, settings = ?, last_activity = ?, error_log = ? 
         WHERE id = ?`,
        [this.deviceId, this.name, this.type, this.scopeType, this.scopeId, 
         this.terminalId, this.status, JSON.stringify(this.settings), 
         this.lastActivity, JSON.stringify(this.errorLog), this.id]
      );
    } else {
      // Create new hardware device
      const result = await pool.execute(
        `INSERT INTO hardware_devices (device_id, name, type, scope_type, scope_id, terminal_id, 
         status, settings, last_activity, error_log) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?)`,
        [this.deviceId, this.name, this.type, this.scopeType, this.scopeId, 
         this.terminalId, this.status, JSON.stringify(this.settings), JSON.stringify(this.errorLog)]
      );
      this.id = result[0].insertId;
    }
    return this;
  }

  // Method to update status
  async updateStatus(status) {
    this.status = status;
    this.lastActivity = new Date();
    return await this.save();
  }

  // Method to delete device
  async delete() {
    const [result] = await pool.execute(
      'DELETE FROM hardware_devices WHERE id = ?',
      [this.id]
    );
    return result.affectedRows > 0;
  }

  // Method to log error
  async logError(error, details) {
    this.errorLog.push({
      timestamp: new Date(),
      error,
      details
    });
    
    // Keep only last 50 errors
    if (this.errorLog.length > 50) {
      this.errorLog = this.errorLog.slice(-50);
    }
    
    this.status = 'ERROR';
    this.lastActivity = new Date();
    return await this.save();
  }

  // Method to check if device is online
  isOnline() {
    const now = new Date();
    const timeDiff = now - new Date(this.lastActivity);
    return timeDiff < 300000; // 5 minutes
  }

  // Static method to find all devices (admin only)
  static async findAll() {
    const [rows] = await pool.execute(
      'SELECT * FROM hardware_devices ORDER BY created_at DESC'
    );
    
    return rows.map(row => new HardwareDevice(row));
  }

  // Static method to find devices by scope
  static async findByScope(scopeType, scopeId) {
    const [rows] = await pool.execute(
      'SELECT * FROM hardware_devices WHERE scope_type = ? AND scope_id = ?',
      [scopeType, scopeId]
    );
    
    return rows.map(row => new HardwareDevice(row));
  }

  // Static method to find devices by terminal
  static async findByTerminal(terminalId) {
    const [rows] = await pool.execute(
      'SELECT * FROM hardware_devices WHERE terminal_id = ?',
      [terminalId]
    );
    
    return rows.map(row => new HardwareDevice(row));
  }

  // Static method to find devices by type
  static async findByType(type, scopeType, scopeId) {
    let query = 'SELECT * FROM hardware_devices WHERE type = ?';
    const params = [type];
    
    if (scopeType && scopeId) {
      query += ' AND scope_type = ? AND scope_id = ?';
      params.push(scopeType, scopeId);
    }
    
    const [rows] = await pool.execute(query, params);
    return rows.map(row => new HardwareDevice(row));
  }

  // Static method to find hardware devices with pagination
  static async find(conditions = {}, options = {}) {
    let query = 'SELECT * FROM hardware_devices WHERE 1=1';
    const params = [];

    if (conditions.name) {
      query += ' AND name LIKE ?';
      params.push(`%${conditions.name}%`);
    }

    if (conditions.type) {
      query += ' AND type = ?';
      params.push(conditions.type);
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

    if (conditions.status) {
      query += ' AND status = ?';
      params.push(conditions.status);
    }

    // Add sorting
    if (options.sort) {
      const sortField = options.sort.replace(/^-/, '');
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
    return rows.map(row => new HardwareDevice(row));
  }

  // Static method to count hardware devices
  static async count(conditions = {}) {
    let query = 'SELECT COUNT(*) as count FROM hardware_devices WHERE 1=1';
    const params = [];

    if (conditions.name) {
      query += ' AND name LIKE ?';
      params.push(`%${conditions.name}%`);
    }

    if (conditions.type) {
      query += ' AND type = ?';
      params.push(conditions.type);
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

    if (conditions.status) {
      query += ' AND status = ?';
      params.push(conditions.status);
    }

    const [rows] = await pool.execute(query, params);
    return rows[0].count;
  }

  // Static method to update hardware device
  static async updateOne(conditions, updateData) {
    let query = 'UPDATE hardware_devices SET ';
    const params = [];
    const setClauses = [];

    Object.keys(updateData).forEach(key => {
      if (key !== 'id') {
        if (key === 'settings' || key === 'errorLog') {
          setClauses.push(`${key} = ?`);
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
    if (conditions.deviceId) {
      whereClauses.push('device_id = ?');
      params.push(conditions.deviceId);
    }

    if (whereClauses.length === 0) return { modifiedCount: 0 };

    query += whereClauses.join(' AND ');

    const [result] = await pool.execute(query, params);
    return { modifiedCount: result.affectedRows };
  }

  // Static method to delete hardware device
  static async deleteOne(conditions) {
    let query = 'DELETE FROM hardware_devices WHERE ';
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
    if (conditions.deviceId) {
      whereClauses.push('device_id = ?');
      params.push(conditions.deviceId);
    }

    if (whereClauses.length === 0) return { deletedCount: 0 };

    query += whereClauses.join(' AND ');

    const [result] = await pool.execute(query, params);
    return { deletedCount: result.affectedRows };
  }
}

module.exports = HardwareDevice;
