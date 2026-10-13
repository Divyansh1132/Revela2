const { DatabaseSync } = require('node:sqlite'); // built into Node 22.13+ (no native build needed)
const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(path.join(dataDir, 'revela.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

const NOW = `(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;
const postCols = db.prepare('PRAGMA table_info(posts)').all().map((c) => c.name);
for (const [name, ddl] of [
  ['valence', 'REAL'],
  ['arousal', 'REAL'],
  ['mood_status', "TEXT NOT NULL DEFAULT 'none'"],
  ['mood_json', 'TEXT'],
]) {
  if (!postCols.includes(name)) db.exec(`ALTER TABLE posts ADD COLUMN ${name} ${ddl}`);
}
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  full_name TEXT NOT NULL DEFAULT '',
  bio TEXT NOT NULL DEFAULT '',
  avatar_path TEXT,
  created_at TEXT NOT NULL DEFAULT ${NOW}
);

CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  caption TEXT NOT NULL DEFAULT '',
  media_path TEXT NOT NULL,
  media_type TEXT NOT NULL CHECK (media_type IN ('image','video')),
  created_at TEXT NOT NULL DEFAULT ${NOW}
);

CREATE TABLE IF NOT EXISTS likes (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT ${NOW},
  PRIMARY KEY (user_id, post_id)
);

CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT ${NOW}
);

CREATE TABLE IF NOT EXISTS follows (
  follower_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  following_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT ${NOW},
  PRIMARY KEY (follower_id, following_id)
);

CREATE INDEX IF NOT EXISTS idx_posts_user ON posts(user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_posts_type ON posts(media_type, id DESC);
CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id, id);
CREATE INDEX IF NOT EXISTS idx_follows_following ON follows(following_id);

CREATE TABLE IF NOT EXISTS user_mood (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  valence REAL NOT NULL,
  arousal REAL NOT NULL,
  samples INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);
`);

db.exec("UPDATE posts SET mood_status = 'none' WHERE mood_status = 'analyzing'"); // interrupted by a restart


module.exports = db;
