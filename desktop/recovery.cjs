'use strict';
const { messageError } = require('./localization.cjs');


const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { renameWithRetry } = require('./rename-retry.cjs');

const MAX_RECOVERY_BYTES = 256 * 1024 * 1024;
// One copy per open project. Copies a crashed session left behind are offered at the next start; the oldest of
// those make room once this many exist, never a copy an open project owns.
const MAX_RECOVERY_SLOTS = 16;
const SLOT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const displayName = name => String(name || 'Untitled').replace(/[\x00-\x1f\x7f\\/:*?"<>|]/g, '_').slice(0, 180).trim() || 'Untitled';

async function atomicWrite(destination, data) {
  const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}.${randomUUID()}.tmp`);
  try {
    const handle = await fs.open(temporary, 'wx');
    try { await handle.writeFile(data); await handle.sync(); }
    finally { await handle.close(); }
    await renameWithRetry(temporary, destination);
  } finally {
    await fs.unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
}

/**
 * Recovery copies in one fixed directory. The unnamed slot is the single copy of earlier versions
 * (recovery.styk); a named slot (a UUID the main process issued) belongs to one open project.
 */
class RecoveryStore {
  constructor(directory, { maxBytes = MAX_RECOVERY_BYTES, maxSlots = MAX_RECOVERY_SLOTS } = {}) {
    this.directory = directory;
    this.file = path.join(directory, 'recovery.styk');
    this.metadata = path.join(directory, 'recovery.json');
    this.maxBytes = maxBytes;
    this.maxSlots = maxSlots;
    this.pending = Promise.resolve();
  }

  /** The files of a slot. Slot names never come from a path: only the issued form is accepted. */
  paths(slot = null) {
    if (slot === null || slot === undefined) return { file: this.file, metadata: this.metadata };
    if (typeof slot !== 'string' || !SLOT.test(slot)) throw messageError(new Error(''), 'desktop.recovery.errors.thisRecoveryCopyIsNoLongerAvailable', {});
    return { file: path.join(this.directory, `recovery-${slot}.styk`), metadata: path.join(this.directory, `recovery-${slot}.json`) };
  }

  async _describe(slot) {
    const { file, metadata: metadataFile } = this.paths(slot);
    let stat;
    try { stat = await fs.stat(file); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (!stat.isFile() || !stat.size || stat.size > this.maxBytes) throw messageError(new Error(''), 'desktop.recovery.errors.theRecoveryFileIsEmptyOrExceedsTheSizeLimit', {});
    let metadata = {};
    try {
      const metaStat = await fs.stat(metadataFile);
      if (metaStat.size < 4096) metadata = JSON.parse(await fs.readFile(metadataFile, 'utf8'));
    } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    return { size: stat.size, name: String(metadata.name || 'Recovered animation').slice(0, 180), savedAt: metadata.savedAt || stat.mtime.toISOString() };
  }

  async _slots() {
    let entries;
    try { entries = await fs.readdir(this.directory); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    return [null, ...entries.map(name => /^recovery-(.+)\.styk$/.exec(name)?.[1]).filter(slot => slot && SLOT.test(slot))];
  }

  /** Every readable copy as {slot, name, savedAt, size}, newest first. A copy that cannot be read is left out, never deleted. */
  list() {
    return this.enqueue(async () => {
      const records = [];
      for (const slot of await this._slots()) {
        try { const record = await this._describe(slot); if (record) records.push({ slot, ...record }); }
        catch { /* An unreadable copy stays on disk for the person to inspect. */ }
      }
      return records.sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
    });
  }

  /** Removes the oldest copies no open project owns once the store holds more than its limit. */
  async prune(owned = new Set()) {
    const records = await this.list();
    return this.enqueue(async () => {
      const named = records.filter(record => record.slot !== null), spare = named.filter(record => !owned.has(record.slot));
      const room = Math.max(0, this.maxSlots - (named.length - spare.length));
      for (const record of spare.slice(room)) await this._remove(record.slot);
      return Math.max(0, spare.length - room);
    });
  }

  async _remove(slot) {
    const { file, metadata } = this.paths(slot);
    for (const filename of [file, metadata]) await fs.unlink(filename).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }

  enqueue(operation) {
    const result = this.pending.then(operation);
    this.pending = result.catch(() => {});
    return result;
  }

  save(options) {
    return this.enqueue(async () => {
      if (!options || typeof options.data !== 'string') throw messageError(new Error(''), 'desktop.recovery.errors.recoveryDataMustBeBase64Text', {});
      if (options.data.length > Math.ceil(this.maxBytes / 3) * 4) throw messageError(new Error(''), 'desktop.recovery.errors.recoveryExceedsThe256MBLimit', {});
      if (options.data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(options.data)) throw messageError(new Error(''), 'desktop.recovery.errors.recoveryDataIsNotValidBase64', {});
      const bytes = Buffer.from(options.data, 'base64');
      if (!bytes.length) throw messageError(new Error(''), 'desktop.main.errors.recoveryDataIsEmpty', {});
      if (bytes.length > this.maxBytes) throw messageError(new Error(''), 'desktop.recovery.errors.recoveryExceedsThe256MBLimit', {});
      const metadata = { name: displayName(options.name), savedAt: new Date().toISOString() };
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
      if (!stat.isFile() || !stat.size || stat.size > this.maxBytes) throw messageError(new Error(''), 'desktop.recovery.errors.theRecoveryFileIsEmptyOrExceedsTheSizeLimit', {});
      const bytes = await fs.readFile(this.file);
      if (bytes.length > this.maxBytes) throw messageError(new Error(''), 'desktop.recovery.errors.theRecoveryFileExceedsTheSizeLimit', {});
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

  /** One slot's name, time and size, without its bytes; null when it holds nothing. */
  info(slot = null) {
    return this.enqueue(() => this._describe(slot));
  }

  updateMetadata(name, slot = null) {
    return this.enqueue(async () => {
      const metadata = { name: displayName(name), savedAt: new Date().toISOString() };
      await atomicWrite(this.paths(slot).metadata, JSON.stringify(metadata));
      return metadata;
    });
  }

  delete(slot = null) {
    return this.enqueue(async () => {
      await this._remove(slot);
      return { deleted: true };
    });
  }

  /** Removes every copy: the single copy of earlier versions and each project's. */
  deleteAll() {
    return this.enqueue(async () => {
      for (const slot of await this._slots()) await this._remove(slot);
      return { deleted: true };
    });
  }
}

module.exports = { RecoveryStore, atomicWrite, MAX_RECOVERY_BYTES, MAX_RECOVERY_SLOTS };
