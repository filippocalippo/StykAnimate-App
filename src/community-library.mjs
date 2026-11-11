/** The community library for the browser build: what people share on stykanimate.com.
 *
 * This is the browser twin of desktop/public-library.cjs and follows the same contract, rules
 * and messages: the site's content document names the current index, the index lists every
 * approved item, and a file reaches the editor only after its size and SHA-256 match the
 * index. tests/community-library-parity.test.mjs holds the two to the same answers.
 *
 * A browser cannot read the site's API from another origin (it sends no CORS headers), so
 * every request goes to the editor's own origin under /community, where web/worker.js passes
 * exactly these requests on to the site (see docs/WEB.md). Nothing about the person or their
 * projects is sent.
 */
const MB = 1024 * 1024;
export const LIMITS = Object.freeze({content: 256 * 1024, index: 4 * MB, poster: 512 * 1024});
// Figures and movieclips are what the app can insert. Full projects stay on the website.
export const KINDS = Object.freeze({figure: {extension: 'stkz', maxBytes: 8 * MB}, movieclip: {extension: 'stykmov', maxBytes: 12 * MB}});
// The order the website lists its categories in; a category it adds later follows these.
const CATEGORY_ORDER = ['characters', 'effects', 'moves', 'props', 'backgrounds', 'animations', 'other'];
const MAX_ITEMS = 5000;
const MAX_COUNTED = 5000;
const REFRESH_AFTER = 10 * 60 * 1000;
const MAX_FILE_CACHE_BYTES = 32 * MB;
const MAX_POSTER_CACHE_BYTES = 16 * MB;
const ID = /^[a-z0-9]{10}$/;
const OBJECT_KEY = /^i\/[a-z0-9]{10}\/[\w.-]{1,120}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const CATEGORY = /^[a-z]{2,24}$/;
const SITE_PAGE = 'https://stykanimate.com/library/';

/** A failure with a message the Library panel can show as it is. */
export class LibraryError extends Error {}

const text = (value, max) => typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : null;
export const isPublicId = value => typeof value === 'string' && ID.test(value);
const categoryName = id => id.charAt(0).toUpperCase() + id.slice(1);
const objectKey = (id, value) => typeof value === 'string' && OBJECT_KEY.test(value) && value.startsWith(`i/${id}/`) ? value : null;
const hex = bytes => [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
export const sha256 = async bytes => hex(await globalThis.crypto.subtle.digest('SHA-256', bytes));

/** Validates the index strictly and keeps only what the app can insert. */
export function parseIndex(source) {
  let value;
  try { value = JSON.parse(source); } catch { throw new LibraryError('The community library could not be read.'); }
  if (!Array.isArray(value?.items)) throw new LibraryError('The community library could not be read.');
  const items = [], objects = new Map();
  for (const entry of value.items.slice(0, MAX_ITEMS)) {
    const id = entry?.id, name = text(entry?.t, 120);
    if (!isPublicId(id) || objects.has(id) || !name || typeof entry.k !== 'string' || !Object.hasOwn(KINDS, entry.k)) continue;
    const kind = KINDS[entry.k];
    if (!Number.isSafeInteger(entry.s) || entry.s <= 0 || entry.s > kind.maxBytes || !SHA256.test(entry.sha256 ?? '')) continue;
    const file = objectKey(id, entry.f), poster = objectKey(id, entry.i);
    if (!file?.endsWith(`.${kind.extension}`) || !poster) continue;
    objects.set(id, {file, poster});
    items.push({
      id, name, kind: entry.k, category: typeof entry.c === 'string' && CATEGORY.test(entry.c) ? entry.c : 'other', description: text(entry.d, 600) ?? '',
      author: text(entry.a, 64) ?? '', tags: Array.isArray(entry.g) ? entry.g.filter(tag => typeof tag === 'string' && tag.length <= 32).slice(0, 12) : [],
      size: entry.s, sha256: entry.sha256,
    });
  }
  const present = [...new Set(items.map(item => item.category))];
  const rank = id => CATEGORY_ORDER.indexOf(id) < 0 ? CATEGORY_ORDER.length : CATEGORY_ORDER.indexOf(id);
  present.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  return {categories: present.map(id => ({id, name: categoryName(id)})), items, objects};
}

const ascii = (bytes, at, length) => String.fromCharCode(...bytes.subarray(at, at + length));
/** The image type a poster really is, from its first bytes. */
export function imageType(bytes) {
  if (bytes.length > 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'image/webp';
  if (bytes.length > 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, i) => bytes[i] === byte)) return 'image/png';
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  return null;
}

