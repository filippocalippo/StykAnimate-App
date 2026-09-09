'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const MAX_RECOVERY_BYTES = 256 * 1024 * 1024;

async function atomicWrite(destination, data) {
  const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}.${randomUUID()}.tmp`);
  try {
    const handle = await fs.open(temporary, 'wx');
    try { await handle.writeFile(data); await handle.sync(); }
    finally { await handle.close(); }
    await fs.rename(temporary, destination);
  } finally {
    await fs.unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
}

class RecoveryStore {
  constructor(directory, { maxBytes = MAX_RECOVERY_BYTES } = {}) {
    this.directory = directory;
    this.file = path.join(directory, 'recovery.styk');
    this.metadata = path.join(directory, 'recovery.json');
    this.maxBytes = maxBytes;
    this.pending = Promise.resolve();
  }

  enqueue(operation) {
    const result = this.pending.then(operation);
    this.pending = result.catch(() => {});
    return result;
  }

  save(options) {
    return this.enqueue(async () => {
      if (!options || typeof options.data !== 'string') throw new Error('Recovery data must be base64 text.');
      if (options.data.length > Math.ceil(this.maxBytes / 3) * 4) throw new Error('Recovery exceeds the 256 MB limit.');
      if (options.data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(options.data)) throw new Error('Recovery data is not valid base64.');
      const bytes = Buffer.from(options.data, 'base64');
      if (!bytes.length) throw new Error('Recovery data is empty.');
      if (bytes.length > this.maxBytes) throw new Error('Recovery exceeds the 256 MB limit.');
      const name = String(options.name || 'Untitled').replace(/[\x00-\x1f\x7f\\/:*?"<>|]/g, '_').slice(0, 180).trim() || 'Untitled';
      const metadata = { name, savedAt: new Date().toISOString() };
      await fs.mkdir(this.directory, { recursive: true });
      // The canonical document itself remains readable even if a process exits
      // between committing it and committing its optional display metadata.
      await atomicWrite(this.file, bytes);
      await atomicWrite(this.metadata, JSON.stringify(metadata));
      return { saved: true, ...metadata };
    });
  }

  get() {
    return this.enqueue(async () => {
      let stat;
      try { stat = await fs.stat(this.file); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
      if (!stat.isFile() || !stat.size || stat.size > this.maxBytes) throw new Error('The recovery file is empty or exceeds the size limit.');
      const bytes = await fs.readFile(this.file);
      if (bytes.length > this.maxBytes) throw new Error('The recovery file exceeds the size limit.');
      let metadata = {};
      try {
        const metaStat = await fs.stat(this.metadata);
        if (metaStat.size < 4096) metadata = JSON.parse(await fs.readFile(this.metadata, 'utf8'));
      } catch (error) {
        if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      }
      return { data: bytes.toString('base64'), name: String(metadata.name || 'Recovered animation').slice(0, 180), savedAt: metadata.savedAt || stat.mtime.toISOString() };
    });
  }

  info() {
    return this.enqueue(async () => {
      let stat;
      try { stat = await fs.stat(this.file); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
      if (!stat.isFile() || !stat.size || stat.size > this.maxBytes) throw new Error('The recovery file is empty or exceeds the size limit.');
      let metadata = {};
      try {
        const metaStat = await fs.stat(this.metadata);
        if (metaStat.size < 4096) metadata = JSON.parse(await fs.readFile(this.metadata, 'utf8'));
      } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
      return { size: stat.size, name: String(metadata.name || 'Recovered animation').slice(0, 180), savedAt: metadata.savedAt || stat.mtime.toISOString() };
    });
  }

  updateMetadata(name) {
    return this.enqueue(async () => {
      const metadata = { name: String(name || 'Untitled').replace(/[\x00-\x1f\x7f\\/:*?"<>|]/g, '_').slice(0, 180).trim() || 'Untitled', savedAt: new Date().toISOString() };
      await atomicWrite(this.metadata, JSON.stringify(metadata));
      return metadata;
    });
  }

  delete() {
    return this.enqueue(async () => {
      for (const filename of [this.file, this.metadata]) {
        await fs.unlink(filename).catch((error) => { if (error.code !== 'ENOENT') throw error; });
      }
      return { deleted: true };
    });
  }
}

module.exports = { RecoveryStore, atomicWrite, MAX_RECOVERY_BYTES };
