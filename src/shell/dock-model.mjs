/**
 * The docking model (docs/DOCKING.md): one arrangement per workspace, a tree
 * of splits, tab groups and the stage, plus floating groups and the panels a
 * person closed. Pure data and pure functions: no DOM, no I/O, no clock. The
 * solver (dock-solve.mjs) fits an arrangement into the window, the store
 * (dock-store.mjs) persists it and the host (dock-host.mjs) draws it.
 *
 * An arrangement (`layout`):
 *
 *   {
 *     root: Node,                              // the window's tree; holds the stage exactly once
 *     floats: [{id, rect: {x, y, w, h}, group}],   // groups over the workspace (rect relative to it)
 *     closed: [{id, group?, index?}],          // closed panels and where they return
 *     tools: 'left' | 'right',                 // the tool bar's side of the stage
 *     ...                                      // unknown keys survive
 *   }
 *   Node = {type: 'stage', flex: 1}
 *        | {type: 'group', id, tabs: [panel ids], active, collapsed?, size?, flex?}
 *        | {type: 'split', axis: 'row' | 'column', children: [Node, ...], size?, flex?}
 *
 * `size` is a node's extent in CSS px along its parent split's axis, stored
 * only once a person sets it (a divider); without it the node takes its
 * default (the panel's preferred size, which the solver derives from the
 * window). `flex` makes a node share the rest of its split by weight; the
 * stage is always flexible.
 *
 * Invariants (`repair` restores them; every operation ends with it): the
 * stage is in the root once; every panel of the workspace is placed exactly
 * once (in a group, a float or `closed`); no group is empty, no split has
 * fewer than two children or the axis of its parent; every split has a
 * flexible child. A panel this version does not know stays in its group as
 * data and is never drawn. Operations never mutate their input and return
 * the input itself when nothing changes.
 */
import {PANEL_CATALOG, panelInMode} from './panel-registry.mjs';

export const DOCK_VERSION = 3;
export const STAGE = 'stage';
export const AXES = Object.freeze(['row', 'column']);
export const SIDES = Object.freeze(['left', 'right', 'top', 'bottom']);
export const MAX_FLOATS = 8;
const MAX_DEPTH = 24;
const MAX_TABS = 32;
const MAX_EXTENT = 8192;
const ID = /^[a-z][a-z0-9-]{0,39}$/;
const GROUP_ID = /^[gf][a-z0-9]{1,15}$/;

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeKey = key => key !== '__proto__' && key !== 'constructor' && key !== 'prototype';
const int = (value, min, max) => (typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : null);
const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;
export const axisOf = side => (side === 'left' || side === 'right' ? 'row' : 'column');
const before = side => side === 'left' || side === 'top';

/** JSON values only, bounded in depth; anything else is dropped. */
export function cloneJSON(value, depth = 0) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'object' || depth >= 40) return undefined;
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

function extras(source, known) {
  const kept = {};
  for (const [key, value] of Object.entries(source)) {
    if (known.has(key) || !safeKey(key)) continue;
    const copy = cloneJSON(value, 1);
    if (copy !== undefined) kept[key] = copy;
  }
  return kept;
}

const LAYOUT_KEYS = new Set(['root', 'floats', 'closed', 'tools']);
const NODE_KEYS = new Set(['type', 'id', 'tabs', 'active', 'collapsed', 'size', 'flex', 'axis', 'children', 'rect', 'group', 'index']);

// ---------------------------------------------------------------------------
// The panels of a workspace

/** The catalogue's panels that exist in `mode`, in catalogue order. */
export const panelsOf = (mode, catalog = PANEL_CATALOG) => catalog.filter(panel => panelInMode(panel, mode)).map(panel => panel.id);
const knownIds = catalog => new Set(catalog.map(panel => panel.id));

// ---------------------------------------------------------------------------
// Walking the tree

/** Calls `visit(node, parent, index, depth)` for every node of `root`, depth first, in reading order. */
export function walk(root, visit, parent = null, index = 0, depth = 0) {
  if (!root) return;
  visit(root, parent, index, depth);
  if (root.type === 'split') root.children.forEach((child, at) => walk(child, visit, root, at, depth + 1));
}

