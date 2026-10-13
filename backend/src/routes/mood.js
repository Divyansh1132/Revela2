const express = require('express');
const multer = require('multer');
const path = require('path');
const db = require('../db');
const { requireAuth } = require('../auth');
const { UPLOAD_DIR } = require('../upload');
const { toPost, moodLabel, POST_SELECT } = require('../lib');

const AI_URL = process.env.AI_URL || 'http://127.0.0.1:8000';
const router = express.Router();
router.use(requireAuth);

const frameUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 3 * 1024 * 1024 } });

// ---------------------------------------------------------------- viewer mood (live, from the front camera)
const FRESH_MS = 5 * 60 * 1000; // a mood older than this is ignored

function getMood(userId) {
  const row = db.prepare('SELECT valence, arousal, samples, updated_at FROM user_mood WHERE user_id = ?').get(userId);
  if (!row || Date.now() - Date.parse(row.updated_at) > FRESH_MS) return null;
  return { valence: row.valence, arousal: row.arousal, samples: row.samples, label: moodLabel(row.valence, row.arousal) };
}

// Smooth over time (exponential average) so one blink or odd frame can't flip the feed.
function updateMood(userId, v, a) {
  const prev = getMood(userId);
  const alpha = 0.3;
  const next = prev
    ? { v: prev.valence * (1 - alpha) + v * alpha, a: prev.arousal * (1 - alpha) + a * alpha, n: prev.samples + 1 }
    : { v: v * 0.7, a: a * 0.7, n: 1 }; // first reading: trust it a little less
  db.prepare(
    `INSERT INTO user_mood (user_id, valence, arousal, samples, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET valence = excluded.valence, arousal = excluded.arousal,
       samples = excluded.samples, updated_at = excluded.updated_at`
  ).run(userId, next.v, next.a, next.n, new Date().toISOString());
  return getMood(userId);
}

router.post('/mood/frame', frameUpload.single('frame'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No frame received.' });
  let r;
  try {
    const form = new FormData();
    form.append('frame', new Blob([req.file.buffer], { type: 'image/jpeg' }), 'frame.jpg');
    const resp = await fetch(`${AI_URL}/analyze`, { method: 'POST', body: form, signal: AbortSignal.timeout(8000) });
    r = await resp.json();
  } catch {
    return res.status(503).json({ error: 'AI service is not running. Start it in the revela/ai folder.' });
  }
  if (!r.face) return res.json({ face: false, reason: r.reason, mood: getMood(req.userId) });
  const mood = updateMood(req.userId, r.valence, r.arousal);
  res.json({ face: true, frame: { valence: r.valence, arousal: r.arousal, top: r.top }, mood });
});

router.get('/mood/me', (req, res) => res.json({ mood: getMood(req.userId) }));

// ---------------------------------------------------------------- reel analysis (speech, faces, audio, motion)
let queue = Promise.resolve();
let lastKick = 0;

function enqueueAnalysis(postId) {
  db.prepare("UPDATE posts SET mood_status = 'analyzing' WHERE id = ? AND mood_status != 'analyzing'").run(postId);
  queue = queue.then(() => analyzeReel(postId)).catch(() => {});
}

async function analyzeReel(postId) {
  const p = db.prepare('SELECT id, caption, media_path FROM posts WHERE id = ?').get(postId);
  if (!p) return;
  try {
    const resp = await fetch(`${AI_URL}/analyze-reel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: path.join(UPLOAD_DIR, p.media_path), caption: p.caption }),
      signal: AbortSignal.timeout(10 * 60 * 1000),
    });
    const r = await resp.json();
    if (!resp.ok) throw new Error(r.detail || `AI service returned ${resp.status}`);
    db.prepare("UPDATE posts SET valence = ?, arousal = ?, mood_status = 'done', mood_json = ? WHERE id = ?").run(
      r.valence, r.arousal, JSON.stringify({ signals: r.signals, transcript: r.transcript }), postId
    );
    console.log(`[mood] reel ${postId} -> ${moodLabel(r.valence, r.arousal)} (v ${r.valence}, a ${r.arousal}) from ${Object.keys(r.signals).join(', ')}`);
  } catch (e) {
    const down = e.cause?.code === 'ECONNREFUSED' || e.name === 'TypeError';
    console.error(`[mood] reel ${postId}: ${down ? 'AI service not running (will retry later)' : e.message}`);
    db.prepare('UPDATE posts SET mood_status = ? WHERE id = ?').run(down ? 'none' : 'failed', postId);
  }
}

// Self-healing: reels uploaded while the AI service was off get analyzed once it is back.
function kickPending() {
  if (Date.now() - lastKick < 30000) return;
  lastKick = Date.now();
  db.prepare("SELECT id FROM posts WHERE media_type = 'video' AND mood_status = 'none'").all().forEach((r) => enqueueAnalysis(r.id));
}

// ---------------------------------------------------------------- ranking
// Policy: sad/negative viewer -> lift (more positive, calmer). Otherwise -> positive content at their energy level.
function targetFor(m) {
  if (!m) return null;
  if (m.valence < -0.15) return { valence: Math.min(0.8, m.valence + 0.45), arousal: m.arousal * 0.5, policy: 'lift' };
  return { valence: Math.max(0.35, m.valence), arousal: m.arousal, policy: 'positive' };
}

function rankReels(userId, offset = 0, limit = 8) {
  kickPending();
  const mood = getMood(userId);
  const target = targetFor(mood);
  const rows = db.prepare(`${POST_SELECT} WHERE p.media_type = 'video'`).all({ me: userId });
  const maxLikes = Math.max(1, ...rows.map((r) => r.like_count));

  const scored = rows.map((r) => {
    const post = toPost(r);
    const pop = Math.log1p(r.like_count) / Math.log1p(maxLikes);
    const ageH = (Date.now() - Date.parse(r.created_at)) / 3600000;
    const fresh = 1 / (1 + ageH / 24);
    const known = r.valence != null && r.mood_status === 'done';
    let score;
    if (target) {
      const match = known ? 1 - Math.hypot(r.valence - target.valence, r.arousal - target.arousal) / 2 : 0.4;
      score = 0.75 * match + 0.2 * pop + 0.05 * fresh;
      post.match = Math.round(match * 100);
    } else {
      score = 0.6 * pop + 0.4 * fresh; // no mood yet: trending
    }
    return { post, score };
  });
  scored.sort((x, y) => y.score - x.score);

  const page = scored.slice(offset, offset + limit).map((s) => s.post);
  const next = offset + limit < scored.length ? offset + limit : null;
  return { posts: page, nextCursor: next, policy: target ? target.policy : 'none', mood };
}

module.exports = router;
module.exports.rankReels = rankReels;
module.exports.enqueueAnalysis = enqueueAnalysis;