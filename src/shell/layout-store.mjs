import {messageError} from '../localized-error.mjs';
/**
 * Layout persistence: load once, then debounced, ordered, merge-on-write
 * saves over an injected `{read, write}` pair. On desktop that pair is the
 * existing workspace preferences IPC (`getWorkspacePreferences()` and
 * `setWorkspacePreferences()`; localStorage does not survive a restart there:
 * the main process clears it at each launch); in the browser it is localStorage.
 *
 * - Nothing is written on load or when a layout is fitted to a small window;
 *   only update() schedules a save. The shell awaits load() first: updates
 *   made before it resolves are queued and replayed on the loaded layout.
 * - Saves are debounced (200 ms) into one promise chain, so writes land in
 *   order; flush() returns that chain (await it before closing).
 * - Merge-on-write: each save re-reads the stored layout and merges it with
 *   this window's (shared sizes and each workspace by newest stamp, saved
 *   layouts as a union minus tombstones), re-reads once more just before
 *   writing and merges again if it changed meanwhile. Two windows then keep
 *   each other's saved layouts; two saves interleaving within the same few
 *   milliseconds can still lose one change (an atomic merge would need the
 *   main process).
 * - After a write the window takes in only the saved layouts and deletions
 *   other windows wrote: its own arrangements and sizes never change as a
 *   side effect of a save (the stamps still keep the newest on disk).
 * - A layout written by a newer version is never overwritten (readOnly).
 * - The written object keeps the v1 mirror and every unknown key, so 1.1's
 *   `{...loaded, studioVersion: 1}` round trip keeps the v2 data. What the
 *   file limit forces out ('trim' events) also leaves the window's layout,
 *   so it is not merged back and trimmed again on every save.
 */
import {PANEL_CATALOG} from './panel-registry.mjs';
import {MAX_SAVED_LAYOUTS, MODES, cloneJSON, fitBudget, migrateLayout, normalizeLayout, serializeLayout, trimLayout} from './layout-schema.mjs';

export const BROWSER_LAYOUT_KEY = 'stykanimate.workspace-layout.v2';
/** Older browser keys, read once when the v2 key is absent: 1.1's studio layout and the earlier splitter layout. */
export const LEGACY_LAYOUT_KEYS = Object.freeze(['stykanimate.studio-layout.v1', 'stykanimate.workspace.v1']);

const KNOWN_TOP = new Set(['layoutVersion', 'shared', 'modes', 'saved', 'tombstones']);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const withoutStamp = value => {
  if (!isObject(value)) return JSON.stringify(value);
  const {stamp, ...rest} = value;
  return JSON.stringify(rest);
};
const newer = (disk, local) => ((local?.stamp ?? 0) >= (disk?.stamp ?? 0) ? local : disk);

/** The desktop pair: the workspace preferences IPC, unchanged. */
export function desktopLayoutBackend(desktop) {
  return {
    read: () => desktop.getWorkspacePreferences(),
    write: value => desktop.setWorkspacePreferences(value),
  };
}

/**
 * The browser pair over a Storage. A blocked storage reads as empty; a
 * failing write rejects, so the store reports it.
 */
export function storageLayoutBackend(storage, {key = BROWSER_LAYOUT_KEY, legacyKeys = LEGACY_LAYOUT_KEYS} = {}) {
  return {
    async read() {
      for (const name of [key, ...legacyKeys]) {
        let text;
        try { text = storage?.getItem(name); } catch { return null; }
        if (text == null) continue;
        try { return JSON.parse(text); } catch { return name === key ? text : null; }   // unreadable v2: 'invalid'
      }
      return null;
    },
    async write(value) {
      if (!storage) throw messageError(new Error(''), "errors.layoutStore.layoutStorageIsUnavailable", {});
      storage.setItem(key, JSON.stringify(value));
    },
  };
}

/**
 * Merges two normalized layouts: shared sizes and each workspace by newest
 * stamp (ties keep `local`), saved layouts as a union by id (the newer copy
 * of each), minus any with a tombstone at or after its stamp; past eight the
 * oldest go, each named `saved:<id>` in `trimmed` when it is given. Unknown
 * keys come from `disk`, which a newer version may have written. Pure.
 */
