const crypto = require('crypto');
const {
  claimIdempotencyKey,
  completeIdempotencyKey,
  failIdempotencyKey,
} = require('../utils/idempotencyMemoryCache');

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((acc, key) => {
      if (value[key] !== undefined) acc[key] = stableValue(value[key]);
      return acc;
    }, {});
  }
  return value;
}

function requestFingerprint(req) {
  const payload = {
    user: req.user?.id || null,
    path: req.originalUrl || req.path,
    body: req.body || {},
  };
  return crypto.createHash('sha256').update(JSON.stringify(stableValue(payload))).digest('hex');
}

async function returnIdempotency(req, res, next) {
  const key = req.get('Idempotency-Key') || req.get('idempotency-key');
  if (!key) {
    return res.status(400).json({
      success: false,
      message: 'Idempotency-Key header is required for returns',
    });
  }

  const fingerprint = requestFingerprint(req);

  try {
    const claim = await claimIdempotencyKey(key);

    if (claim.status === 'replay') {
      const stored = claim.body || {};
      if (stored.fingerprint && stored.fingerprint !== fingerprint) {
        return res.status(409).json({
          success: false,
          message: 'Idempotency-Key was already used for a different return request',
        });
      }
      return res.status(200).json(stored.response || stored);
    }

    if (claim.status === 'in_progress') {
      return res.status(409).json({
        success: false,
        message: 'A request with this Idempotency-Key is already in progress',
      });
    }

    const originalJson = res.json.bind(res);
    res.json = async (body) => {
      try {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          await completeIdempotencyKey(key, { fingerprint, response: body });
        } else {
          await failIdempotencyKey(key);
        }
      } catch (_) {
      }
      return originalJson(body);
    };

    return next();
  } catch (error) {
    return next(error);
  }
}

module.exports = { returnIdempotency };
