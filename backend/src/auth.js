const jwt = require('jsonwebtoken');
const db = require('./db');

const SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
if (!process.env.JWT_SECRET) {
  console.warn('[auth] JWT_SECRET not set, using an insecure development secret.');
}

const signToken = (userId) => jwt.sign({ uid: userId }, SECRET, { expiresIn: '30d' });

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Please log in to continue.' });
  try {
    const { uid } = jwt.verify(token, SECRET);
    const exists = db.prepare('SELECT 1 FROM users WHERE id = ?').get(uid);
    if (!exists) return res.status(401).json({ error: 'Account not found. Please log in again.' });
    req.userId = uid;
    next();
  } catch {
    res.status(401).json({ error: 'Your session expired. Please log in again.' });
  }
}

module.exports = { signToken, requireAuth };