/** Every group of the arrangement: the tree's in reading order, then each float's. */
export function groupsOf(layout) {
  const groups = [];
  walk(layout.root, node => { if (node.type === 'group') groups.push(node); });
  for (const float of layout.floats ?? []) groups.push(float.group);
  return groups;
}

/** Where a panel is: `{where: 'tree' | 'float' | 'closed', group, float, index}` or null. */
export function findPanel(layout, id) {
  let found = null;
  walk(layout.root, node => {
    if (!found && node.type === 'group' && node.tabs.includes(id)) found = {where: 'tree', group: node, index: node.tabs.indexOf(id)};
  });
  if (found) return found;
  for (const float of layout.floats ?? []) {
    if (float.group.tabs.includes(id)) return {where: 'float', group: float.group, float, index: float.group.tabs.indexOf(id)};
  }
  const closed = (layout.closed ?? []).find(item => item.id === id);
  return closed ? {where: 'closed', closed} : null;
}

export function findGroup(layout, groupId) {
  return groupsOf(layout).find(group => group.id === groupId) ?? null;
}

/** The node's parent split and index in the tree, or null for the root. */
export function parentOf(root, target) {
  let found = null;
  walk(root, (node, parent, index) => { if (node === target && parent) found = {parent, index}; });
  return found;
}

/** The path of child indices from the root to `target` (null when it is not in the tree). */
export function pathOf(root, target) {
  const path = [];
  const search = node => {
    if (node === target) return true;
    if (node.type !== 'split') return false;
    for (let index = 0; index < node.children.length; index++) {
      path.push(index);
      if (search(node.children[index])) return true;
      path.pop();
    }
    return false;
  };
  return search(root) ? path : null;
}

export const nodeAt = (root, path) => path.reduce((node, index) => node?.children?.[index] ?? null, root);

/** A deep copy of an arrangement (JSON data), so operations can edit it freely. */
const copyLayout = layout => structuredClone(layout);

// ---------------------------------------------------------------------------
// Ids

function nextId(layout, prefix) {
  const taken = new Set(groupsOf(layout).map(group => group.id));
  for (const float of layout.floats ?? []) taken.add(float.id);
  for (let n = 1; ; n++) if (!taken.has(`${prefix}${n}`)) return `${prefix}${n}`;
}

export const makeGroup = (layout, tabs, extra = {}) => ({type: 'group', id: nextId(layout, 'g'), tabs: [...tabs], active: tabs[0], ...extra});

// ---------------------------------------------------------------------------
// Repair: the invariants

function normalizeRect(rect) {
  if (!isObject(rect)) return null;
  const x = int(rect.x, -MAX_EXTENT, MAX_EXTENT), y = int(rect.y, -MAX_EXTENT, MAX_EXTENT);
  const w = int(rect.w ?? rect.width, 1, MAX_EXTENT), h = int(rect.h ?? rect.height, 1, MAX_EXTENT);
  return x === null || y === null || w === null || h === null ? null : {x, y, w, h};
}

function sizeFields(raw, node) {
  const size = int(raw.size, 1, MAX_EXTENT);
  if (size !== null) node.size = size;
  if (positive(raw.flex)) node.flex = Math.min(1000, Math.round(raw.flex * 1000) / 1000);
  return node;
}

/**
 * One node read from storage: unknown keys kept, invalid parts dropped.
 * `state` tracks ids already used (a panel or group id seen twice keeps its
 * first place), the stage and the panels this version knows.
 */
function readNode(raw, state, depth) {
  if (!isObject(raw) || depth > MAX_DEPTH) return null;
  if (raw.type === STAGE) {
    if (state.stage) return null;
    state.stage = true;
    return {...extras(raw, NODE_KEYS), type: STAGE, flex: 1};
  }
  if (raw.type === 'group') return readGroup(raw, state);
  if (raw.type === 'split') {
    const axis = AXES.includes(raw.axis) ? raw.axis : 'row';
    const children = (Array.isArray(raw.children) ? raw.children : []).map(child => readNode(child, state, depth + 1)).filter(Boolean);
    return sizeFields(raw, {...extras(raw, NODE_KEYS), type: 'split', axis, children});
  }
  return null;
}

