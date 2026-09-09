'use strict';

const path = require('node:path');
const { randomUUID } = require('node:crypto');

/** Native paths never enter this store through renderer-provided strings. */
class ProjectFiles {
  constructor({ maxOpenTokens = 32, openTokenTtlMs = 10 * 60 * 1000 } = {}) {
    if (!Number.isSafeInteger(maxOpenTokens) || maxOpenTokens < 1 || !Number.isFinite(openTokenTtlMs) || openTokenTtlMs <= 0) throw new Error('Native project capability limits must be positive.');
    this.maxOpenTokens = maxOpenTokens;
    this.openTokenTtlMs = openTokenTtlMs;
    this.opens = new Map();
    this.current = null;
  }

  validateDestination(filename) {
    if (typeof filename !== 'string' || !path.isAbsolute(filename) || path.extname(filename).toLowerCase() !== '.styk') {
      throw new Error('Choose a .styk project filename. Pivot source files are saved through Export.');
    }
    return filename;
  }

  rememberOpen(filename) {
    if (path.extname(filename).toLowerCase() !== '.styk') return null;
    this.validateDestination(filename);
    const now = Date.now();
    for (const [token, value] of this.opens) if (value.expires <= now) this.opens.delete(token);
    while (this.opens.size >= this.maxOpenTokens) this.opens.delete(this.opens.keys().next().value);
    const token = randomUUID();
    this.opens.set(token, { filename, expires: now + this.openTokenTtlMs });
    return token;
  }

  activate({ openToken } = {}) {
    let filename = null;
    if (openToken !== undefined && openToken !== null) {
      const opened = this.opens.get(openToken);
      if (!opened || opened.expires <= Date.now()) throw new Error('This native project open is no longer active. Reopen the file to save to its original location.');
      filename = opened.filename;
      this.opens.delete(openToken);
    }
    this.current = { documentToken: randomUUID(), filename };
    return this.describe(this.current);
  }

  requireCurrent(documentToken) {
    if (!this.current || typeof documentToken !== 'string' || this.current.documentToken !== documentToken) {
      throw new Error('This save belongs to a different document.');
    }
    return this.current;
  }

  commit(documentToken, filename) {
    const document = this.requireCurrent(documentToken);
    document.filename = this.validateDestination(filename);
    return this.describe(document);
  }

  describe(document) {
    return { documentToken: document.documentToken, filename: document.filename ? path.basename(document.filename) : null, hasSaveTarget: Boolean(document.filename) };
  }
}

module.exports = { ProjectFiles };
