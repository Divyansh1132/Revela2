const db = require('./db');

const toUrl = (p) => (p ? `/uploads/${p}` : null);

const toUser = (u) => ({
  id: u.id,
  username: u.username,
  fullName: u.full_name,
  bio: u.bio,
  avatarUrl: toUrl(u.avatar_path),
});

const POST_SELECT = `
SELECT p.id, p.caption, p.media_path, p.media_type, p.created_at,
       u.id AS user_id, u.username, u.avatar_path,
       (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) AS like_count,
       (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS comment_count,
       EXISTS (SELECT 1 FROM likes l WHERE l.post_id = p.id AND l.user_id = @me) AS liked_by_me
FROM posts p JOIN users u ON u.id = p.user_id`;

const toPost = (r) => ({
  id: r.id,
  caption: r.caption,
  mediaUrl: toUrl(r.media_path),
  mediaType: r.media_type,
  createdAt: r.created_at,
  likeCount: r.like_count,
  commentCount: r.comment_count,
  likedByMe: !!r.liked_by_me,
  user: { id: r.user_id, username: r.username, avatarUrl: toUrl(r.avatar_path) },
});

function getPost(id, me) {
  const row = db.prepare(`${POST_SELECT} WHERE p.id = @id`).get({ id, me });
  return row ? toPost(row) : null;
}

// Cursor pagination: newest first, `before` = last post id seen.
function listPosts({ where = '1=1', params = {}, me, before, limit = 10 }) {
  const args = { ...params, me, limit: limit + 1 };
  let sql = `${POST_SELECT} WHERE ${where}`;
  if (before) {
    sql += ' AND p.id < @before';
    args.before = Number(before);
  }
  sql += ' ORDER BY p.id DESC LIMIT @limit';
  const rows = db.prepare(sql).all(args);
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    posts: page.map(toPost),
    nextCursor: hasMore ? page[page.length - 1].id : null,
  };
}

module.exports = { toUrl, toUser, toPost, getPost, listPosts };
