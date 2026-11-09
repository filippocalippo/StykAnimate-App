import {messageError} from '../localized-error.mjs';
/**
 * Docking persistence: load once, then debounced, ordered, merge-on-write
 * saves over an injected backend (dock-workspaces.mjs holds the state's
 * shape).
 *
 * - Desktop: the `dock` key of the workspace preferences file, through the
 *   existing preferences calls (`getWorkspacePreferences()` and
 *   `setWorkspacePreferences()`), so the desktop shell keeps one file, its
 *   atomic replacement and its 16 KiB limit. Every other key of that file is
 *   written back as read, today's v2 layout included, so an older version
 *   still opens with the layout it had. When the file would pass its limit,
 *   the v2 keys go first (their content lives on in `dock`), then Focus
 *   snapshots, then the oldest saved layouts.
 * - Browser: its own localStorage key; today's v2 key is read once to import
 *   and left as it is.
 * - Nothing is written on load or when a window is too small for a layout;
 *   only update() schedules a save, 200 ms later, in one promise chain so
 *   writes land in order. flush() returns the chain (await it before closing).
 * - A state written by a newer version is used read-only: defaults are
 *   shown, and changes stay in this session.
 * - Merge-on-write: each save re-reads the stored state and merges it with
 *   this window's (each workspace by newest stamp, saved layouts as a union
 *   minus deletions), so two windows keep each other's saved layouts.
 */
import {PANEL_CATALOG} from './panel-registry.mjs';
import {DOCK_VERSION, cloneJSON, validateLayout} from './dock-model.mjs';
import {MAX_SAVED_LAYOUTS, MODES, highestStamp, readState, serializeState, stateBytes} from './dock-workspaces.mjs';
import {importV2} from './dock-migrate.mjs';

export const BROWSER_DOCK_KEY = 'stykanimate.dock-layout.v3';
/** Today's browser keys, read once to import: the v2 layout, 1.1's studio layout and the earlier splitter layout. */
export const LEGACY_LAYOUT_KEYS = Object.freeze(['stykanimate.workspace-layout.v2', 'stykanimate.studio-layout.v1', 'stykanimate.workspace.v1']);
/** The preferences file's limit (desktop/preferences.cjs) and the size a write aims under. */
export const FILE_LIMIT_BYTES = 16 * 1024;
export const BUDGET_BYTES = 15 * 1024;
const V2_KEYS = ['layoutVersion', 'shared', 'modes', 'saved', 'tombstones', 'studioVersion', 'right', 'timeline', 'left', 'floating'];

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Fits the preferences object under the budget: the v2 layout keys go first,
 * then Focus snapshots, then the oldest saved layouts. Returns
 * `{value, trimmed, ok}`; `trimmed` names what went (`v2`, `focus`, `saved:<id>`).
 */
export function fitPreferences(value, {budget = BUDGET_BYTES} = {}) {
  let current = value;
  const trimmed = [];
  if (stateBytes(current) > budget && V2_KEYS.some(key => key in current)) {
    current = Object.fromEntries(Object.entries(current).filter(([key]) => !V2_KEYS.includes(key)));
    trimmed.push('v2');
  }
  const dock = () => current.dock;
  if (stateBytes(current) > budget && isObject(dock()?.workspaces)) {
    const workspaces = Object.fromEntries(Object.entries(dock().workspaces).map(([mode, entry]) => {
      if (!isObject(entry) || !entry.focus) return [mode, entry];
      const {focus, ...rest} = entry;
      return [mode, rest];
    }));
    current = {...current, dock: {...dock(), workspaces}};
    trimmed.push('focus');
  }
  while (stateBytes(current) > budget && Array.isArray(dock()?.saved) && dock().saved.length) {
    const oldest = dock().saved.reduce((a, b) => ((b.stamp ?? 0) < (a.stamp ?? 0) ? b : a));
    current = {...current, dock: {...dock(), saved: dock().saved.filter(item => item !== oldest)}};
    trimmed.push(`saved:${oldest.id}`);
  }
  return {value: current, trimmed, ok: stateBytes(current) <= FILE_LIMIT_BYTES};
}

/** The desktop backend: the `dock` key of the workspace preferences, the rest kept as read. */
export function desktopDockBackend(desktop) {
  return {
    async read() {
      const prefs = await desktop.getWorkspacePreferences();
      return {dock: isObject(prefs) ? prefs.dock ?? null : null, legacy: isObject(prefs) ? prefs : null};
    },
    async write(dock) {
      const prefs = await desktop.getWorkspacePreferences();
      const fitted = fitPreferences({...(isObject(prefs) ? prefs : {}), dock});
      if (!fitted.ok) throw messageError(new Error(''), "errors.layoutStore.theWorkspaceLayoutDoesNotFitInThe", {});
      await desktop.setWorkspacePreferences(fitted.value);
      return {stored: fitted.value.dock, trimmed: fitted.trimmed};
    },
  };
}