export function mergeLayouts(disk, local, {catalog = PANEL_CATALOG, now = Date.now(), trimmed} = {}) {
  const merged = {};
  for (const source of [local, disk]) {
    for (const [key, value] of Object.entries(source)) if (!KNOWN_TOP.has(key)) merged[key] = value;
  }
  merged.shared = newer(disk.shared, local.shared);
  merged.modes = {...local.modes, ...disk.modes};
  for (const mode of MODES) merged.modes[mode] = newer(disk.modes[mode], local.modes[mode]);
  const tombstones = new Map();
  for (const tombstone of [...disk.tombstones, ...local.tombstones]) tombstones.set(tombstone.id, Math.max(tombstones.get(tombstone.id) ?? 0, tombstone.stamp));
  merged.tombstones = [...tombstones].map(([id, stamp]) => ({id, stamp}));
  const byId = new Map();
  for (const item of [...disk.saved, ...local.saved]) {
    const known = byId.get(item.id);
    byId.set(item.id, known ? newer(known, item) : item);
  }
  let saved = [...byId.values()].filter(item => !(tombstones.get(item.id) >= item.stamp));
  // More than eight after a union: the newest eight stay, in their order.
  if (saved.length > MAX_SAVED_LAYOUTS) {
    const keep = new Set([...saved].sort((a, b) => b.stamp - a.stamp).slice(0, MAX_SAVED_LAYOUTS));
    for (const item of saved) if (!keep.has(item)) trimmed?.push(`saved:${item.id}`);
    saved = saved.filter(item => keep.has(item));
  }
  merged.saved = saved;
  return normalizeLayout(merged, {catalog, now});
}

/**
 * Stamps what changed between two normalized layouts with `tick()`: the
 * shared section, each workspace and each saved layout; a saved layout that
 * disappeared gets a tombstone.
 */
