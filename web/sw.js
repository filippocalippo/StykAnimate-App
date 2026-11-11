// Offline support for the StykAnimate web build (docs/WEB.md).
//
// The editor is a fixed set of files, so each build has its own cache holding all
// of them, and every request the page makes is answered from it: the app starts
// with no network and always runs one consistent version. scripts/build-web.mjs
// replaces the PRECACHE line below with the build's file list. Served as it is
// (a development server), it caches nothing and answers nothing.
//
// A new build installs in the background and takes over when every window of the
// old one is closed, so an open project is never swapped under its owner. Files
// that did not change are copied from the previous cache rather than downloaded,
// such as the Pivot codec's WebAssembly module.
'use strict';

// Entries are [path, hash]; the empty path is the page itself.
const PRECACHE = {version: 'development', core: [], codec: []};

const PREFIX = 'styk-app-';
const CACHE = PREFIX + PRECACHE.version;
const SCOPE = self.registration.scope;
const SCOPE_PATH = new URL(SCOPE).pathname;
const RECORD = new URL('.precache', SCOPE).href;
const CONCURRENCY = 8;
// The Pivot codec is stored in the background after the editor; it is also kept the first time it is used.
// The same list as CODEC_FILES in scripts/build-web.mjs.
const isCodec = relative => relative === 'src/engine/pkg/styk_codec.js' || relative === 'src/engine/pkg/styk_codec_bg.wasm';
const urlOf = path => new URL(path, SCOPE).href;

async function recorded(cache) {
  const saved = await cache.match(RECORD);
  return saved ? saved.json().catch(() => null) : null;
}

/** The newest older version's cache with its file hashes. */
async function previousVersion() {
  let best = null;
  for (const name of await caches.keys()) {
    if (!name.startsWith(PREFIX) || name === CACHE) continue;
    const cache = await caches.open(name), saved = await recorded(cache);
    if (saved?.hashes && (!best || saved.savedAt > best.saved.savedAt)) best = {cache, saved};
  }
  return best;
}

/** Stores `entries`: what is already here stays, unchanged files come from the previous version, and only the rest is downloaded (when asked to). */
async function store(entries, {download}) {
  const cache = await caches.open(CACHE), previous = await previousVersion(), queue = entries.slice();
  const step = async () => {
    for (let entry; (entry = queue.shift());) {
      const [path, hash] = entry, url = urlOf(path);
      if (await cache.match(url)) continue;
      const kept = previous?.saved.hashes[path] === hash ? await previous.cache.match(url) : undefined;
      if (kept) { await cache.put(url, kept); continue; }
      if (!download) continue;
      const response = await fetch(url);
      if (!response.ok) throw new Error(`${path || 'the page'}: ${response.status}`);
      await cache.put(url, response);
    }
  };
  await Promise.all(Array.from({length: CONCURRENCY}, step));
  // Record what is really stored, so a later version knows which files it can reuse.
  const saved = await recorded(cache), hashes = {...saved?.hashes};
  for (const [path, hash] of entries) if (await cache.match(urlOf(path))) hashes[path] = hash;
  await cache.put(RECORD, new Response(JSON.stringify({version: PRECACHE.version, savedAt: saved?.savedAt ?? Date.now(), hashes}), {headers: {'content-type': 'application/json'}}));
}

self.addEventListener('install', event => {
  if (!PRECACHE.core.length) return;
  // Only the editor must be stored for the install to succeed; the Pivot codec follows on request.
  event.waitUntil(store(PRECACHE.core, {download: true}).then(() => store(PRECACHE.codec, {download: false})));
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) if (name.startsWith(PREFIX) && name !== CACHE) await caches.delete(name);
    await self.clients.claim();
  })());
});

/** The cache key for a request: the page for its own address, otherwise the path without a query. Null when the site does not own it. */
function keyFor(request, url) {
  if (url.origin !== location.origin || !url.pathname.startsWith(SCOPE_PATH)) return null;
  const relative = url.pathname.slice(SCOPE_PATH.length);
  // The community library is live data from the site (web/worker.js): never stored, never answered from here.
  if (relative.startsWith('community/')) return null;
  if (relative === '' || relative === 'index.html') return urlOf('');
  return request.mode === 'navigate' ? null : urlOf(relative);
}

self.addEventListener('fetch', event => {
  const {request} = event;
  // The Cache API cannot answer partial content.
  if (request.method !== 'GET' || request.headers.has('range') || !PRECACHE.core.length) return;
  const key = keyFor(request, new URL(request.url));
  if (key) event.respondWith(respond(request, key));
});

async function respond(request, key) {
  const cache = await caches.open(CACHE), hit = await cache.match(key);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok && isCodec(key.slice(SCOPE.length))) await cache.put(key, response.clone());
  return response;
}

async function reply(event, message) {
  const client = event.source ?? (await self.clients.matchAll())[0];
  client?.postMessage(message);
}

/** How much of this version is stored: {core, codec} are true once every file is. */
async function status() {
  const cache = await caches.open(CACHE), complete = async entries => {
    for (const [path] of entries) if (!(await cache.match(urlOf(path)))) return false;
    return true;
  };
  return {version: PRECACHE.version, core: await complete(PRECACHE.core), codec: await complete(PRECACHE.codec)};
}

self.addEventListener('message', event => {
  const type = event.data?.type;
  if (type === 'precache-codec') {
    event.waitUntil(store(PRECACHE.codec, {download: true}).then(status)
      .then(state => reply(event, {type: 'codec', ...state}), error => reply(event, {type: 'codec', error: String(error?.message ?? error)})));
  } else if (type === 'status') event.waitUntil(status().then(state => reply(event, {type: 'status', ...state})));
});
