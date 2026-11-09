/**
 * Today's stored layouts (schema v2 in layout-schema.mjs, and the v1 and
 * earlier blobs it reads) as docking arrangements (dock-model.mjs), once,
 * when no docking state is stored yet. Pure; nothing here writes.
 *
 * Each workspace's arrangement becomes a tree as close to what it showed as
 * the new model allows: a side's islands become groups (two islands stack in
 * a column that keeps their shares), its strip a collapsed group at the outer
 * edge, the timeline a group under everything or under the stage, floating
 * panels floats, hidden panels closed ones and the rail the tool bar's side.
 * The shared sizes (one inspector width, one timeline height) are copied into
 * every workspace and saved layout, where they now belong to each. A record
 * that cannot be placed leaves its panel to repairLayout, which puts it home:
 * no panel is lost.
 */
import {PANEL_CATALOG} from './panel-registry.mjs';
import {migrateLayout} from './layout-schema.mjs';
import {STAGE, repairLayout} from './dock-model.mjs';
import {DEFAULT_PRESETS, MAX_SAVED_LAYOUTS, MODES, PRESETS, cleanLayoutName, defaultLayout, presetLayout, readState} from './dock-workspaces.mjs';

/** Where v2 floating rects started: the stage island's corner in the default window (8px of field, then the left column). */
const STAGE_ORIGIN = Object.freeze({x: 8, y: 8});

const byOrder = (a, b) => (a.order ?? 0) - (b.order ?? 0);

function groupsOfSide(records, side, ids) {
  const docked = records.filter(record => record.dock === side).sort(byOrder);
  const islands = [];
  for (const record of docked) (islands[record.group ?? 0] ??= []).push(record);
  return islands.filter(Boolean).map(members => {
    const tabs = members.map(record => record.id);
    const active = (members.find(record => record.active) ?? members[0]).id;
    return {type: 'group', id: ids(), tabs, active};
  });
}

/**
 * One v2 arrangement (`{rail, bottomSpan, panels, weights}`) with the shared
 * `sizes` as a docking layout for `mode`, repaired.
 */
export function arrangementToLayout(arrangement, sizes, mode, {catalog = PANEL_CATALOG} = {}) {
  const known = new Set(catalog.map(panel => panel.id));
  const records = (arrangement?.panels ?? []).filter(record => record && known.has(record.id) && typeof record.dock === 'string');
  let n = 0;
  const ids = () => `g${++n}`;
  const column = side => {
    const groups = groupsOfSide(records, side, ids);
    const strip = records.filter(record => record.dock === 'strip' && record.side === side).sort(byOrder);
    const weights = arrangement?.weights?.[side];
    let docked = null;
    if (groups.length === 1) docked = groups[0];
    else if (groups.length > 1) {
      docked = {type: 'split', axis: 'column', children: groups.map((group, index) => ({...group, flex: Math.max(0.05, weights?.[index] ?? 1 / groups.length)}))};
    }
    if (docked) {
      const owner = docked.type === 'group' ? docked.tabs : docked.children.flatMap(group => group.tabs);
      const size = owner.includes('structure') ? sizes.structure : sizes[side];
      if (Number.isFinite(size)) docked.size = size;
    }
    const folded = strip.length ? {type: 'group', id: ids(), tabs: strip.map(record => record.id), active: strip[0].id, collapsed: true} : null;
    return {docked, folded};
  };
  const left = column('left'), right = column('right');
  const timeline = records.find(record => record.id === 'timeline');
  let bottom = null;
  if (timeline?.dock === 'bottom' || timeline?.dock === 'strip') {
    bottom = {type: 'group', id: ids(), tabs: ['timeline'], active: 'timeline'};
    if (timeline.dock === 'strip') bottom.collapsed = true;
    else if (Number.isFinite(sizes.bottom)) bottom.size = sizes.bottom;
  }
  const stage = {type: STAGE, flex: 1};
  const row = middle => [left.folded, left.docked, middle, right.docked, right.folded].filter(Boolean);
  let root;
  if (bottom && arrangement?.bottomSpan === 'stage') {
    root = {type: 'split', axis: 'row', children: row({type: 'split', axis: 'column', flex: 1, children: [stage, bottom]})};
  } else {
    const across = row(stage);
    const top = across.length > 1 ? {type: 'split', axis: 'row', flex: 1, children: across} : stage;
    root = bottom ? {type: 'split', axis: 'column', children: [top, bottom]} : top;
  }
  const leftWidth = left.docked ? (left.docked.size ?? 232) + 8 : left.folded ? 48 : 0;
  const floats = records.filter(record => record.dock === 'float').map((record, index) => ({
    id: `f${index + 1}`,
    rect: record.rect ? {x: record.rect.x + STAGE_ORIGIN.x + leftWidth, y: record.rect.y + STAGE_ORIGIN.y, w: record.rect.w, h: record.rect.h}
      : {x: 400 + index * 24, y: 120 + index * 24, w: 288, h: 520},
    group: {type: 'group', id: ids(), tabs: [record.id], active: record.id},
  }));
  const closed = records.filter(record => record.dock === 'hidden').map(record => ({id: record.id}));
  return repairLayout({root, floats, closed, tools: arrangement?.rail === 'right' ? 'right' : 'left'}, mode,
    {catalog, fallback: defaultLayout(mode, {catalog})});
}

