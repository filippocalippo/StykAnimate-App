import {messageError} from '../localized-error.mjs';
/**
 * Workspace layouts as versioned data (schema v2), as StykAnimate stored them
 * before the docking model (dock-model.mjs). Pure functions: no DOM and no
 * I/O. dock-migrate.mjs reads stored v2 layouts through migrateLayout once,
 * to import them; the v2 keys stay in the file for older versions.
 *
 * Stored shape, inside the desktop's workspace-preferences.json (16 KiB file
 * cap) or the browser's localStorage:
 *
 *   {
 *     studioVersion: 1, right: 300, timeline: 240,   // v1 mirror, read by StykAnimate 1.1
 *     layoutVersion: 2,
 *     shared: {stamp, sizes: {left, right, bottom, structure, timelineLabels}},
 *     modes: {
 *       animate: {stamp, preset: 'animate'},          // compact: equal to its built-in preset
 *       draw: {stamp, preset: 'draw', rail: 'left', bottomSpan: 'full',
 *              panels: [{id: 'library', dock: 'left', order: 0}, …], focus: {…}},
 *       rig: {…},                                     // Build
 *     },
 *     saved: [{id: 'u…', name, mode, stamp, arrangement: {rail, bottomSpan, panels}}],
 *     tombstones: [{id, stamp}],
 *     …                                               // unknown keys are kept as they are
 *   }
 *
 * - Sizes are CSS px shared by every workspace (one timeline height, one
 *   inspector width); an absent size means the default, which the solver
 *   derives from the window and never stores.
 * - Arrangements are per workspace: `{rail, bottomSpan, panels, weights}`
 *   with one record per panel, `{id, dock, side, order, group?, active?,
 *   rect?}`. `dock` is where the panel is now: `left`, `right`, `bottom`,
 *   `float`, `strip` or `hidden`; `side` is the dock side it belongs to
 *   (where a strip sits and where a hidden or floating panel returns); `order`
 *   is its tab order on that side; docked records of one side and `group` are
 *   one island's tabs and `active` marks the shown tab; `rect` ({x, y, w, h},
 *   relative to the stage) is where it floats. `weights` holds each side's
 *   island shares when it stacks two islands (`{right: [0.75, 0.25]}`, summing
 *   to 1), so a share stays with its island when tabs move between islands.
 * - Downgrade safety: 1.1 reads the file as v1 and writes back
 *   `{...loaded, studioVersion: 1}`, so every v2 key survives, and a size it
 *   changed in the mirror is adopted on the next read (reconcileMirror).
 * - A newer layoutVersion is never rewritten: migrateLayout returns presets
 *   with `readOnly: true`.
 * - Forward compatibility within v2: data this version does not read survives
 *   normalization, so a newer 2.x file keeps it through an older 2.x app:
 *   unknown keys at the top, in `shared`, `shared.sizes`, mode entries,
 *   arrangements (saved and Focus ones too), saved layouts and records;
 *   records of unknown panels; records of known panels outside the workspaces
 *   this version gives them; records on a dock this version does not know
 *   (solved at the panel's home until the user moves it, never rewritten
 *   otherwise); and a compact entry naming a preset this version does not
 *   know (solved as the workspace default, written back compact).
 */
import {DOCK_SIDES, PANEL_CATALOG, WORKSPACES, panelCanHide, panelInMode} from './panel-registry.mjs';

export const LAYOUT_VERSION = 2;
export const MODES = WORKSPACES;
export const DOCKS = Object.freeze([...DOCK_SIDES, 'float', 'strip', 'hidden']);
/** Soft target for the serialized layout; new saved layouts must fit under it. */
export const LAYOUT_BUDGET_BYTES = 12 * 1024;
/** The preferences file cap (desktop/preferences.cjs); writes above it are rejected. */
export const LAYOUT_FILE_LIMIT_BYTES = 16 * 1024;
export const MAX_SAVED_LAYOUTS = 8;
export const MAX_LAYOUT_NAME = 48;
export const MAX_TOMBSTONES = 16;
export const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_FLOATING = 2;
/** 1.1's default timeline height; a v1 file holding it was never customised. */
export const V1_DEFAULT_TIMELINE = 280;
/** The editor setting's default outliner width (settings.mjs builderOutlinerWidth). */
export const V1_DEFAULT_OUTLINER_WIDTH = 236;

const MAX_EXTENT = 4096;
const MAX_UNKNOWN_RECORDS = 8;
const EXTRA_SIZE_LIMITS = Object.freeze({timelineLabels: Object.freeze({min: 140, max: 420})});
const ID_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;
const SAVED_ID = /^u[a-z0-9]{1,15}$/;
const PRESET_REF = /^(?:user:u[a-z0-9]{1,15}|[a-z][a-z0-9-]{0,39})$/;
const SIZE_KEY = /^[a-zA-Z][a-zA-Z0-9-]{0,39}$/;
// Keys this schema reads at each level; everything else is carried through.
const TOP_KEYS = new Set(['studioVersion', 'right', 'timeline', 'left', 'floating', 'layoutVersion', 'shared', 'modes', 'saved', 'tombstones']);
const V2_KEYS = new Set(['layoutVersion', 'shared', 'modes', 'saved', 'tombstones']);
const SHARED_KEYS = new Set(['stamp', 'sizes']);
const ARRANGEMENT_KEYS = new Set(['rail', 'bottomSpan', 'panels', 'weights']);
const ENTRY_KEYS = new Set(['stamp', 'preset', 'focus', ...ARRANGEMENT_KEYS]);
const SAVED_KEYS = new Set(['id', 'name', 'mode', 'stamp', 'arrangement']);
const RECORD_KEYS = new Set(['id', 'dock', 'side', 'order', 'group', 'active', 'rect']);
const MIRROR_KEYS = new Set(['studioVersion', 'right', 'timeline']);

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeKey = key => key !== '__proto__' && key !== 'constructor' && key !== 'prototype';
const int = (value, min, max) => typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : null;
const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;
const stampOf = value => int(value, 0, Number.MAX_SAFE_INTEGER) ?? 0;
const sideIndex = side => {
  const index = DOCK_SIDES.indexOf(side);
  return index < 0 ? DOCK_SIDES.length : index;
};

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

/**
 * A deep copy holding only JSON values (finite numbers, strings, booleans,
 * null, arrays and plain objects), at most 12 levels deep; the preferences
 * IPC rejects anything else. Returns undefined for a value that cannot be kept.
 */
