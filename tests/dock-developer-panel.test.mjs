// The developer tools' dock panel (docs/DEVTOOLS.md "Panels"): only the developer build defines it, and what a
// developer build stores opens cleanly in the shipping build: no error, no lost or doubled panel, and the developer
// panel's slot kept as data that takes no room and draws nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import {PANEL_CATALOG, normalizePanelDescriptor} from '../src/shell/panel-registry.mjs';
import {groupsOf, placedPanels, reopenPanel, repairLayout, validateLayout} from '../src/shell/dock-model.mjs';
import {MODES, defaultLayout, defaultState, readState, saveLayout, serializeState, setLayout} from '../src/shell/dock-workspaces.mjs';
import {solveDock} from '../src/shell/dock-solve.mjs';
import {paintedMetrics} from '../src/shell/dock-host.mjs';

const metrics = paintedMetrics({ruler: 32, pinnedRow: 32, row: 32});
const ID = 'developer';
// The descriptor src/devtools/panels/panels.mjs defines (that module is a developer file the shipping build leaves out).
const DEVELOPER = normalizePanelDescriptor({id: ID, title: 'Developer', icon: 'bug', docks: ['right', 'left', 'bottom'], floatable: true, min: 320, pref: 440, max: 960, defaultDock: 'hidden'});
const developerCatalog = Object.freeze([...PANEL_CATALOG, DEVELOPER]);
const shipping = {catalog: PANEL_CATALOG};
const developer = {catalog: developerCatalog};
const count = (layout, id) => placedPanels(layout).filter(placed => placed === id).length;

test('the shipping catalogue and default layouts never name the developer panel', () => {
  assert.ok(!PANEL_CATALOG.some(panel => panel.id === ID));
  for (const mode of MODES) assert.equal(count(defaultLayout(mode), ID), 0, mode);
});

test('in the developer build the panel arrives closed: every default layout keeps its shape', () => {
  for (const mode of MODES) {
    const ship = defaultLayout(mode), dev = defaultLayout(mode, developer);
    assert.deepEqual(dev.root, ship.root, `${mode}: the same tree`);
    assert.deepEqual(dev.floats, ship.floats);
    assert.ok(dev.closed.some(entry => entry.id === ID), `${mode}: the developer panel waits closed`);
    const env = {width: 1440, height: 900, mode, metrics};
    assert.deepEqual(solveDock(dev, {...env, panels: developerCatalog}).stage, solveDock(ship, env).stage, `${mode}: the stage is where it was`);
  }
  // Opened, it docks at its home edge.
  const opened = reopenPanel(defaultLayout('animate', developer), ID, {mode: 'animate', ...developer, fallback: defaultLayout('animate', developer)});
  assert.ok(groupsOf(opened).some(group => group.tabs.includes(ID)));
  assert.deepEqual(validateLayout(opened, 'animate', developer), []);
});

/** Layouts a developer build may store: the panel in a group of its own, tabbed with Properties, floating, closed. */
function developerLayouts(mode) {
  const base = defaultLayout(mode, developer), fallback = base;
  const own = reopenPanel(base, ID, {mode, ...developer, fallback});
  const tabbed = repairLayout({...own, root: JSON.parse(JSON.stringify(own.root).replace(/"tabs":\["properties"/, `"tabs":["properties","${ID}"`)),
    floats: [], closed: []}, mode, {...developer, fallback});
  const floating = repairLayout({...base, closed: base.closed.filter(entry => entry.id !== ID),
    floats: [{id: 'f1', rect: {x: 300, y: 200, w: 440, h: 360}, group: {type: 'group', id: 'g90', tabs: [ID], active: ID}}]}, mode, {...developer, fallback});
  return {own, tabbed, floating, closed: base};
}

test('a layout a developer build stored opens in the shipping build without an error, a lost panel or a drawn slot', () => {
  for (const mode of MODES) {
    for (const [name, layout] of Object.entries(developerLayouts(mode))) {
      const where = `${mode} ${name}`;
      assert.deepEqual(validateLayout(layout, mode, developer), [], `${where}: valid where it was written`);
      // The whole stored state, as the developer build writes it and the shipping build reads it.
      let state = setLayout(defaultState(developer), mode, layout);
      state = saveLayout(state, {name: `dev ${name}`, mode, now: 1}).state;
      const stored = JSON.parse(JSON.stringify(serializeState(state, developer)));
      const read = readState(stored, shipping);
      for (const each of MODES) {
        const opened = read.workspaces[each].layout;
        assert.deepEqual(validateLayout(opened, each, shipping), [], `${where}: valid in the shipping build (${each})`);
        for (const panel of PANEL_CATALOG.filter(panel => !panel.modes || panel.modes.includes(each))) assert.equal(count(opened, panel.id), 1, `${where}: ${panel.id} once in ${each}`);
        assert.ok(count(opened, ID) <= 1, `${where}: the developer slot is kept at most once`);
        const solved = solveDock(opened, {width: 1440, height: 900, mode: each, metrics});
        assert.ok(!solved.groups.some(group => group.tabs.length && group.tabs.every(id => id === ID)), `${where}: no island of the developer panel alone`);
        assert.ok(!solved.floats.some(float => float.tabs.every(id => id === ID)), `${where}: no float of the developer panel alone`);
        assert.ok(!(ID in solved.panels) || solved.panels[ID].presentation === 'unavailable', `${where}: the developer panel is not presented`);
      }
      assert.equal(read.saved.length, 1, `${where}: the saved layout is kept`);
      assert.deepEqual(validateLayout(read.saved[0].layout, mode, shipping), [], `${where}: the saved layout is valid`);
      // And back in a developer build the panel is where it was left.
      const again = readState(JSON.parse(JSON.stringify(serializeState(read, shipping))), developer);
      assert.equal(count(again.workspaces[mode].layout, ID), 1, `${where}: the developer build finds its panel again`);
    }
  }
});