function readGroup(raw, state) {
  if (!isObject(raw)) return null;
  const tabs = [];
  for (const id of Array.isArray(raw.tabs) ? raw.tabs : []) {
    if (typeof id !== 'string' || !ID.test(id) || id === STAGE || state.panels.has(id) || tabs.length >= MAX_TABS) continue;
    // A panel of another workspace (Structure outside Build) is not shown here; it waits in its own workspace.
    if (state.known.has(id) && !state.workspace.has(id)) continue;
    state.panels.add(id);
    tabs.push(id);
  }
  let id = typeof raw.id === 'string' && GROUP_ID.test(raw.id) && !state.groups.has(raw.id) ? raw.id : null;
  if (!id) for (let n = 1; !id; n++) if (!state.groups.has(`g${n}`) && !state.reserved.has(`g${n}`)) id = `g${n}`;
  state.groups.add(id);
  const group = {...extras(raw, NODE_KEYS), type: 'group', id, tabs};
  group.active = tabs.includes(raw.active) ? raw.active : tabs.find(tab => state.known.has(tab)) ?? tabs[0];
  if (raw.collapsed === true) group.collapsed = true;
  return sizeFields(raw, group);
}

/** Every group id in a raw arrangement, so generated ids never take a stored one. */
function storedGroupIds(raw) {
  const ids = new Set();
  const visit = node => {
    if (!isObject(node)) return;
    if (node.type === 'group' && typeof node.id === 'string') ids.add(node.id);
    if (Array.isArray(node.children)) node.children.forEach(visit);
  };
  visit(raw?.root);
  for (const float of Array.isArray(raw?.floats) ? raw.floats : []) {
    if (isObject(float)) { visit(float.group); if (typeof float.id === 'string') ids.add(float.id); }
  }
  return ids;
}

/**
 * Simplifies a tree: drops empty groups (groups of unknown panels only are
 * kept as data), lifts single children, merges a split into its parent of the
 * same axis and makes sure each split has a flexible child.
 */
function simplify(node, state, isRoot = false) {
  if (!node) return null;
  if (node.type === 'group') return node.tabs.length ? node : null;
  if (node.type !== 'split') return node;
  let children = [];
  for (const child of node.children) {
    const kept = simplify(child, state);
    if (!kept) continue;
    if (kept.type === 'split' && kept.axis === node.axis) {
      // The inner split's children take its place; its own size goes with it, its children keep theirs.
      children.push(...kept.children);
    } else children.push(kept);
  }
  if (!children.length) return null;
  if (children.length === 1) {
    const only = children[0];
    // A lone child takes its parent's place and its parent's size along the grandparent's axis.
    const {size, flex, ...rest} = only;
    const lifted = {...rest};
    if (node.size !== undefined) lifted.size = node.size;
    if (node.flex !== undefined) lifted.flex = node.flex;
    if (lifted.type === STAGE) lifted.flex = 1;
    return lifted;
  }
  if (!children.some(child => child.flex !== undefined)) {
    // Nothing shares the rest: the last child that is not collapsed does (a stack of two fixed groups keeps one fixed).
    const index = children.map(child => !(child.type === 'group' && child.collapsed)).lastIndexOf(true);
    const at = index < 0 ? children.length - 1 : index;
    const {size, ...rest} = children[at];
    children = children.map((child, i) => (i === at ? {...rest, flex: 1} : child));
  }
  const split = {...node, children};
  if (isRoot) { delete split.size; delete split.flex; }
  return split;
}

/**
 * Reads and repairs an arrangement for a workspace: invalid parts dropped,
 * missing panels placed at their home in `fallback` (the workspace default),
 * the stage added when missing. Never fails; never mutates its input.
 */
