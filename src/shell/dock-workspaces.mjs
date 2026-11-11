/**
 * Workspaces, built-in presets and saved layouts over the docking model
 * (dock-model.mjs). Pure: the store (dock-store.mjs) stamps, persists and
 * merges; the host applies.
 *
 * The state, stored as the `dock` key of the workspace preferences (desktop)
 * or under its own localStorage key (browser):
 *
 *   {
 *     version: 3,
 *     workspaces: {animate: {stamp, preset, layout?, focus?}, draw: {...}, rig: {...}},
 *     saved: [{id: 'u…', name, mode, stamp, layout}],
 *     tombstones: [{id, stamp}],
 *     ...                                     // unknown keys survive
 *   }
 *
 * `preset` names the layout a workspace started from (a built-in id or
 * `user:<id>`); `layout` is stored only when the arrangement differs from it.
 * `focus` holds the arrangement Focus mode restores. Layouts are stored flat
 * (`{nodes: [...], floats, closed, tools}`, each node naming its parent), so
 * the stored JSON stays shallow however deep a person nests the panels.
 */
import {PANEL_CATALOG} from './panel-registry.mjs';
import {
  DOCK_VERSION, STAGE, cloneJSON, groupsOf, repairLayout, sameLayout, walk,
} from './dock-model.mjs';

export const MODES = Object.freeze(['animate', 'draw', 'rig']);
export const MAX_SAVED_LAYOUTS = 16;
export const MAX_LAYOUT_NAME = 48;
export const MAX_TOMBSTONES = 16;
export const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SAVED_ID = /^u[a-z0-9]{1,15}$/;
const PRESET_REF = /^(?:user:u[a-z0-9]{1,15}|[a-z][a-z0-9-]{0,39})$/;
const STATE_KEYS = new Set(['version', 'workspaces', 'saved', 'tombstones']);
const ENTRY_KEYS = new Set(['stamp', 'preset', 'layout', 'focus']);
const SAVED_KEYS = new Set(['id', 'name', 'mode', 'stamp', 'layout']);

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeKey = key => key !== '__proto__' && key !== 'constructor' && key !== 'prototype';
const stampOf = value => (typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value))) : 0);
const extras = (source, known) => Object.fromEntries(Object.entries(source).filter(([key]) => !known.has(key) && safeKey(key))
  .map(([key, value]) => [key, cloneJSON(value, 1)]).filter(([, value]) => value !== undefined));

export function normalizeMode(mode) {
  if (mode === 'build') return 'rig';
  return MODES.includes(mode) ? mode : 'animate';
}

// ---------------------------------------------------------------------------
// Built-in presets

const inspector = (extra = {}) => ({type: 'group', id: 'g2', tabs: ['properties', 'vfx', 'library'], active: 'properties', ...extra});
const timeline = (extra = {}) => ({type: 'group', id: 'g3', tabs: ['timeline'], active: 'timeline', ...extra});
const structure = () => ({type: 'group', id: 'g1', tabs: ['structure'], active: 'structure', collapsed: true});
const stage = () => ({type: STAGE, flex: 1});
const over = (top, bottom) => ({type: 'split', axis: 'column', children: [{...top, flex: 1}, bottom]});
const beside = (...children) => ({type: 'split', axis: 'row', children});

/**
 * The built-in layouts per workspace, in menu order. `shares` are fractions
 * of the workspace height that applying the preset turns into a stored size
 * (Timing's 40% timeline). Focus is a toggle with no layout of its own.
 */