const UNAVAILABLE = 'The community library is unavailable right now.';
const GONE = 'This asset is no longer in the community library.';
const OFFLINE = 'Could not reach the community library. Check your connection and try again.';

/** A signal that aborts after `ms`; AbortSignal.timeout is missing from older browsers. */
function deadline(ms) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), ms);
  return {signal: controller.signal, done: () => clearTimeout(timer)};
}

async function readBounded(response, limit, missing) {
  if (!response.ok) throw new LibraryError(response.status === 404 ? missing : UNAVAILABLE);
  if (Number(response.headers.get('content-length')) > limit) throw new LibraryError('The community library sent an unexpectedly large file.');
  if (!response.body?.getReader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > limit) throw new LibraryError('The community library sent an unexpectedly large file.');
    return bytes;
  }
  const reader = response.body.getReader(), parts = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) throw new LibraryError('The community library sent an unexpectedly large file.');
      parts.push(part.value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const part of parts) { bytes.set(part, at); at += part.byteLength; }
  return bytes;
}

const base64 = bytes => {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};

/**
 * The items this person has already downloaded once. The site counts a download when a file
 * is requested through its counting route, so the editor asks that route only the first time;
 * every later download of the same item reads the public file directly. Only public ids are
 * kept, on this device (`storage` has async get() and set(value), or nothing to keep them for
 * the session only). The oldest ids go first past MAX_COUNTED.
 */
export class DownloadLedger {
  constructor(storage = null) { this.storage = storage; this.loading = null; }
  load() {
    this.loading ??= (async () => {
      const stored = await this.storage?.get().catch(() => null);
      return new Set(Array.isArray(stored?.ids) ? stored.ids.filter(isPublicId).slice(-MAX_COUNTED) : []);
    })();
    return this.loading;
  }
  async has(id) { return (await this.load()).has(id); }
  async add(id) {
    const ids = await this.load();
    if (ids.has(id)) return;
    ids.add(id);
    while (ids.size > MAX_COUNTED) ids.delete(ids.values().next().value);
    // Best effort: if this cannot be written the next session counts the item once more, and nothing else is lost.
    await this.storage?.set({version: 1, ids: [...ids]}).catch(() => {});
  }
}

/** The ledger's home in the browser: one small localStorage entry. */
export function localStorageLedgerStorage(storage, key = 'stykanimate-community-downloads') {
  // Reading localStorage itself can throw when the browser blocks site data; the ledger then lasts for the session.
  const store = () => storage ?? globalThis.localStorage;
  return {
    async get() { try { return JSON.parse(store().getItem(key)); } catch { return null; } },
    async set(value) { store().setItem(key, JSON.stringify(value)); },
  };
}

/** Least recently used values under a byte budget; one oversized value is still kept alone. */
class ByteCache {
  constructor(limit) { this.limit = limit; this.bytes = 0; this.entries = new Map(); }
  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key); this.entries.set(key, entry);
    return entry.value;
  }
  set(key, value, size) {
    this.delete(key);
    this.entries.set(key, {value, size}); this.bytes += size;
    while (this.bytes > this.limit && this.entries.size > 1) this.delete(this.entries.keys().next().value);
  }
  delete(key) {
    const entry = this.entries.get(key);
    if (entry) { this.entries.delete(key); this.bytes -= entry.size; }
  }
  retain(keep) { for (const key of [...this.entries.keys()]) if (!keep(key)) this.delete(key); }
}