export function repairLayout(input, mode, {catalog = PANEL_CATALOG, fallback = null} = {}) {
  const raw = isObject(input) ? input : {};
  const workspace = new Set(panelsOf(mode, catalog));
  const state = {stage: false, panels: new Set(), groups: new Set(), reserved: storedGroupIds(raw), known: knownIds(catalog), workspace};
  let root = readNode(raw.root, state, 0);
  const floats = [];
  for (const item of Array.isArray(raw.floats) ? raw.floats : []) {
    if (!isObject(item) || floats.length >= MAX_FLOATS) continue;
    const rect = normalizeRect(item.rect);
    // A float without a place is dropped before its panels count as placed: they go home instead.
    if (!rect) continue;
    const group = readGroup(item.group, state);
    if (!group?.tabs.length) continue;
    delete group.size; delete group.flex;
    const id = typeof item.id === 'string' && GROUP_ID.test(item.id) && !state.groups.has(item.id) ? item.id : null;
    floats.push({...extras(item, NODE_KEYS), id: id ?? `f${floats.length + 1}x`, rect, group});
    state.groups.add(floats.at(-1).id);
  }
  const closed = [];
  for (const item of Array.isArray(raw.closed) ? raw.closed : []) {
    const id = isObject(item) ? item.id : item;
    if (typeof id !== 'string' || !ID.test(id) || state.panels.has(id) || id === STAGE) continue;
    if (state.known.has(id) && !workspace.has(id)) continue;
    state.panels.add(id);
    const entry = {id};
    if (isObject(item) && typeof item.group === 'string' && GROUP_ID.test(item.group)) entry.group = item.group;
    if (isObject(item) && Number.isInteger(item.index) && item.index >= 0) entry.index = Math.min(item.index, MAX_TABS);
    closed.push(entry);
  }
  // The stage: a tree without one gets it beside everything else.
  if (!state.stage) {
    state.stage = true;
    const stage = {type: STAGE, flex: 1};
    root = root ? {type: 'split', axis: 'row', children: [stage, root.type === 'split' ? {...root} : root]} : stage;
  }
  let layout = {...extras(raw, LAYOUT_KEYS), root: simplify(root, state, true), floats: floats.map(item => ({...item, group: item.group})), closed,
    tools: raw.tools === 'right' ? 'right' : 'left'};
  layout.floats = layout.floats.filter(item => item.group.tabs.length);
  // Panels of the workspace that are nowhere go home.
  const missing = [...workspace].filter(id => !state.panels.has(id));
  for (const id of missing) layout = placeHome(layout, id, mode, {catalog, fallback});
  return layout;
}

// ---------------------------------------------------------------------------
// Homes: where a panel goes when nothing else says

const HOME_SIDE = Object.freeze({properties: 'right', vfx: 'right', library: 'right', structure: 'left', timeline: 'bottom'});

/**
 * Puts a panel that is nowhere at its home: beside the panels it shares a
 * group with in `fallback` (the workspace default), else in a new group at
 * the window edge it belongs to. Collapsed when its default group is.
 */
function placeHome(layout, id, mode, {catalog, fallback, open = false}) {
  const home = fallback ? findPanel(fallback, id) : null;
  if (home?.group) {
    for (const mate of home.group.tabs) {
      if (mate === id) continue;
      const there = findPanel(layout, mate);
      if (there?.group) {
        const next = copyLayout(layout);
        const group = findGroup(next, there.group.id);
        group.tabs.splice(Math.min(home.index, group.tabs.length), 0, id);
        return next;
      }
    }
  }
  // A panel the default keeps closed stays closed when it was missing, but opens when a person asks for it.
  if (home?.where === 'closed' && !open) return {...layout, closed: [...layout.closed, {id}]};
  const descriptor = catalog.find(panel => panel.id === id);
  // A panel whose descriptor says where it arrives when nothing records it (panel-registry.mjs `defaultDock`):
  // 'hidden' arrives closed and 'strip' collapsed, so a panel defined later never reshapes a layout on its own.
  if (!home && descriptor?.defaultDock === 'hidden' && !open) return {...layout, closed: [...layout.closed, {id}]};
  const side = HOME_SIDE[id] ?? (descriptor?.docks?.[0] === 'left' ? 'left' : descriptor?.docks?.[0] === 'bottom' ? 'bottom' : 'right');
  const group = makeGroup(layout, [id]);
  if (home?.group?.collapsed || (!home && descriptor?.defaultDock === 'strip')) group.collapsed = true;
  return insertAtEdge(layout, group, side);
}