export function cloneJSON(value, depth = 0) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'object' || depth >= 12) return undefined;
  if (Array.isArray(value)) return value.map(item => cloneJSON(item, depth + 1)).filter(item => item !== undefined);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const copy = {};
  for (const [key, item] of Object.entries(value)) {
    if (!safeKey(key)) continue;
    const kept = cloneJSON(item, depth + 1);
    if (kept !== undefined) copy[key] = kept;
  }
  return copy;
}

function unknownKeys(source, known, depth = 1) {
  const kept = {};
  for (const [key, value] of Object.entries(source)) {
    if (known.has(key) || !safeKey(key)) continue;
    const copy = cloneJSON(value, depth);
    if (copy !== undefined) kept[key] = copy;
  }
  return kept;
}

const encoder = new TextEncoder();
/** UTF-8 size of the JSON text, as the preferences file measures it. */
export const layoutBytes = value => encoder.encode(JSON.stringify(value)).length;

/** 'build' is Build's user-facing name; the workspace id is 'rig'. Anything else is Animate. */
export function normalizeMode(mode) {
  if (mode === 'build') return 'rig';
  return MODES.includes(mode) ? mode : 'animate';
}

/** Operations on one workspace refuse to guess it: a Build arrangement read as Animate would lose Structure. */
function requireMode(mode) {
  if (mode !== 'build' && !MODES.includes(mode)) throw messageError(new TypeError(''), "errors.layoutSchema.unknownWorkspace", {value: String(mode)});
  return normalizeMode(mode);
}

// ---------------------------------------------------------------------------
// Catalogue helpers (cached per catalogue array; catalogues are frozen)

const catalogCache = new WeakMap();
function catalogInfo(catalog) {
  let info = catalogCache.get(catalog);
  if (!info) {
    const limits = {...EXTRA_SIZE_LIMITS};
    for (const descriptor of catalog) {
      for (const key of descriptor.sizeKey ? [descriptor.sizeKey] : descriptor.docks) {
        const limit = limits[key] = {...(limits[key] ?? {min: Infinity, max: 0})};
        limit.min = Math.min(limit.min, descriptor.min ?? 0);
        limit.max = Math.max(limit.max, descriptor.max ?? MAX_EXTENT);
      }
    }
    info = {byId: new Map(catalog.map(descriptor => [descriptor.id, descriptor])), limits: deepFreeze(limits), presets: new Map()};
    catalogCache.set(catalog, info);
  }
  return info;
}

/** The clamp applied to each stored shared size: the widest limits of the panels that use it. */
export const sizeLimits = (catalog = PANEL_CATALOG) => catalogInfo(catalog).limits;
const limitOf = (catalog, key) => sizeLimits(catalog)[key] ?? {min: 0, max: MAX_EXTENT};

// ---------------------------------------------------------------------------
// Presets (data; the Layout popover draws each as a small dock map)

const inspectorTabs = (docks = {}) => ['properties', 'vfx', 'library'].map((id, order) => ({id, dock: docks[id] ?? 'right', side: 'right', order}));
const timelineRecord = dock => ({id: 'timeline', dock, side: 'bottom', order: 0});
// Structure starts folded to its strip in Build, so the canvas has the room; its tab or strip opens it.
const structureRecord = {id: 'structure', dock: 'strip', side: 'left', order: 0};
const animateArrangement = {rail: 'left', bottomSpan: 'full', panels: [...inspectorTabs(), timelineRecord('bottom')]};

/**
 * Built-in presets per workspace. `sizes` are fractions of the workspace
 * height written to the shared sizes (Timing writes the one timeline height,
 * so it changes it in every workspace, like the splitter). Focus has no
 * arrangement: it folds the current one and restores it (toggleFocus).
 */
export const PRESETS = deepFreeze([
  {id: 'animate', title: 'Animate', titleKey: 'shell.preset.animate', modes: ['animate'], arrangement: animateArrangement},
  {id: 'timing', title: 'Timing', titleKey: 'shell.preset.timing', modes: ['animate'], sizes: {bottom: 0.4},
    arrangement: {rail: 'left', bottomSpan: 'full', panels: [...inspectorTabs({vfx: 'strip', library: 'strip'}), timelineRecord('bottom')]}},
  {id: 'focus', title: 'Focus', titleKey: 'shell.preset.focus', modes: [...MODES], toggle: 'focus'},
  {id: 'review', title: 'Review', titleKey: 'shell.preset.review', modes: ['animate'],
    arrangement: {rail: 'left', bottomSpan: 'full', panels: [...inspectorTabs({properties: 'hidden', vfx: 'hidden', library: 'hidden'}), timelineRecord('strip')]}},
  {id: 'draw', title: 'Draw', titleKey: 'shell.preset.draw', modes: ['draw'], arrangement: animateArrangement},
  {id: 'build', title: 'Build', titleKey: 'shell.preset.build', modes: ['rig'],
    arrangement: {rail: 'left', bottomSpan: 'full', panels: [structureRecord, ...inspectorTabs(), timelineRecord('hidden')]}},
  {id: 'build-timeline', title: 'Build + timeline', titleKey: 'shell.preset.buildTimeline', modes: ['rig'],
    arrangement: {rail: 'left', bottomSpan: 'full', panels: [structureRecord, ...inspectorTabs(), timelineRecord('bottom')]}},
]);
export const DEFAULT_PRESETS = Object.freeze({animate: 'animate', draw: 'draw', rig: 'build'});

/** The built-in presets offered in a workspace, in popover order. */
export const presetsFor = mode => PRESETS.filter(preset => preset.modes.includes(normalizeMode(mode)));

function builtInPreset(id, mode) {
  const preset = PRESETS.find(item => item.id === id);
  return preset && preset.modes.includes(mode) ? preset : null;
}

const defaultRecords = mode => PRESETS.find(preset => preset.id === DEFAULT_PRESETS[mode]).arrangement.panels;

/**
 * A preset's normalized arrangement for the workspace: built-in ids, or
 * `user:<id>` when `layout` holds that saved layout. Null for Focus, an
 * unknown id or a preset another workspace owns.
 */
export function presetArrangement(presetId, mode, {catalog = PANEL_CATALOG, layout} = {}) {
  mode = normalizeMode(mode);
  if (typeof presetId === 'string' && presetId.startsWith('user:')) {
    const saved = layout?.saved?.find(item => `user:${item.id}` === presetId);
    return saved ? normalizeArrangement(saved.arrangement, mode, {catalog}) : null;
  }
  const preset = builtInPreset(presetId, mode);
  if (!preset?.arrangement) return null;
  const cache = catalogInfo(catalog).presets, key = `${mode}:${preset.id}`;
  if (!cache.has(key)) cache.set(key, deepFreeze(normalizeArrangement(preset.arrangement, mode, {catalog, keepUnknown: false})));
  return cache.get(key);
}

