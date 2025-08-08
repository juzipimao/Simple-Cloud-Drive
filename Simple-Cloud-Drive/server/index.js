import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { promises as fsp } from 'fs';
import mime from 'mime-types';

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 8089);
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_me';
const STORAGE_ROOT = path.resolve(process.env.STORAGE_ROOT || path.resolve(process.cwd(), 'storage'));
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const MAX_EDIT_SIZE_BYTES = 2 * 1024 * 1024; // 2MB

// Ensure storage root exists
fs.mkdirSync(STORAGE_ROOT, { recursive: true });

// Middlewares - Configure helmet for HTTP development
app.use(helmet({
  crossOriginOpenerPolicy: false, // 禁用COOP以支持HTTP
  crossOriginEmbedderPolicy: false, // 禁用COEP
  contentSecurityPolicy: false, // 禁用CSP，避免资源加载问题
}));
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());

// Disable asset caching to avoid stale UI in browsers
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

// Static frontend (no cache)
app.use('/', express.static(path.join(process.cwd(), 'public'), {
  etag: false,
  lastModified: false,
  cacheControl: false,
  maxAge: 0,
}));

// Multer storage (store directly in destination, but we will compute safe dest at request-time)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } }); // 50MB per file

// Helpers
function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

function getRoleFromRequest(req) {
  const token = req.cookies && req.cookies.token;
  if (!token) return 'guest';
  const decoded = verifyToken(token);
  return decoded && decoded.role === 'admin' ? 'admin' : 'guest';
}

function requireAdmin(req, res, next) {
  const role = getRoleFromRequest(req);
  if (role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden: admin only' });
  }
  next();
}

function resolveSafePath(requestedPath) {
  const normalized = path.normalize('/' + (requestedPath || ''));
  const target = path.resolve(STORAGE_ROOT + normalized);
  if (!target.startsWith(STORAGE_ROOT)) {
    throw new Error('Invalid path');
  }
  return target;
}

function isTextLikeExtension(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const allowed = new Set(['.md', '.markdown', '.txt', '.log', '.json', '.csv', '.yml', '.yaml', '.ini', '.conf']);
  return allowed.has(ext);
}

async function statSafe(targetPath) {
  try {
    return await fsp.stat(targetPath);
  } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    throw e;
  }
}

async function listDirectory(dirPath) {
  const entries = await fsp.readdir(dirPath, { withFileTypes: true });
  const items = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(dirPath, entry.name);
      const st = await fsp.stat(full);
      return {
        name: entry.name,
        type: entry.isDirectory() ? 'dir' : 'file',
        size: st.size,
        mtimeMs: st.mtimeMs,
      };
    })
  );
  // Sort: dirs first then files, alphabetical
  items.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name, 'en');
  });
  return items;
}

// Routes
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    const token = signToken({ role: 'admin', username });
    res.cookie('token', token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
    return res.json({ ok: true, role: 'admin' });
  }
  return res.status(401).json({ error: 'Invalid credentials' });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ ok: true });
});

app.get('/api/whoami', (req, res) => {
  const role = getRoleFromRequest(req);
  res.json({ role });
});

app.get('/api/list', async (req, res) => {
  try {
    const dir = resolveSafePath(req.query.path || '/');
    const st = await statSafe(dir);
    if (!st) return res.status(404).json({ error: 'Not found' });
    if (!st.isDirectory()) return res.status(400).json({ error: 'Not a directory' });
    const items = await listDirectory(dir);
    res.json({ path: req.query.path || '/', items });
  } catch (e) {
    res.status(400).json({ error: e.message || 'Bad request' });
  }
});

