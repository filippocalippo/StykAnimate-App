/**
 * The docking model, workspaces, solver and migration (src/shell/dock-*.mjs):
 * the default layouts land on today's rectangles, no operation or damaged
 * input ever loses or doubles a panel, today's saved layouts migrate, and
 * the stored form stays shallow and round-trips.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {PANEL_CATALOG} from '../src/shell/panel-registry.mjs';
import {
  STAGE, closePanel, dockFloat, findPanel, groupsOf, movePanel, moveGroup, panelsOf, placeFloat, reopenPanel, repairLayout,
  resizeChildren, sameLayout, setCollapsed, validateLayout, walk,
} from '../src/shell/dock-model.mjs';
import {
  MODES, applyPreset, defaultLayout, defaultState, deleteLayout, exportLayout, flattenLayout, importLayout, isModified, readState,
  resetWorkspace, saveLayout, serializeState, setLayout, toggleFocus, unflattenLayout,
} from '../src/shell/dock-workspaces.mjs';
import {dividerChanges, dividerReset, solveDock} from '../src/shell/dock-solve.mjs';
import {arrangementToLayout, importV2} from '../src/shell/dock-migrate.mjs';
import {solveLayout} from '../src/shell/layout-solver.mjs';
import {defaultLayout as v2Default, movePanel as v2Move, normalizeLayout as v2Normalize, serializeLayout as v2Serialize} from '../src/shell/layout-schema.mjs';
import {paintedMetrics} from '../src/shell/dock-host.mjs';

const metrics = paintedMetrics({ruler: 32, pinnedRow: 32, row: 32});
const rect = box => (box ? [box.x, box.y, box.width, box.height].map(Math.round).join(',') : null);

/** A small seeded generator (mulberry32), so a failing sequence repeats. */
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('each workspace\'s default layout lands on today\'s rectangles in every window and touch profile', () => {
  let cases = 0;
  const profiles = [null, ...['phone', 'tablet'].flatMap(form => ['portrait', 'landscape'].map(orient => ({active: true, form, orient})))];
  for (const touch of profiles) {
    for (const mode of MODES) {
      for (let width = 360; width <= 2600; width += 89) {
        for (let height = 340; height <= 1500; height += 97) {
          const env = {width, height, mode, metrics, measured: touch ? {band: 0, stageHead: 40} : {stageHead: height >= 801 ? 44 : 40}, touch};
          const today = solveLayout(v2Default(), env), now = solveDock(defaultLayout(mode), env);
          const where = `${touch?.form ?? 'desktop'} ${touch?.orient ?? ''} ${mode} ${width}x${height}`;
          const timeline = now.groups.find(group => group.tabs.includes('timeline'));
          const inspector = now.groups.find(group => group.tabs.includes('properties'));
          assert.equal(rect(now.stage), rect(today.stage), `stage ${where}`);
          assert.equal(rect(timeline?.rect), rect(today.regions.bottom.rect), `timeline ${where}`);
          assert.equal(inspector?.state === 'docked' ? rect(inspector.rect) : inspector?.state ?? 'sheet',
            today.regions.right.state === 'docked' ? rect(today.regions.right.rect) : today.regions.right.state, `inspector ${where}`);
          assert.equal(rect(now.rail.rect), rect(today.rail.rect), `rail ${where}`);
          assert.deepEqual(now.timelineRows, today.timelineRows, `timeline rows ${where}`);
          assert.deepEqual(now.stageInsets, today.stageInsets, `insets ${where}`);
          cases++;
        }
      }
    }
  }
  assert.ok(cases > 4000);
});

test('defaults are valid and Build keeps Structure collapsed on the left with the timeline closed', () => {
  for (const mode of MODES) assert.deepEqual(validateLayout(defaultLayout(mode), mode), [], mode);
  const build = defaultLayout('rig');
  assert.equal(findPanel(build, 'structure').group.collapsed, true);
  assert.equal(findPanel(build, 'timeline').where, 'closed');
  const solved = solveDock(build, {width: 1440, height: 900, mode: 'rig', metrics});
  const structure = solved.groups.find(group => group.tabs.includes('structure'));
  assert.equal(structure.state, 'strip');
  assert.equal(structure.side, 'left');
});

