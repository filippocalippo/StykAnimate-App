'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {FileStreams} = require('./file-streams.cjs');
const EXTENSIONS = new Set(['.stkz', '.stykmov']);
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

function validName(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 120 || /[<>:"/\\|?*\x00-\x1f]/.test(value) || /[. ]$/.test(value) || value.startsWith('.') || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(value))
    throw new Error('Use a name of 1–120 characters without reserved filename characters.');
  return value.trim();
}

/** Every renderer path is relative to one fixed Documents library. Never follow links. */
class LibraryStore {
  constructor(root) { this.root = path.resolve(root); this.streams = new FileStreams(); this.pending = new Map(); this.chain = Promise.resolve(); }
  serial(operation) { const result = this.chain.then(operation); this.chain = result.catch(() => {}); return result; }
  async init() {
    await fs.mkdir(this.root, {recursive: true});
    await this.resolve('');
    return this.root;
  }
  async resolve(relative = '') {
    if (typeof relative !== 'string' || relative.length > 2000 || relative.includes('\\') || path.isAbsolute(relative) || relative.split('/').some(p => p && (p === '.' || p === '..' || /[:\x00-\x1f]/.test(p)))) throw new Error('Invalid library path.');
    let current = this.root;
    for (const part of ['', ...relative.split('/').filter(Boolean)]) {
      if (part) current = path.join(current, part);
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw new Error('Linked folders and files are not supported in the library.');
    }
    return current;
  }
  async folder(relative = '') { const target = await this.resolve(relative); if (!(await fs.stat(target)).isDirectory()) throw new Error('Choose a library folder.'); return target; }
  async available(folder, name, suffix = '', unique = false) {
    const names = new Set((await fs.readdir(folder)).map(n => n.toLocaleLowerCase()));
    for (const item of this.pending.values()) if (path.dirname(item.destination) === folder) names.add(path.basename(item.destination).toLocaleLowerCase());
    let candidate = name + suffix, i = 2;
    while (names.has(candidate.toLocaleLowerCase())) {
      if (!unique) throw new Error('An item with this name already exists.');
      candidate = `${name} (${i++})${suffix}`;
    }
    return path.join(folder, candidate);
  }
  relative(target) { return path.relative(this.root, target).split(path.sep).join('/'); }
  async list(relative = '') {
    await this.init();
    const folder = await this.folder(relative), entries = [];
    for (const item of await fs.readdir(folder, {withFileTypes: true})) {
      if (item.name.startsWith('.') || item.isSymbolicLink()) continue;
      const extension = path.extname(item.name).toLowerCase();
      if (!item.isDirectory() && (!item.isFile() || !EXTENSIONS.has(extension))) continue;
      const target = path.join(folder, item.name), stat = await fs.stat(target).catch(() => null);
      if (!stat) continue;
      entries.push({path: this.relative(target), name: item.isDirectory() ? item.name : item.name.slice(0, -extension.length),
        kind: item.isDirectory() ? 'folder' : extension === '.stykmov' ? 'movieclip' : 'figure', extension, size: stat.size, modified: stat.mtimeMs});
    }
    entries.sort((a,b) => Number(b.kind === 'folder') - Number(a.kind === 'folder') || a.name.localeCompare(b.name, undefined, {numeric: true}));
    return {root: this.root, path: relative, entries};
  }
  createFolder({folder = '', name}) { return this.serial(async () => { const parent = await this.folder(folder); const target = await this.available(parent, validName(name)); await fs.mkdir(target); return {path: this.relative(target)}; }); }
  async thumbnail(relative) {
    const target = await this.asset(relative), thumb = `${target}.png`;
    try { await this.resolve(this.relative(thumb)); const stat = await fs.stat(thumb); if (stat.size > 1024 * 1024) return null; const bytes = await fs.readFile(thumb); return bytes.subarray(0,8).equals(PNG) ? `data:image/png;base64,${bytes.toString('base64')}` : null; }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async asset(relative) { const target = await this.resolve(relative); if (!EXTENSIONS.has(path.extname(target).toLowerCase()) || !(await fs.stat(target)).isFile()) throw new Error('Choose a saved figure or movieclip.'); return target; }
  beginSave({folder = '', name, extension, size, thumbnail}) { return this.serial(async () => {
    if (!EXTENSIONS.has(extension)) throw new Error('Unsupported library format.');
    if (typeof thumbnail !== 'string' || thumbnail.length > 1400000 || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(thumbnail)) throw new Error('A PNG thumbnail is required.');
    const png = Buffer.from(thumbnail.split(',')[1], 'base64');
    if (!png.subarray(0,8).equals(PNG)) throw new Error('Invalid PNG thumbnail.');
    const parent = await this.folder(folder), destination = await this.available(parent, validName(name), extension, true);
    const transfer = await this.streams.beginWrite({destination, size});
    this.pending.set(transfer.token, {destination, png});
    return {...transfer, path: this.relative(destination)};
  }); }
  write(token, bytes) { return this.streams.write(token, bytes); }
  finish(token) { return this.serial(async () => {
    const item = this.pending.get(token); if (!item) throw new Error('Library save is no longer active.');
    const thumb = `${item.destination}.png`, temporary = `${thumb}.${randomUUID()}.tmp`;
    try {
      await this.folder(this.relative(path.dirname(item.destination)));
      // Refuse overwriting a file created externally during a transfer.
      try { await fs.lstat(item.destination); throw new Error('This name was taken while saving. Try again.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await fs.writeFile(temporary, item.png, {flag: 'wx'});
      await fs.rename(temporary, thumb);
      try { await this.streams.finish(token); } catch (error) { await fs.unlink(thumb).catch(() => {}); throw error; }
      return {saved: true, path: this.relative(item.destination)};
    } finally { this.pending.delete(token); await fs.unlink(temporary).catch(() => {}); await this.streams.cancel(token); }
  }); }
  async cancel(token) { this.pending.delete(token); return this.streams.cancel(token); }
  async beginRead(relative) { const target = await this.asset(relative); return {...await this.streams.beginRead(target), name: path.basename(target)}; }
  read(token) { return this.streams.read(token); }
  change({path: relative, name, folder}) { return this.serial(async () => {
    if (!relative) throw new Error('The library root cannot be moved or renamed.');
    const source = await this.resolve(relative), stat = await fs.stat(source);
    if (!stat.isDirectory()) await this.asset(relative);
    for (const item of this.pending.values()) if (item.destination === source || item.destination.startsWith(source + path.sep)) throw new Error('Wait for the current save to finish.');
    const parent = folder === undefined ? path.dirname(source) : await this.folder(folder);
    if (stat.isDirectory() && (parent === source || parent.startsWith(source + path.sep))) throw new Error('A folder cannot be moved into itself.');
    const ext = stat.isDirectory() ? '' : path.extname(source), stem = name === undefined ? path.basename(source, ext) : validName(name);
    if (parent === path.dirname(source) && stem + ext === path.basename(source)) return {path: relative};
    const destination = await this.available(parent, stem, ext);
    await fs.rename(source, destination);
    if (!stat.isDirectory()) {
      try { await this.resolve(`${relative}.png`); await fs.rename(`${source}.png`, `${destination}.png`); }
      catch (error) { if (error.code !== 'ENOENT') { await fs.rename(destination, source); throw error; } }
    }
    return {path: this.relative(destination)};
  }); }
  async dispose() { await this.streams.dispose(); this.pending.clear(); }
}
module.exports = {LibraryStore, validName};
