const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { signToken, requireAuth } = require('../auth');
const { toUser } = require('../lib');

const router = express.Router();

const privateUser = (u) => ({ ...toUser(u), email: u.email });

router.post('/register', (req, res) => {
  const { username = '', email = '', password = '' } = req.body || {};
  const name = username.trim();
  const mail = email.trim();

  if (!/^[a-zA-Z0-9._]{3,30}$/.test(name)) {
    return res.status(400).json({ error: 'Username must be 3-30 characters: letters, numbers, dots or underscores.' });
  }
  if (!/^\S+@\S+\.\S+$/.test(mail)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });

  const taken = db.prepare('SELECT username, email FROM users WHERE username = ? OR email = ?').get(name, mail);
  if (taken) {
    const field = taken.username.toLowerCase() === name.toLowerCase() ? 'Username' : 'Email';
    return res.status(409).json({ error: `${field} is already taken.` });
  }

  const hash = bcrypt.hashSync(password, 10);
  const info = db
    .prepare('INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)')
    .run(name, mail, hash);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ token: signToken(user.id), user: privateUser(user) });
});

router.post('/login', (req, res) => {
  const { identifier = '', password = '' } = req.body || {};
  const id = identifier.trim();
  const user = db.prepare('SELECT * FROM users WHERE username = ? OR email = ?').get(id, id);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Wrong username/email or password.' });
  }
  res.json({ token: signToken(user.id), user: privateUser(user) });
});

router.get('/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  res.json({ user: privateUser(user) });
});

module.exports = router;
module.exports.privateUser = privateUser;
