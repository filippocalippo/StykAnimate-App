'use strict';
const { messageError } = require('./localization.cjs');


const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { renameWithRetry } = require('./rename-retry.cjs');

class FileStreams {
  constructor({ maxBytes = 256 * 1024 * 1024, maxStreamBytes = 16 * 1024 * 1024 * 1024, maxChunkBytes = 256 * 1024, maxSessions = 8, ttlMs = 120000, onCommitError = () => {} } = {}) {
    this.maxBytes = maxBytes;
    this.maxStreamBytes = maxStreamBytes;
    this.maxChunkBytes = maxChunkBytes;
    this.maxSessions = maxSessions;
    this.ttlMs = ttlMs;
    this.onCommitError = onCommitError;
    this.jobs = new Map();
  }

  validateSize(size) {
    if (!Number.isSafeInteger(size) || size < 0 || size > this.maxBytes) throw messageError(new Error(''), 'desktop.fileStreams.errors.theFileSizeIsInvalidOrExceedsThe256MBLimit', {});
  }

  validateStreamSize(size) {
    if (size !== null && size !== undefined && (!Number.isSafeInteger(size) || size < 0 || size > this.maxStreamBytes)) throw messageError(new Error(''), 'desktop.fileStreams.errors.theStreamedFileSizeLimitIsInvalid', {});
  }

  touch(job) {
    clearTimeout(job.timer);
    job.timer = setTimeout(() => this.cancel(job.token).catch(() => {}), this.ttlMs);
    job.timer.unref?.();
  }

  register(job) {
    if (this.jobs.size >= this.maxSessions) throw messageError(new Error(''), 'desktop.fileStreams.errors.tooManyFileTransfersAreActive', {});
    job.token = randomUUID();
    job.busy = false;
    this.jobs.set(job.token, job);
    this.touch(job);
    return { token: job.token, size: job.size, maxChunkBytes: this.maxChunkBytes };
  }

  async use(token, mode, operation) {
    const job = this.jobs.get(token);
    if (!job || job.mode !== mode || job.cancelled) throw messageError(new Error(''), 'desktop.fileStreams.errors.thisFileTransferIsNoLongerActive', {});
    if (job.busy) throw messageError(new Error(''), 'desktop.fileStreams.errors.waitForThePreviousFileChunkToFinish', {});
    job.busy = true;
    job.idle = new Promise((resolve) => { job.resolveIdle = resolve; });
    clearTimeout(job.timer);
    try { return await operation(job); }
    finally { job.busy = false; job.resolveIdle?.(); job.idle = null; if (this.jobs.has(token) && !job.cancelled) this.touch(job); }
  }

