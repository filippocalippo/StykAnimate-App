'use strict';
const { messageError } = require('./localization.cjs');

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { atomicWrite } = require('./recovery.cjs');
const { canonicalPathKey } = require('./recent-files.cjs');

const MAX_LIBRARY_BYTES = 1024 * 1024;
const MAX_PREVIEW_BYTES = 384 * 1024;
const MAX_PROJECTS = 200;
const MAX_FOLDERS = 48;
const MAX_FOLDER_NAME = 60;
// What Home lists as a project: an animation that opens as a document. Figures and movieclips are assets.
const EXTENSIONS = new Set(['.styk', '.piv', '.json', '.stknds']);
const OPAQUE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PREVIEW = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/;

const projectPath = filename => typeof filename === 'string' && filename.length <= 32767 && !filename.includes('\0') &&
  path.isAbsolute(filename) && EXTENSIONS.has(path.extname(filename).toLowerCase());
const cleanFolder = name => (typeof name === 'string' ? name.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_FOLDER_NAME) : '');
const folderKey = name => name.toLocaleLowerCase();
const whole = (value, min, max) => (Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : null);

/** What a project shows about itself on Home: counts and sizes only, never content. */
function cleanStats(stats) {
  if (!stats || typeof stats !== 'object') return null;
  const frames = whole(stats.frames, 0, 10000000), width = whole(stats.width, 1, 100000), height = whole(stats.height, 1, 100000);
  const fps = Number.isFinite(stats.fps) ? Math.min(1000, Math.max(0.01, Math.round(stats.fps * 100) / 100)) : null;
  return frames === null || width === null || height === null || fps === null ? null : { frames, fps, width, height };
}

/**
 * The projects Home shows and how the person arranged them: pins and folders. The list remembers the paths of the
 * animations that were opened or saved (the main process calls remember(); the renderer only ever sees opaque ids),
 * one small picture per project and its counts. A folder is a label on Home, not a directory: nothing here moves,
 * renames or deletes a file. Removing a project from the list leaves its file alone.
 *
 * Unpinned projects beyond the limit leave oldest first; a pinned project stays until it is unpinned or removed.
 * Mutations are serialized and published after an atomic save, like the recent files.
 */