app.get('/api/download', async (req, res) => {
  try {
    const file = resolveSafePath(req.query.path || '');
    const st = await statSafe(file);
    if (!st) return res.status(404).json({ error: 'Not found' });
    if (st.isDirectory()) return res.status(400).json({ error: 'Cannot download directory' });
    const fileName = path.basename(file);
    res.setHeader('Content-Type', mime.lookup(fileName) || 'application/octet-stream');
    res.setHeader('Content-Length', st.size);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`);
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    res.status(400).json({ error: e.message || 'Bad request' });
  }
});

app.get('/api/read', async (req, res) => {
  try {
    const filePath = resolveSafePath(req.query.path || '');
    const st = await statSafe(filePath);
    if (!st) return res.status(404).json({ error: 'Not found' });
    if (st.isDirectory()) return res.status(400).json({ error: 'Is a directory' });
    if (!isTextLikeExtension(filePath)) return res.status(415).json({ error: 'Unsupported type for reading' });
    if (st.size > MAX_EDIT_SIZE_BYTES) return res.status(413).json({ error: 'File too large to read' });
    const content = await fsp.readFile(filePath, 'utf8');
    res.json({ path: req.query.path || '', content });
  } catch (e) {
    res.status(400).json({ error: e.message || 'Bad request' });
  }
});

app.post('/api/write', requireAdmin, async (req, res) => {
  try {
    const { path: p, content } = req.body || {};
    if (typeof p !== 'string') return res.status(400).json({ error: 'Invalid path' });
    const filePath = resolveSafePath(p);
    if (!isTextLikeExtension(filePath)) return res.status(415).json({ error: 'Unsupported type for writing' });
    if (Buffer.byteLength(content || '', 'utf8') > MAX_EDIT_SIZE_BYTES) return res.status(413).json({ error: 'Content too large' });
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(filePath, content || '', 'utf8');
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message || 'Bad request' });
  }
});

app.post('/api/mkdir', requireAdmin, async (req, res) => {
  try {
    const { path: p, name } = req.body || {};
    const base = resolveSafePath(p || '/');
    const target = resolveSafePath(path.join(p || '/', name || ''));
    if (!target.startsWith(base)) return res.status(400).json({ error: 'Invalid path' });
    await fsp.mkdir(target, { recursive: true });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message || 'Bad request' });
  }
});

app.post('/api/rename', requireAdmin, async (req, res) => {
  try {
    const { path: p, newName } = req.body || {};
    const src = resolveSafePath(p || '');
    const st = await statSafe(src);
    if (!st) return res.status(404).json({ error: 'Not found' });
    const dst = resolveSafePath(path.join(path.dirname(p || ''), newName || ''));
    await fsp.rename(src, dst);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message || 'Bad request' });
  }
});

async function removeRecursively(targetPath) {
  const st = await statSafe(targetPath);
  if (!st) return;
  if (st.isDirectory()) {
    const children = await fsp.readdir(targetPath);
    for (const child of children) {
      await removeRecursively(path.join(targetPath, child));
    }
    await fsp.rmdir(targetPath);
  } else {
    await fsp.unlink(targetPath);
  }
}

app.delete('/api/delete', requireAdmin, async (req, res) => {
  try {
    const p = req.query.path || (req.body && req.body.path) || '';
    const target = resolveSafePath(p);
    const st = await statSafe(target);
    if (!st) return res.status(404).json({ error: 'Not found' });
    await removeRecursively(target);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message || 'Bad request' });
  }
});

app.post('/api/upload', requireAdmin, upload.array('files', 20), async (req, res) => {
  try {
    const p = req.query.path || '';
    const dir = resolveSafePath(p);
    const st = await statSafe(dir);
    if (!st || !st.isDirectory()) return res.status(400).json({ error: 'Target directory not found' });
    const files = req.files || [];
    for (const file of files) {
      const dest = resolveSafePath(path.join(p, file.originalname));
      // ensure inside dir
      if (!dest.startsWith(dir)) throw new Error('Invalid upload path');
      await fsp.writeFile(dest, file.buffer);
    }
    res.json({ ok: true, uploaded: (req.files || []).map(f => f.originalname) });
  } catch (e) {
    res.status(400).json({ error: e.message || 'Bad request' });
  }
});

// Fallback route for SPA navigation to index.html
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(process.cwd(), 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Simple Cloud Drive running on http://0.0.0.0:${PORT}`);
  console.log(`Storage root: ${STORAGE_ROOT}`);
});