/** One random operation on a state; returns the next state. */
function step(state, mode, next) {
  const layout = state.workspaces[mode].layout;
  const panels = panelsOf(mode);
  const pick = list => list[Math.floor(next() * list.length)];
  const groups = groupsOf(layout);
  if (!groups.length) return setLayout(state, mode, reopenPanel(layout, pick(panels), {mode, fallback: defaultLayout(mode)}));
  const sides = ['left', 'right', 'top', 'bottom'];
  const zone = () => {
    const kind = pick(['tab', 'split', 'split', 'edge', 'float']);
    if (kind === 'tab') return {kind, group: pick(groups).id, index: Math.floor(next() * 4)};
    if (kind === 'split') return {kind, target: next() < 0.3 ? STAGE : pick(groups).id, side: pick(sides)};
    if (kind === 'edge') return {kind, side: pick(sides)};
    return {kind, rect: {x: Math.floor(next() * 1200) - 100, y: Math.floor(next() * 800) - 50, w: 200 + Math.floor(next() * 400), h: 120 + Math.floor(next() * 400)}};
  };
  const options = {mode, fallback: defaultLayout(mode)};
  const op = Math.floor(next() * 12);
  let result = layout;
  switch (op) {
    case 0: case 1: case 2: result = movePanel(layout, pick(panels), zone(), options); break;
    case 3: result = moveGroup(layout, pick(groups).id, zone(), options); break;
    case 4: result = closePanel(layout, pick(panels), options); break;
    case 5: result = reopenPanel(layout, pick(panels), options); break;
    case 6: result = setCollapsed(layout, pick(groups).id, next() < 0.5); break;
    case 7: if (layout.floats.length) result = dockFloat(layout, pick(layout.floats).id, options); break;
    case 8: if (layout.floats.length) result = placeFloat(layout, pick(layout.floats).id, {x: 10, y: 20, w: 300, h: 300}); break;
    case 9: {
      const splits = [];
      walk(layout.root, node => { if (node.type === 'split') splits.push(node); });
      if (splits.length) {
        const split = pick(splits);
        const path = [];
        const search = (node, at) => { if (node === split) { path.push(...at); return true; } return node.type === 'split' && node.children.some((child, i) => search(child, [...at, i])); };
        search(layout.root, []);
        result = resizeChildren(layout, path, {[Math.floor(next() * split.children.length)]: next() < 0.2 ? null : next() < 0.5 ? {size: Math.floor(next() * 900)} : {flex: next() * 3}});
      }
      break;
    }
    case 10: return toggleFocus(state, mode);
    default: return applyPreset(state, mode, pick(['animate', 'timing', 'review', 'draw', 'build', 'build-timeline']), {workspaceHeight: 800});
  }
  return setLayout(state, mode, result);
}

test('no sequence of operations loses or doubles a panel, and every arrangement solves inside the window', () => {
  let operations = 0;
  for (let seed = 1; seed <= 120; seed++) {
    const next = random(seed);
    let state = defaultState();
    for (let i = 0; i < 60; i++) {
      const mode = MODES[Math.floor(next() * MODES.length)];
      state = step(state, mode, next);
      operations++;
      const layout = state.workspaces[mode].layout;
      assert.deepEqual(validateLayout(layout, mode), [], `seed ${seed} step ${i}: ${JSON.stringify(layout)}`);
      const solved = solveDock(layout, {width: 1440, height: 900, mode, metrics});
      for (const group of solved.groups) {
        assert.ok(group.rect.x >= 0 && group.rect.y >= 0 && group.rect.x + group.rect.width <= 1440.5 && group.rect.y + group.rect.height <= 900.5,
          `seed ${seed} step ${i}: ${group.id} at ${rect(group.rect)} leaves the window`);
      }
      for (const float of solved.floats) assert.ok(float.rect.x + float.rect.width >= 80 && float.rect.x <= 1440 - 80 && float.rect.y >= 52, `float on screen: ${rect(float.rect)}`);
      // Every panel of the workspace is reachable: on screen, folded, in the sheet or closed (View › Panels reopens it).
      for (const id of panelsOf(mode)) assert.notEqual(solved.panels[id].presentation, 'unavailable', `${id} reachable (seed ${seed})`);
    }
    // The stored form reads back as the same arrangements.
    const back = readState(JSON.parse(JSON.stringify(serializeState(state))));
    for (const mode of MODES) assert.ok(sameLayout(back.workspaces[mode].layout, state.workspaces[mode].layout), `round trip seed ${seed} ${mode}`);
  }
  assert.ok(operations >= 7000);
});