/** A new group at a window edge: the root splits along that edge's axis (or grows when it already does). */
function insertAtEdge(layout, group, side) {
  const axis = axisOf(side);
  const next = copyLayout(layout);
  const root = next.root;
  if (root.type === 'split' && root.axis === axis) {
    if (before(side)) root.children.unshift(group); else root.children.push(group);
  } else {
    const {size, flex, ...rest} = root;
    const old = {...rest, flex: 1};
    next.root = {type: 'split', axis, children: before(side) ? [group, old] : [old, group]};
  }
  return next;
}

// ---------------------------------------------------------------------------
// Operations

/** Removes a panel from wherever it is, leaving the tree simplified; returns `{layout, from}`. */
function detach(layout, id) {
  const next = copyLayout(layout);
  const place = findPanel(next, id);
  if (!place) return {layout: next, from: null};
  let from = null;
  if (place.where === 'closed') {
    next.closed = next.closed.filter(item => item.id !== id);
    from = {where: 'closed'};
  } else {
    const group = place.group;
    group.tabs.splice(place.index, 1);
    if (group.active === id) group.active = group.tabs[Math.min(place.index, group.tabs.length - 1)] ?? group.tabs[0];
    from = {where: place.where, group: group.id, index: place.index, empty: !group.tabs.length};
    if (!group.tabs.length && place.where === 'tree') Object.assign(from, anchorOf(next.root, group));
    if (place.where === 'float' && !group.tabs.length) next.floats = next.floats.filter(item => item !== place.float);
  }
  next.root = simplify(next.root, null, true);
  return {layout: next, from};
}

/**
 * Where an emptied group stood, so its panel can return there: the
 * neighbour it was beside (a group, or the stage when the neighbour holds
 * it), the side of that neighbour, and whether it was collapsed.
 */
function anchorOf(root, group) {
  const owner = parentOf(root, group);
  if (!owner) return {};
  const {parent, index} = owner;
  const after = parent.children[index + 1], before = parent.children[index - 1];
  const neighbour = after ?? before;
  if (!neighbour) return {};
  let target = null, stage = false;
  walk(neighbour, node => { if (node.type === STAGE) stage = true; if (!target && node.type === 'group' && node.tabs.length) target = node.id; });
  const side = parent.axis === 'row' ? (after ? 'left' : 'right') : (after ? 'top' : 'bottom');
  return {beside: stage ? STAGE : target, side, collapsed: Boolean(group.collapsed)};
}

/**
 * Where a drop puts a panel or a group (`zone`):
 *   {kind: 'tab', group, index?}                  a tab of that group
 *   {kind: 'split', target: group id | 'stage', side}   beside a group or the stage
 *   {kind: 'edge', side}                          at a window edge, across the window
 *   {kind: 'float', rect: {x, y, w, h}}           floating over the workspace
 */
export const ZONE_KINDS = Object.freeze(['tab', 'split', 'edge', 'float']);

/**
 * Moves a panel to a zone. Returns the new arrangement, or the input when the
 * zone is not a place it can go (its own lone group, a missing target).
 */
export function movePanel(layout, id, zone, {mode, catalog = PANEL_CATALOG} = {}) {
  if (!panelsOf(mode, catalog).includes(id) || !zone || !ZONE_KINDS.includes(zone.kind)) return layout;
  const place = findPanel(layout, id);
  if (!place) return layout;
  // Dropping a lone tab beside or onto itself changes nothing.
  if (place.group && place.group.tabs.length === 1 && zone.target === place.group.id) return layout;
  if (zone.kind === 'tab' && place.group?.id === zone.group) return reorderTab(layout, id, zone.index ?? place.group.tabs.length - 1);
  const target = zone.kind === 'tab' ? findGroup(layout, zone.group) : null;
  if (zone.kind === 'tab' && !target) return layout;
  if (zone.kind === 'split' && zone.target !== STAGE && !findGroup(layout, zone.target)) return layout;
  const {layout: next, from} = detach(layout, id);
  const ret = from?.group ? {group: from.group, index: from.index, ...(from.beside ? {beside: from.beside, side: from.side, collapsed: from.collapsed} : {})} : null;
  return insert(next, [id], zone, {mode, catalog, ret}) ?? layout;
}

