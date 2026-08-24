const { pool, executeQuery } = require('../config/database');

class ClinicService {
  constructor(data) {
    this.id = data.id;
    this.categoryId = data.category_id;
    this.categoryName = data.category_name;
    this.name = data.name;
    this.description = data.description;
    this.defaultPrice = parseFloat(data.default_price) || 0;
    this.code = data.code;
    this.status = data.status;
    this.sortOrder = data.sort_order;
    this.createdAt = data.created_at;
    this.updatedAt = data.updated_at;
  }

  static async create(data) {
    const {
      categoryId = null,
      name,
      description = null,
      defaultPrice = 0,
      code = null,
      status = 'ACTIVE',
      sortOrder = 0,
    } = data;
    const [result] = await pool.execute(
      `INSERT INTO clinic_services
       (category_id, name, description, default_price, code, status, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [categoryId, name, description, defaultPrice, code, status, sortOrder]
    );
    return ClinicService.findById(result.insertId);
  }

  static async findById(id) {
    const rows = await executeQuery(
      `SELECT s.*, c.name AS category_name
       FROM clinic_services s
       LEFT JOIN clinic_service_categories c ON c.id = s.category_id
       WHERE s.id = ?`,
      [id]
    );
    return rows?.[0] ? new ClinicService(rows[0]) : null;
  }

  static async findAll({ status, categoryId } = {}) {
    let query = `SELECT s.*, c.name AS category_name
      FROM clinic_services s
      LEFT JOIN clinic_service_categories c ON c.id = s.category_id
      WHERE s.deleted_at IS NULL`;
    const params = [];
    if (status) {
      query += ' AND s.status = ?';
      params.push(status);
    }
    if (categoryId) {
      query += ' AND s.category_id = ?';
      params.push(categoryId);
    }
    query += ' ORDER BY c.sort_order ASC, s.sort_order ASC, s.name ASC';
    const rows = await executeQuery(query, params);
    return rows.map((r) => new ClinicService(r));
  }

  static async updateById(id, updateData) {
    const map = {
      categoryId: 'category_id',
      name: 'name',
      description: 'description',
      defaultPrice: 'default_price',
      code: 'code',
      status: 'status',
      sortOrder: 'sort_order',
    };
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
      `UPDATE clinic_services SET ${fields.join(', ')}, updated_at = NOW() WHERE id = ?`,
      values
    );
    return { modifiedCount: result.affectedRows };
  }

  static async deleteById(id) {
    const result = await executeQuery('DELETE FROM clinic_services WHERE id = ?', [id]);
    return { deletedCount: result.affectedRows };
  }
}

module.exports = ClinicService;
