const express = require('express');
const db = require('../db');
const { requireAuth } = require('../auth');
const { upload, removeFile } = require('../upload');
const { toUser, getPost, listPosts } = require('../lib');

const router = express.Router();
router.use(requireAuth);

// Home feed: my posts + posts from people I follow
router.get('/feed', (req, res) => {
  res.json(
    listPosts({
      where: '(p.user_id = @me OR p.user_id IN (SELECT following_id FROM follows WHERE follower_id = @me))',
      me: req.userId,
      before: req.query.before,
    })
  );
});

// Explore: everything, newest first
router.get('/explore', (req, res) => {
  res.json(listPosts({ me: req.userId, before: req.query.before, limit: 30 }));
});

// Reels: video posts only
router.get('/reels', (req, res) => {
  res.json(listPosts({ where: "p.media_type = 'video'", me: req.userId, before: req.query.before, limit: 8 }));
});

router.post('/posts', upload.single('media'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Choose a photo or video to share.' });
  const type = req.file.mimetype.startsWith('video/') ? 'video' : 'image';
  const caption = (req.body.caption || '').toString().trim().slice(0, 2200);
  const info = db
    .prepare('INSERT INTO posts (user_id, caption, media_path, media_type) VALUES (?, ?, ?, ?)')
    .run(req.userId, caption, req.file.filename, type);
  res.status(201).json({ post: getPost(info.lastInsertRowid, req.userId) });
});

router.get('/posts/:id', (req, res) => {
  const post = getPost(Number(req.params.id), req.userId);
  if (!post) return res.status(404).json({ error: 'Post not found.' });
  res.json({ post });
});

router.delete('/posts/:id', (req, res) => {
  const row = db.prepare('SELECT id, user_id, media_path FROM posts WHERE id = ?').get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Post not found.' });
  if (row.user_id !== req.userId) return res.status(403).json({ error: 'You can only delete your own posts.' });
  db.prepare('DELETE FROM posts WHERE id = ?').run(row.id);
  removeFile(row.media_path);
  res.json({ ok: true });
});

router.post('/posts/:id/like', (req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT 1 FROM posts WHERE id = ?').get(id)) return res.status(404).json({ error: 'Post not found.' });

  const existing = db.prepare('SELECT 1 FROM likes WHERE user_id = ? AND post_id = ?').get(req.userId, id);
  if (existing) db.prepare('DELETE FROM likes WHERE user_id = ? AND post_id = ?').run(req.userId, id);
  else db.prepare('INSERT INTO likes (user_id, post_id) VALUES (?, ?)').run(req.userId, id);

  const { n } = db.prepare('SELECT COUNT(*) AS n FROM likes WHERE post_id = ?').get(id);
  res.json({ liked: !existing, likeCount: n });
});

const toComment = (r) => ({
  id: r.id,
  text: r.text,
  createdAt: r.created_at,
  user: toUser({ id: r.user_id, username: r.username, full_name: '', bio: '', avatar_path: r.avatar_path }),
});

const COMMENT_SELECT = `SELECT c.id, c.text, c.created_at, u.id AS user_id, u.username, u.avatar_path
                        FROM comments c JOIN users u ON u.id = c.user_id`;

router.get('/posts/:id/comments', (req, res) => {
  const rows = db.prepare(`${COMMENT_SELECT} WHERE c.post_id = ? ORDER BY c.id ASC`).all(Number(req.params.id));
  res.json({ comments: rows.map(toComment) });
});

router.post('/posts/:id/comments', (req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT 1 FROM posts WHERE id = ?').get(id)) return res.status(404).json({ error: 'Post not found.' });
  const text = (req.body?.text || '').toString().trim().slice(0, 500);
  if (!text) return res.status(400).json({ error: 'Write something first.' });
  const info = db.prepare('INSERT INTO comments (post_id, user_id, text) VALUES (?, ?, ?)').run(id, req.userId, text);
  const row = db.prepare(`${COMMENT_SELECT} WHERE c.id = ?`).get(info.lastInsertRowid);
  res.status(201).json({ comment: toComment(row) });
});

module.exports = router;