export class CommunityLibrary {
  /** `proxy` is where the editor's own origin forwards to the site (web/worker.js). */
  constructor({proxy = '/community', fetcher = (...args) => globalThis.fetch(...args), now = Date.now, downloads = new DownloadLedger()} = {}) {
    this.proxy = proxy.replace(/\/+$/, '');
    this.fetcher = fetcher; this.now = now; this.downloads = downloads;
    this.snapshot = null; this.checkedAt = 0; this.pending = null; this.inflight = new Map();
    this.posters = new ByteCache(MAX_POSTER_CACHE_BYTES); this.files = new ByteCache(MAX_FILE_CACHE_BYTES);
  }
  /** One bounded GET, redirects refused. `missing` is what a 404 means to the person. */
  async request(url, limit, {timeout = 15000, missing = UNAVAILABLE} = {}) {
    const limited = deadline(timeout);
    try { return await readBounded(await this.fetcher(url, {signal: limited.signal, redirect: 'error', credentials: 'omit'}), limit, missing); }
    catch (error) {
      if (error instanceof LibraryError) throw error;
      throw new LibraryError(OFFLINE);
    } finally { limited.done(); }
  }
  /** The catalogue is checked against the website at most every ten minutes unless refreshed. */
  async catalog({refresh = false} = {}) {
    if (!refresh && this.snapshot && this.now() < this.checkedAt + REFRESH_AFTER) return this.snapshot.catalog;
    if (this.pending) return this.pending;
    this.pending = this.load();
    try { return await this.pending; } finally { this.pending = null; }
  }
  async load() {
    let content;
    try { content = JSON.parse(new TextDecoder().decode(await this.request(`${this.proxy}/content`, LIMITS.content))); }
    catch (error) { throw error instanceof SyntaxError ? new LibraryError('The community library could not be read.') : error; }
    const library = content?.library, version = library?.v;
    if (!library) throw new LibraryError('The community library is not available right now.');
    if (!Number.isSafeInteger(version) || version < 0) throw new LibraryError('The community library could not be read.');
    // An index never changes once published, so an unchanged version needs no second download.
    if (this.snapshot?.version === version) { this.checkedAt = this.now(); return this.snapshot.catalog; }
    const parsed = version === 0 ? {categories: [], items: [], objects: new Map()}
      : parseIndex(new TextDecoder().decode(await this.request(`${this.proxy}/files/index/${version}.json`, LIMITS.index)));
    const {objects, ...catalog} = parsed;
    this.snapshot = {version, catalog, records: new Map(catalog.items.map(item => [item.id, {item, ...objects.get(item.id)}]))};
    this.checkedAt = this.now();
    // Posters and files of items that changed or left the library are released.
    const current = new Set(catalog.items.map(item => `${item.id}:${item.sha256}`));
    this.posters.retain(key => current.has(key));
    this.files.retain(key => current.has(key));
    return catalog;
  }
  async record(id) {
    if (!isPublicId(id)) throw new LibraryError('Unknown community library asset.');
    await this.catalog();
    const record = this.snapshot.records.get(id);
    if (!record) throw new LibraryError(GONE);
    return record;
  }
  once(key, operation) {
    if (this.inflight.has(key)) return this.inflight.get(key);
    const result = operation().finally(() => this.inflight.delete(key));
    this.inflight.set(key, result);
    return result;
  }
  objectUrl(key) { return `${this.proxy}/files/${key}`; }
  /** The asset's poster as a data URL (the page's policy allows only its own images, data: and blob:). */
  async preview(id) {
    const {item, poster} = await this.record(id), key = `${id}:${item.sha256}`;
    return this.posters.get(key) ?? this.once(`poster:${key}`, async () => {
      const bytes = await this.request(this.objectUrl(poster), LIMITS.poster, {missing: GONE}), type = imageType(bytes);
      if (!type) throw new LibraryError('The asset preview is not an image.');
      const url = `data:${type};base64,${base64(bytes)}`;
      this.posters.set(key, url, url.length);
      return url;
    });
  }
  /**
   * The file's bytes. An item's first download goes through the site's counting route (the
   * editor's proxy follows the site's redirect to the public file, which a browser cannot do
   * for itself); once counted, the item is remembered and later downloads, in this session or
   * another, read the public file directly, so one person adds one download however often the
   * asset is inserted.
   */
  async download({item, file}) {
    if (await this.downloads.has(item.id)) return this.request(this.objectUrl(file), item.size, {timeout: 60000, missing: GONE});
    const bytes = await this.request(`${this.proxy}/get/${item.id}?k=${encodeURIComponent(file)}`, item.size, {timeout: 60000, missing: GONE});
    await this.downloads.add(item.id);
    return bytes;
  }
  /** The verified native file: {item, name, extension, bytes}. */
  async asset(id) {
    const record = await this.record(id), {item} = record, {extension} = KINDS[item.kind];
    // Per item, not per checksum: two uploads with identical bytes are still two downloads.
    const key = `${item.id}:${item.sha256}`;
    const bytes = this.files.get(key) ?? await this.once(`file:${key}`, async () => {
      const downloaded = await this.download(record);
      if (downloaded.length !== item.size || await sha256(downloaded) !== item.sha256) throw new LibraryError('The downloaded asset did not match the community library. Try again later.');
      this.files.set(key, downloaded, downloaded.length);
      return downloaded;
    });
    return {item, name: `${item.name}.${extension}`, extension: `.${extension}`, bytes};
  }
  /** The website's page for the library, or for one asset. */
  pageFor(id) { return isPublicId(id) ? `${SITE_PAGE}?item=${id}` : SITE_PAGE; }
}
