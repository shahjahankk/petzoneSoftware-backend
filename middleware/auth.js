const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { accessSecret } = require('../utils/jwt');

const auth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ 
        success: false, 
        message: 'Access token required' 
      });
    }

    const token = authHeader.substring(7); // Remove 'Bearer ' prefix
    const decoded = jwt.verify(token, accessSecret());
    
    try {
      const user = await User.findById(decoded.userId);
      
      if (!user) {
        return res.status(401).json({ 
          success: false, 
          message: 'User not found' 
        });
      }

      if (user.status !== 'ACTIVE') {
        return res.status(401).json({ 
          success: false, 
          message: 'User account is not active' 
        });
      }

      req.user = user;
      next();
    } catch (dbError) {
      // Fail closed: never fabricate a user (especially not an ADMIN) when the
      // database is unavailable. Treating any token as a full admin on a DB
      // blip is a privilege escalation. Return 503 so the client retries.
      return res.status(503).json({
        success: false,
        message: 'Unavailable: could not verify user. Please try again.'
      });
    }
  } catch (error) {
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ 
        success: false, 
        message: 'Invalid token' 
      });
    }
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ 
        success: false, 
        message: 'Token expired' 
      });
    }
    
    res.status(500).json({ 
      success: false, 
      message: 'Internal server error' 
    });
  }
};

module.exports = auth;