/** The browser backend over a Storage; a blocked storage reads as empty, a failing write rejects. */
export function storageDockBackend(storage, {key = BROWSER_DOCK_KEY, legacyKeys = LEGACY_LAYOUT_KEYS} = {}) {
  const get = name => {
    try { return storage?.getItem(name) ?? null; } catch { return null; }
  };
  const parse = text => {
    if (text == null) return null;
    try { return JSON.parse(text); } catch { return text; }
  };
  return {
    async read() {
      const dock = parse(get(key));
      let legacy = null;
      for (const name of legacyKeys) {
        const value = parse(get(name));
        if (value != null) { legacy = value; break; }
      }
      return {dock, legacy};
    },
    async write(dock) {
      if (!storage) throw messageError(new Error(''), "errors.layoutStore.layoutStorageIsUnavailable", {});
      storage.setItem(key, JSON.stringify(dock));
      return {stored: dock, trimmed: []};
    },
  };
}

/**
 * Merges two read states: each workspace by newest stamp (ties keep
 * `local`), saved layouts as a union by id (the newer copy of each) minus any
 * with a tombstone at or after its stamp, sixteen at most (the newest).
 * Unknown keys come from `disk`, which a newer version may have written.
 */
export function mergeStates(disk, local, {catalog = PANEL_CATALOG, now = Date.now()} = {}) {
  const newer = (a, b) => ((b?.stamp ?? 0) >= (a?.stamp ?? 0) ? b : a);
  const merged = {...local, ...Object.fromEntries(Object.entries(disk).filter(([key]) => !['version', 'workspaces', 'saved', 'tombstones'].includes(key)))};
  merged.workspaces = {...disk.workspaces, ...local.workspaces};
  for (const mode of MODES) merged.workspaces[mode] = newer(disk.workspaces[mode], local.workspaces[mode]);
  const tombstones = new Map();
  for (const item of [...disk.tombstones, ...local.tombstones]) tombstones.set(item.id, Math.max(tombstones.get(item.id) ?? 0, item.stamp));
  merged.tombstones = [...tombstones].map(([id, stamp]) => ({id, stamp}));
  const byId = new Map();
  for (const item of [...disk.saved, ...local.saved]) byId.set(item.id, byId.has(item.id) ? newer(byId.get(item.id), item) : item);
  let saved = [...byId.values()].filter(item => !(tombstones.get(item.id) >= item.stamp));
  if (saved.length > MAX_SAVED_LAYOUTS) {
    const keep = new Set([...saved].sort((a, b) => b.stamp - a.stamp).slice(0, MAX_SAVED_LAYOUTS));
    saved = saved.filter(item => keep.has(item));
  }
  merged.saved = saved;
  // The layouts are already repaired; reading the serialized form again keeps the merge's result normalized.
  return readState(serializeState(merged, {catalog}), {catalog, now});
}

const entryKey = entry => JSON.stringify(serializeState({workspaces: {x: entry}, saved: [], tombstones: []}).workspaces.x, (key, value) => (key === 'stamp' ? undefined : value));

/** Stamps what changed between two states with `tick()`; a saved layout that went gets a tombstone. */
function stampChanges(previous, next, tick) {
  const stamped = {...next, workspaces: {...next.workspaces}};
  for (const mode of MODES) {
    const before = previous.workspaces[mode], after = next.workspaces[mode];
    stamped.workspaces[mode] = before === after || entryKey(before) === entryKey(after) ? {...after, stamp: before.stamp} : {...after, stamp: tick()};
  }
  const earlier = new Map(previous.saved.map(item => [item.id, item]));
  stamped.saved = next.saved.map(item => {
    const before = earlier.get(item.id);
    return before && (before === item || JSON.stringify({...before, stamp: 0}) === JSON.stringify({...item, stamp: 0})) ? {...item, stamp: before.stamp} : {...item, stamp: tick()};
  });
  const kept = new Set(next.saved.map(item => item.id));
  const tombstones = [...next.tombstones];
  for (const item of previous.saved) if (!kept.has(item.id) && !tombstones.some(tombstone => tombstone.id === item.id)) tombstones.push({id: item.id, stamp: tick()});
  stamped.tombstones = tombstones;
  return stamped;
}

/**
 * Creates the store over `{read, write}` (a backend above). `legacy` passes
 * the editor settings today's migration reads (builderOutlinerWidth); timers
 * and the clock are injectable for tests.
 *
 * Events (on(type, listener)): 'change' {state, origin: 'local' | 'merge'},
 * 'error' {error}, 'readonly' {}, 'trim' {trimmed}.
 */