/** The workspace's default arrangement (its default preset). */
export const defaultArrangement = (mode, options) => presetArrangement(DEFAULT_PRESETS[normalizeMode(mode)], mode, options);

// ---------------------------------------------------------------------------
// Arrangements

function normalizeRect(rect) {
  if (!isObject(rect)) return null;
  const x = int(rect.x, -MAX_EXTENT, MAX_EXTENT), y = int(rect.y, -MAX_EXTENT, MAX_EXTENT);
  const w = int(rect.w ?? rect.width, 1, MAX_EXTENT), h = int(rect.h ?? rect.height, 1, MAX_EXTENT);
  return x === null || y === null || w === null || h === null ? null : {x, y, w, h};
}

/**
 * A dock name this version does not know (a newer 2.x dock type): the record
 * is kept as it is and solved at the panel's home (solvableArrangement).
 */
const isForeignDock = dock => typeof dock === 'string' && !DOCKS.includes(dock) && ID_PATTERN.test(dock);

/**
 * One stored record, placed where its descriptor allows in this workspace;
 * its unknown fields are kept.
 */
function placeRecord(raw, descriptor, mode) {
  const home = descriptor.docks[0];
  let dock = DOCKS.includes(raw.dock) ? raw.dock : home;
  let side = descriptor.docks.includes(raw.side) ? raw.side : null;
  if (DOCK_SIDES.includes(dock)) {
    if (!descriptor.docks.includes(dock)) dock = home;   // a place the panel does not allow: back home
    side = dock;
  }
  side ??= home;
  if (dock === 'float' && !descriptor.floatable) dock = side;
  if (dock === 'hidden' && !panelCanHide(descriptor, mode)) {
    const fallback = descriptor.hiddenFallback;
    dock = fallback === 'strip' ? 'strip' : descriptor.docks.includes(fallback) ? fallback : side;
    if (DOCK_SIDES.includes(dock)) side = dock;
  }
  const record = {...unknownKeys(raw, RECORD_KEYS, 5), id: descriptor.id, dock, side, order: int(raw.order, 0, 999) ?? 999};
  const group = int(raw.group, 0, 1);
  if (group) record.group = group;
  if (raw.active === true) record.active = true;
  const rect = normalizeRect(raw.rect);
  if (rect) record.rect = rect;
  return record;
}

/** A side's island shares: one per island, summing to 1 (equal when absent or invalid). */
function normalizeWeights(raw, count) {
  const values = Array.from({length: count}, (_, index) => (Array.isArray(raw) && positive(raw[index]) ? raw[index] : 0));
  const total = values.reduce((sum, value) => sum + value, 0);
  const shares = values.every(value => value > 0) ? values.map(value => value / total) : values.map(() => 1 / count);
  let rest = 1;
  return shares.map((share, index) => {
    const value = index === count - 1 ? rest : Math.min(0.95, Math.max(0.05, Math.round(share * 1000) / 1000));
    rest = Math.round((rest - value) * 1000) / 1000;
    return value;
  });
}

function normalizePanels(list, rawWeights, mode, catalog, fallback, keepUnknown) {
  const {byId} = catalogInfo(catalog);
  const seen = new Set(), records = [], kept = [], unknown = [];
  for (const raw of Array.isArray(list) ? list : []) {
    if (!isObject(raw) || typeof raw.id !== 'string' || seen.has(raw.id)) continue;
    const descriptor = byId.get(raw.id);
    if (!descriptor) {
      // A panel this version does not know (a newer 2.x file): kept, never solved.
      if (!keepUnknown || unknown.length >= MAX_UNKNOWN_RECORDS || !ID_PATTERN.test(raw.id) || !(DOCKS.includes(raw.dock) || isForeignDock(raw.dock))) continue;
      seen.add(raw.id);
      unknown.push(cloneJSON(raw, 4));
      continue;
    }
    seen.add(raw.id);
    // A known panel outside its workspaces here, or on a dock this version does
    // not know: kept as it is (a newer 2.x file may allow it), never placed.
    const inMode = panelInMode(descriptor, mode);
    if (keepUnknown && (!inMode || isForeignDock(raw.dock))) kept.push(cloneJSON(raw, 4));
    else if (inMode) records.push(placeRecord(raw, descriptor, mode));
  }
  // Every panel of the workspace has a record: missing ones (a file from before
  // the panel existed, or a damaged one) take the default preset's place, or
  // the panel's own default dock.
  for (const descriptor of catalog) {
    if (seen.has(descriptor.id) || !panelInMode(descriptor, mode)) continue;
    const template = fallback?.find(record => record.id === descriptor.id) ?? {dock: descriptor.defaultDock ?? descriptor.docks[0]};
    records.push(placeRecord(template, descriptor, mode));
  }
  let floating = 0;
  for (const record of records) if (record.dock === 'float' && ++floating > MAX_FLOATING) record.dock = record.side;
  // Tab order: consecutive per side, keeping the stored order and then the input order.
  const position = new Map(records.map((record, index) => [record, index]));
  const byOrder = (a, b) => a.order - b.order || position.get(a) - position.get(b);
  for (const side of DOCK_SIDES) records.filter(record => record.side === side).sort(byOrder).forEach((record, index) => { record.order = index; });
  // Islands: docked groups renumbered 0.. per side; one active tab each; the
  // shares of a side with two islands follow the islands, not their tabs.
  const weights = {};
  for (const side of DOCK_SIDES) {
    const docked = records.filter(record => record.dock === side).sort(byOrder);
    const groups = [...new Set(docked.map(record => record.group ?? 0))].sort((a, b) => a - b);
    for (const record of docked) {
      const group = groups.indexOf(record.group ?? 0);
      if (group) record.group = group; else delete record.group;
    }
    for (const group of groups.keys()) {
      const members = docked.filter(record => (record.group ?? 0) === group);
      const active = members.find(record => record.active) ?? members[0];
      for (const record of members) if (record === active) record.active = true; else delete record.active;
    }
    if (groups.length > 1) weights[side] = normalizeWeights(groups.map(group => rawWeights?.[side]?.[group]), groups.length);
  }
  for (const record of records) {
    if (record.dock !== record.side) { delete record.active; delete record.group; }
  }
  records.sort((a, b) => sideIndex(a.side) - sideIndex(b.side) || (a.group ?? 0) - (b.group ?? 0) || a.order - b.order);
  return {panels: [...records, ...kept, ...unknown], weights};
}