test('damaged or foreign arrangements are repaired without losing a panel; unknown panels stay as data', () => {
  const inputs = [
    null, 42, 'text', {}, {root: null}, {root: {type: 'group', tabs: []}},
    {root: {type: 'split', axis: 'diagonal', children: [{type: 'group', id: 'g1', tabs: ['properties', 'properties', 'vfx']}]}},
    {root: {type: 'split', axis: 'row', children: [{type: STAGE}, {type: STAGE}, {type: 'group', id: 'g1', tabs: ['timeline']}, {type: 'group', id: 'g1', tabs: ['library']}]}},
    {root: {type: 'group', id: 'g1', tabs: ['notes', 'properties']}, floats: [{id: 'f1', rect: {x: 'a'}, group: {type: 'group', tabs: ['vfx']}}], closed: ['library', {id: 'library'}, {id: 'timeline'}]},
    {root: {type: 'split', axis: 'row', children: [{type: STAGE}, {type: 'group', id: 'g9', tabs: ['future-panel'], active: 'future-panel'}]}, extra: {kept: true}},
  ];
  for (const input of inputs) {
    for (const mode of MODES) {
      const layout = repairLayout(input, mode, {fallback: defaultLayout(mode)});
      assert.deepEqual(validateLayout(layout, mode), [], `${JSON.stringify(input)} in ${mode}`);
      solveDock(layout, {width: 1200, height: 800, mode, metrics});
    }
  }
  const future = repairLayout(inputs.at(-1), 'animate', {fallback: defaultLayout('animate')});
  assert.ok(groupsOf(future).some(group => group.tabs.includes('future-panel')), 'a panel this version does not know is kept');
  assert.deepEqual(future.extra, {kept: true}, 'unknown keys survive');
  // A deep tree is still valid and stores flat.
  let root = {type: STAGE};
  for (let i = 0; i < 20; i++) root = {type: 'split', axis: i % 2 ? 'row' : 'column', children: [root, {type: 'group', id: `g${i + 1}`, tabs: [], active: null}]};
  const deep = repairLayout({root}, 'animate', {fallback: defaultLayout('animate')});
  assert.deepEqual(validateLayout(deep, 'animate'), []);
  const depth = value => (value && typeof value === 'object' ? 1 + Math.max(0, ...Object.values(value).map(depth)) : 0);
  assert.ok(depth(flattenLayout(deep)) <= 5, 'the stored form is shallow');
  assert.ok(sameLayout(repairLayout(unflattenLayout(flattenLayout(deep)), 'animate'), deep));
});

