'use strict';
const { messageError } = require('./localization.cjs');


const path = require('node:path');
const { randomUUID } = require('node:crypto');

/**
 * The open projects' save targets. Native paths never enter this store through renderer-provided strings.
 *
 * A window keeps several projects open; one is current (the one in front), and only it can be written. Each
 * document also names its recovery copy (`recovery`): its own token, or the copy it was restored from.
 */
class ProjectFiles {
  constructor({ maxOpenTokens = 32, openTokenTtlMs = 10 * 60 * 1000, maxDocuments = 32 } = {}) {
    if (!Number.isSafeInteger(maxOpenTokens) || maxOpenTokens < 1 || !Number.isFinite(openTokenTtlMs) || openTokenTtlMs <= 0 ||
      !Number.isSafeInteger(maxDocuments) || maxDocuments < 1) throw messageError(new Error(''), 'desktop.projectFiles.errors.nativeProjectCapabilityLimitsMustBePositive', {});
    this.maxOpenTokens = maxOpenTokens;
    this.openTokenTtlMs = openTokenTtlMs;
    this.maxDocuments = maxDocuments;
    this.opens = new Map();
    this.documents = new Map();
    this.current = null;
  }

  validateDestination(filename) {
    if (typeof filename !== 'string' || !path.isAbsolute(filename) || path.extname(filename).toLowerCase() !== '.styk') {
      throw messageError(new Error(''), 'desktop.projectFiles.errors.chooseAStykProjectFilenamePivotSourceFilesAreSavedThroughExport', {});
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

  /** Opens a document and makes it current. `recovery` names the copy it was restored from (a slot the caller verified). */
  activate({ openToken } = {}, { recovery } = {}) {
    let filename = null;
    if (openToken !== undefined && openToken !== null) {
      const opened = this.opens.get(openToken);
      if (!opened || opened.expires <= Date.now()) throw messageError(new Error(''), 'desktop.projectFiles.errors.thisNativeProjectOpenIsNoLongerActiveReopenTheFileToSaveToItsOriginalLocation', {});
      filename = opened.filename;
      this.opens.delete(openToken);
    }
    const documentToken = randomUUID();
    this.current = { documentToken, filename, recovery: recovery === undefined ? documentToken : recovery };
    // A renderer that never releases (it reloaded, or crashed) cannot grow this map: the oldest make room.
    while (this.documents.size >= this.maxDocuments) this.documents.delete(this.documents.keys().next().value);
    this.documents.set(documentToken, this.current);
    return this.describe(this.current);
  }

  /** An open document, current or not. */
  require(documentToken) {
    const document = typeof documentToken === 'string' ? this.documents.get(documentToken) : null;
    if (!document) throw messageError(new Error(''), 'desktop.projectFiles.errors.thisSaveBelongsToADifferentDocument', {});
    return document;
  }

  /** Brings an open document to the front: saves and their dialogs follow it. */
  select(documentToken) {
    this.current = this.require(documentToken);
    return this.describe(this.current);
  }

  /** Closes a document. Its save target and pending capabilities end with it. */
  release(documentToken) {
    const document = typeof documentToken === 'string' ? this.documents.get(documentToken) : null;
    if (!document) return false;
    this.documents.delete(documentToken);
    if (this.current === document) this.current = null;
    return true;
  }

  /** Forgets every document (the page loaded again). Pending native opens stay valid. */
  clear() {
    this.documents.clear();
    this.current = null;
  }

  /** The recovery slots open documents own. */
  get recoverySlots() {
    return new Set([...this.documents.values()].map(document => document.recovery));
  }

  requireCurrent(documentToken) {
    if (!this.current || typeof documentToken !== 'string' || this.current.documentToken !== documentToken) {
      throw messageError(new Error(''), 'desktop.projectFiles.errors.thisSaveBelongsToADifferentDocument', {});
    }
    return this.current;
  }

  reloadFilename(documentToken) {
    return this.requireCurrent(documentToken).filename;
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
