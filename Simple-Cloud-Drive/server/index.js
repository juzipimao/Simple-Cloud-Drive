import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { promises as fsp } from 'fs';
import { fileURLToPath } from 'url';
import { pipeline } from 'node:stream';
import { DownloadLinks, fileIdentity, openDownloadFile } from './download-links.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const PUBLIC_ROOT = path.join(PROJECT_ROOT, 'public');

dotenv.config({ path: path.join(PROJECT_ROOT, '.env') });

function resolveStorageRoot(input) {
  if (!input) return path.join(PROJECT_ROOT, 'storage');
  if (path.isAbsolute(input)) return input;
  return path.join(PROJECT_ROOT, input);
}

const app = express();
const BASE_PATH = '/start-index';
const PORT = Number(process.env.PORT || 8089);
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_me';
const STORAGE_ROOT = path.resolve(resolveStorageRoot(process.env.STORAGE_ROOT));
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const MAX_EDIT_SIZE_BYTES = 2 * 1024 * 1024; // 2MB
const downloadLinks = new DownloadLinks();

// Ensure storage root exists
fs.mkdirSync(STORAGE_ROOT, { recursive: true });

// Middlewares - Dynamic helmet config based on environment
const isHttps = process.env.NODE_ENV === 'production' || process.env.HTTPS === 'true';
app.use(helmet({
  crossOriginOpenerPolicy: isHttps ? { policy: 'same-origin' } : false,
  crossOriginEmbedderPolicy: isHttps ? { policy: 'require-corp' } : false,
  contentSecurityPolicy: isHttps ? {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:"],
    }
  } : false,
  // 其他安全头保持启用
  xssFilter: true,
  frameguard: { action: 'deny' },
  noSniff: true,
}));
// The UI and API are same-origin. Do not reflect arbitrary origins with
// credentials: that would expose administrator APIs to hostile sibling sites.
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());

// Disable asset caching to avoid stale UI in browsers
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

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
    return res.status(401).json({ error: 'Authentication required' });
  }
  next();
}

