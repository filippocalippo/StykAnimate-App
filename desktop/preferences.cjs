'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { atomicWrite } = require('./recovery.cjs');

function validateJSON(value, depth = 0) {
  if (depth > 16) throw new Error('Workspace preferences are too deeply nested.');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object') throw new Error('Workspace preferences must contain valid JSON values.');
  if (Array.isArray(value)) { for (const item of value) validateJSON(item, depth + 1); return; }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error('Workspace preferences must contain plain JSON objects.');
  for (const item of Object.values(value)) validateJSON(item, depth + 1);
}

class WorkspacePreferences {
  constructor(directory, { maxBytes = 16 * 1024, filename = 'workspace-preferences.json' } = {}) {
    if (typeof filename !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}\.json$/.test(filename) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])\.json$/i.test(filename)) {
      throw new Error('Preferences filename must be a safe JSON basename.');
    }
    this.directory = directory;
    this.file = path.join(directory, filename);
    this.maxBytes = maxBytes;
    this.pending = Promise.resolve();
  }

  serialize(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Workspace preferences must be a JSON object.');
    validateJSON(value);
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text, 'utf8') > this.maxBytes) throw new Error('Workspace preferences exceed the 16 KB limit.');
    return text;
  }

  set(value) {
    let encoded;
    try { encoded = this.serialize(value); }
    catch (error) { return Promise.reject(error); }
    const result = this.pending.then(async () => {
      await fs.mkdir(this.directory, { recursive: true });
      await atomicWrite(this.file, encoded);
      return { saved: true };
    });
    this.pending = result.catch(() => {});
    return result;
  }

  async get() {
    await this.pending;
    try {
      const stat = await fs.stat(this.file);
      if (!stat.isFile() || stat.size > this.maxBytes) return {};
      const value = JSON.parse(await fs.readFile(this.file, 'utf8'));
      this.serialize(value);
      return value;
    } catch (error) {
      if (error.code === 'ENOENT' || error instanceof SyntaxError || !error.code) return {};
      throw error;
    }
  }
}

module.exports = { WorkspacePreferences };