/** The arrangement keys of `source`, normalized (no unknown keys). */
function arrangementParts(source, mode, catalog, keepUnknown) {
  const {panels, weights} = normalizePanels(source.panels, isObject(source.weights) ? source.weights : null, mode, catalog, defaultRecords(mode), keepUnknown);
  return {
    rail: source.rail === 'right' ? 'right' : 'left',
    bottomSpan: source.bottomSpan === 'stage' ? 'stage' : 'full',
    panels,
    weights,
  };
}

/**
 * Normalizes an arrangement `{rail, bottomSpan, panels, weights}` for a
 * workspace: one record per panel of the workspace, each in a place its
 * descriptor allows (a timeline Hidden outside Build becomes a strip, a
 * non-floatable float docks, a third floating panel docks), tab orders
 * consecutive, one active tab per island and island shares summing to 1.
 * Missing panels take the default preset's place. With `keepUnknown` (the
 * default) data this version does not read is kept (see the file comment).
 */
export function normalizeArrangement(input, mode, {catalog = PANEL_CATALOG, keepUnknown = true} = {}) {
  mode = normalizeMode(mode);
  const source = isObject(input) ? input : {};
  return {...(keepUnknown ? unknownKeys(source, ARRANGEMENT_KEYS) : {}), ...arrangementParts(source, mode, catalog, keepUnknown)};
}

/** Only the arrangement keys of a mode entry or arrangement. */
const pickArrangement = entry => ({rail: entry.rail, bottomSpan: entry.bottomSpan, panels: entry.panels, weights: entry.weights ?? {}});
const arrangementKey = arrangement => JSON.stringify([arrangement.rail, arrangement.bottomSpan, arrangement.panels, arrangement.weights ?? {}]);
/** True when two normalized arrangements place every panel alike. */
export const sameArrangement = (a, b) => Boolean(a && b) && arrangementKey(a) === arrangementKey(b);

/**
 * A preset id this version cannot resolve for the workspace (a newer
 * version's preset): a compact entry naming it is solved as the workspace
 * default and written back compact, so the newer version gets its preset back.
 */
const isForeignPreset = (preset, mode) => !preset.startsWith('user:') && !builtInPreset(preset, mode);

/**
 * The arrangement to solve: records on a dock this version does not know are
 * placed at their panel's home (as the last tab there), without changing the
 * stored arrangement. Returns `arrangement` itself when there are none.
 */
export function solvableArrangement(arrangement, mode, {catalog = PANEL_CATALOG} = {}) {
  mode = normalizeMode(mode);
  const {byId} = catalogInfo(catalog);
  const foreign = record => isForeignDock(record.dock) && byId.has(record.id) && panelInMode(byId.get(record.id), mode);
  if (!arrangement.panels.some(foreign)) return arrangement;
  const panels = arrangement.panels.map(record => (foreign(record) ? {id: record.id, order: 999} : record));
  return normalizeArrangement({...arrangement, panels}, mode, {catalog});
}

function normalizeModeEntry(input, mode, catalog) {
  const source = isObject(input) ? input : {};
  const preset = typeof source.preset === 'string' && PRESET_REF.test(source.preset) ? source.preset : DEFAULT_PRESETS[mode];
  // A compact entry is its built-in preset's arrangement (the default's for a preset this version does not know).
  const base = Array.isArray(source.panels) ? source
    : (builtInPreset(preset, mode)?.arrangement ?? builtInPreset(DEFAULT_PRESETS[mode], mode).arrangement);
  return {
    ...unknownKeys(source, ENTRY_KEYS),
    stamp: stampOf(source.stamp),
    preset,
    ...arrangementParts(base, mode, catalog, true),
    focus: isObject(source.focus) ? normalizeArrangement(source.focus, mode, {catalog}) : null,
  };
}

// ---------------------------------------------------------------------------
// The layout

const graphemes = typeof Intl?.Segmenter === 'function' ? new Intl.Segmenter(undefined, {granularity: 'grapheme'}) : null;
const splitGraphemes = text => (graphemes ? [...graphemes.segment(text)].map(part => part.segment) : [...text]);
const EMOJI = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;

/**
 * A layout name: one line of text, at most 48 code points, never cut inside
 * a character (an emoji sequence or a letter with its marks). Invisible
 * format characters (bidi overrides, zero-width spaces) are removed, except
 * the joiners inside an emoji or between letters (ZWJ, ZWNJ); a name with
 * nothing visible is empty.
 */
export function cleanLayoutName(value) {
  if (typeof value !== 'string') return '';
  const line = value.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ').replace(/\p{Cs}/gu, '');
  const parts = splitGraphemes(line).map(part => (EMOJI.test(part) ? part : part.replace(/[^\P{Cf}\u200C\u200D]/gu, '')));
  const text = parts.join('').replace(/\s+/g, ' ').trim();
  if (!/[^\p{Cf}\p{M}\p{Z}\s]/u.test(text)) return '';
  let kept = '', length = 0;
  for (const part of splitGraphemes(text)) {
    length += [...part].length;
    if (length > MAX_LAYOUT_NAME) break;
    kept += part;
  }
  return kept.trim();
}

function normalizeShared(input, catalog) {
  const source = isObject(input) ? input : {};
  const sizes = {};
  if (isObject(source.sizes)) {
    for (const [key, value] of Object.entries(source.sizes)) {
      if (!SIZE_KEY.test(key) || !safeKey(key)) continue;
      const limit = limitOf(catalog, key);
      const size = int(value, limit.min, limit.max);
      if (size !== null) sizes[key] = size;
    }
  }
  return {...unknownKeys(source, SHARED_KEYS), stamp: stampOf(source.stamp), sizes};
}

function normalizeTombstones(list, now) {
  const newest = new Map();
  for (const raw of Array.isArray(list) ? list : []) {
    if (!isObject(raw) || typeof raw.id !== 'string' || !SAVED_ID.test(raw.id)) continue;
    const stamp = stampOf(raw.stamp);
    if (now - stamp > TOMBSTONE_TTL_MS) continue;
    if ((newest.get(raw.id) ?? -1) < stamp) newest.set(raw.id, stamp);
  }
  return [...newest].map(([id, stamp]) => ({id, stamp})).sort((a, b) => b.stamp - a.stamp || (a.id < b.id ? -1 : 1)).slice(0, MAX_TOMBSTONES);
}

