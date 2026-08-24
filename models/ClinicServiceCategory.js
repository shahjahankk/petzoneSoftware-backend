const { pool, executeQuery } = require('../config/database');

class ClinicServiceCategory {
  constructor(data) {
    this.id = data.id;
    this.name = data.name;
    this.description = data.description;
    this.status = data.status;
    this.sortOrder = data.sort_order;
    this.createdAt = data.created_at;
    this.updatedAt = data.updated_at;
  }

  static async create({ name, description = null, status = 'ACTIVE', sortOrder = 0 }) {
    const [result] = await pool.execute(
      `INSERT INTO clinic_service_categories (name, description, status, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, NOW(), NOW())`,
      [name, description, status, sortOrder]
    );
    return ClinicServiceCategory.findById(result.insertId);
  }

  static async findById(id) {
    const rows = await executeQuery('SELECT * FROM clinic_service_categories WHERE id = ?', [id]);
    return rows?.[0] ? new ClinicServiceCategory(rows[0]) : null;
  }

  static async findAll({ status } = {}) {
    let query = 'SELECT * FROM clinic_service_categories WHERE deleted_at IS NULL';
    const params = [];
    if (status) {
      query += ' AND status = ?';
      params.push(status);
    }
    query += ' ORDER BY sort_order ASC, name ASC';
    const rows = await executeQuery(query, params);
    return rows.map((r) => new ClinicServiceCategory(r));
  }

  static async updateById(id, updateData) {
    const map = { name: 'name', description: 'description', status: 'status', sortOrder: 'sort_order' };
    const fields = [];
    const values = [];
    Object.entries(updateData || {}).forEach(([key, val]) => {
      const col = map[key];
      if (col && val !== undefined) {
        fields.push(`${col} = ?`);
        values.push(val);
      }
    });
    if (!fields.length) return { modifiedCount: 0 };
    values.push(id);
    const result = await executeQuery(
      `UPDATE clinic_service_categories SET ${fields.join(', ')}, updated_at = NOW() WHERE id = ?`,
      values
    );
    return { modifiedCount: result.affectedRows };
  }

  static async deleteById(id) {
    const result = await executeQuery('DELETE FROM clinic_service_categories WHERE id = ?', [id]);
    return { deletedCount: result.affectedRows };
  }
}

module.exports = ClinicServiceCategory;