class ProjectLibrary {
  constructor({ directory, limit = MAX_PROJECTS, now = () => Date.now() } = {}) {
    if (typeof directory !== 'string' || !path.isAbsolute(directory))
      throw messageError(new Error(''), 'desktop.projectLibrary.errors.theProjectListNeedsAnAbsoluteStorageDirectory', {});
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PROJECTS)
      throw messageError(new Error(''), 'desktop.projectLibrary.errors.theProjectListHoldsBetween1AndProjects', {count: MAX_PROJECTS});
    this.directory = path.normalize(directory);
    this.file = path.join(this.directory, 'projects.json');
    this.previews = path.join(this.directory, 'previews');
    this.limit = limit;
    this.now = now;
    this.state = null;
    this.pending = Promise.resolve();
  }

  enqueue(operation) {
    const result = this.pending.then(async () => {
      if (this.state === null) this.state = await this.read();
      return operation();
    });
    this.pending = result.catch(() => {});
    return result;
  }

  /** A damaged list loses what cannot be read and keeps the rest: pins and folders are the person's work. */
  async read() {
    let text;
    try {
      const stat = await fs.stat(this.file);
      if (!stat.isFile() || stat.size > MAX_LIBRARY_BYTES) return { projects: [], folders: [] };
      text = await fs.readFile(this.file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'EISDIR') return { projects: [], folders: [] };
      throw error;
    }
    let value;
    try { value = JSON.parse(text); } catch { return { projects: [], folders: [] }; }
    if (value?.version !== 1) return { projects: [], folders: [] };
    const folders = [], folderNames = new Set();
    for (const raw of Array.isArray(value.folders) ? value.folders.slice(0, MAX_FOLDERS) : []) {
      const name = cleanFolder(raw);
      if (!name || folderNames.has(folderKey(name))) continue;
      folderNames.add(folderKey(name)); folders.push(name);
    }
    const projects = [], ids = new Set(), paths = new Set();
    for (const item of Array.isArray(value.projects) ? value.projects : []) {
      if (!item || typeof item.id !== 'string' || !OPAQUE_ID.test(item.id) || !projectPath(item.path)) continue;
      const filename = path.normalize(item.path), key = canonicalPathKey(filename);
      if (ids.has(item.id) || paths.has(key)) continue;
      ids.add(item.id); paths.add(key);
      const folder = folders.find(name => folderKey(name) === folderKey(cleanFolder(item.folder))) ?? '';
      projects.push({ id: item.id, path: filename, pinned: item.pinned === true, folder,
        openedAt: Number.isFinite(item.openedAt) ? item.openedAt : 0, stats: cleanStats(item.stats), preview: item.preview === true });
    }
    return { projects: projects.slice(0, MAX_PROJECTS), folders };
  }

  async save(next) {
    const encoded = JSON.stringify({ version: 1, folders: next.folders, projects: next.projects });
    if (Buffer.byteLength(encoded, 'utf8') > MAX_LIBRARY_BYTES)
      throw messageError(new Error(''), 'desktop.projectLibrary.errors.theProjectListIsFull', {});
    await fs.mkdir(this.directory, { recursive: true });
    await atomicWrite(this.file, encoded);
    this.state = next;
  }

  previewFile(id) { return path.join(this.previews, `${id}.png`); }
  async dropPreview(id) { await fs.unlink(this.previewFile(id)).catch(() => {}); }

  requireProject(id) {
    const project = typeof id === 'string' && this.state.projects.find(item => item.id === id);
    if (!project) throw messageError(new Error(''), 'desktop.projectLibrary.errors.thisProjectIsNoLongerInTheList', {});
    return project;
  }

  /** Newest first; the unpinned ones beyond the limit leave, and take their pictures with them. */
  async publish(projects, folders = this.state.folders) {
    const ordered = [...projects].sort((a, b) => b.openedAt - a.openedAt);
    const kept = [], dropped = [];
    let unpinned = 0;
    const room = Math.max(0, this.limit - ordered.filter(item => item.pinned).length);
    for (const item of ordered) {
      if (item.pinned || unpinned++ < room) kept.push(item); else dropped.push(item);
    }
    await this.save({ projects: kept, folders });
    await Promise.all(dropped.map(item => this.dropPreview(item.id)));
  }

  describe(project, { missing = false, modifiedAt = null, bytes = null, documentToken = null } = {}) {
    const extension = path.extname(project.path).toLowerCase().slice(1);
    return { id: project.id, name: path.basename(project.path, path.extname(project.path)), filename: path.basename(project.path),
      directory: path.dirname(project.path), extension, pinned: project.pinned, folder: project.folder, openedAt: project.openedAt,
      modifiedAt, bytes, missing, stats: project.stats, hasPreview: project.preview, open: documentToken !== null, documentToken };
  }

  /** A project was opened or saved at `absolutePath`: it leads the list. Other kinds of file are ignored. */
  remember(absolutePath) {
    return this.enqueue(async () => {
      if (!projectPath(absolutePath)) return null;
      let filename;
      try {
        filename = await fs.realpath(absolutePath);
        if (!(await fs.stat(filename)).isFile()) return null;
      } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
        throw error;
      }
      if (!projectPath(filename)) return null;
      const key = canonicalPathKey(filename);
      const previous = this.state.projects.find(item => canonicalPathKey(item.path) === key);
      const project = { id: previous?.id ?? randomUUID(), path: filename, pinned: previous?.pinned ?? false, folder: previous?.folder ?? '',
        openedAt: this.now(), stats: previous?.stats ?? null, preview: previous?.preview ?? false };
      await this.publish([project, ...this.state.projects.filter(item => item !== previous)]);
      return this.describe(project);
    });
  }

  /**
   * The list for Home. `open` names the projects the window has open ([{filename, documentToken}]): each is marked
   * with its document's token, so Home returns to it instead of loading it again.
   */
  list({ open = [] } = {}) {
    return this.enqueue(async () => {
      const tokens = new Map();
      for (const item of Array.isArray(open) ? open : []) {
        if (typeof item?.filename !== 'string' || typeof item.documentToken !== 'string') continue;
        let filename = path.normalize(item.filename);
        // remember() stores resolved paths; a tab may have opened through a linked folder instead.
        try { filename = await fs.realpath(filename); } catch { /* A missing open file can still match its stored path. */ }
        tokens.set(canonicalPathKey(filename), item.documentToken);
      }
      const projects = await Promise.all(this.state.projects.map(async project => {
        let stat = null;
        try { stat = await fs.stat(project.path); } catch { /* A missing project stays listed so it can be removed. */ }
        const present = Boolean(stat?.isFile());
        return this.describe(project, { missing: !present, modifiedAt: present ? stat.mtimeMs : null, bytes: present ? stat.size : null,
          documentToken: tokens.get(canonicalPathKey(project.path)) ?? null });
      }));
      return { projects, folders: [...this.state.folders] };
    });
  }

  /** The path to open, checked now. */
  resolve(id) {
    return this.enqueue(async () => {
      const project = this.requireProject(id);
      try {
        if (!(await fs.stat(project.path)).isFile()) throw Object.assign(new Error(''), { code: 'ENOENT' });
      } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR')
          throw messageError(new Error(''), 'desktop.projectLibrary.errors.valueWasMovedOrDeleted', {value: path.basename(project.path)});
        throw error;
      }
      return project.path;
    });
  }

  /** Where a listed project is, for the file manager. */
  location(id) { return this.enqueue(async () => this.requireProject(id).path); }

  /** Pins or unpins a project, or files it under a folder ('' takes it out). */
  update(id, changes = {}) {
    return this.enqueue(async () => {
      const project = this.requireProject(id), next = { ...project };
      if (typeof changes.pinned === 'boolean') next.pinned = changes.pinned;
      if (changes.folder !== undefined) {
        const name = cleanFolder(changes.folder);
        const folder = name ? this.state.folders.find(item => folderKey(item) === folderKey(name)) : '';
        if (folder === undefined) throw messageError(new Error(''), 'desktop.projectLibrary.errors.thisFolderNoLongerExists', {});
        next.folder = folder;
      }
      await this.publish(this.state.projects.map(item => (item === project ? next : item)));
      return this.describe(next);
    });
  }

  /** Takes a project off the list. Its file stays where it is. */
  remove(id) {
    return this.enqueue(async () => {
      const project = this.requireProject(id);
      await this.save({ projects: this.state.projects.filter(item => item !== project), folders: this.state.folders });
      await this.dropPreview(project.id);
      return { removed: true };
    });
  }

  createFolder(name) {
    return this.enqueue(async () => {
      const folder = cleanFolder(name);
      if (!folder) throw messageError(new Error(''), 'desktop.projectLibrary.errors.giveTheFolderAName', {});
      const existing = this.state.folders.find(item => folderKey(item) === folderKey(folder));
      if (existing) return { folder: existing, created: false };
      if (this.state.folders.length >= MAX_FOLDERS) throw messageError(new Error(''), 'desktop.projectLibrary.errors.thereCanBeAtMostFolders', {count: MAX_FOLDERS});
      await this.save({ projects: this.state.projects, folders: [...this.state.folders, folder] });
      return { folder, created: true };
    });
  }

  renameFolder(from, to) {
    return this.enqueue(async () => {
      const current = this.state.folders.find(item => folderKey(item) === folderKey(cleanFolder(from)));
      if (!current) throw messageError(new Error(''), 'desktop.projectLibrary.errors.thisFolderNoLongerExists', {});
      const folder = cleanFolder(to);
      if (!folder) throw messageError(new Error(''), 'desktop.projectLibrary.errors.giveTheFolderAName', {});
      if (this.state.folders.some(item => item !== current && folderKey(item) === folderKey(folder)))
        throw messageError(new Error(''), 'desktop.projectLibrary.errors.aFolderNamedValueAlreadyExists', {value: folder});
      await this.save({ folders: this.state.folders.map(item => (item === current ? folder : item)),
        projects: this.state.projects.map(item => (item.folder === current ? { ...item, folder } : item)) });
      return { folder };
    });
  }

  /** Deletes the label. Its projects stay on the list, outside any folder. */
  deleteFolder(name) {
    return this.enqueue(async () => {
      const current = this.state.folders.find(item => folderKey(item) === folderKey(cleanFolder(name)));
      if (!current) return { deleted: false };
      await this.save({ folders: this.state.folders.filter(item => item !== current),
        projects: this.state.projects.map(item => (item.folder === current ? { ...item, folder: '' } : item)) });
      return { deleted: true };
    });
  }

  /**
   * The picture and counts of the project saved at `absolutePath` (the main process knows the path; the renderer
   * supplies a small PNG as a data URL and the counts). A project that is not listed is ignored.
   */
  setPreview(absolutePath, { thumbnail, stats } = {}) {
    return this.enqueue(async () => {
      if (typeof absolutePath !== 'string') return { stored: false };
      let filename;
      try { filename = await fs.realpath(absolutePath); }
      catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return { stored: false };
        throw error;
      }
      const key = canonicalPathKey(filename);
      const project = this.state.projects.find(item => canonicalPathKey(item.path) === key);
      if (!project) return { stored: false };
      const next = { ...project, stats: cleanStats(stats) ?? project.stats };
      if (thumbnail !== undefined && thumbnail !== null) {
        const match = typeof thumbnail === 'string' && thumbnail.length <= MAX_PREVIEW_BYTES * 1.4 ? PREVIEW.exec(thumbnail) : null;
        const png = match ? Buffer.from(match[1], 'base64') : null;
        if (!png || png.length > MAX_PREVIEW_BYTES || !png.subarray(0, 8).equals(PNG))
          throw messageError(new Error(''), 'desktop.projectLibrary.errors.aProjectPictureMustBeASmallPNG', {});
        await fs.mkdir(this.previews, { recursive: true });
        await atomicWrite(this.previewFile(project.id), png);
        next.preview = true;
      }
      await this.save({ folders: this.state.folders, projects: this.state.projects.map(item => (item === project ? next : item)) });
      return { stored: true, id: project.id };
    });
  }

  /** A listed project's picture as a data URL, or null. */
  preview(id) {
    return this.enqueue(async () => {
      const project = this.requireProject(id);
      if (!project.preview) return null;
      try {
        const stat = await fs.stat(this.previewFile(project.id));
        if (!stat.isFile() || stat.size > MAX_PREVIEW_BYTES) return null;
        const png = await fs.readFile(this.previewFile(project.id));
        return png.subarray(0, 8).equals(PNG) ? `data:image/png;base64,${png.toString('base64')}` : null;
      } catch { return null; }
    });
  }
}

module.exports = { ProjectLibrary, MAX_PROJECTS, MAX_FOLDERS, MAX_PREVIEW_BYTES };