function normalizeSaved(list, catalog, tombstones) {
  const saved = [], seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    if (saved.length >= MAX_SAVED_LAYOUTS) break;
    if (!isObject(raw)) continue;
    const id = typeof raw.id === 'string' && SAVED_ID.test(raw.id) ? raw.id : null;
    const name = cleanLayoutName(raw.name);
    const mode = raw.mode === 'build' ? 'rig' : MODES.includes(raw.mode) ? raw.mode : null;
    if (!id || !name || !mode || seen.has(id)) continue;
    const stamp = stampOf(raw.stamp);
    if (tombstones.some(tombstone => tombstone.id === id && tombstone.stamp >= stamp)) continue;
    seen.add(id);
    saved.push({...unknownKeys(raw, SAVED_KEYS), id, name, mode, stamp, arrangement: normalizeArrangement(raw.arrangement, mode, {catalog})});
  }
  return saved;
}

/**
 * The in-memory layout: the stored shape without the v1 mirror, with every
 * workspace's arrangement expanded. Idempotent; never mutates its input.
 * Invalid parts fall back to presets and defaults.
 */
export function normalizeLayout(input, {catalog = PANEL_CATALOG, now = Date.now()} = {}) {
  const source = isObject(input) ? input : {};
  const layout = unknownKeys(source, TOP_KEYS);
  layout.layoutVersion = LAYOUT_VERSION;
  layout.shared = normalizeShared(source.shared, catalog);
  const modes = isObject(source.modes) ? source.modes : {};
  layout.modes = {};
  for (const mode of MODES) layout.modes[mode] = normalizeModeEntry(modes[mode], mode, catalog);
  Object.assign(layout.modes, unknownKeys(modes, new Set(MODES), 2));
  layout.tombstones = normalizeTombstones(source.tombstones, now);
  layout.saved = normalizeSaved(source.saved, catalog, layout.tombstones);
  return layout;
}

/** A layout with every workspace at its default preset and default sizes. */
export const defaultLayout = options => normalizeLayout(null, options);

/**
 * 1.1 edits only the mirror keys. The v2 writer keeps them equal to the
 * shared sizes, so a difference means an older app changed the size since:
 * it wins, and the shared stamp moves so merges prefer it.
 */
function reconcileMirror(layout, raw, catalog) {
  const sizes = layout.shared.sizes;
  let changed = false;
  for (const [mirror, key] of [['right', 'right'], ['timeline', 'bottom']]) {
    const limit = limitOf(catalog, key);
    const value = positive(raw[mirror]) ? int(raw[mirror], limit.min, limit.max) : undefined;
    if (value === sizes[key]) continue;
    if (value === undefined) delete sizes[key]; else sizes[key] = value;
    changed = true;
  }
  if (changed) layout.shared.stamp += 1;
}

/**
 * Reads anything found in storage. Returns `{layout, source, readOnly}`:
 * - `v2`: normalized, with sizes an older app changed in the mirror adopted;
 * - `v1` (`{studioVersion: 1, right, timeline}`, 1.1's studio layout) and
 *   `legacy` (the earlier `{left, right, timeline, floating}` splitter blob):
 *   presets with the old sizes (1.1's untouched default timeline, 280, and
 *   the editor setting's default outliner width mean "default");
 * - `future`: a newer layoutVersion; presets, `readOnly` so it is never rewritten;
 * - `empty` or `invalid`: presets.
 * `legacy.builderOutlinerWidth` (the editor setting) seeds the Structure width
 * once, when the file is not yet v2.
 */
export function migrateLayout(raw, {catalog = PANEL_CATALOG, now = Date.now(), legacy} = {}) {
  const options = {catalog, now};
  if (!isObject(raw)) return {...fromOlder({}, options, legacy), source: raw == null ? 'empty' : 'invalid'};
  if (raw.layoutVersion === LAYOUT_VERSION) {
    const layout = normalizeLayout(raw, options);
    reconcileMirror(layout, raw, catalog);
    return {layout, source: 'v2', readOnly: false};
  }
  if (Number.isSafeInteger(raw.layoutVersion) && raw.layoutVersion > LAYOUT_VERSION) {
    return {layout: normalizeLayout(null, options), source: 'future', readOnly: true};
  }
  return fromOlder(raw, options, legacy);
}

/** Not v2: keep the unknown keys, ignore any invalid v2 data, and take the old sizes. */
function fromOlder(raw, options, legacy) {
  const {catalog} = options;
  const layout = normalizeLayout(Object.fromEntries(Object.entries(raw).filter(([key]) => !V2_KEYS.has(key))), options);
  const sizes = layout.shared.sizes;
  const put = (key, value) => {
    const {min, max} = limitOf(catalog, key);
    const size = positive(value) ? int(value, min, max) : null;
    if (size !== null) sizes[key] = size;
  };
  let source = raw.layoutVersion === undefined ? 'empty' : 'invalid';
  if (raw.studioVersion === 1) {
    source = 'v1';
    put('right', raw.right);
    if (raw.timeline !== V1_DEFAULT_TIMELINE) put('bottom', raw.timeline);
  } else if (['left', 'right', 'timeline', 'floating'].some(key => key in raw)) {
    source = 'legacy';
    put('left', raw.left);
    put('right', raw.right);
    put('bottom', raw.timeline);
  }
  const outliner = legacy?.builderOutlinerWidth;
  if (outliner !== V1_DEFAULT_OUTLINER_WIDTH) put('structure', outliner);
  return {layout, source, readOnly: false};
}

/** True for a stored layout this version must not rewrite. */
export const isFutureLayout = raw => isObject(raw) && Number.isSafeInteger(raw.layoutVersion) && raw.layoutVersion > LAYOUT_VERSION;

const compactRecord = record => {
  if (record.dock !== record.side || !DOCKS.includes(record.dock)) return record;
  const {side, ...rest} = record;
  return rest;
};
/** An arrangement to store: records without a redundant `side`, shares only where a side stacks islands, unknown keys kept. */
function compactArrangement(arrangement) {
  const stored = {...unknownKeys(arrangement, ARRANGEMENT_KEYS), rail: arrangement.rail, bottomSpan: arrangement.bottomSpan, panels: arrangement.panels.map(compactRecord)};
  if (Object.keys(arrangement.weights ?? {}).length) stored.weights = arrangement.weights;
  return stored;
}

