'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

class FileStreams {
  constructor({ maxBytes = 256 * 1024 * 1024, maxChunkBytes = 256 * 1024, maxSessions = 8, ttlMs = 120000 } = {}) {
    this.maxBytes = maxBytes;
    this.maxChunkBytes = maxChunkBytes;
    this.maxSessions = maxSessions;
    this.ttlMs = ttlMs;
    this.jobs = new Map();
  }

  validateSize(size) {
    if (!Number.isSafeInteger(size) || size < 0 || size > this.maxBytes) throw new Error('The file size is invalid or exceeds the 256 MB limit.');
  }

  touch(job) {
    clearTimeout(job.timer);
    job.timer = setTimeout(() => this.cancel(job.token).catch(() => {}), this.ttlMs);
    job.timer.unref?.();
  }

  register(job) {
    if (this.jobs.size >= this.maxSessions) throw new Error('Too many file transfers are active.');
    job.token = randomUUID();
    job.busy = false;
    this.jobs.set(job.token, job);
    this.touch(job);
    return { token: job.token, size: job.size, maxChunkBytes: this.maxChunkBytes };
  }

  async use(token, mode, operation) {
    const job = this.jobs.get(token);
    if (!job || job.mode !== mode || job.cancelled) throw new Error('This file transfer is no longer active.');
    if (job.busy) throw new Error('Wait for the previous file chunk to finish.');
    job.busy = true;
    job.idle = new Promise((resolve) => { job.resolveIdle = resolve; });
    clearTimeout(job.timer);
    try { return await operation(job); }
    finally { job.busy = false; job.resolveIdle?.(); job.idle = null; if (this.jobs.has(token) && !job.cancelled) this.touch(job); }
  }

  async beginWrite({ destination, size, onCommit } = {}) {
    this.validateSize(size);
    if (typeof destination !== 'string' || !path.isAbsolute(destination)) throw new Error('A native-approved destination is required.');
    if (this.jobs.size >= this.maxSessions) throw new Error('Too many file transfers are active.');
    const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}.${randomUUID()}.tmp`);
    const handle = await fs.open(temporary, 'wx');
    try { return this.register({ mode: 'write', destination, temporary, handle, size, position: 0, onCommit }); }
    catch (error) { await handle.close(); await fs.unlink(temporary); throw error; }
  }

  write(token, chunk) {
    return this.use(token, 'write', async (job) => {
      let bytes;
      if (chunk instanceof ArrayBuffer) bytes = Buffer.from(chunk);
      else if (ArrayBuffer.isView(chunk) && !(chunk instanceof DataView)) bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      else throw new Error('Each file chunk must contain binary bytes.');
      if (!bytes.byteLength || bytes.byteLength > this.maxChunkBytes) throw new Error('A file chunk must contain between 1 byte and 256 KB.');
      if (job.position + bytes.byteLength > job.size) throw new Error('The file transfer exceeds its declared size.');
      let offset = 0;
      while (offset < bytes.length) {
        const result = await job.handle.write(bytes, offset, bytes.length - offset, job.position + offset);
        if (!result.bytesWritten) throw new Error('The file chunk could not be written.');
        offset += result.bytesWritten;
      }
      job.position += bytes.length;
      return { written: job.position, total: job.size };
    });
  }

  finish(token) {
    return this.use(token, 'write', async (job) => {
      if (job.position !== job.size) throw new Error('The file transfer is incomplete.');
      await job.handle.sync();
      if (job.cancelled) throw new Error('The file transfer was cancelled.');
      await job.handle.close();
      job.handle = null;
      if (job.cancelled) throw new Error('The file transfer was cancelled.');
      try {
        await fs.rename(job.temporary, job.destination);
        this.jobs.delete(token);
        clearTimeout(job.timer);
        if (job.onCommit) await job.onCommit();
        return { saved: true, path: job.destination, size: job.size };
      } catch (error) {
        this.jobs.delete(token);
        await fs.unlink(job.temporary).catch((failure) => { if (failure.code !== 'ENOENT') throw failure; });
        throw error;
      }
    });
  }

  async beginRead(filename) {
    if (typeof filename !== 'string' || !path.isAbsolute(filename)) throw new Error('A native-approved source is required.');
    if (this.jobs.size >= this.maxSessions) throw new Error('Too many file transfers are active.');
    let handle;
    try { handle = await fs.open(filename, 'r'); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error('The recovery source is not a file.');
      this.validateSize(stat.size);
      return this.register({ mode: 'read', handle, size: stat.size, position: 0, modifiedAt: stat.mtime.toISOString() });
    } catch (error) { await handle.close(); throw error; }
  }

  read(token) {
    return this.use(token, 'read', async (job) => {
      const count = Math.min(this.maxChunkBytes, job.size - job.position);
      const bytes = Buffer.allocUnsafe(count);
      let offset = 0;
      while (offset < count) {
        const result = await job.handle.read(bytes, offset, count - offset, job.position + offset);
        if (!result.bytesRead) throw new Error('The recovery file changed during reading.');
        offset += result.bytesRead;
      }
      job.position += count;
      const done = job.position === job.size;
      if (done) {
        await job.handle.close();
        job.handle = null;
        this.jobs.delete(token);
        clearTimeout(job.timer);
      }
      return { bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), done, read: job.position, total: job.size };
    });
  }

  async cancel(token) {
    const job = this.jobs.get(token);
    if (!job) return { cancelled: false };
    if (job.cancellation) return job.cancellation;
    job.cancelled = true;
    clearTimeout(job.timer);
    job.cancellation = (async () => {
      if (job.busy) await job.idle;
      if (!this.jobs.has(token)) return { cancelled: false };
      this.jobs.delete(token);
      if (job.handle) await job.handle.close();
      if (job.temporary) await fs.unlink(job.temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; });
      return { cancelled: true };
    })();
    return job.cancellation;
  }

  closeRead(token) { return this.cancel(token); }

  async dispose() {
    for (const token of [...this.jobs.keys()]) await this.cancel(token).catch(() => {});
  }
}

module.exports = { FileStreams };