/** Moves a whole group (a float's tabs, a collapsed strip) to a zone, keeping its tab order and active tab. */
export function moveGroup(layout, groupId, zone, {mode, catalog = PANEL_CATALOG} = {}) {
  const group = findGroup(layout, groupId);
  if (!group || !zone || !ZONE_KINDS.includes(zone.kind)) return layout;
  if (zone.kind === 'tab' && zone.group === groupId) return layout;
  if (zone.kind === 'split' && zone.target === groupId) return layout;
  const tabs = [...group.tabs], active = group.active;
  let next = layout;
  for (const id of tabs) next = detach(next, id).layout;
  if (zone.kind === 'tab' && !findGroup(next, zone.group)) return layout;
  if (zone.kind === 'split' && zone.target !== STAGE && !findGroup(next, zone.target)) return layout;
  const result = insert(next, tabs, zone, {mode, catalog, active});
  return result ?? layout;
}

function insert(layout, tabs, zone, {mode, catalog, ret = null, active = tabs[0]}) {
  const next = copyLayout(layout);
  if (zone.kind === 'tab') {
    const group = findGroup(next, zone.group);
    if (!group) return null;
    const index = Math.max(0, Math.min(group.tabs.length, Number.isInteger(zone.index) ? zone.index : group.tabs.length));
    group.tabs.splice(index, 0, ...tabs);
    group.active = active;
    return finish(next, mode, catalog);
  }
  const group = makeGroup(next, tabs, {active});
  if (zone.kind === 'float') {
    const rect = normalizeRect(zone.rect);
    if (!rect) return null;
    if (next.floats.length >= MAX_FLOATS) return null;
    const float = {id: nextId(next, 'f'), rect, group};
    if (ret) float.ret = ret;
    next.floats.push(float);
    return finish(next, mode, catalog);
  }
  if (zone.kind === 'edge') {
    if (!SIDES.includes(zone.side)) return null;
    return finish(insertAtEdge(next, group, zone.side), mode, catalog);
  }
  // A split beside a group or the stage.
  if (!SIDES.includes(zone.side)) return null;
  const axis = axisOf(zone.side);
  let target = null;
  walk(next.root, node => {
    if (target) return;
    if (zone.target === STAGE ? node.type === STAGE : node.type === 'group' && node.id === zone.target) target = node;
  });
  if (!target) return null;
  const owner = parentOf(next.root, target);
  // Beside the stage, or beside a group that keeps its own size along the axis: the new group takes its default size.
  // Beside a group that shares its split, the two share its place equally.
  const shares = target.type === 'group' && owner?.parent.axis === axis && target.flex !== undefined;
  if (shares) group.flex = target.flex;
  if (owner && owner.parent.axis === axis) {
    owner.parent.children.splice(owner.index + (before(zone.side) ? 0 : 1), 0, group);
  } else {
    // The target becomes a split of two along the axis, taking the target's place and size.
    const {size, flex, ...rest} = target;
    const inner = target.type === STAGE ? {...rest, flex: 1} : {...rest, flex: 1};
    if (target.type !== STAGE) group.flex = 1;
    const split = {type: 'split', axis, children: before(zone.side) ? [group, inner] : [inner, group]};
    if (size !== undefined) split.size = size;
    if (flex !== undefined || target.type === STAGE) split.flex = flex ?? 1;
    if (owner) owner.parent.children[owner.index] = split; else next.root = split;
  }
  return finish(next, mode, catalog);
}

function finish(layout, mode, catalog) {
  return repairLayout(layout, mode, {catalog});
}

/** Makes a panel its group's shown tab (and expands nothing). */
export function activatePanel(layout, id) {
  const place = findPanel(layout, id);
  if (!place?.group || place.group.active === id) return layout;
  const next = copyLayout(layout);
  findGroup(next, place.group.id).active = id;
  return next;
}

/** Moves a tab within its group to `index`. */
export function reorderTab(layout, id, index) {
  const place = findPanel(layout, id);
  if (!place?.group) return layout;
  const tabs = place.group.tabs.filter(tab => tab !== id);
  const at = Math.max(0, Math.min(tabs.length, index));
  tabs.splice(at, 0, id);
  if (tabs.every((tab, i) => tab === place.group.tabs[i]) && place.group.active === id) return layout;
  const next = copyLayout(layout);
  const group = findGroup(next, place.group.id);
  group.tabs = tabs;
  group.active = id;
  return next;
}