function resolveSafePath(requestedPath) {
  if (typeof requestedPath !== 'string' || requestedPath.length > 4096 ||
      /[\0\\]/.test(requestedPath) || requestedPath.split('/').includes('..')) {
    throw new Error('Invalid path');
  }
  const root = fs.realpathSync(STORAGE_ROOT);
  let target = root;
  for (const part of requestedPath.split('/').filter(Boolean)) {
    target = path.join(target, part);
    try {
      if (fs.lstatSync(target).isSymbolicLink()) throw new Error('Symbolic links are not allowed');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return target;
}

function requireSameOrigin(req, res, next) {
  const origin = req.get('origin');
  let foreignOrigin = false;
  if (origin) {
    try {
      const parsed = new URL(origin);
      foreignOrigin = !['http:', 'https:'].includes(parsed.protocol) || parsed.host !== req.get('host');
    } catch {
      foreignOrigin = true;
    }
  }
  if (foreignOrigin || req.get('sec-fetch-site') === 'cross-site') {
    return res.status(403).json({ error: 'Cross-origin requests are not allowed' });
  }
  next();
}

async function sendDownload(req, res, file) {
  let stream;
  try {
    res.attachment(file.filename);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', file.stat.size.toString());
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
    if (req.method === 'HEAD') {
      await file.handle.close();
      return res.end();
    }
    stream = file.handle.createReadStream();
    pipeline(stream, res, () => {
      // pipeline destroys both ends on errors/client disconnects, closing the fd.
    });
  } catch (error) {
    if (stream) stream.destroy();
    else await file.handle.close();
    throw error;
  }
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
    entries.filter(entry => entry.isDirectory() || entry.isFile()).map(async (entry) => {
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
const api = express.Router();

api.post('/login', async (req, res) => {
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

api.post('/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ ok: true });
});

api.get('/whoami', (req, res) => {
  const role = getRoleFromRequest(req);
  res.json({ role });
});

// All management operations require login. Public links use a separate,
// read-only route below and never act as administrator credentials.
// Both API prefixes below share this guard.
api.use(requireAdmin);

api.post('/share', requireSameOrigin, async (req, res) => {
  let file;
  try {
    file = await openDownloadFile(STORAGE_ROOT, req.body?.path);
    const { token, expiresAt } = downloadLinks.create({
      filePath: file.filePath,
      identity: fileIdentity(file.stat),
    });
    // Never build bearer URLs from the untrusted Host/X-Forwarded-Host header.
    res.status(201).json({ url: `${BASE_PATH}/share/${token}`, expiresAt });
  } catch (error) {
    const status = error.status || (error.code === 'ENOENT' ? 404 : 400);
    res.status(status).json({ error: status === 429 ? error.message : 'File unavailable or invalid path' });
  } finally {
    if (file) await file.handle.close();
  }
});

api.get('/list', async (req, res) => {
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

api.get('/download', async (req, res) => {
  try {
    const file = await openDownloadFile(STORAGE_ROOT, req.query.path);
    await sendDownload(req, res, file);
  } catch (e) {
    if (!res.headersSent) res.status(e.code === 'ENOENT' ? 404 : 400).json({ error: 'File unavailable or invalid path' });
  }
});

api.get('/read', async (req, res) => {
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

api.post('/write', requireAdmin, async (req, res) => {
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

api.post('/mkdir', requireAdmin, async (req, res) => {
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

api.post('/rename', requireAdmin, async (req, res) => {
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

api.post('/move', requireAdmin, async (req, res) => {
  try {
    const { path: p, to } = req.body || {};
    if (typeof p !== 'string' || typeof to !== 'string') return res.status(400).json({ error: 'Invalid path' });

    const src = resolveSafePath(p);
    const srcSt = await statSafe(src);
    if (!srcSt) return res.status(404).json({ error: 'Not found' });

    const baseName = path.basename(p);
    if (!baseName) return res.status(400).json({ error: 'Invalid path' });

    const targetDir = resolveSafePath(to);
    const targetDirSt = await statSafe(targetDir);
    if (!targetDirSt || !targetDirSt.isDirectory()) return res.status(400).json({ error: 'Target directory not found' });

    if (srcSt.isDirectory()) {
      const srcPrefix = src.endsWith(path.sep) ? src : src + path.sep;
      if (targetDir === src || targetDir.startsWith(srcPrefix)) {
        return res.status(400).json({ error: 'Cannot move directory into itself' });
      }
    }

    const dst = resolveSafePath(path.join(to, baseName));
    if (!dst.startsWith(targetDir)) return res.status(400).json({ error: 'Invalid target path' });

    const dstSt = await statSafe(dst);
    if (dstSt) return res.status(409).json({ error: 'Target already exists' });

    await fsp.rename(src, dst);
    res.json({ ok: true, from: p, to: path.join(to, baseName) });
  } catch (e) {
    res.status(400).json({ error: e.message || 'Bad request' });
  }
});

async function removeRecursively(targetPath) {
  let st;
  try { st = await fsp.lstat(targetPath); } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
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

api.delete('/delete', requireAdmin, async (req, res) => {
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

api.post('/upload', requireAdmin, upload.array('files', 20), async (req, res) => {
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

app.use(`${BASE_PATH}/api`, api);
// Backward-compatible API path
app.use('/api', api);

// This is the sole public file endpoint. It accepts only an opaque token, not
// a client-supplied file path, and is registered before the management guard.
app.get(`${BASE_PATH}/share/:token`, async (req, res) => {
  const invalid = () => res.status(404).json({ error: 'Download link invalid or expired' });
  const entry = downloadLinks.get(req.params.token);
  if (!entry) return invalid();
  let file;
  try {
    file = await openDownloadFile(STORAGE_ROOT, entry.filePath);
    if (fileIdentity(file.stat) !== entry.identity) {
      downloadLinks.revoke(req.params.token);
      return invalid();
    }
    // Recheck expiry after asynchronous filesystem work, including HEAD.
    if (downloadLinks.get(req.params.token) !== entry) return invalid();
    const download = file;
    file = null; // sendDownload owns and closes the descriptor from here.
    await sendDownload(req, res, download);
  } catch {
    downloadLinks.revoke(req.params.token);
    if (!res.headersSent) return invalid();
  } finally {
    if (file) await file.handle.close();
  }
});

app.get([`${BASE_PATH}/login`, `${BASE_PATH}/login.html`], (req, res) => {
  if (getRoleFromRequest(req) === 'admin') return res.redirect(`${BASE_PATH}/`);
  res.sendFile(path.join(PUBLIC_ROOT, 'login.html'));
});

// The login screen only needs these public assets. Everything else is guarded
// before static path decoding, including direct and encoded index.html URLs.
app.get(`${BASE_PATH}/style.css`, (req, res) => {
  res.sendFile(path.join(PUBLIC_ROOT, 'style.css'));
});
app.get(`${BASE_PATH}/login.js`, (req, res) => {
  res.sendFile(path.join(PUBLIC_ROOT, 'login.js'));
});
app.use(BASE_PATH, (req, res, next) => {
  if (getRoleFromRequest(req) !== 'admin') return res.redirect(`${BASE_PATH}/login`);
  next();
});

app.get(`${BASE_PATH}/dompurify.min.js`, (req, res) => {
  res.sendFile(path.join(PROJECT_ROOT, 'node_modules/dompurify/dist/purify.min.js'));
});

// Static frontend (no cache)
app.use(BASE_PATH, express.static(PUBLIC_ROOT, {
  etag: false,
  lastModified: false,
  cacheControl: false,
  maxAge: 0,
}));

app.listen(PORT, () => {
  console.log(`Simple Cloud Drive running on http://0.0.0.0:${PORT}${BASE_PATH}`);
  console.log(`Storage root: ${STORAGE_ROOT}`);
});