function compactModeEntry(entry, mode, catalog) {
  const kept = {...unknownKeys(entry, ENTRY_KEYS), stamp: entry.stamp, preset: entry.preset};
  const preset = presetArrangement(entry.preset, mode, {catalog}) ?? (isForeignPreset(entry.preset, mode) ? defaultArrangement(mode, {catalog}) : null);
  if (!entry.focus && sameArrangement(entry, preset)) return kept;
  const full = {...kept, ...compactArrangement(pickArrangement(entry))};
  if (entry.focus) full.focus = compactArrangement(entry.focus);
  return full;
}

/**
 * The JSON object to store: the v1 mirror (`studioVersion: 1`, `right`,
 * `timeline`), the v2 keys with preset-equal arrangements compacted to
 * `{stamp, preset}`, and every unknown key. Default sizes are left out.
 */
export function serializeLayout(layout, {catalog = PANEL_CATALOG, now = Date.now()} = {}) {
  const model = normalizeLayout(layout, {catalog, now});
  const stored = {};
  for (const [key, value] of Object.entries(model)) if (!V2_KEYS.has(key)) stored[key] = value;
  stored.studioVersion = 1;
  if (model.shared.sizes.right !== undefined) stored.right = model.shared.sizes.right;
  if (model.shared.sizes.bottom !== undefined) stored.timeline = model.shared.sizes.bottom;
  stored.layoutVersion = LAYOUT_VERSION;
  stored.shared = model.shared;
  stored.modes = Object.fromEntries(Object.entries(model.modes).map(([mode, entry]) => [mode, MODES.includes(mode) ? compactModeEntry(entry, mode, catalog) : entry]));
  stored.saved = model.saved.map(item => ({...item, arrangement: compactArrangement(item.arrangement)}));
  stored.tombstones = model.tombstones;
  // Every part is already JSON; the round trip only detaches the result from the model.
  return JSON.parse(JSON.stringify(stored));
}

/**
 * Removes the value at `path` from a layout (stored or in memory) and returns
 * a copy; `value` is not changed. Array items (saved layouts, records,
 * tombstones) are addressed by their `id`. A missing path changes nothing.
 */
function removePath(value, [head, ...rest]) {
  if (Array.isArray(value)) {
    const index = value.findIndex(item => isObject(item) && item.id === head);
    if (index < 0) return value;
    if (!rest.length) return value.filter((_, at) => at !== index);
    const item = removePath(value[index], rest);
    return item === value[index] ? value : value.map((other, at) => (at === index ? item : other));
  }
  if (!isObject(value) || !Object.hasOwn(value, head)) return value;
  if (!rest.length) return Object.fromEntries(Object.entries(value).filter(([key]) => key !== head));
  const item = removePath(value[head], rest);
  return item === value[head] ? value : {...value, [head]: item};
}

/** Every part of a stored layout this version does not read, as `{path, bytes}`. */
function unknownParts(value, catalog) {
  const {byId} = catalogInfo(catalog);
  const parts = [];
  const add = (path, item) => { parts.push({path, bytes: layoutBytes(item ?? null)}); };
  const extras = (path, object, known) => {
    if (isObject(object)) for (const [key, item] of Object.entries(object)) if (!known.has(key)) add([...path, key], item);
  };
  const arrangement = (path, source, known) => {
    if (!isObject(source)) return;
    extras(path, source, known);
    for (const record of Array.isArray(source.panels) ? source.panels : []) {
      if (!isObject(record) || typeof record.id !== 'string') continue;
      if (byId.has(record.id)) extras([...path, 'panels', record.id], record, RECORD_KEYS);
      else add([...path, 'panels', record.id], record);
    }
  };
  extras([], value, new Set([...V2_KEYS, ...MIRROR_KEYS]));
  extras(['shared'], value.shared, SHARED_KEYS);
  if (isObject(value.modes)) {
    for (const [mode, entry] of Object.entries(value.modes)) {
      if (!MODES.includes(mode)) { add(['modes', mode], entry); continue; }
      arrangement(['modes', mode], entry, ENTRY_KEYS);
      if (isObject(entry)) arrangement(['modes', mode, 'focus'], entry.focus, ARRANGEMENT_KEYS);
    }
  }
  for (const item of Array.isArray(value.saved) ? value.saved : []) {
    if (!isObject(item)) continue;
    extras(['saved', item.id], item, SAVED_KEYS);
    arrangement(['saved', item.id, 'arrangement'], item.arrangement, ARRANGEMENT_KEYS);
  }
  return parts;
}

/**
 * Keeps a serialized layout within the budget. Over the 12 KiB soft budget
 * only the oldest tombstones go (they only guard merges). Over the 16 KiB
 * file limit, which the preferences store would reject outright, focus
 * snapshots, then the oldest saved layouts, then the largest data this
 * version does not read (unknown keys at any level, records of unknown
 * panels, unknown workspaces) go.
 * Returns `{value, bytes, trimmed, removed, ok}`: `trimmed` names what went
 * (`tombstones`, `focus`, `saved:<id>`, `key:<path>`), `removed` lists the
 * paths for trimLayout, and `ok` is false if it still does not fit.
 */
export function fitBudget(value, {budget = LAYOUT_BUDGET_BYTES, limit = LAYOUT_FILE_LIMIT_BYTES, catalog = PANEL_CATALOG} = {}) {
  let current = value, bytes = layoutBytes(current);
  const trimmed = [], removed = [];
  /** Removes one part; false when nothing was left to remove there. */
  const drop = (path, label) => {
    const next = removePath(current, path);
    if (next === current) return false;
    current = next;
    removed.push(path);
    if (!trimmed.includes(label)) trimmed.push(label);
    return true;
  };
  while (bytes > budget && Array.isArray(current.tombstones) && drop(['tombstones', current.tombstones.at(-1)?.id], 'tombstones')) bytes = layoutBytes(current);
  const steps = [
    () => Object.entries(isObject(current.modes) ? current.modes : {})
      .filter(([, entry]) => isObject(entry) && 'focus' in entry)
      .map(([mode]) => drop(['modes', mode, 'focus'], 'focus'))
      .includes(true),
    () => {
      const saved = Array.isArray(current.saved) ? current.saved.filter(isObject) : [];
      if (!saved.length) return false;
      const oldest = saved.reduce((a, b) => (b.stamp < a.stamp ? b : a));
      return drop(['saved', oldest.id], `saved:${oldest.id}`);
    },
    () => {
      const parts = unknownParts(current, catalog);
      if (!parts.length) return false;
      const largest = parts.reduce((a, b) => (b.bytes > a.bytes ? b : a));
      return drop(largest.path, `key:${largest.path.join('.')}`);
    },
  ];
  for (const step of steps) {
    while (bytes > limit && step()) bytes = layoutBytes(current);
  }
  return {value: current, bytes, trimmed, removed, ok: bytes <= limit};
}

