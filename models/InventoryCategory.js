const { pool, executeQuery } = require('../config/database');

class InventoryCategory {
  constructor(data) {
    this.id = data.id;
    this.name = data.name;
    this.description = data.description;
    this.status = data.status;
    this.createdAt = data.created_at;
    this.updatedAt = data.updated_at;
  }

  static async create({ name, description = null, status = 'ACTIVE' }) {
    const [result] = await pool.execute(
      `INSERT INTO inventory_categories (name, description, status, created_at, updated_at)
       VALUES (?, ?, ?, NOW(), NOW())`,
      [name, description, status]
    );
    return await InventoryCategory.findById(result.insertId || result.lastID);
  }

  static async findById(id) {
    const rows = await executeQuery(
      'SELECT * FROM inventory_categories WHERE id = ?',
      [id]
    );
    if (!rows || rows.length === 0) return null;
    return new InventoryCategory(rows[0]);
  }

  static async findAll({ status } = {}) {
    let query = 'SELECT * FROM inventory_categories WHERE deleted_at IS NULL';
    const params = [];
    if (status) {
      query += ' AND status = ?';
      params.push(status);
    }
    query += ' ORDER BY name ASC';
    const rows = await executeQuery(query, params);
    return rows.map(row => new InventoryCategory(row));
  }

  static async updateById(id, updateData) {
    const fields = [];
    const values = [];
    const map = { name: 'name', description: 'description', status: 'status' };
    Object.keys(updateData || {}).forEach((key) => {
      const column = map[key];
      const val = updateData[key];
      if (column && val !== undefined) {
        fields.push(`${column} = ?`);
        values.push(val);
      }
    });
    if (fields.length === 0) return { modifiedCount: 0 };
    values.push(id);
    const result = await executeQuery(
      `UPDATE inventory_categories SET ${fields.join(', ')}, updated_at = NOW() WHERE id = ?`,
      values
    );
    return { modifiedCount: result.affectedRows };
  }

  static async deleteById(id) {
    const result = await executeQuery(
      'DELETE FROM inventory_categories WHERE id = ?',
      [id]
    );
    return { deletedCount: result.affectedRows };
  }
}

module.exports = InventoryCategory;