/** Collapses (`on`) or expands a group; a float collapses to its header. */
export function setCollapsed(layout, groupId, on) {
  const group = findGroup(layout, groupId);
  if (!group || Boolean(group.collapsed) === Boolean(on)) return layout;
  const next = copyLayout(layout);
  const target = findGroup(next, groupId);
  if (on) target.collapsed = true; else delete target.collapsed;
  return next;
}

/** Closes a panel: it waits in `closed` with the place it returns to. */
export function closePanel(layout, id, {mode, catalog = PANEL_CATALOG} = {}) {
  const place = findPanel(layout, id);
  if (!place || place.where === 'closed') return layout;
  const {layout: next, from} = detach(layout, id);
  next.closed.push({id, ...(from?.group && !from.empty ? {group: from.group, index: from.index} : {})});
  return finish(next, mode, catalog);
}

/**
 * Opens a closed panel where it was (its old group, at its old index), else
 * at its home. A panel that is already placed is returned unchanged.
 */
export function reopenPanel(layout, id, {mode, catalog = PANEL_CATALOG, fallback = null} = {}) {
  const place = findPanel(layout, id);
  if (!place || place.where !== 'closed') return layout;
  const {group, index} = place.closed;
  const {layout: next} = detach(layout, id);
  if (group && findGroup(next, group)) {
    const result = insert(next, [id], {kind: 'tab', group, index}, {mode, catalog});
    if (result) return result;
  }
  return finish(placeHome(next, id, mode, {catalog, fallback, open: true}), mode, catalog);
}

/**
 * Docks a float's group back: to the group it came from (at its old index),
 * else beside the panels it shares a group with in `fallback`, else home.
 */
export function dockFloat(layout, floatId, {mode, catalog = PANEL_CATALOG, fallback = null} = {}) {
  const float = (layout.floats ?? []).find(item => item.id === floatId);
  if (!float) return layout;
  const ret = float.ret;
  const tabs = [...float.group.tabs], active = float.group.active;
  const next = copyLayout(layout);
  next.floats = next.floats.filter(item => item.id !== floatId);
  if (ret?.group && findGroup(next, ret.group)) {
    const result = insert(next, tabs, {kind: 'tab', group: ret.group, index: ret.index}, {mode, catalog, active});
    if (result) return result;
  }
  // Its group is gone: beside the neighbour it had, on the same side, collapsed again if it was.
  if (ret?.beside && SIDES.includes(ret.side) && (ret.beside === STAGE || findGroup(next, ret.beside))) {
    let result = insert(next, tabs, {kind: 'split', target: ret.beside, side: ret.side}, {mode, catalog, active});
    if (result) {
      const group = findPanel(result, tabs[0])?.group;
      if (ret.collapsed && group) result = setCollapsed(result, group.id, true);
      return result;
    }
  }
  // Each panel goes home; the first one's group takes the rest as tabs.
  let result = repairLayout(next, mode, {catalog, fallback});
  const first = findPanel(result, tabs[0]);
  if (first?.group) {
    for (const id of tabs.slice(1)) result = movePanel(result, id, {kind: 'tab', group: findPanel(result, tabs[0]).group.id}, {mode, catalog});
    result = activatePanel(result, active);
  }
  return result;
}

/** Moves or resizes a float (rect relative to the workspace). */
export function placeFloat(layout, floatId, rect) {
  const float = (layout.floats ?? []).find(item => item.id === floatId);
  const kept = normalizeRect(rect);
  if (!float || !kept || (float.rect.x === kept.x && float.rect.y === kept.y && float.rect.w === kept.w && float.rect.h === kept.h)) return layout;
  const next = copyLayout(layout);
  next.floats.find(item => item.id === floatId).rect = kept;
  // The float moved last is drawn on top.
  next.floats.push(...next.floats.splice(next.floats.findIndex(item => item.id === floatId), 1));
  return next;
}

/**
 * Sets the sizes of a split's children (`sizes[i]`: {size} in px, {flex}
 * a weight, or null for the default). Used by dividers; the solver measures.
 */