test('moves preview what they do: a panel beside the stage, as a tab, split, at an edge and floating', () => {
  const mode = 'animate', options = {mode};
  const base = defaultLayout(mode);
  const left = movePanel(base, 'vfx', {kind: 'split', target: STAGE, side: 'left'}, options);
  let solved = solveDock(left, {width: 1440, height: 900, mode, metrics});
  const vfx = solved.groups.find(group => group.tabs.includes('vfx'));
  assert.equal(vfx.side, 'left');
  assert.equal(Math.round(vfx.rect.width), 320, 'a panel docked beside the stage takes its preferred width');
  assert.equal(Math.round(solved.groups.find(group => group.tabs.includes('properties')).rect.width), 320, 'its old group keeps its width');
  const split = movePanel(base, 'library', {kind: 'split', target: findPanel(base, 'properties').group.id, side: 'bottom'}, options);
  solved = solveDock(split, {width: 1440, height: 900, mode, metrics});
  const [top, bottom] = ['properties', 'library'].map(id => solved.groups.find(group => group.tabs.includes(id)).rect);
  assert.equal(top.x, bottom.x);
  assert.ok(Math.abs(top.height - bottom.height) <= 1, 'a split shares its group\'s place equally');
  const tab = movePanel(split, 'library', {kind: 'tab', group: findPanel(split, 'properties').group.id, index: 0}, options);
  assert.deepEqual(findPanel(tab, 'properties').group.tabs, ['library', 'properties', 'vfx']);
  const edge = movePanel(base, 'library', {kind: 'edge', side: 'left'}, options);
  assert.equal(edge.root.type, 'split');
  assert.equal(edge.root.axis, 'row');
  assert.ok(edge.root.children[0].tabs?.includes('library'), 'an edge dock runs across the window');
  const floated = movePanel(base, 'vfx', {kind: 'float', rect: {x: 100, y: 100, w: 300, h: 400}}, options);
  assert.equal(findPanel(floated, 'vfx').where, 'float');
  const back = dockFloat(floated, floated.floats[0].id, {mode, fallback: base});
  assert.deepEqual(findPanel(back, 'vfx').group.tabs, ['properties', 'vfx', 'library'], 'a float docks back where it came from');
  // A lone tab dropped on itself changes nothing.
  const alone = findPanel(left, 'vfx').group.id;
  assert.equal(movePanel(left, 'vfx', {kind: 'split', target: alone, side: 'top'}, options), left);
});

test('closed panels come back where they were, and Reset always restores the workspace\'s layout', () => {
  const mode = 'animate', options = {mode, fallback: defaultLayout(mode)};
  const closed = closePanel(defaultLayout(mode), 'vfx', options);
  assert.equal(findPanel(closed, 'vfx').where, 'closed');
  const open = reopenPanel(closed, 'vfx', options);
  assert.deepEqual(findPanel(open, 'vfx').group.tabs, ['properties', 'vfx', 'library']);
  let state = defaultState();
  state = setLayout(state, mode, closePanel(closePanel(closePanel(state.workspaces[mode].layout, 'properties', options), 'vfx', options), 'library', options));
  assert.equal(isModified(state, mode), true);
  state = resetWorkspace(state, mode);
  assert.ok(sameLayout(state.workspaces[mode].layout, defaultLayout(mode)));
  assert.equal(isModified(state, mode), false);
});

test('Focus collapses everything and restores the arrangement exactly', () => {
  let state = applyPreset(defaultState(), 'animate', 'timing', {workspaceHeight: 800});
  const before = state.workspaces.animate.layout;
  assert.equal(groupsOf(before).find(group => group.tabs.includes('timeline')).size, 320, 'Timing stores 40% of the workspace');
  state = toggleFocus(state, 'animate');
  assert.ok(groupsOf(state.workspaces.animate.layout).every(group => group.collapsed));
  state = toggleFocus(state, 'animate');
  assert.equal(state.workspaces.animate.layout, before);
});

test('saved layouts: named, applied, exported and imported; a newer file is refused', () => {
  let state = defaultState();
  state = setLayout(state, 'animate', movePanel(state.workspaces.animate.layout, 'vfx', {kind: 'split', target: STAGE, side: 'left'}, {mode: 'animate'}));
  const saved = saveLayout(state, {name: '  My‮ layout  ', mode: 'animate', now: 1000});
  assert.equal(saved.state.saved[0].name, 'My layout');
  state = saved.state;
  assert.equal(state.workspaces.animate.preset, `user:${saved.id}`);
  const file = JSON.parse(JSON.stringify(exportLayout(state, 'animate')));
  state = resetWorkspace(applyPreset(state, 'animate', 'animate'), 'animate');
  const imported = importLayout(state, file, {mode: 'animate', name: 'Copy', now: 2000});
  assert.ok(sameLayout(imported.state.workspaces.animate.layout, saved.state.workspaces.animate.layout));
  assert.equal(importLayout(state, {...file, stykLayout: 99}, {mode: 'animate'}).error, 'newer');
  assert.equal(importLayout(state, {nope: true}, {mode: 'animate'}).error, 'invalid');
  const removed = deleteLayout(imported.state, imported.id, {now: 3000});
  assert.equal(removed.saved.length, 1);
  assert.equal(removed.tombstones[0].id, imported.id);
});