  async beginWrite({ destination, size, onCommit, exclusive = false, stream = false } = {}) {
    if (stream) this.validateStreamSize(size); else this.validateSize(size);
    if (typeof destination !== 'string' || !path.isAbsolute(destination)) throw messageError(new Error(''), 'desktop.fileStreams.errors.aNativeApprovedDestinationIsRequired', {});
    if (this.jobs.size >= this.maxSessions) throw messageError(new Error(''), 'desktop.fileStreams.errors.tooManyFileTransfersAreActive', {});
    const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}.${randomUUID()}.tmp`);
    const handle = await fs.open(temporary, 'wx');
    // Streamed writes declare their final size at finish time, not up front.
    try { return this.register({ mode: 'write', destination, temporary, handle, size: stream ? (size ?? null) : size, stream, position: 0, onCommit, exclusive }); }
    catch (error) { await handle.close(); await fs.unlink(temporary); throw error; }
  }

  write(token, chunk) {
    return this.use(token, 'write', async (job) => {
      let bytes;
      if (chunk instanceof ArrayBuffer) bytes = Buffer.from(chunk);
      else if (ArrayBuffer.isView(chunk) && !(chunk instanceof DataView)) bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      else throw messageError(new Error(''), 'desktop.fileStreams.errors.eachFileChunkMustContainBinaryBytes', {});
      if (!bytes.byteLength || bytes.byteLength > this.maxChunkBytes) throw messageError(new Error(''), 'desktop.fileStreams.errors.aFileChunkMustContainBetween1ByteAnd256KB', {});
      if (job.size !== null && job.position + bytes.byteLength > job.size) throw messageError(new Error(''), 'desktop.fileStreams.errors.theFileTransferExceedsItsDeclaredSize', {});
      if (job.size === null && job.position + bytes.byteLength > this.maxStreamBytes) throw messageError(new Error(''), 'desktop.fileStreams.errors.theStreamedFileExceedsThe16GBLimit', {});
      let offset = 0;
      while (offset < bytes.length) {
        const result = await job.handle.write(bytes, offset, bytes.length - offset, job.position + offset);
        if (!result.bytesWritten) throw messageError(new Error(''), 'desktop.fileStreams.errors.theFileChunkCouldNotBeWritten', {});
        offset += result.bytesWritten;
      }
      job.position += bytes.length;
      return { written: job.position, total: job.size };
    });
  }

  /** Overwrite already-written bytes without moving the append position. */
  patch(token, offset, chunk) {
    return this.use(token, 'write', async (job) => {
      let bytes;
      if (chunk instanceof ArrayBuffer) bytes = Buffer.from(chunk);
      else if (ArrayBuffer.isView(chunk) && !(chunk instanceof DataView)) bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      else throw messageError(new Error(''), 'desktop.fileStreams.errors.eachFilePatchMustContainBinaryBytes', {});
      if (!bytes.byteLength || bytes.byteLength > this.maxChunkBytes) throw messageError(new Error(''), 'desktop.fileStreams.errors.aFilePatchMustContainBetween1ByteAnd256KB', {});
      if (!Number.isSafeInteger(offset) || offset < 0 || offset + bytes.byteLength > job.position) throw messageError(new Error(''), 'desktop.fileStreams.errors.aFilePatchMustStayInsideTheWrittenRange', {});
      let written = 0;
      while (written < bytes.length) {
        const result = await job.handle.write(bytes, written, bytes.length - written, offset + written);
        if (!result.bytesWritten) throw messageError(new Error(''), 'desktop.fileStreams.errors.theFilePatchCouldNotBeWritten', {});
        written += result.bytesWritten;
      }
      return { patched: offset, bytes: bytes.length };
    });
  }

  finish(token) {
    return this.use(token, 'write', async (job) => {
      if (job.size !== null && job.position !== job.size) throw messageError(new Error(''), 'desktop.fileStreams.errors.theFileTransferIsIncomplete', {});
      await job.handle.sync();
      if (job.cancelled) throw messageError(new Error(''), 'desktop.fileStreams.errors.theFileTransferWasCancelled', {});
      await job.handle.close();
      job.handle = null;
      if (job.cancelled) throw messageError(new Error(''), 'desktop.fileStreams.errors.theFileTransferWasCancelled', {});
      try {
        if (job.exclusive) await fs.link(job.temporary, job.destination);
        // A cancel that comes while the rename is being tried again wins (nothing was replaced); one that comes after the
        // rename found its mark is too late: the save is committed and is reported as saved.
        else await renameWithRetry(job.temporary, job.destination, { stopped: () => job.cancelled });
      } catch (error) {
        this.jobs.delete(token);
        clearTimeout(job.timer);
        await fs.unlink(job.temporary).catch((failure) => { if (failure.code !== 'ENOENT') throw failure; });
        if (job.cancelled) { job.abandoned = true; throw messageError(new Error(''), 'desktop.fileStreams.errors.theFileTransferWasCancelled', {}); }
        throw error;
      }
      // The destination is committed. Optional display metadata or temporary
      // link cleanup must not report a failed save after replacing the file.
      this.jobs.delete(token);clearTimeout(job.timer);
      const result = { saved: true, path: job.destination, size: job.position };
      const report = async error => {try {await this.onCommitError(error);} catch { /* Diagnostics cannot undo a committed file. */ }};
      if(job.exclusive)await fs.unlink(job.temporary).catch(report);
      if(job.onCommit)try {await job.onCommit();} catch(error) {result.metadataSaved=false;await report(error);}
      return result;
    });
  }

  async beginRead(filename) {
    if (typeof filename !== 'string' || !path.isAbsolute(filename)) throw messageError(new Error(''), 'desktop.fileStreams.errors.aNativeApprovedSourceIsRequired', {});
    if (this.jobs.size >= this.maxSessions) throw messageError(new Error(''), 'desktop.fileStreams.errors.tooManyFileTransfersAreActive', {});
    let handle;
    try { handle = await fs.open(filename, 'r'); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw messageError(new Error(''), 'desktop.fileStreams.errors.theRecoverySourceIsNotAFile', {});
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
        if (!result.bytesRead) throw messageError(new Error(''), 'desktop.fileStreams.errors.theRecoveryFileChangedDuringReading', {});
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
      if (!this.jobs.has(token)) return { cancelled: job.abandoned === true };
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
