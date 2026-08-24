const { pool } = require('../config/database');

const TABLE_MAP = {
  sale: 'sales',
  inventory_item: 'inventory_items',
  purchase_order: 'purchase_orders',
  customer: 'customers',
  retailer: 'retailers',
  transfer: 'transfers',
  financial_voucher: 'financial_vouchers',
  company: 'companies',
  inventory_category: 'inventory_categories',
  salesperson: 'salespeople',
  user: 'users',
  branch: 'branches',
  warehouse: 'warehouses',
  pos: 'pos',
  hardware_device: 'hardware_devices',
  billing: 'billing',
  credit_debit_transaction: 'credit_debit_transactions',
  ledger: 'ledgers',
  ledger_entry: 'ledger_entries',
  clinic_service: 'clinic_services',
  clinic_service_category: 'clinic_service_categories',
};

const CHILD_DELETE_MAP = {
  sale: [{ table: 'sale_items', fk: 'sale_id' }],
  purchase_order: [{ table: 'purchase_order_items', fk: 'purchase_order_id' }],
  transfer: [{ table: 'transfer_items', fk: 'transfer_id' }],
};

const DISPLAY_NAME_FIELDS = [
  'name',
  'username',
  'email',
  'title',
  'label',
  'invoice_no',
  'order_number',
  'voucher_no',
  'account_name',
  'code',
  'sku',
  'terminal_name',
  'device_name',
  'customer_name',
];

function extractDisplayName(entityType, entityData) {
  if (!entityData || typeof entityData !== 'object') return `#${entityType}`;
  for (const field of DISPLAY_NAME_FIELDS) {
    if (entityData[field] != null && String(entityData[field]).trim() !== '') {
      return String(entityData[field]).trim();
    }
  }
  return `${entityType} #${entityData.id || '?'}`;
}

async function softDelete(entityType, entityId, deletedBy) {
  const tableName = TABLE_MAP[entityType];
  if (!tableName) {
    throw new Error(`Unsupported entity type: ${entityType}`);
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [rows] = await connection.execute(
      `SELECT * FROM \`${tableName}\` WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
      [entityId]
    );

    if (!rows.length) {
      await connection.rollback();
      throw new Error(`${entityType} with id ${entityId} not found`);
    }

    const entityData = rows[0];

    const [trashInsert] = await connection.execute(
      `INSERT INTO trash (entity_type, entity_id, entity_data, deleted_by, deleted_at, expires_at, is_expired)
       VALUES (?, ?, ?, ?, NOW(), DATE_ADD(NOW(), INTERVAL 6 MONTH), 0)`,
      [entityType, entityId, JSON.stringify(entityData), deletedBy]
    );

    await connection.execute(
      `UPDATE \`${tableName}\` SET deleted_at = NOW() WHERE id = ?`,
      [entityId]
    );

    await connection.commit();
    return trashInsert.insertId;
  } catch (error) {
    try {
      await connection.rollback();
    } catch (_) {}
    throw error;
  } finally {
    connection.release();
  }
}

async function restoreFromTrash(trashId) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [trashRows] = await connection.execute(
      'SELECT * FROM trash WHERE id = ? LIMIT 1',
      [trashId]
    );

    if (!trashRows.length) {
      throw new Error('Trash record not found');
    }

    const trashRow = trashRows[0];
    if (Number(trashRow.is_expired) === 1) {
      throw new Error('This record has expired and cannot be restored');
    }

    const tableName = TABLE_MAP[trashRow.entity_type];
    if (!tableName) {
      throw new Error(`Unsupported entity type: ${trashRow.entity_type}`);
    }

    const restoredEntity = JSON.parse(trashRow.entity_data || '{}');

    await connection.execute(
      `UPDATE \`${tableName}\` SET deleted_at = NULL WHERE id = ?`,
      [trashRow.entity_id]
    );

    await connection.execute('DELETE FROM trash WHERE id = ?', [trashId]);

    await connection.commit();
    return restoredEntity;
  } catch (error) {
    try {
      await connection.rollback();
    } catch (_) {}
    throw error;
  } finally {
    connection.release();
  }
}

async function purgeExpiredRecords() {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [expiredRows] = await connection.execute(
      'SELECT id, entity_type, entity_id FROM trash WHERE expires_at <= NOW() AND is_expired = 0'
    );

    let purgedCount = 0;
    for (const row of expiredRows) {
      const tableName = TABLE_MAP[row.entity_type];
      if (!tableName) {
        continue;
      }

      const childRules = CHILD_DELETE_MAP[row.entity_type] || [];
      for (const rule of childRules) {
        await connection.execute(
          `DELETE FROM \`${rule.table}\` WHERE ${rule.fk} = ?`,
          [row.entity_id]
        );
      }

      await connection.execute(`DELETE FROM \`${tableName}\` WHERE id = ?`, [row.entity_id]);
      await connection.execute('UPDATE trash SET is_expired = 1 WHERE id = ?', [row.id]);
      purgedCount += 1;
    }

    await connection.commit();
    return purgedCount;
  } catch (error) {
    try {
      await connection.rollback();
    } catch (_) {}
    throw error;
  } finally {
    connection.release();
  }
}

async function getTrashList({ entityType, search, page = 1, limit = 20 } = {}) {
  const safePage = Math.max(parseInt(page, 10) || 1, 1);
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 200);
  const offset = (safePage - 1) * safeLimit;

  const connection = await pool.getConnection();
  try {
    const whereParts = ['t.is_expired = 0'];
    const params = [];

    if (entityType) {
      whereParts.push('t.entity_type = ?');
      params.push(entityType);
    }

    if (search && String(search).trim()) {
      whereParts.push('LOWER(t.entity_data) LIKE ?');
      params.push(`%${String(search).trim().toLowerCase()}%`);
    }

    const whereClause = `WHERE ${whereParts.join(' AND ')}`;

    const [rows] = await connection.execute(
      `SELECT t.*, u.username AS deleted_by_username
       FROM trash t
       LEFT JOIN users u ON u.id = t.deleted_by
       ${whereClause}
       ORDER BY t.deleted_at DESC
       LIMIT ? OFFSET ?`,
      [...params, safeLimit, offset]
    );

    const [countRows] = await connection.execute(
      `SELECT COUNT(*) AS total FROM trash t ${whereClause}`,
      params
    );

    return {
      items: rows.map((row) => {
        let entityData = {};
        try {
          entityData =
            typeof row.entity_data === 'string'
              ? JSON.parse(row.entity_data || '{}')
              : row.entity_data || {};
        } catch (_) {
          entityData = {};
        }
        return {
          ...row,
          entity_data: entityData,
          display_name: extractDisplayName(row.entity_type, entityData),
          days_remaining: Math.ceil((new Date(row.expires_at) - new Date()) / 86400000),
        };
      }),
      total: countRows[0]?.total || 0,
      page: safePage,
      limit: safeLimit,
      entity_types: Object.keys(TABLE_MAP),
    };
  } finally {
    connection.release();
  }
}

module.exports = {
  TABLE_MAP,
  CHILD_DELETE_MAP,
  softDelete,
  restoreFromTrash,
  purgeExpiredRecords,
  getTrashList,
  extractDisplayName,
};