test('today\'s stored layouts migrate: presets, sizes, sides, strips, floats, hidden panels and saved layouts', () => {
  // The default v2 file: every workspace equals its preset.
  const plain = importV2({studioVersion: 1, layoutVersion: 2, shared: {stamp: 1, sizes: {}}, modes: {animate: {stamp: 1, preset: 'animate'}}});
  for (const mode of MODES) assert.ok(sameLayout(plain.state.workspaces[mode].layout, defaultLayout(mode)), mode);
  assert.equal(isModified(plain.state, 'animate'), false);
  // v1 sizes become each workspace's sizes.
  const v1 = importV2({studioVersion: 1, right: 300, timeline: 240});
  assert.equal(v1.source, 'v1');
  const animate = v1.state.workspaces.animate.layout;
  assert.equal(findPanel(animate, 'properties').group.size, 300);
  assert.equal(findPanel(animate, 'timeline').group.size, 240);
  // A rearranged v2 workspace: VFX docked left, Library floating, the timeline folded, the rail right.
  let v2 = v2Default();
  let arrangement = v2.modes.animate;
  arrangement = v2Move(arrangement, 'vfx', 'left', {mode: 'animate'});
  arrangement = v2Move(arrangement, 'library', 'float', {mode: 'animate', rect: {x: 40, y: 60, w: 300, h: 400}});
  arrangement = v2Move(arrangement, 'timeline', 'strip', {mode: 'animate'});
  arrangement = {...arrangement, rail: 'right'};
  v2 = v2Normalize({...v2, shared: {stamp: 3, sizes: {left: 280, right: 340}}, modes: {...v2.modes, animate: {...v2.modes.animate, ...arrangement, preset: 'animate'}},
    saved: [{id: 'uabc', name: 'Fight setup', mode: 'animate', stamp: 5, arrangement}]});
  // As stored: serialized with today's v1 mirror (right, timeline), which the migration reconciles.
  const {state} = importV2(v2Serialize(v2));
  const layout = state.workspaces.animate.layout;
  assert.deepEqual(validateLayout(layout, 'animate'), []);
  const solved = solveDock(layout, {width: 1440, height: 900, mode: 'animate', metrics});
  const where = id => solved.groups.find(group => group.tabs.includes(id));
  assert.equal(where('vfx').side, 'left');
  assert.equal(Math.round(where('vfx').rect.width), 280, 'the left width migrates');
  assert.equal(Math.round(where('properties').rect.width), 340, 'the right width migrates');
  assert.equal(solved.panels.library.presentation, 'float');
  assert.equal(where('timeline').state, 'header', 'a folded timeline stays its header');
  assert.equal(layout.tools, 'right');
  assert.equal(state.saved.length, 1);
  assert.equal(state.saved[0].name, 'Fight setup');
  assert.deepEqual(validateLayout(state.saved[0].layout, 'animate'), []);
  // Build: Structure keeps its strip; hidden panels are closed, never lost.
  const build = arrangementToLayout({panels: [{id: 'structure', dock: 'left', side: 'left'}, {id: 'properties', dock: 'hidden', side: 'right'}]}, {structure: 300}, 'rig');
  assert.deepEqual(validateLayout(build, 'rig'), []);
  assert.equal(findPanel(build, 'structure').group.size, 300);
  assert.equal(findPanel(build, 'properties').where, 'closed');
  // A newer v2 file and garbage give the defaults.
  for (const raw of [{layoutVersion: 9}, 'garbage', null]) {
    const result = importV2(raw);
    for (const mode of MODES) assert.ok(sameLayout(result.state.workspaces[mode].layout, defaultLayout(mode)));
  }
});