export function createDockStore({read, write, catalog = PANEL_CATALOG, delay = 200, legacy,
  now = Date.now, setTimer = globalThis.setTimeout, clearTimer = globalThis.clearTimeout, onError} = {}) {
  if (typeof read !== 'function' || typeof write !== 'function') throw messageError(new TypeError(''), "errors.layoutStore.aLayoutStoreNeedsReadAndWrite", {});
  const panels = typeof catalog === 'function' ? () => catalog() ?? PANEL_CATALOG : () => catalog;
  const at = () => ({catalog: panels(), now: now()});
  let state = readState(null, at());
  let readOnly = false, source = 'empty', error = null, timer = null, dirty = false, last = 0, destroyed = false, loaded = false;
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
  const fail = failure => {
    error = failure;
    try { onError?.(failure); } catch (reporting) { globalThis.reportError?.(reporting); }
    emit('error', {error: failure});
  };

  /** What a backend read holds: `{state, source, readOnly}`. A damaged or missing dock state imports today's layout. */
  function interpret({dock, legacy: old} = {}) {
    if (isObject(dock) && Number.isSafeInteger(dock.version) && dock.version > DOCK_VERSION) return {state: readState(null, at()), source: 'future', readOnly: true};
    if (isObject(dock) && dock.version === DOCK_VERSION) return {state: readState(dock, at()), source: 'dock', readOnly: false};
    const imported = importV2(old, {...at(), legacy});
    return {state: imported.state, source: dock != null ? 'invalid' : imported.source === 'empty' ? 'empty' : `import-${imported.source}`, readOnly: false};
  }

  async function save() {
    if (readOnly) return true;
    try {
      const disk = interpret(await read());
      if (disk.readOnly) { readOnly = true; dirty = false; emit('readonly', {}); return true; }
      const merged = disk.source === 'dock' ? mergeStates(disk.state, state, at()) : state;
      const result = await write(serializeState(merged, {catalog: panels()}));
      stored = cloneJSON(result?.stored ?? null);
      error = null;
      // Take in the saved layouts and deletions other windows wrote; this window's arrangements stay as they are.
      const next = {...state, saved: merged.saved, tombstones: merged.tombstones};
      if (JSON.stringify(next.saved) !== JSON.stringify(state.saved) || JSON.stringify(next.tombstones) !== JSON.stringify(state.tombstones)) {
        state = next;
        emit('change', {state, origin: 'merge'});
      }
      if (result?.trimmed?.length) emit('trim', {trimmed: result.trimmed});
      return true;
    } catch (failure) {
      dirty = true;
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
    /** Reads the stored state (importing today's layout when there is none). Never writes. */
    async load() {
      let raw = null;
      try { raw = await read(); } catch (failure) { fail(failure); }
      const result = interpret(raw ?? {});
      stored = cloneJSON(raw?.dock ?? null);
      source = error && !raw ? 'error' : result.source;
      state = result.state;
      readOnly = result.readOnly;
      last = Math.max(last, highestStamp(state));
      if (readOnly) emit('readonly', {});
      loaded = true;
      for (const change of queued.splice(0)) store.update(change);
      return state;
    },
    get state() { return state; },
    get readOnly() { return readOnly; },
    /** Where the loaded state came from: dock, import-v2, import-v1, import-legacy, empty, invalid, future or error. */
    get source() { return source; },
    /** A copy of the stored dock value this window last read or wrote. */
    get stored() { return cloneJSON(stored) ?? null; },
    get error() { return error; },
    /**
     * Replaces the state with `change(state)`, stamped, and schedules a save.
     * A change that would leave a workspace's arrangement invalid (a lost or
     * doubled panel) is refused. Before load() resolves the change is queued.
     */
    update(change) {
      if (destroyed) return state;
      if (!loaded) { queued.push(change); return state; }
      const next = typeof change === 'function' ? change(state) : change;
      if (!next || next === state) return state;
      for (const mode of MODES) {
        const problems = validateLayout(next.workspaces[mode].layout, mode, {catalog: panels()});
        if (problems.length) { fail(new Error(`Refused a layout change that would lose a panel: ${problems.join('; ')}`)); return state; }
      }
      state = stampChanges(state, next, tick);
      emit('change', {state, origin: 'local'});
      if (!readOnly) {
        dirty = true;
        if (timer !== null) clearTimer(timer);
        timer = setTimer(() => { timer = null; void flush(); }, delay);
      }
      return state;
    },
    flush,
    on(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
      return () => listeners.get(type)?.delete(listener);
    },
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
