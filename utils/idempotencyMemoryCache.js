/**
 * DB-backed idempotency for double-submit / network retry safety.
 *
 * Single source of truth is the `idempotency_keys` table (created by
 * scripts/add-idempotency-table.js), so replay state is shared across all
 * server instances the same way the ledger is. A request claims its key with
 * an atomic INSERT (status PENDING); the first request wins and the others get
 * status 'in_progress' (HTTP 409). On success the key is marked COMPLETED and
 * the response body is retained for replay; on failure it is marked FAILED so
 * a retry can claim it again.
 */
const { pool } = require('../config/database');

const DEFAULT_TTL_MS = 5 * 60 * 1000;

function validKey(key) {
  return typeof key === 'string' && key.length >= 8;
}

/**
 * Read-only replay check (no claim). Returns the stored response body if the
 * key is COMPLETED and not expired, otherwise null.
 *
 * @param {string} [key]
 * @returns {Promise<object | null>}
 */
async function getIdempotentResponse(key) {
  if (!validKey(key)) return null;
  try {
    const [rows] = await pool.execute(
      'SELECT status, response_body, expires_at FROM idempotency_keys WHERE idkey = ? LIMIT 1',
      [key]
    );
    if (!rows.length || rows[0].status !== 'COMPLETED') return null;
    if (rows[0].expires_at && new Date(rows[0].expires_at).getTime() <= Date.now()) return null;
    if (!rows[0].response_body) return null;
    return JSON.parse(rows[0].response_body);
  } catch (e) {
    if (e && (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_DB_ERROR')) {
      return null;
    }
    throw e;
  }
}

/**
 * Atomically claim a fresh key (PENDING). Differs from getIdempotentResponse:
 * this both checks an existing COMPLETED key for replay AND inserts a PENDING
 * guard row so concurrent duplicate submits cannot both proceed.
 *
 * Returns:
 *   { status: 'claimed' }                  — caller may proceed with the work
 *   { status: 'replay', body }             — key already completed → return body
 *   { status: 'in_progress' }              — a sibling request is running → 409
 *   { status: 'bypassed' }                 — storage unavailable (no table) → proceed with memory-only guard
 *
 * @param {string} [key]
 * @returns {Promise<{status: string, body?: object}>}
 */
async function claimIdempotencyKey(key) {
  if (!validKey(key)) return { status: 'claimed' };
  const expiresAt = new Date(Date.now() + DEFAULT_TTL_MS);
  try {
    try {
      await pool.execute(
        'INSERT INTO idempotency_keys (idkey, status, expires_at, created_at) VALUES (?, ?, ?, NOW())',
        [key, 'PENDING', expiresAt]
      );
      return { status: 'claimed' };
    } catch (insertErr) {
      if (!insertErr || insertErr.code !== 'ER_DUP_ENTRY') throw insertErr;
    }

    const [rows] = await pool.execute(
      'SELECT status, response_body, expires_at FROM idempotency_keys WHERE idkey = ? LIMIT 1',
      [key]
    );
    if (!rows.length) {
      await pool.execute(
        'INSERT INTO idempotency_keys (idkey, status, expires_at, created_at) VALUES (?, ?, ?, NOW())',
        [key, 'PENDING', expiresAt]
      );
      return { status: 'claimed' };
    }
    const row = rows[0];
    const expired = !row.expires_at || new Date(row.expires_at).getTime() <= Date.now();

    if (row.status === 'COMPLETED') {
      if (expired) {
        await pool.execute(
          'UPDATE idempotency_keys SET status = ?, expires_at = ? WHERE idkey = ?',
          ['PENDING', expiresAt, key]
        );
        return { status: 'claimed' };
      }
      if (row.response_body) {
        return { status: 'replay', body: JSON.parse(row.response_body) };
      }
      return { status: 'replay', body: null };
    }

    if (row.status === 'FAILED' || expired) {
      // Stale or failed previous attempt → reclaim the key.
      await pool.execute(
        'UPDATE idempotency_keys SET status = ?, expires_at = ? WHERE idkey = ?',
        ['PENDING', expiresAt, key]
      );
      return { status: 'claimed' };
    }

    return { status: 'in_progress' };
  } catch (e) {
    if (e && (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_DB_ERROR')) {
      return { status: 'bypassed' };
    }
    throw e;
  }
}

/**
 * Mark a claimed key COMPLETED with its response body (for replay).
 *
 * @param {string} key
 * @param {object} body
 * @returns {Promise<void>}
 */
async function completeIdempotencyKey(key, body) {
  if (!validKey(key)) return;
  try {
    await pool.execute(
      'UPDATE idempotency_keys SET status = ?, response_body = ?, expires_at = ? WHERE idkey = ?',
      ['COMPLETED', JSON.stringify(body), new Date(Date.now() + DEFAULT_TTL_MS), key]
    );
  } catch (e) {
    if (!e || (e.code !== 'ER_NO_SUCH_TABLE' && e.code !== 'ER_BAD_DB_ERROR')) throw e;
  }
}

/**
 * Mark a claimed key FAILED so a retry can reclaim and redo the work
 * (best-effort; never fails the request).
 *
 * @param {string} key
 * @returns {Promise<void>}
 */
async function failIdempotencyKey(key) {
  if (!validKey(key)) return;
  try {
    await pool.execute(
      'UPDATE idempotency_keys SET status = ?, expires_at = ? WHERE idkey = ?',
      ['FAILED', new Date(Date.now() + DEFAULT_TTL_MS), key]
    );
  } catch (e) {
    /* best-effort */
  }
}

module.exports = {
  getIdempotentResponse,
  claimIdempotencyKey,
  completeIdempotencyKey,
  failIdempotencyKey,
};