test('dividers: a fixed side takes the size, two flexible sides share by weight, reset returns the default', () => {
  const fixed = {a: 0, b: 1, control: 'b', kinds: ['flex', 'fixed'], extents: [1000, 320], min: 256, max: 420};
  assert.deepEqual(dividerChanges(fixed, 380), {1: {size: 380}});
  assert.deepEqual(dividerChanges(fixed, 999), {1: {size: 420}}, 'clamped to the panel\'s maximum');
  assert.deepEqual(dividerReset(fixed), {1: null});
  const flexible = {a: 0, b: 1, control: 'a', kinds: ['flex', 'flex'], extents: [300, 300], min: 160, max: 440};
  const changes = dividerChanges(flexible, 400);
  assert.ok(Math.abs(changes[0].flex / changes[1].flex - 2) < 0.01);
  assert.deepEqual(dividerReset(flexible), {0: {flex: 1}, 1: {flex: 1}});
  // Solved: dragging the inspector's divider keeps the stage at its minimum.
  const solved = solveDock(defaultLayout('animate'), {width: 1440, height: 900, mode: 'animate', metrics});
  const divider = solved.dividers.find(item => item.axis === 'row');
  assert.equal(divider.now, 320);
  assert.equal(divider.min, 256);
  assert.equal(divider.max, 420);
});

test('small windows fold without changing the arrangement', () => {
  const layout = movePanel(defaultLayout('animate'), 'vfx', {kind: 'split', target: STAGE, side: 'left'}, {mode: 'animate'});
  const stored = JSON.stringify(layout);
  const compact = solveDock(layout, {width: 720, height: 800, mode: 'animate', metrics});
  assert.equal(compact.groups.find(group => group.tabs.includes('vfx')).state, 'strip', 'left folds to a strip');
  assert.deepEqual(compact.sheet, ['properties', 'library'], 'right folds to the sheet');
  assert.ok(compact.stage.width >= 360);
  const low = solveDock(layout, {width: 1440, height: 560, mode: 'animate', metrics});
  assert.equal(low.groups.find(group => group.tabs.includes('timeline')).state, 'header');
  assert.equal(JSON.stringify(layout), stored, 'solving never writes the arrangement');
  // Floats fold to the sheet in compact windows and come back.
  const floated = movePanel(layout, 'library', {kind: 'float', rect: {x: 900, y: 100, w: 300, h: 400}}, {mode: 'animate'});
  assert.ok(solveDock(floated, {width: 720, height: 800, mode: 'animate', metrics}).sheet.includes('library'));
  assert.equal(solveDock(floated, {width: 1440, height: 900, mode: 'animate', metrics}).panels.library.presentation, 'float');
  // A float stored off screen comes back on screen.
  const away = placeFloat(floated, floated.floats[0].id, {x: 5000, y: 5000, w: 300, h: 300});
  const fit = solveDock(away, {width: 1280, height: 720, mode: 'animate', metrics}).floats[0].rect;
  assert.ok(fit.x <= 1280 - 80 && fit.y <= 720 - 40);
});

test('a panel the default keeps closed opens when asked, and a float docks back beside its old neighbour', () => {
  const build = defaultLayout('rig');
  assert.equal(findPanel(build, 'timeline').where, 'closed');
  const open = reopenPanel(build, 'timeline', {mode: 'rig', fallback: build});
  assert.equal(findPanel(open, 'timeline').where, 'tree', 'Build\'s timeline opens');
  // VFX alone at the left of the stage, collapsed, then floated: its group is gone, yet it returns beside the stage, collapsed.
  const mode = 'animate', options = {mode, fallback: defaultLayout(mode)};
  let layout = movePanel(defaultLayout(mode), 'vfx', {kind: 'split', target: STAGE, side: 'left'}, options);
  layout = setCollapsed(layout, findPanel(layout, 'vfx').group.id, true);
  layout = movePanel(layout, 'vfx', {kind: 'float', rect: {x: 300, y: 100, w: 300, h: 300}}, options);
  const back = dockFloat(layout, layout.floats[0].id, options);
  const solved = solveDock(back, {width: 1440, height: 900, mode, metrics});
  const group = solved.groups.find(item => item.tabs.includes('vfx'));
  assert.deepEqual([group.side, group.state], ['left', 'strip']);
});