export const PRESETS = Object.freeze([
  {id: 'animate', titleKey: 'shell.preset.animate', modes: ['animate'],
    layout: {root: over(beside(stage(), inspector()), timeline()), floats: [], closed: [], tools: 'left'}},
  {id: 'timing', titleKey: 'shell.preset.timing', modes: ['animate'], shares: {g3: 0.4},
    layout: {root: over(beside(stage(), {...inspector(), tabs: ['properties'], active: 'properties'},
      {type: 'group', id: 'g4', tabs: ['vfx', 'library'], active: 'vfx', collapsed: true}), timeline()), floats: [], closed: [], tools: 'left'}},
  {id: 'focus', titleKey: 'shell.preset.focus', modes: [...MODES], toggle: true},
  {id: 'review', titleKey: 'shell.preset.review', modes: ['animate'],
    layout: {root: over(stage(), timeline({collapsed: true})), floats: [], closed: [{id: 'properties'}, {id: 'vfx'}, {id: 'library'}], tools: 'left'}},
  {id: 'draw', titleKey: 'shell.preset.draw', modes: ['draw'],
    layout: {root: over(beside(stage(), inspector()), timeline()), floats: [], closed: [], tools: 'left'}},
  {id: 'build', titleKey: 'shell.preset.build', modes: ['rig'],
    layout: {root: beside(structure(), stage(), inspector()), floats: [], closed: [{id: 'timeline'}], tools: 'left'}},
  {id: 'build-timeline', titleKey: 'shell.preset.buildTimeline', modes: ['rig'],
    layout: {root: over(beside(structure(), stage(), inspector()), timeline()), floats: [], closed: [], tools: 'left'}},
].map(preset => Object.freeze(preset)));
export const DEFAULT_PRESETS = Object.freeze({animate: 'animate', draw: 'draw', rig: 'build'});

export const presetsFor = mode => PRESETS.filter(preset => preset.modes.includes(normalizeMode(mode)));
const builtIn = (id, mode) => PRESETS.find(preset => preset.id === id && preset.modes.includes(mode) && preset.layout) ?? null;

const presetCache = new WeakMap();
/** A built-in preset's repaired layout for the workspace (cached per catalogue). */
function builtInLayout(id, mode, catalog) {
  const preset = builtIn(id, mode);
  if (!preset) return null;
  let cache = presetCache.get(catalog);
  if (!cache) presetCache.set(catalog, cache = new Map());
  const key = `${mode}:${id}`;
  if (!cache.has(key)) cache.set(key, deepFreeze(repairLayout(preset.layout, mode, {catalog})));
  return cache.get(key);
}

/** The workspace's default layout (its default preset). */
export const defaultLayout = (mode, {catalog = PANEL_CATALOG} = {}) => builtInLayout(DEFAULT_PRESETS[normalizeMode(mode)], normalizeMode(mode), catalog);

