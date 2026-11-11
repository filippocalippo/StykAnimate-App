/**
 * Docking persistence (src/shell/dock-store.mjs): nothing is written on load,
 * today's layouts are imported once, other preferences survive, a newer
 * state is read-only, a damaged one falls back without losing a panel, two
 * windows keep each other's saved layouts, and the file stays under its limit.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createDockStore, desktopDockBackend, fitPreferences, storageDockBackend, BROWSER_DOCK_KEY, FILE_LIMIT_BYTES} from '../src/shell/dock-store.mjs';
import {MODES, defaultLayout, saveLayout, setLayout, stateBytes} from '../src/shell/dock-workspaces.mjs';
import {STAGE, closePanel, findPanel, movePanel, validateLayout} from '../src/shell/dock-model.mjs';
import {defaultLayout as v2Default, movePanel as v2Move, serializeLayout as v2Serialize} from '../src/shell/layout-schema.mjs';

function fakeDesktop(initial) {
  let value = initial === undefined ? null : JSON.parse(JSON.stringify(initial));
  const writes = [];
  return {
    writes,
    get value() { return value; },
    async getWorkspacePreferences() { return value === null ? {} : JSON.parse(JSON.stringify(value)); },
    async setWorkspacePreferences(next) {
      const text = JSON.stringify(next);
      if (Buffer.byteLength(text) > FILE_LIMIT_BYTES) throw new Error('too large');
      writes.push(JSON.parse(text));
      value = JSON.parse(text);
    },
  };
}
const timers = () => {
  const queue = [];
  return {setTimer: (run) => { queue.push(run); return queue.length; }, clearTimer: () => {}, run: () => { for (const run of queue.splice(0)) run(); }};
};
const store = (desktop, extra = {}) => {
  const clock = timers();
  let now = 1_000_000;
  const instance = createDockStore({...desktopDockBackend(desktop), setTimer: clock.setTimer, clearTimer: clock.clearTimer, now: () => (now += 10), ...extra});
  return {instance, clock};
};

test('loading imports today\'s layout and writes nothing; the first change writes the dock key and keeps the rest', async () => {
  let v2 = v2Default();
  v2 = {...v2, modes: {...v2.modes, animate: {...v2.modes.animate, ...v2Move(v2.modes.animate, 'vfx', 'left', {mode: 'animate'})}}};
  const stored = {...v2Serialize(v2), somethingElse: {kept: 1}};
  const desktop = fakeDesktop(stored);
  const {instance, clock} = store(desktop);
  const state = await instance.load();
  assert.equal(instance.source, 'import-v2');
  assert.equal(desktop.writes.length, 0, 'loading writes nothing');
  const vfx = findPanel(state.workspaces.animate.layout, 'vfx');
  assert.ok(vfx.group && !vfx.group.tabs.includes('properties'), 'VFX keeps its own place');
  instance.update(current => setLayout(current, 'animate', closePanel(current.workspaces.animate.layout, 'library', {mode: 'animate'})));
  clock.run();
  await instance.flush();
  assert.equal(desktop.writes.length, 1);
  const written = desktop.writes[0];
  assert.equal(written.dock.version, 3);
  assert.deepEqual(written.somethingElse, {kept: 1}, 'other preferences survive');
  assert.equal(written.layoutVersion, 2, 'today\'s layout stays for an older version');
  // A second window reads the dock key, not the v2 data.
  const again = store(desktop).instance;
  await again.load();
  assert.equal(again.source, 'dock');
  assert.equal(findPanel(again.state.workspaces.animate.layout, 'library').where, 'closed');
});

test('a newer state is read-only: defaults show and nothing is written', async () => {
  const desktop = fakeDesktop({dock: {version: 9, workspaces: {animate: {layout: {nodes: []}}}}});
  const {instance, clock} = store(desktop);
  await instance.load();
  assert.equal(instance.readOnly, true);
  for (const mode of MODES) assert.deepEqual(validateLayout(instance.state.workspaces[mode].layout, mode), []);
  instance.update(current => setLayout(current, 'animate', closePanel(current.workspaces.animate.layout, 'vfx', {mode: 'animate'})));
  clock.run();
  await instance.flush();
  assert.equal(desktop.writes.length, 0);
  assert.equal(desktop.value.dock.version, 9);
});

test('a damaged state falls back without losing a panel', async () => {
  for (const dock of [{version: 3, workspaces: 'x'}, {version: 3, workspaces: {animate: {layout: {nodes: [{t: 'g', p: -1, tabs: ['vfx', 'vfx']}]}}}}, 'garbage', {version: 'x'}]) {
    const desktop = fakeDesktop({dock});
    const {instance} = store(desktop);
    await instance.load();
    for (const mode of MODES) assert.deepEqual(validateLayout(instance.state.workspaces[mode].layout, mode), [], JSON.stringify(dock));
    assert.equal(desktop.writes.length, 0);
  }
});

test('a change that would lose a panel is refused and reported', async () => {
  const errors = [];
  const desktop = fakeDesktop(null);
  const {instance} = store(desktop, {onError: error => errors.push(error)});
  await instance.load();
  const before = instance.state;
  const broken = {...before.workspaces.animate.layout, closed: [], root: {type: STAGE, flex: 1}};
  instance.update(current => setLayout(current, 'animate', broken));
  assert.equal(instance.state, before);
  assert.equal(errors.length, 1);
});

test('two windows keep each other\'s saved layouts', async () => {
  const desktop = fakeDesktop(null);
  const a = store(desktop), b = store(desktop);
  await a.instance.load();
  await b.instance.load();
  a.instance.update(current => saveLayout(current, {name: 'From A', mode: 'animate', now: 10}).state);
  a.clock.run(); await a.instance.flush();
  b.instance.update(current => saveLayout(current, {name: 'From B', mode: 'draw', now: 20}).state);
  b.clock.run(); await b.instance.flush();
  assert.deepEqual(desktop.value.dock.saved.map(item => item.name).sort(), ['From A', 'From B']);
  assert.deepEqual(b.instance.state.saved.map(item => item.name).sort(), ['From A', 'From B']);
});

test('the preferences stay under the file limit: today\'s layout goes first, then Focus snapshots, then the oldest saved layouts', () => {
  const big = {layoutVersion: 2, modes: {animate: {padding: 'x'.repeat(9000)}}, other: 1, dock: {version: 3, workspaces: {animate: {focus: {nodes: [], pad: 'y'.repeat(4000)}}}, saved: [{id: 'u1', stamp: 1, pad: 'z'.repeat(5000)}, {id: 'u2', stamp: 2}]}};
  const fitted = fitPreferences(big, {budget: 4000});
  assert.equal(fitted.value.layoutVersion, undefined);
  assert.equal(fitted.value.other, 1);
  assert.deepEqual(fitted.trimmed, ['v2', 'focus', 'saved:u1']);
  assert.ok(stateBytes(fitted.value) <= 4000);
});

test('the browser keeps its own key and reads today\'s once', async () => {
  const items = new Map([['stykanimate.workspace-layout.v2', JSON.stringify(v2Serialize(v2Default()))]]);
  const storage = {getItem: key => items.get(key) ?? null, setItem: (key, value) => items.set(key, value)};
  const clock = timers();
  const instance = createDockStore({...storageDockBackend(storage), setTimer: clock.setTimer, clearTimer: clock.clearTimer});
  await instance.load();
  assert.equal(instance.source, 'import-v2');
  assert.ok(!items.has(BROWSER_DOCK_KEY));
  instance.update(current => setLayout(current, 'animate', movePanel(current.workspaces.animate.layout, 'vfx', {kind: 'split', target: STAGE, side: 'left'}, {mode: 'animate'})));
  clock.run();
  await instance.flush();
  assert.equal(JSON.parse(items.get(BROWSER_DOCK_KEY)).version, 3);
  assert.ok(items.has('stykanimate.workspace-layout.v2'), 'today\'s key is left as it is');
  for (const mode of MODES) assert.ok(validateLayout(defaultLayout(mode), mode).length === 0);
});