const V2_PRESETS = new Set(PRESETS.map(preset => preset.id));

/**
 * The docking state from today's stored value (`raw`: the preferences object
 * or the browser's v2 key), with `legacy` editor settings as migrateLayout
 * reads them. Returns `{state, source}`; `source` is migrateLayout's (v2, v1,
 * legacy, empty, invalid, future). A newer v2 file yields the defaults.
 */
export function importV2(raw, {catalog = PANEL_CATALOG, now = Date.now(), legacy} = {}) {
  const {layout: v2, source} = migrateLayout(raw, {now, legacy});
  if (source === 'future' || source === 'empty' || source === 'invalid') return {state: readState(null, {catalog, now}), source};
  const sizes = v2.shared?.sizes ?? {};
  const workspaces = {};
  const saved = [];
  for (const item of v2.saved ?? []) {
    if (saved.length >= MAX_SAVED_LAYOUTS) break;
    const name = cleanLayoutName(item.name);
    if (!name) continue;
    saved.push({id: item.id, name, mode: item.mode, stamp: item.stamp ?? 0, layout: arrangementToLayout(item.arrangement, sizes, item.mode, {catalog})});
  }
  for (const mode of MODES) {
    const entry = v2.modes?.[mode];
    if (!entry) continue;
    const layout = arrangementToLayout(entry, sizes, mode, {catalog});
    const focus = entry.focus ? arrangementToLayout(entry.focus, sizes, mode, {catalog}) : null;
    let preset = typeof entry.preset === 'string' ? entry.preset : DEFAULT_PRESETS[mode];
    if (!preset.startsWith('user:') && !V2_PRESETS.has(preset)) preset = DEFAULT_PRESETS[mode];
    if (preset.startsWith('user:') && !saved.some(item => `user:${item.id}` === preset)) preset = DEFAULT_PRESETS[mode];
    if (!preset.startsWith('user:') && !presetLayout(preset, mode, {catalog})) preset = DEFAULT_PRESETS[mode];
    workspaces[mode] = {stamp: entry.stamp ?? 0, preset, layout, focus};
  }
  const state = readState({version: 3, workspaces, saved, tombstones: v2.tombstones ?? []}, {catalog, now});
  // readState reads stored (flat or tree) layouts; the converted trees are already repaired.
  for (const mode of MODES) {
    if (workspaces[mode]) state.workspaces[mode] = {...state.workspaces[mode], layout: workspaces[mode].layout, focus: workspaces[mode].focus};
  }
  return {state, source};
}
