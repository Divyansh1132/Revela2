const express = require('express');
const db = require('../db');
const { requireAuth } = require('../auth');
const { upload, removeFile } = require('../upload');
const { toUser, listPosts } = require('../lib');
const { privateUser } = require('./auth');

const router = express.Router();
router.use(requireAuth);

// Update my profile (multipart: fullName, bio, optional avatar image)
router.put('/me', upload.single('avatar'), (req, res) => {
  const me = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  const fullName = (req.body.fullName ?? me.full_name).toString().trim().slice(0, 60);
  const bio = (req.body.bio ?? me.bio).toString().trim().slice(0, 200);

  let avatar = me.avatar_path;
  if (req.file) {
    if (!req.file.mimetype.startsWith('image/')) {
      removeFile(req.file.filename);
      return res.status(400).json({ error: 'Profile photo must be an image.' });
    }
    removeFile(me.avatar_path);
    avatar = req.file.filename;
  }

  db.prepare('UPDATE users SET full_name = ?, bio = ?, avatar_path = ? WHERE id = ?').run(fullName, bio, avatar, req.userId);
  res.json({ user: privateUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId)) });
});

router.get('/users/search', (req, res) => {
  const q = (req.query.q || '').toString().trim();
  if (!q) return res.json({ users: [] });
  const like = `%${q.replace(/[%_]/g, '')}%`;
  const rows = db
    .prepare('SELECT * FROM users WHERE username LIKE ? OR full_name LIKE ? ORDER BY username LIMIT 20')
    .all(like, like);
  res.json({ users: rows.map(toUser) });
});

router.get('/users/:username', (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(req.params.username);
  if (!u) return res.status(404).json({ error: 'User not found.' });
  const c = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM posts WHERE user_id = @id) AS posts,
              (SELECT COUNT(*) FROM follows WHERE following_id = @id) AS followers,
              (SELECT COUNT(*) FROM follows WHERE follower_id = @id) AS following,
              EXISTS (SELECT 1 FROM follows WHERE follower_id = @me AND following_id = @id) AS is_following`
    )
    .get({ id: u.id, me: req.userId });
  res.json({
    ...toUser(u),
    postCount: c.posts,
    followerCount: c.followers,
    followingCount: c.following,
    isFollowing: !!c.is_following,
    isMe: u.id === req.userId,
  });
});

router.get('/users/:username/posts', (req, res) => {
  const u = db.prepare('SELECT id FROM users WHERE username = ?').get(req.params.username);
  if (!u) return res.status(404).json({ error: 'User not found.' });
  res.json(listPosts({ where: 'p.user_id = @uid', params: { uid: u.id }, me: req.userId, before: req.query.before, limit: 30 }));
});

router.post('/users/:username/follow', (req, res) => {
  const u = db.prepare('SELECT id FROM users WHERE username = ?').get(req.params.username);
  if (!u) return res.status(404).json({ error: 'User not found.' });
  if (u.id === req.userId) return res.status(400).json({ error: "You can't follow yourself." });

  const existing = db.prepare('SELECT 1 FROM follows WHERE follower_id = ? AND following_id = ?').get(req.userId, u.id);
  if (existing) db.prepare('DELETE FROM follows WHERE follower_id = ? AND following_id = ?').run(req.userId, u.id);
  else db.prepare('INSERT INTO follows (follower_id, following_id) VALUES (?, ?)').run(req.userId, u.id);

  const { n } = db.prepare('SELECT COUNT(*) AS n FROM follows WHERE following_id = ?').get(u.id);
  res.json({ following: !existing, followerCount: n });
});

module.exports = router;