export function resizeChildren(layout, path, changes) {
  const split = nodeAt(layout.root, path);
  if (split?.type !== 'split') return layout;
  const next = copyLayout(layout);
  const target = nodeAt(next.root, path);
  let changed = false;
  for (const [index, change] of Object.entries(changes)) {
    const child = target.children[index];
    if (!child || child.type === STAGE) continue;
    const before = JSON.stringify([child.size, child.flex]);
    if (change === null) delete child.size;
    else if (change.size !== undefined) {
      const size = int(change.size, 1, MAX_EXTENT);
      if (size === null) delete child.size; else child.size = size;
    }
    if (change && change.flex !== undefined) {
      if (positive(change.flex)) child.flex = Math.round(change.flex * 1000) / 1000; else delete child.flex;
    }
    if (JSON.stringify([child.size, child.flex]) !== before) changed = true;
  }
  return changed ? simplifyOnly(next) : layout;
}

const simplifyOnly = layout => ({...layout, root: simplify(layout.root, null, true)});

/** Sets the tool bar's side of the stage. */
export const setTools = (layout, side) => (side !== 'left' && side !== 'right') || layout.tools === side ? layout : {...layout, tools: side};

/** Every panel id placed in the tree, the floats and `closed` (unknown ones included). */
export function placedPanels(layout) {
  const ids = [];
  for (const group of groupsOf(layout)) ids.push(...group.tabs);
  for (const item of layout.closed ?? []) ids.push(item.id);
  return ids;
}

/**
 * Checks the invariants; returns a list of problems (empty when the
 * arrangement is valid for the workspace). Tests and the store use it.
 */
export function validateLayout(layout, mode, {catalog = PANEL_CATALOG} = {}) {
  const problems = [];
  if (!isObject(layout) || !isObject(layout.root)) return ['no root'];
  let stages = 0;
  const groupIds = new Set();
  const check = (node, parent, depth) => {
    if (depth > MAX_DEPTH) problems.push('too deep');
    if (node.type === STAGE) stages++;
    else if (node.type === 'group') {
      if (!node.tabs.length) problems.push(`empty group ${node.id}`);
      if (!node.tabs.includes(node.active)) problems.push(`group ${node.id} shows a tab it does not hold`);
      if (groupIds.has(node.id)) problems.push(`group ${node.id} twice`);
      groupIds.add(node.id);
    } else if (node.type === 'split') {
      if (node.children.length < 2) problems.push('a split with one child');
      if (parent && parent.axis === node.axis) problems.push('a split inside a split of its axis');
      if (!node.children.some(child => child.flex !== undefined)) problems.push('a split without a flexible child');
      node.children.forEach(child => check(child, node, depth + 1));
    } else problems.push(`unknown node ${node.type}`);
  };
  check(layout.root, null, 0);
  if (stages !== 1) problems.push(`${stages} stages`);
  for (const float of layout.floats ?? []) {
    if (!float.group?.tabs?.length) problems.push(`empty float ${float.id}`);
    if (groupIds.has(float.group?.id)) problems.push(`group ${float.group?.id} twice`);
    groupIds.add(float.group?.id);
  }
  const placed = placedPanels(layout);
  const counts = new Map();
  for (const id of placed) counts.set(id, (counts.get(id) ?? 0) + 1);
  for (const id of panelsOf(mode, catalog)) if (counts.get(id) !== 1) problems.push(`${id} placed ${counts.get(id) ?? 0} times`);
  for (const [id, count] of counts) if (count > 1 && !problems.some(problem => problem.startsWith(`${id} `))) problems.push(`${id} placed ${count} times`);
  return problems;
}

/** True when two arrangements place and size everything alike (unknown keys aside). */
export function sameLayout(a, b) {
  return Boolean(a && b) && JSON.stringify(shape(a)) === JSON.stringify(shape(b));
}
const shapeNode = node => (node.type === 'split'
  ? [node.axis, node.size ?? null, node.flex ?? null, node.children.map(shapeNode)]
  : node.type === 'group' ? [node.tabs, node.active, Boolean(node.collapsed), node.size ?? null, node.flex ?? null] : STAGE);
const shape = layout => [shapeNode(layout.root), (layout.floats ?? []).map(item => [item.rect, shapeNode(item.group)]), (layout.closed ?? []).map(item => item.id), layout.tools];