/** A preset's layout for the workspace: built-in ids, or `user:<id>` from `state.saved`. Null for Focus or an unknown id. */
export function presetLayout(presetId, mode, {catalog = PANEL_CATALOG, state = null} = {}) {
  mode = normalizeMode(mode);
  if (typeof presetId === 'string' && presetId.startsWith('user:')) {
    const saved = state?.saved?.find(item => `user:${item.id}` === presetId);
    return saved ? repairLayout(saved.layout, mode, {catalog, fallback: defaultLayout(mode, {catalog})}) : null;
  }
  return builtInLayout(presetId, mode, catalog);
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Flat storage of a layout

const NODE_CODES = Object.freeze({stage: 's', group: 'g', split: 'x'});
const CODE_NODES = Object.freeze({s: 'stage', g: 'group', x: 'split'});

/** A layout as stored: its tree as a flat pre-order list, each node naming its parent's index (-1 for the root). */
export function flattenLayout(layout) {
  const nodes = [];
  const visit = (node, parent) => {
    const {type, children, ...rest} = node;
    const index = nodes.length;
    nodes.push({t: NODE_CODES[type], p: parent, ...rest});
    if (type === 'split') children.forEach(child => visit(child, index));
  };
  visit(layout.root, -1);
  const {root, ...rest} = layout;
  return {...rest, nodes};
}

/** The tree of a stored layout (flat, or an older tree form); invalid entries are dropped for repairLayout. */
export function unflattenLayout(stored) {
  if (!isObject(stored)) return null;
  if (!Array.isArray(stored.nodes)) return stored;
  const {nodes: list, ...rest} = stored;
  const nodes = [];
  let root = null;
  for (const raw of list.slice(0, 256)) {
    if (!isObject(raw) || !CODE_NODES[raw.t]) { nodes.push(null); continue; }
    const {t, p, ...fields} = raw;
    const node = {...fields, type: CODE_NODES[t]};
    if (node.type === 'split') node.children = [];
    nodes.push(node);
    if (p === -1 && !root) root = node;
    else if (Number.isInteger(p) && p >= 0 && p < nodes.length - 1 && nodes[p]?.type === 'split') nodes[p].children.push(node);
  }
  return {...rest, root};
}

// ---------------------------------------------------------------------------
// The state

const graphemes = typeof Intl?.Segmenter === 'function' ? new Intl.Segmenter(undefined, {granularity: 'grapheme'}) : null;
const splitGraphemes = text => (graphemes ? [...graphemes.segment(text)].map(part => part.segment) : [...text]);

/** A layout name: one line, at most 48 characters, never cut inside a character; invisible format characters removed. */
export function cleanLayoutName(value) {
  if (typeof value !== 'string') return '';
  const line = value.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ').replace(/\p{Cs}/gu, '').replace(/[​‎‏‪-‮⁦-⁩﻿]/gu, '');
  const text = line.replace(/\s+/g, ' ').trim();
  if (!/[^\p{Cf}\p{M}\p{Z}\s]/u.test(text)) return '';
  let kept = '', length = 0;
  for (const part of splitGraphemes(text)) {
    length += [...part].length;
    if (length > MAX_LAYOUT_NAME) break;
    kept += part;
  }
  return kept.trim();
}

function readEntry(raw, mode, catalog, saved) {
  const source = isObject(raw) ? raw : {};
  let preset = typeof source.preset === 'string' && PRESET_REF.test(source.preset) ? source.preset : DEFAULT_PRESETS[mode];
  const fallback = defaultLayout(mode, {catalog});
  const base = presetLayout(preset, mode, {catalog, state: {saved}});
  const stored = unflattenLayout(source.layout);
  // A compact entry is its preset's layout; a preset this version does not know is solved as the default.
  const layout = stored ? repairLayout(stored, mode, {catalog, fallback}) : base ?? fallback;
  const focus = source.focus ? repairLayout(unflattenLayout(source.focus), mode, {catalog, fallback}) : null;
  if (!base && !preset.startsWith('user:') && !PRESETS.some(item => item.id === preset)) {
    // A newer version's preset: kept by name so the newer version gets it back.
  } else if (!base) preset = DEFAULT_PRESETS[mode];
  return {...extras(source, ENTRY_KEYS), stamp: stampOf(source.stamp), preset, layout, focus};
}

function readTombstones(list, now) {
  const newest = new Map();
  for (const raw of Array.isArray(list) ? list : []) {
    if (!isObject(raw) || typeof raw.id !== 'string' || !SAVED_ID.test(raw.id)) continue;
    const stamp = stampOf(raw.stamp);
    if (now - stamp > TOMBSTONE_TTL_MS) continue;
    if ((newest.get(raw.id) ?? -1) < stamp) newest.set(raw.id, stamp);
  }
  return [...newest].map(([id, stamp]) => ({id, stamp})).sort((a, b) => b.stamp - a.stamp || (a.id < b.id ? -1 : 1)).slice(0, MAX_TOMBSTONES);
}

function readSaved(list, catalog, tombstones) {
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
    const layout = repairLayout(unflattenLayout(raw.layout), mode, {catalog, fallback: defaultLayout(mode, {catalog})});
    saved.push({...extras(raw, SAVED_KEYS), id, name, mode, stamp, layout});
  }
  return saved;
}

/**
 * The in-memory state from anything stored (`null` or invalid: every
 * workspace at its default). Idempotent; never mutates its input; never
 * fails: a damaged part falls back to its default without dropping a panel.
 */
export function readState(input, {catalog = PANEL_CATALOG, now = Date.now()} = {}) {
  const source = isObject(input) ? input : {};
  const state = extras(source, STATE_KEYS);
  state.version = DOCK_VERSION;
  state.tombstones = readTombstones(source.tombstones, now);
  state.saved = readSaved(source.saved, catalog, state.tombstones);
  const workspaces = isObject(source.workspaces) ? source.workspaces : {};
  state.workspaces = {...extras(workspaces, new Set(MODES))};
  for (const mode of MODES) state.workspaces[mode] = readEntry(workspaces[mode], mode, catalog, state.saved);
  return state;
}

export const defaultState = options => readState(null, options);

