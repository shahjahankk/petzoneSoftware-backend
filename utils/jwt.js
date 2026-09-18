const jwt = require('jsonwebtoken');

/**
 * JWT secrets MUST come from the environment. Hardcoded fallbacks were removed
 * because a known secret lets anyone forge tokens for any user id.
 */
function accessSecret() {
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 16) {
    throw new Error('JWT_SECRET is not configured. Set a random secret of at least 16 characters in production/development.');
  }
  return process.env.JWT_SECRET;
}

function refreshSecret() {
  if (!process.env.JWT_REFRESH_SECRET || process.env.JWT_REFRESH_SECRET.length < 16) {
    throw new Error('JWT_REFRESH_SECRET is not configured. Set a random secret of at least 16 characters in production/development.');
  }
  return process.env.JWT_REFRESH_SECRET;
}

const generateAccessToken = (userId) => {
  return jwt.sign(
    { userId },
    accessSecret(),
    { expiresIn: process.env.JWT_EXPIRES_IN || '24h' }
  );
};

const generateRefreshToken = (userId) => {
  return jwt.sign(
    { userId },
    refreshSecret(),
    { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d' }
  );
};

const verifyRefreshToken = (refreshToken) => {
  try {
    return jwt.verify(refreshToken, refreshSecret());
  } catch (error) {
    throw new Error('Invalid refresh token');
  }
};

const setRefreshTokenCookie = (res, refreshToken) => {
  res.cookie('refreshToken', refreshToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
  });
};

const clearRefreshTokenCookie = (res) => {
  res.clearCookie('refreshToken');
};

module.exports = {
  generateAccessToken,
  generateRefreshToken,
  verifyRefreshToken,
  setRefreshTokenCookie,
  clearRefreshTokenCookie,
  accessSecret,
  refreshSecret,
};