/**
 * Applies fitBudget's `removed` paths to an in-memory layout, so what was
 * trimmed from the file is not merged back and trimmed again on every save.
 */
export function trimLayout(layout, removed, {catalog = PANEL_CATALOG, now = Date.now()} = {}) {
  if (!removed?.length) return layout;
  return normalizeLayout(removed.reduce(removePath, layout), {catalog, now});
}

// ---------------------------------------------------------------------------
// Operations (pure; the store stamps what changed)

const withMode = (layout, mode, entry, {catalog, now}) => normalizeLayout({...layout, modes: {...layout.modes, [mode]: entry}}, {catalog, now});
/** A record this version places in the workspace (not one it only keeps). */
const placedIn = (catalog, mode) => {
  const {byId} = catalogInfo(catalog);
  return record => byId.has(record.id) && panelInMode(byId.get(record.id), mode) && DOCKS.includes(record.dock);
};

/** Applies a built-in (`animate`, `timing`, …), `focus` or saved (`user:<id>`) preset to a workspace. */
export function applyPreset(layout, mode, presetId, {catalog = PANEL_CATALOG, now = Date.now(), workspaceHeight} = {}) {
  mode = requireMode(mode);
  if (presetId === 'focus') return toggleFocus(layout, mode, {on: true, catalog, now});
  const arrangement = presetArrangement(presetId, mode, {catalog, layout});
  if (!arrangement) return layout;
  let {shared} = layout;
  const fractions = builtInPreset(presetId, mode)?.sizes;
  if (fractions && positive(workspaceHeight)) {
    const sizes = {...shared.sizes};
    for (const [key, fraction] of Object.entries(fractions)) sizes[key] = Math.round(fraction * workspaceHeight);
    shared = {...shared, sizes};
  }
  const entry = {...layout.modes[mode], preset: presetId, ...arrangement, focus: null};
  return normalizeLayout({...layout, shared, modes: {...layout.modes, [mode]: entry}}, {catalog, now});
}

/**
 * Focus: snapshots the arrangement and folds every docked or floating panel
 * to a strip on its side; turning it off restores the snapshot. `on` forces a state.
 */
export function toggleFocus(layout, mode, {on, catalog = PANEL_CATALOG, now = Date.now()} = {}) {
  mode = requireMode(mode);
  const entry = layout.modes[mode];
  const active = Boolean(entry.focus);
  if ((on ?? !active) === active) return layout;
  if (active) return withMode(layout, mode, {...entry, ...entry.focus, focus: null}, {catalog, now});
  const placed = placedIn(catalog, mode);
  const {byId} = catalogInfo(catalog);
  // Docked and floating panels fold, and so do records on a dock this version
  // does not know (solved docked at home); the snapshot keeps them as they were.
  const folds = record => (placed(record) && (record.dock === record.side || record.dock === 'float'))
    || (isForeignDock(record.dock) && byId.has(record.id) && panelInMode(byId.get(record.id), mode));
  const panels = entry.panels.map(record => (folds(record) ? {...record, dock: 'strip'} : record));
  return withMode(layout, mode, {...entry, panels, focus: pickArrangement(entry)}, {catalog, now});
}

/** Returns the workspace to its default preset. */
export function resetMode(layout, mode, {catalog = PANEL_CATALOG, now = Date.now()} = {}) {
  mode = requireMode(mode);
  return withMode(layout, mode, {...layout.modes[mode], preset: DEFAULT_PRESETS[mode], panels: undefined, focus: null}, {catalog, now});
}

/** Every workspace at its default and the shared sizes cleared; saved layouts stay. */
export function resetLayout(layout, {catalog = PANEL_CATALOG, now = Date.now()} = {}) {
  const modes = {...layout.modes};
  for (const mode of MODES) modes[mode] = {...modes[mode], preset: DEFAULT_PRESETS[mode], panels: undefined, focus: null};
  return normalizeLayout({...layout, shared: {...layout.shared, sizes: {}}, modes}, {catalog, now});
}

/** Sets one shared size (null: the default). */
export function setSharedSize(layout, key, value, {catalog = PANEL_CATALOG, now = Date.now()} = {}) {
  const sizes = {...layout.shared.sizes};
  if (value == null) delete sizes[key]; else sizes[key] = value;
  return normalizeLayout({...layout, shared: {...layout.shared, sizes}}, {catalog, now});
}

/**
 * True when a panel may go to `target` in the workspace: a side it allows,
 * `float` when floatable, `hidden` where it may hide, `strip` or `docked`
 * (back to its side).
 */
export function canPlacePanel(id, target, {mode, catalog = PANEL_CATALOG} = {}) {
  if (mode !== 'build' && !MODES.includes(mode)) return false;
  mode = normalizeMode(mode);
  const descriptor = catalogInfo(catalog).byId.get(id);
  if (!descriptor || !panelInMode(descriptor, mode)) return false;
  if (DOCK_SIDES.includes(target)) return descriptor.docks.includes(target);
  if (target === 'float') return descriptor.floatable;
  if (target === 'hidden') return panelCanHide(descriptor, mode);
  return target === 'strip' || target === 'docked';
}

/**
 * Moves a panel within an arrangement and returns the normalized arrangement
 * (unchanged when the move is not allowed). Docking adds the panel as the
 * active tab at `index` of `group` on that side; floating a third panel
 * docks the one that floated first. `split: before|after` places a panel
 * above or below the other docked panels, up to two resizable islands.
 */