/** The JSON object to store: layouts flat, an entry equal to its preset compact, unknown keys kept. */
export function serializeState(state, {catalog = PANEL_CATALOG} = {}) {
  const stored = {};
  for (const [key, value] of Object.entries(state)) if (!STATE_KEYS.has(key)) stored[key] = value;
  stored.version = DOCK_VERSION;
  stored.workspaces = {};
  for (const [mode, entry] of Object.entries(state.workspaces)) {
    if (!MODES.includes(mode)) { stored.workspaces[mode] = entry; continue; }
    const {layout, focus, ...rest} = entry;
    const item = {...rest};
    const base = presetLayout(entry.preset, mode, {catalog, state});
    if (!base || !sameLayout(base, layout)) item.layout = flattenLayout(layout);
    if (focus) item.focus = flattenLayout(focus);
    stored.workspaces[mode] = item;
  }
  stored.saved = state.saved.map(item => ({...item, layout: flattenLayout(item.layout)}));
  stored.tombstones = state.tombstones;
  return JSON.parse(JSON.stringify(stored));
}

const encoder = new TextEncoder();
export const stateBytes = value => encoder.encode(JSON.stringify(value)).length;

// ---------------------------------------------------------------------------
// Operations on the state (pure; the store stamps what changed)

const withEntry = (state, mode, change) => ({...state, workspaces: {...state.workspaces, [mode]: {...state.workspaces[mode], ...change}}});

/** Replaces a workspace's arrangement (an edit: its preset stays the base it came from). */
export function setLayout(state, mode, layout) {
  mode = normalizeMode(mode);
  return state.workspaces[mode].layout === layout ? state : withEntry(state, mode, {layout});
}

/** True when a workspace's arrangement differs from the preset it came from (the menu's "modified" dot). */
export function isModified(state, mode, {catalog = PANEL_CATALOG} = {}) {
  mode = normalizeMode(mode);
  const entry = state.workspaces[mode];
  const base = presetLayout(entry.preset, mode, {catalog, state});
  return Boolean(base) && !sameLayout(base, entry.layout);
}

/**
 * Applies a built-in, saved (`user:<id>`) or Focus preset to a workspace.
 * `workspaceHeight` turns a preset's shares into sizes (Timing's timeline).
 */
export function applyPreset(state, mode, presetId, {catalog = PANEL_CATALOG, workspaceHeight} = {}) {
  mode = normalizeMode(mode);
  if (presetId === 'focus') return toggleFocus(state, mode, {on: true});
  let layout = presetLayout(presetId, mode, {catalog, state});
  if (!layout) return state;
  const shares = builtIn(presetId, mode)?.shares;
  if (shares && workspaceHeight > 0) {
    layout = structuredClone(layout);
    for (const group of groupsOf(layout)) if (shares[group.id]) group.size = Math.round(shares[group.id] * workspaceHeight);
  }
  return withEntry(state, mode, {preset: presetId, layout, focus: null});
}

/**
 * Focus: collapses every group (floats roll up too) and keeps the
 * arrangement; turning it off restores that arrangement exactly.
 */
export function toggleFocus(state, mode, {on} = {}) {
  mode = normalizeMode(mode);
  const entry = state.workspaces[mode];
  const active = Boolean(entry.focus);
  if ((on ?? !active) === active) return state;
  if (active) return withEntry(state, mode, {layout: entry.focus, focus: null});
  const layout = structuredClone(entry.layout);
  for (const group of groupsOf(layout)) group.collapsed = true;
  return withEntry(state, mode, {layout, focus: entry.layout});
}

export const focusActive = (state, mode) => Boolean(state.workspaces[normalizeMode(mode)]?.focus);

/** Returns the workspace to its default layout (Reset layout): always succeeds, built-ins are repaired data. */
export function resetWorkspace(state, mode, {catalog = PANEL_CATALOG} = {}) {
  mode = normalizeMode(mode);
  return withEntry(state, mode, {preset: DEFAULT_PRESETS[mode], layout: defaultLayout(mode, {catalog}), focus: null});
}

/** Every workspace at its default preset; saved layouts stay (Settings › Reset workspace). */
export function resetAll(state, {catalog = PANEL_CATALOG} = {}) {
  const workspaces = {...state.workspaces};
  for (const mode of MODES) workspaces[mode] = {...workspaces[mode], preset: DEFAULT_PRESETS[mode], layout: defaultLayout(mode, {catalog}), focus: null};
  return {...state, workspaces};
}

