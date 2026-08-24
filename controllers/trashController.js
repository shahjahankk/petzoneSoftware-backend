const { pool } = require('../config/database');
const trashService = require('../services/trashService');

const getTrashList = async (req, res, next) => {
  try {
    const { entityType, search, page, limit } = req.query;
    const result = await trashService.getTrashList({ entityType, search, page, limit });
    return res.json({ success: true, data: result });
  } catch (error) {
    return next(error);
  }
};

const getStats = async (req, res, next) => {
  try {
    const [byTypeRows] = await pool.execute(
      `SELECT entity_type, COUNT(*) AS count
       FROM trash
       WHERE is_expired = 0
       GROUP BY entity_type`
    );

    const [totalRows] = await pool.execute(
      'SELECT COUNT(*) AS total FROM trash WHERE is_expired = 0'
    );

    const [expiringSoonRows] = await pool.execute(
      `SELECT COUNT(*) AS expiring_soon
       FROM trash
       WHERE expires_at <= DATE_ADD(NOW(), INTERVAL 30 DAY)
         AND is_expired = 0`
    );

    const byType = {};
    for (const row of byTypeRows) {
      byType[row.entity_type] = row.count;
    }

    return res.json({
      success: true,
      data: {
        total: totalRows[0]?.total || 0,
        by_type: byType,
        expiring_soon: expiringSoonRows[0]?.expiring_soon || 0,
      },
    });
  } catch (error) {
    return next(error);
  }
};

const restoreItem = async (req, res, next) => {
  try {
    const result = await trashService.restoreFromTrash(req.params.id);
    return res.json({
      success: true,
      message: 'Record restored successfully',
      data: result,
    });
  } catch (error) {
    return next(error);
  }
};

const permanentDelete = async (req, res, next) => {
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    const [trashRows] = await connection.execute(
      'SELECT * FROM trash WHERE id = ? LIMIT 1',
      [req.params.id]
    );

    if (!trashRows.length) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Trash record not found' });
    }

    const trashRow = trashRows[0];
    const tableName = trashService.TABLE_MAP[trashRow.entity_type];
    if (!tableName) {
      throw new Error(`Unsupported entity type: ${trashRow.entity_type}`);
    }

    for (const rule of trashService.CHILD_DELETE_MAP[trashRow.entity_type] || []) {
      await connection.execute(
        `DELETE FROM \`${rule.table}\` WHERE ${rule.fk} = ?`,
        [trashRow.entity_id]
      );
    }

    await connection.execute(`DELETE FROM \`${tableName}\` WHERE id = ?`, [trashRow.entity_id]);
    await connection.execute('DELETE FROM trash WHERE id = ?', [req.params.id]);

    await connection.commit();
    return res.json({ success: true, message: 'Record permanently deleted' });
  } catch (error) {
    try {
      if (connection) {
        await connection.rollback();
      }
    } catch (_) {}
    return next(error);
  } finally {
    if (connection) {
      connection.release();
    }
  }
};

module.exports = {
  getTrashList,
  getStats,
  restoreItem,
  permanentDelete,
};