function stampChanges(previous, next, tick) {
  const stamped = {...next, modes: {...next.modes}};
  stamped.shared = withoutStamp(previous.shared) === withoutStamp(next.shared) ? {...next.shared, stamp: previous.shared.stamp} : {...next.shared, stamp: tick()};
  for (const mode of MODES) {
    const before = previous.modes[mode], after = next.modes[mode];
    stamped.modes[mode] = withoutStamp(before) === withoutStamp(after) ? {...after, stamp: before.stamp} : {...after, stamp: tick()};
  }
  const earlier = new Map(previous.saved.map(item => [item.id, item]));
  stamped.saved = next.saved.map(item => {
    const before = earlier.get(item.id);
    return before && withoutStamp(before) === withoutStamp(item) ? {...item, stamp: before.stamp} : {...item, stamp: tick()};
  });
  const kept = new Set(next.saved.map(item => item.id));
  const tombstones = [...next.tombstones];
  for (const item of previous.saved) {
    if (!kept.has(item.id) && !tombstones.some(tombstone => tombstone.id === item.id)) tombstones.push({id: item.id, stamp: tick()});
  }
  stamped.tombstones = tombstones;
  return stamped;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

/**
 * Creates the store. `read()` returns the stored object (or null); `write(value)`
 * stores it. `catalog` is the panel catalogue or a function returning the
 * current one (`() => registry.constraints()`), so panels defined at runtime
 * are placed by the store as the solver places them. `legacy` passes the
 * editor settings the first migration reads (builderOutlinerWidth). Timers
 * and the clock are injectable for tests.
 *
 * Events (on(type, listener)): 'change' {layout, origin: 'local'|'merge'},
 * 'error' {error}, 'readonly' {source}, 'trim' {trimmed}: what a save had to
 * leave out (`saved:<id>` for a saved layout past eight or over the file
 * limit, `focus`, `tombstones`, `key:<path>`), once per save.
 */
export function createLayoutStore({
  read, write, catalog = PANEL_CATALOG, delay = 200, legacy,
  now = Date.now, setTimer = globalThis.setTimeout, clearTimer = globalThis.clearTimeout,
  onError,
} = {}) {
  if (typeof read !== 'function' || typeof write !== 'function') throw messageError(new TypeError(''), "errors.layoutStore.aLayoutStoreNeedsReadAndWrite", {});
  const panels = typeof catalog === 'function' ? () => catalog() ?? PANEL_CATALOG : () => catalog;
  const at = () => ({catalog: panels(), now: now()});
  let layout = deepFreeze(normalizeLayout(null, at()));
  let readOnly = false, source = 'empty', error = null, timer = null, dirty = false, last = 0, destroyed = false, loaded = false;
  // The stored value as this window last read or wrote it (JSON), for callers that show what is on disk.
  let stored = null;
  let chain = Promise.resolve(true);
  const queued = [];
  const listeners = new Map();
  const emit = (type, detail) => {
    for (const listener of [...(listeners.get(type) ?? [])]) {
      try { listener(detail); } catch (failure) { globalThis.reportError?.(failure); }
    }
  };
  const tick = () => (last = Math.max(Math.floor(now()), last + 1));
  const highestStamp = value => Math.max(value.shared.stamp, ...MODES.map(mode => value.modes[mode].stamp), ...value.saved.map(item => item.stamp), ...value.tombstones.map(item => item.stamp));

  function adopt(next, origin) {
    const frozen = deepFreeze(next);
    const changed = JSON.stringify(frozen) !== JSON.stringify(layout);
    layout = frozen;
    last = Math.max(last, highestStamp(layout));
    if (changed) emit('change', {layout, origin});
  }

  function fail(failure) {
    error = failure;
    try { onError?.(failure); } catch (reporting) { globalThis.reportError?.(reporting); }
    emit('error', {error: failure});
  }

  function becomeReadOnly(reason) {
    if (readOnly) return;
    readOnly = true;
    dirty = false;
    if (timer !== null) { clearTimer(timer); timer = null; }
    emit('readonly', {source: reason});
  }

  /**
   * A trimmed path applies to this window's layout unless the section it is in
   * changed since the merge (an edit made while the save ran) or came from
   * another window's newer copy.
   */
  function trimsMine(path, merged) {
    const [head, key] = path;
    if (head === 'shared') return layout.shared.stamp === merged.shared.stamp;
    if (head === 'modes' && MODES.includes(key)) return layout.modes[key].stamp === merged.modes[key].stamp;
    if (head === 'saved') return layout.saved.find(item => item.id === key)?.stamp === merged.saved.find(item => item.id === key)?.stamp;
    return true;
  }

  async function save() {
    if (readOnly) return true;
    try {
      let raw = await read();
      let merged, fitted, dropped;
      for (let attempt = 0; ; attempt++) {
        const disk = migrateLayout(raw, {...at(), legacy});
        if (disk.readOnly) { becomeReadOnly('future'); return true; }
        dropped = [];
        merged = mergeLayouts(disk.layout, layout, {...at(), trimmed: dropped});
        fitted = fitBudget(serializeLayout(merged, at()), {catalog: panels()});
        if (!fitted.ok) throw messageError(new Error(''), "errors.layoutStore.theWorkspaceLayoutDoesNotFitInThe", {});
        if (attempt === 1) break;
        // Another window may have written since the first read: merge again once.
        const check = await read();
        if (JSON.stringify(check) === JSON.stringify(raw)) break;
        raw = check;
      }
      await write(fitted.value);
      stored = cloneJSON(fitted.value);
      error = null;
      // Take in the saved layouts and deletions other windows wrote, and drop what
      // the file could not hold; this window's arrangements and sizes stay as they
      // are (edits made while this save ran included).
      const live = trimLayout(layout, fitted.removed.filter(path => trimsMine(path, merged)), at());
      const both = mergeLayouts(migrateLayout(fitted.value, at()).layout, live, at());
      adopt(normalizeLayout({...live, saved: both.saved, tombstones: both.tombstones}, at()), 'merge');
      const trimmed = [...new Set([...dropped, ...fitted.trimmed])];
      if (trimmed.length) emit('trim', {trimmed});
      return true;
    } catch (failure) {
      dirty = true;   // the next update or flush tries again
      fail(failure);
      return false;
    }
  }

  function flush() {
    if (timer !== null) { clearTimer(timer); timer = null; }
    if (dirty && !readOnly) {
      dirty = false;
      chain = chain.then(save);
    }
    return chain;
  }

  const store = {
    /** Reads and migrates the stored layout, then applies updates queued meanwhile. Never writes by itself. */
    async load() {
      let raw;
      try { raw = await read(); } catch (failure) { fail(failure); raw = null; }
      stored = cloneJSON(raw) ?? null;
      const result = migrateLayout(raw, {...at(), legacy});
      source = error && raw === null ? 'error' : result.source;
      layout = deepFreeze(result.layout);
      last = Math.max(last, highestStamp(layout));
      if (result.readOnly) becomeReadOnly('future');
      loaded = true;
      for (const change of queued.splice(0)) store.update(change);
      return layout;
    },
    get layout() { return layout; },
    /** True when the stored layout came from a newer version: changes stay in this session. */
    get readOnly() { return readOnly; },
    /** Where the loaded layout came from: v2, v1, legacy, empty, invalid, future or error. */
    get source() { return source; },
    /** A copy of the stored value this window last read (load) or wrote (a save); null before load or when nothing is stored. */
    get stored() { return cloneJSON(stored) ?? null; },
    get error() { return error; },
    /**
     * Replaces the layout with `change(layout)` (or `change`), normalized and
     * stamped, and schedules a save. Returns the new layout. Before load()
     * has resolved the change is queued (and the current layout returned):
     * load() applies it to the loaded layout.
     */
    update(change) {
      if (destroyed) return layout;
      if (!loaded) { queued.push(change); return layout; }
      const next = normalizeLayout(typeof change === 'function' ? change(layout) : change, at());
      const stamped = stampChanges(layout, next, tick);
      if (JSON.stringify(stamped) === JSON.stringify(layout)) return layout;
      adopt(stamped, 'local');
      if (!readOnly) {
        dirty = true;
        if (timer !== null) clearTimer(timer);
        timer = setTimer(() => { timer = null; void flush(); }, delay);
      }
      return layout;
    },
    flush,
    on(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
      return () => listeners.get(type)?.delete(listener);
    },
    /** Saves anything pending and stops accepting updates. */
    destroy() {
      const pending = flush();
      destroyed = true;
      queued.length = 0;
      listeners.clear();
      return pending;
    },
  };
  return store;
}