export function movePanel(arrangement, id, target, {mode, catalog = PANEL_CATALOG, index, group, rect, split} = {}) {
  mode = requireMode(mode);
  if (!canPlacePanel(id, target, {mode, catalog})) return arrangement;
  const placed = placedIn(catalog, mode);
  const panels = arrangement.panels.map(record => ({...record}));
  const record = panels.find(item => item.id === id);
  if (!record) return arrangement;
  let weights = arrangement.weights;
  if (target === 'docked' || DOCK_SIDES.includes(target)) {
    const {docks} = catalogInfo(catalog).byId.get(id);
    const side = target !== 'docked' ? target : docks.includes(record.side) ? record.side : docks[0];
    let island = Number.isInteger(group) ? group : target === 'docked' ? record.group ?? 0 : 0;
    if (split === 'before' || split === 'after') {
      const others = panels.filter(item => item !== record && placed(item) && item.dock === side);
      // The shell supports two independently resizable islands on each side.
      if (!others.length || new Set(others.map(item => item.group ?? 0)).size > 1) return arrangement;
      island = split === 'before' ? 0 : 1;
      for (const item of others) item.group = 1 - island;
      weights = {...weights, [side]: [.5, .5]};
    }
    const siblings = panels.filter(item => item !== record && placed(item) && item.side === side).sort((a, b) => a.order - b.order);
    siblings.splice(Math.max(0, Math.min(siblings.length, Number.isInteger(index) ? index : siblings.length)), 0, record);
    siblings.forEach((item, order) => { item.order = order; });
    for (const item of panels) if (placed(item) && item.dock === side && (item.group ?? 0) === island) delete item.active;
    Object.assign(record, {dock: side, side, group: island, active: true});
  } else {
    if (target === 'float') {
      const others = panels.filter(item => item !== record && placed(item) && item.dock === 'float');
      for (const item of others.slice(0, Math.max(0, others.length - MAX_FLOATING + 1))) item.dock = item.side;
      const kept = normalizeRect(rect);
      if (kept) record.rect = kept;
    }
    record.dock = target;
  }
  return normalizeArrangement({...arrangement, panels, weights}, mode, {catalog});
}

/**
 * Makes a docked panel its island's shown tab. A panel on a dock this version
 * does not know (shown at its home) is docked there for good.
 */
export function activatePanel(arrangement, id, {mode, catalog = PANEL_CATALOG} = {}) {
  mode = requireMode(mode);
  const placed = placedIn(catalog, mode);
  const record = arrangement.panels.find(item => item.id === id);
  if (record && isForeignDock(record.dock)) return movePanel(arrangement, id, 'docked', {mode, catalog});
  if (!record || !placed(record) || record.dock !== record.side) return arrangement;
  const panels = arrangement.panels.map(item => {
    if (!placed(item) || item.dock !== record.side || (item.group ?? 0) !== (record.group ?? 0)) return item;
    const {active, ...rest} = item;
    return item.id === id ? {...rest, active: true} : rest;
  });
  return normalizeArrangement({...arrangement, panels}, mode, {catalog});
}

// ---------------------------------------------------------------------------
// Saved layouts

function uniqueSavedId(layout, now) {
  const base = `u${Math.max(0, Math.floor(now)).toString(36)}`.slice(0, 13);
  const taken = new Set([...layout.saved.map(item => item.id), ...layout.tombstones.map(item => item.id)]);
  let id = base;
  for (let n = 0; taken.has(id); n++) id = `${base}${n.toString(36)}`;
  return id;
}

/**
 * Whether the workspace's arrangement can be saved as a new layout:
 * `{ok: true}`, or `{ok: false, reason: 'limit'}` with 8 saved and
 * `{ok: false, reason: 'budget'}` when it would pass the 12 KiB budget.
 */
export function canSavePreset(layout, mode, {catalog = PANEL_CATALOG, now = Date.now()} = {}) {
  if (layout.saved.length >= MAX_SAVED_LAYOUTS) return {ok: false, reason: 'limit'};
  const trial = savePreset(layout, {name: 'x'.repeat(MAX_LAYOUT_NAME), mode, catalog, now, check: false});
  return layoutBytes(serializeLayout(trial.layout, {catalog, now})) > LAYOUT_BUDGET_BYTES ? {ok: false, reason: 'budget'} : {ok: true};
}

/**
 * Saves the workspace's arrangement as a named layout for that workspace.
 * Returns `{layout, id}`, or the unchanged layout with `error`: `name`
 * (empty), `limit` or `budget` (canSavePreset).
 */
export function savePreset(layout, {name, mode, catalog = PANEL_CATALOG, now = Date.now(), check = true} = {}) {
  mode = requireMode(mode);
  const clean = cleanLayoutName(name);
  if (!clean) return {layout, error: 'name'};
  if (layout.saved.length >= MAX_SAVED_LAYOUTS) return {layout, error: 'limit'};
  const entry = layout.modes[mode];
  const id = uniqueSavedId(layout, now);
  const next = normalizeLayout({
    ...layout,
    saved: [...layout.saved, {id, name: clean, mode, stamp: Math.floor(now), arrangement: pickArrangement(entry)}],
    modes: {...layout.modes, [mode]: {...entry, preset: `user:${id}`}},
  }, {catalog, now});
  if (check && layoutBytes(serializeLayout(next, {catalog, now})) > LAYOUT_BUDGET_BYTES) return {layout, error: 'budget'};
  return {layout: next, id};
}

/** Renames a saved layout; `{layout, error: 'name' | 'missing'}` when it cannot. */
export function renamePreset(layout, id, name, {catalog = PANEL_CATALOG, now = Date.now()} = {}) {
  const clean = cleanLayoutName(name);
  if (!clean) return {layout, error: 'name'};
  if (!layout.saved.some(item => item.id === id)) return {layout, error: 'missing'};
  return {layout: normalizeLayout({...layout, saved: layout.saved.map(item => item.id === id ? {...item, name: clean} : item)}, {catalog, now})};
}

/** Replaces a saved layout's arrangement with its workspace's current one. */
export function updatePreset(layout, id, {catalog = PANEL_CATALOG, now = Date.now()} = {}) {
  const item = layout.saved.find(saved => saved.id === id);
  if (!item) return {layout, error: 'missing'};
  const arrangement = pickArrangement(layout.modes[item.mode]);
  return {layout: normalizeLayout({...layout, saved: layout.saved.map(saved => saved === item ? {...saved, arrangement} : saved)}, {catalog, now})};
}

/**
 * Deletes a saved layout and records a tombstone, so a merge with another
 * window's older copy does not bring it back. Workspaces that came from it
 * keep their arrangement.
 */
export function deletePreset(layout, id, {catalog = PANEL_CATALOG, now = Date.now()} = {}) {
  const item = layout.saved.find(saved => saved.id === id);
  if (!item) return layout;
  const modes = {...layout.modes};
  for (const mode of MODES) if (modes[mode].preset === `user:${id}`) modes[mode] = {...modes[mode], preset: DEFAULT_PRESETS[mode]};
  return normalizeLayout({
    ...layout,
    modes,
    saved: layout.saved.filter(saved => saved !== item),
    tombstones: [...layout.tombstones, {id, stamp: Math.max(Math.floor(now), item.stamp + 1)}],
  }, {catalog, now});
}
