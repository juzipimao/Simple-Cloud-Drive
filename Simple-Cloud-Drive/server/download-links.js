import { createHash, randomBytes } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';

export const DOWNLOAD_LINK_TTL_MS = 60 * 60 * 1000;
const hashToken = token => createHash('sha256').update(token).digest('hex');

// Deliberately separate from login JWTs. Only token hashes are kept in memory;
// restarting the process revokes all links rather than persisting bearer secrets.
export class DownloadLinks {
  #entries = new Map();
  #now;
  #limit;

  constructor({ now = Date.now, limit = 10000 } = {}) {
    this.#now = now;
    this.#limit = limit;
  }

  create(file) {
    const now = this.#now();
    for (const [key, entry] of this.#entries) {
      if (entry.expiresAt <= now) this.#entries.delete(key);
    }
    if (this.#entries.size >= this.#limit) {
      const error = new Error('Too many active download links; try again later');
      error.status = 429;
      throw error;
    }
    const token = randomBytes(32).toString('base64url');
    const expiresAt = now + DOWNLOAD_LINK_TTL_MS;
    this.#entries.set(hashToken(token), Object.freeze({ ...file, expiresAt }));
    return { token, expiresAt };
  }

  get(token) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const key = hashToken(token);
    const entry = this.#entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= this.#now()) {
      this.#entries.delete(key);
      return null;
    }
    return entry;
  }

  revoke(token) {
    this.#entries.delete(hashToken(token));
  }
}

export function fileIdentity(stat) {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
}

// Reject symlinks in EVERY component, not just the final filename. On Linux,
// walk through pinned directory descriptors so renames/symlink swaps cannot
// redirect an open between validation and use. Stream this same descriptor.
export async function openDownloadFile(storageRoot, requestedPath) {
  if (typeof requestedPath !== 'string' || !requestedPath || requestedPath.length > 4096 ||
      /[\0\\]/.test(requestedPath) || requestedPath.split('/').includes('..')) {
    throw new Error('Invalid file path');
  }
  const parts = requestedPath.split('/').filter(part => part && part !== '.');
  if (!parts.length) throw new Error('Cannot download directory');
  if (constants.O_NOFOLLOW === undefined) throw new Error('Secure file opening is unavailable');

  const root = await fs.realpath(storageRoot);
  const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  let handle = await fs.open(root, directoryFlags);
  try {
    for (let i = 0; i < parts.length; i++) {
      const candidate = path.join(root, ...parts.slice(0, i + 1));
      const filename = process.platform === 'linux' ? `/proc/self/fd/${handle.fd}/${parts[i]}` : candidate;
      if (process.platform !== 'linux' && (await fs.lstat(candidate)).isSymbolicLink()) {
        throw new Error('Symbolic links are not allowed');
      }
      const flags = i === parts.length - 1
        ? constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
        : directoryFlags;
      const child = await fs.open(filename, flags);
      const parent = handle;
      handle = child;
      await parent.close();
    }
    const actualPath = await fs.realpath(process.platform === 'linux'
      ? `/proc/self/fd/${handle.fd}` : path.join(root, ...parts));
    if (!actualPath.startsWith(root.endsWith(path.sep) ? root : root + path.sep)) {
      throw new Error('Invalid file path');
    }
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile()) throw new Error('Only regular files can be downloaded');
    const result = { handle, stat, filePath: '/' + parts.join('/'), filename: parts.at(-1) };
    handle = null;
    return result;
  } finally {
    if (handle) await handle.close();
  }
}