function uniqueSavedId(state, now) {
  const base = `u${Math.max(0, Math.floor(now)).toString(36)}`.slice(0, 13);
  const taken = new Set([...state.saved.map(item => item.id), ...state.tombstones.map(item => item.id)]);
  let id = base;
  for (let n = 0; taken.has(id); n++) id = `${base}${n.toString(36)}`;
  return id;
}

/** Saves the workspace's arrangement as a named layout. `{state, id}` or `{state, error: 'name' | 'limit'}`. */
export function saveLayout(state, {name, mode, now = Date.now()} = {}) {
  mode = normalizeMode(mode);
  const clean = cleanLayoutName(name);
  if (!clean) return {state, error: 'name'};
  if (state.saved.length >= MAX_SAVED_LAYOUTS) return {state, error: 'limit'};
  const id = uniqueSavedId(state, now);
  const layout = state.workspaces[mode].layout;
  const next = {...state, saved: [...state.saved, {id, name: clean, mode, stamp: Math.floor(now), layout}]};
  return {state: withEntry(next, mode, {preset: `user:${id}`, focus: null}), id};
}

export function renameLayout(state, id, name) {
  const clean = cleanLayoutName(name);
  if (!clean) return {state, error: 'name'};
  if (!state.saved.some(item => item.id === id)) return {state, error: 'missing'};
  return {state: {...state, saved: state.saved.map(item => (item.id === id ? {...item, name: clean} : item))}};
}

/** Overwrites a saved layout with its workspace's current arrangement. */
export function updateLayout(state, id) {
  const item = state.saved.find(saved => saved.id === id);
  if (!item) return {state, error: 'missing'};
  const layout = state.workspaces[item.mode].layout;
  return {state: {...state, saved: state.saved.map(saved => (saved === item ? {...saved, layout} : saved))}};
}

/** Deletes a saved layout with a tombstone; workspaces that came from it keep their arrangement. */
export function deleteLayout(state, id, {now = Date.now()} = {}) {
  const item = state.saved.find(saved => saved.id === id);
  if (!item) return state;
  const workspaces = {...state.workspaces};
  for (const mode of MODES) if (workspaces[mode].preset === `user:${id}`) workspaces[mode] = {...workspaces[mode], preset: DEFAULT_PRESETS[mode]};
  return {...state, workspaces, saved: state.saved.filter(saved => saved !== item),
    tombstones: [...state.tombstones, {id, stamp: Math.max(Math.floor(now), item.stamp + 1)}]};
}

/** A saved layout as a file (`.stylayout`): its name, workspace and layout, for Export. */
export function exportLayout(state, mode) {
  mode = normalizeMode(mode);
  const entry = state.workspaces[mode];
  const saved = entry.preset.startsWith('user:') ? state.saved.find(item => `user:${item.id}` === entry.preset) : null;
  return {stykLayout: DOCK_VERSION, name: saved?.name ?? null, mode, layout: flattenLayout(entry.layout)};
}

/**
 * Reads an exported layout and saves it under its name for its workspace
 * (or `mode`). `{state, id}`, or `{state, error: 'invalid' | 'newer' | 'limit' | 'name'}`.
 */
export function importLayout(state, value, {mode, name, catalog = PANEL_CATALOG, now = Date.now()} = {}) {
  if (!isObject(value) || !Number.isInteger(value.stykLayout)) return {state, error: 'invalid'};
  if (value.stykLayout > DOCK_VERSION) return {state, error: 'newer'};
  const target = normalizeMode(mode ?? value.mode);
  const layout = repairLayout(unflattenLayout(value.layout), target, {catalog, fallback: defaultLayout(target, {catalog})});
  const staged = withEntry(state, target, {layout});
  return saveLayout(staged, {name: name ?? value.name, mode: target, now});
}

/** Every stamp of the state, for the store's clock. */
export const highestStamp = state => Math.max(0, ...MODES.map(mode => state.workspaces[mode].stamp), ...state.saved.map(item => item.stamp), ...state.tombstones.map(item => item.stamp));

/** True when a layout holds a group of only unknown panels (data kept from a newer version). */
export function hasForeignGroups(layout, catalog = PANEL_CATALOG) {
  const known = new Set(catalog.map(panel => panel.id));
  let found = false;
  walk(layout.root, node => { if (node.type === 'group' && !node.tabs.some(id => known.has(id))) found = true; });
  return found;
}
