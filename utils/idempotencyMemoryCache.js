/**
 * In-memory idempotency for single-instance API (double-submit / network retry).
 * Not shared across server processes — use Redis for multi-instance.
 */
const store = new Map();
const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * @param {string} [key]
 * @returns {object | null} previously stored JSON-serializable body
 */
function getIdempotentResponse(key) {
  if (!key || typeof key !== 'string' || key.length < 8) return null;
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return null;
  }
  return entry.body;
}

/**
 * @param {string} key
 * @param {object} body — response payload (will be returned again on replay)
 * @param {number} [ttlMs]
 */
function setIdempotentResponse(key, body, ttlMs = DEFAULT_TTL_MS) {
  if (!key || typeof key !== 'string') return;
  store.set(key, { expiresAt: Date.now() + ttlMs, body });
}

module.exports = {
  getIdempotentResponse,
  setIdempotentResponse,
};
