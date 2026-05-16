// src/middleware/auth.js
// This runs before any protected route.
// It checks the Authorization header for a valid JWT token.
// If valid, it adds req.userId and req.userNickname to the request.
// Usage: add `authenticate` as a middleware to any route that needs login.

const jwt = require('jsonwebtoken');

function authenticate(req, res, next) {
  // The frontend sends: Authorization: Bearer <token>
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'You must be logged in.' });
  }

  const token = header.split(' ')[1];

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = payload.userId;
    req.userName = payload.name;
    next(); // proceed to the actual route handler
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token. Please log in again.' });
  }
}

module.exports = { authenticate };
