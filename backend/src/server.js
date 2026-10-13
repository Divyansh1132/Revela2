const express = require('express');
const cors = require('cors');
const { UPLOAD_DIR } = require('./upload');

const app = express();
app.use(cors());
app.use(express.json());
app.use((req, _res, next) => {
  if (req.method !== 'GET') console.log(`${new Date().toLocaleTimeString()} ${req.method} ${req.originalUrl}`);
  next();
});
app.use('/uploads', express.static(UPLOAD_DIR));

app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.use('/api/auth', require('./routes/auth'));
app.use('/api', require('./routes/users'));
app.use('/api', require('./routes/mood'));
app.use('/api', require('./routes/posts'));

app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error(err);
  const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : err.status || 400;
  res.status(status).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'File is too large (max 300 MB).' : err.message || 'Something went wrong.' });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, '0.0.0.0', () => console.log(`Revela API running on http://0.0.0.0:${PORT}`));