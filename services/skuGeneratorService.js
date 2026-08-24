function normalizeBase(name = '') {
  const cleaned = String(name || '')
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, ' ')
    .trim();

  if (!cleaned) return 'ITEM';
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 4) || 'ITEM';
  return (parts[0][0] || 'I') + (parts[1][0] || 'T') + (parts[2] ? parts[2][0] : '') + (parts[3] ? parts[3][0] : '');
}

function scopePrefix(scopeType, scopeId) {
  const st = String(scopeType || '').toUpperCase() === 'BRANCH' ? 'BR' : 'WH';
  const sid = String(scopeId ?? '').trim();
  const compactId = sid.replace(/[^A-Z0-9]/gi, '').toUpperCase().slice(0, 10) || 'GEN';
  return `${st}-${compactId}`;
}

async function runQuery(connection, sql, params) {
  if (typeof connection.execute === 'function') {
    return connection.execute(sql, params);
  }
  if (typeof connection.query === 'function') {
    return connection.query(sql, params);
  }
  throw new Error('Invalid DB connection passed to generateUniqueSku');
}

async function skuExists(connection, scopeType, scopeId, sku) {
  const [rows] = await runQuery(
    connection,
    'SELECT id FROM inventory_items WHERE scope_type = ? AND scope_id = ? AND sku = ? LIMIT 1',
    [scopeType, String(scopeId), sku]
  );
  return rows.length > 0;
}

async function generateUniqueSku({ scopeType, scopeId, name, connection, reservedSkus = new Set() }) {
  if (!connection) throw new Error('DB connection is required for SKU generation');
  if (!scopeType || scopeId === undefined || scopeId === null || scopeId === '') {
    throw new Error('scopeType and scopeId are required for SKU generation');
  }

  const prefix = scopePrefix(scopeType, scopeId);
  const base = normalizeBase(name);

  for (let seq = 1; seq <= 999999; seq += 1) {
    const suffix = String(seq).padStart(4, '0');
    const candidate = `${prefix}-${base}-${suffix}`.slice(0, 255);

    if (reservedSkus.has(candidate)) continue;
    // eslint-disable-next-line no-await-in-loop
    const exists = await skuExists(connection, scopeType, scopeId, candidate);
    if (!exists) {
      reservedSkus.add(candidate);
      return candidate;
    }
  }

  throw new Error('Unable to generate a unique SKU for this scope');
}

module.exports = {
  generateUniqueSku,
};
