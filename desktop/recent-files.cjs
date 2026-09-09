'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { atomicWrite } = require('./recovery.cjs');

const MAX_RECENT_BYTES = 512 * 1024;
// Main remembers .json only after the existing legacy STYK Open path validates it.
const EXTENSIONS = new Set(['.piv', '.stk', '.styk', '.stkz', '.json']);
const OPAQUE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Input has already been normalized/realpathed by the native process. */
function canonicalPathKey(filename, platform = process.platform) {
  return platform === 'win32' ? filename.toLowerCase() : filename;
}

function validPath(filename) {
  return typeof filename === 'string' && filename.length <= 32767 &&
    !filename.includes('\0') && path.isAbsolute(filename) &&
    EXTENSIONS.has(path.extname(filename).toLowerCase());
}

function unavailable(filename) {
  return new Error(`“${path.basename(filename)}” is no longer available. Locate it using Open file, or remove it from Recent files.`);
}

/**
 * Only the main process may remember paths, after an authorized open or save.
 * Renderer operations use persisted opaque IDs. Removing history never removes
 * an animation or figure. Mutations are serialized and publish after atomic save.
 */
class RecentFiles {
  constructor({ directory, limit = 20 } = {}) {
    if (typeof directory !== 'string' || !path.isAbsolute(directory))
      throw new Error('Recent files need an absolute native storage directory.');
    if (!Number.isInteger(limit) || limit < 1 || limit > 20)
      throw new Error('Recent files supports between 1 and 20 entries.');
    this.directory = path.normalize(directory);
    this.file = path.join(this.directory, 'recent-files.json');
    this.limit = limit;
    this.entries = null;
    this.pending = Promise.resolve();
  }

  enqueue(operation) {
    const result = this.pending.then(async () => {
      if (this.entries === null) this.entries = await this.read();
      return operation();
    });
    this.pending = result.catch(() => {});
    return result;
  }

  async read() {
    let handle;
    try {
      handle = await fs.open(this.file, 'r');
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_RECENT_BYTES) return [];
      // A bounded read also protects against a file that grows after stat().
      const buffer = Buffer.alloc(Math.min(MAX_RECENT_BYTES + 1, stat.size + 1));
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > MAX_RECENT_BYTES) return [];
      const value = JSON.parse(buffer.toString('utf8', 0, length));
      if (value?.version !== 1 || !Array.isArray(value.entries) || value.entries.length > 20) return [];
      const ids = new Set(), paths = new Set(), entries = [];
      for (const item of value.entries) {
        if (!item || typeof item.id !== 'string' || !OPAQUE_ID.test(item.id) || !validPath(item.path)) return [];
        const filename = path.normalize(item.path), key = canonicalPathKey(filename);
        if (ids.has(item.id)) return [];
        ids.add(item.id);
        if (paths.has(key)) continue;
        paths.add(key);
        if (entries.length < this.limit) entries.push({ id: item.id, path: filename });
      }
      return entries;
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'EISDIR' || error instanceof SyntaxError) return [];
      throw error;
    } finally {
      await handle?.close();
    }
  }

  async save(entries) {
    const encoded = JSON.stringify({ version: 1, entries });
    if (Buffer.byteLength(encoded, 'utf8') > MAX_RECENT_BYTES)
      throw new Error('Recent files exceeds its 512 KB storage limit.');
    await fs.mkdir(this.directory, { recursive: true });
    await atomicWrite(this.file, encoded);
    this.entries = entries;
  }

  describe(entry, missing) {
    return { id: entry.id, name: path.basename(entry.path), directory: path.dirname(entry.path), missing };
  }

  remember(absolutePath) {
    return this.enqueue(async () => {
      if (!validPath(absolutePath)) throw new Error('Recent files accepts an absolute .piv, .stk, .stkz or .styk filename.');
      let filename, stat;
      try {
        filename = await fs.realpath(absolutePath);
        stat = await fs.stat(filename);
      } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw unavailable(absolutePath);
        throw error;
      }
      if (!stat.isFile()) throw unavailable(absolutePath);
      if (!validPath(filename)) throw new Error('Recent files accepts .piv, .stk, .stkz or .styk documents.');
      const key = canonicalPathKey(filename);
      const previous = this.entries.find(entry => canonicalPathKey(entry.path) === key);
      const entry = { id: previous?.id ?? randomUUID(), path: filename };
      const next = [entry, ...this.entries.filter(item => canonicalPathKey(item.path) !== key)].slice(0, this.limit);
      await this.save(next);
      return this.describe(entry, false);
    });
  }

  list() {
    return this.enqueue(() => Promise.all(this.entries.map(async entry => {
      let missing = true;
      try { missing = !(await fs.stat(entry.path)).isFile(); }
      catch { /* Retain an unavailable entry so the user can remove it. */ }
      return this.describe(entry, missing);
    })));
  }

  requireEntry(id) {
    const entry = typeof id === 'string' && this.entries.find(item => item.id === id);
    if (!entry) throw new Error('This recent file is no longer in the list. Open it using Open file.');
    return entry;
  }

  resolve(id) {
    return this.enqueue(async () => {
      const entry = this.requireEntry(id);
      try {
        if (!(await fs.stat(entry.path)).isFile()) throw unavailable(entry.path);
      } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw unavailable(entry.path);
        if (error.code === 'EACCES' || error.code === 'EPERM')
          throw new Error(`“${path.basename(entry.path)}” cannot be read. Check its file permissions or open it from another location.`);
        throw error;
      }
      return entry.path;
    });
  }

  remove(id) {
    return this.enqueue(async () => {
      const entry = this.requireEntry(id);
      await this.save(this.entries.filter(item => item !== entry));
      return { removed: true };
    });
  }

  clear() {
    return this.enqueue(async () => {
      await this.save([]);
      return { cleared: true };
    });
  }
}

module.exports = { RecentFiles, MAX_RECENT_BYTES, canonicalPathKey };
