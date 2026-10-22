import test from 'node:test';
import assert from 'node:assert/strict';
import {CATALOG_REQUIREMENTS, COMMAND_BY_ID, COMMAND_CATALOG, COMMAND_CATEGORIES} from '../src/ui/command-catalog.mjs';
import {CommandRegistry, ariaKeyShortcut, fuzzyMatch, humanizeId} from '../src/ui/command-registry.mjs';
import {DEFAULT_HOTKEYS, HOTKEY_BY_ID, findHotkeyConflicts, formatBinding} from '../src/hotkeys.mjs';
import {iconNames} from '../src/icons.mjs';
import english from '../src/locales/en.mjs';
import overlayStrings from '../src/locales/en-overlays.mjs';
// The shell contract's scanner for the actions map (app.mjs and the modules it passes the map to).
import {actionKeys, readActionSources} from './helpers/source-scan.mjs';

const ACTIONS = actionKeys(readActionSources());
// The zoom menu's presets, which app.mjs builds at run time (the scanner cannot see them;
// tests/overlays.browser.mjs checks the running app's actions against the catalog).
for (const n of [25, 50, 100, 200]) ACTIONS.add(`zoom-${n}`);
const catalogText = {...english, ...overlayStrings};
const everyRequirement = (answer = () => true) => Object.fromEntries(CATALOG_REQUIREMENTS.map(name => [name, answer]));
const hotkeyOf = entry => entry.hotkey ?? (HOTKEY_BY_ID.has(entry.id) ? entry.id : null);

test('every catalog id is an existing action or hotkey command, listed once', t => {
  assert.ok(ACTIONS.size > 150, `the actions map was scanned (${ACTIONS.size} keys)`);
  const ids = COMMAND_CATALOG.map(entry => entry.id);
  assert.equal(new Set(ids).size, ids.length, 'catalog ids are unique');
  for (const id of ids) assert.ok(ACTIONS.has(id) || HOTKEY_BY_ID.has(id), `${id} is an actions key or a HOTKEY_COMMANDS id`);
  const missing = [...new Set([...ACTIONS, ...HOTKEY_BY_ID.keys()])].filter(id => !COMMAND_BY_ID.has(id));
  if (missing.length) t.diagnostic(`commands without catalog metadata (the registry falls back to hotkey labels): ${missing.join(', ')}`);
});

test('catalog metadata is well formed', () => {
  const categories = new Set(COMMAND_CATEGORIES.map(category => category.id)), icons = new Set(iconNames);
  for (const entry of COMMAND_CATALOG) {
    assert.ok(categories.has(entry.category), `${entry.id}: category ${entry.category}`);
    assert.ok(entry.label && entry.label === entry.label.trim(), `${entry.id}: label`);
    if (entry.icon) assert.ok(icons.has(entry.icon), `${entry.id}: glyph ${entry.icon} exists in icons.mjs`);
    if (entry.labelKey) assert.equal(catalogText[entry.labelKey], entry.label, `${entry.id}: ${entry.labelKey} is the English label`);
    if (entry.hotkey) assert.ok(HOTKEY_BY_ID.has(entry.hotkey), `${entry.id}: hotkey alias ${entry.hotkey} exists`);
    if (entry.aliasOf) assert.ok(COMMAND_BY_ID.has(entry.aliasOf) && !COMMAND_BY_ID.get(entry.aliasOf).aliasOf, `${entry.id}: aliasOf ${entry.aliasOf}`);
    for (const mode of entry.modes ?? []) assert.ok(['animate', 'draw', 'rig'].includes(mode), `${entry.id}: mode ${mode}`);
    assert.ok(Object.isFrozen(entry), `${entry.id} is frozen`);
  }
  for (const category of COMMAND_CATEGORIES) assert.equal(catalogText[category.labelKey], category.label, `${category.id}: ${category.labelKey}`);
  for (const key of Object.keys(overlayStrings)) assert.equal(english[key], overlayStrings[key], `${key} is composed into the shared catalog`);
});

test('CATALOG_REQUIREMENTS lists every requirement name the catalog uses', () => {
  const used = new Set(COMMAND_CATALOG.flatMap(entry => entry.requires ?? []));
  assert.deepEqual(CATALOG_REQUIREMENTS, [...used].sort());
  assert.ok(CATALOG_REQUIREMENTS.includes('desktop:updates') && CATALOG_REQUIREMENTS.includes('figure'));
});

test('no two commands claim the same shortcut', () => {
  // Within a scope, the default bindings the catalog shows never collide.
  const shown = new Set(COMMAND_CATALOG.map(hotkeyOf).filter(Boolean));
  for (const id of shown)
    for (const binding of DEFAULT_HOTKEYS[id])
      assert.deepEqual(findHotkeyConflicts(DEFAULT_HOTKEYS, id, binding, false).map(command => command.id), [], `${binding} (${id}) is unique in its scope`);
  // Each hotkey is shown by one command; others may show it only as a declared alias (hotkey: …).
  const owners = new Map();
  for (const entry of COMMAND_CATALOG) {
    const hotkey = hotkeyOf(entry);
    if (!hotkey || entry.hotkey) continue;
    assert.ok(!owners.has(hotkey), `${hotkey} is shown by ${owners.get(hotkey)} and ${entry.id}`);
    owners.set(hotkey, entry.id);
  }
  // Across scopes, in each workspace: a shortcut is shown on the command it runs there, never on two.
  const registry = new CommandRegistry({actions: Object.fromEntries([...ACTIONS].map(id => [id, () => {}])), runHotkey: () => {},
    requirements: everyRequirement(), formatBinding: binding => formatBinding(binding, false), hotkeys: {mac: false}});
  const transient = new Set(['canvas', 'hover', 'polygon', 'timeline', 'simple', 'library']);   // focus- and pointer-dependent scopes
  for (const mode of ['animate', 'draw', 'rig']) {
    const shownBy = new Map();
    for (const entry of COMMAND_CATALOG) {
      const hotkey = hotkeyOf(entry), command = registry.get(entry.id, {mode});
      if (!hotkey || entry.hotkey || command.hidden || transient.has(HOTKEY_BY_ID.get(hotkey).scope)) continue;
      for (const part of command.shortcutParts) {
        assert.ok(!shownBy.has(part), `${mode}: ${part} is shown on ${shownBy.get(part)} and ${entry.id}`);
        shownBy.set(part, entry.id);
      }
    }
  }
});

test('a workspace scope that claims a key takes its shortcut off the general command', () => {
  const registry = new CommandRegistry({actions: actions(), formatBinding: binding => formatBinding(binding, false), hotkeys: {mac: false}});
  assert.equal(registry.shortcut('camera-align-view', {mode: 'animate'}), 'F10');
  assert.equal(registry.shortcut('camera-align-view', {mode: 'rig'}), '', 'F10 shows Static handles in Build');
  assert.equal(registry.shortcut('builder-static-handles', {mode: 'rig'}), 'F10');
  assert.equal(registry.shortcut('camera-paste', {mode: 'rig'}), '', 'F12 highlights the part in Build');
  assert.deepEqual(['toggle-motion-paths', 'select-all'].map(id => registry.shortcut(id, {mode: 'draw'})), ['', ''], 'M and Ctrl+A belong to painting in Draw');
  assert.equal(registry.shortcut('drawing-select-all', {mode: 'draw'}), 'Ctrl+A');
  assert.equal(registry.shortcut('select-all', {mode: 'animate'}), 'Ctrl+A');
  assert.equal(registry.shortcut('camera-align-view', {mode: 'animate', hotkeyScopes: ['builder']}), '', 'an explicit scope list wins over the mode');
  const user = new CommandRegistry({actions: actions(), hotkeys: {mac: false, bindings: {'camera-align-view': ['F10', 'Shift+F10'], 'builder-static-handles': ['F10']}},
    formatBinding: binding => formatBinding(binding, false)});
  assert.deepEqual(user.get('camera-align-view', {mode: 'rig'}).shortcutParts, ['Shift+F10'], 'only the claimed binding is dropped');
});

test('shortcuts reach assistive tech as aria-keyshortcuts', () => {
  assert.equal(ariaKeyShortcut('Mod+Shift+KeyZ', false), 'Control+Shift+Z');
  assert.equal(ariaKeyShortcut('Mod+KeyZ', true), 'Meta+Z');
  assert.deepEqual(['Equal', 'Shift+Digit1', 'F10', 'Space', 'ArrowLeft'].map(binding => ariaKeyShortcut(binding, false)), ['=', 'Shift+1', 'F10', 'Space', 'ArrowLeft']);
  const registry = new CommandRegistry({actions: actions(), hotkeys: {mac: false}});
  assert.equal(registry.get('redo').keyshortcuts, 'Control+Shift+Z Control+Y');
  assert.equal(registry.get('export', {mode: 'animate'}).keyshortcuts, 'Control+Shift+E');
  assert.equal(registry.items(['undo'])[0].keyshortcuts, 'Control+Z');
});

const actions = () => Object.fromEntries(['undo', 'redo', 'mirror', 'mirror-vertical', 'toggle-handles', 'delete-single-segment', 'save', 'export', 'zoom-25', 'zoom-400', 'play']
  .map(id => [id, () => id]));

test('get() describes a command from the catalog, the bindings and the context', () => {
  const registry = new CommandRegistry({actions: actions(), hotkeys: {bindings: {undo: ['Mod+KeyU'], redo: []}}, formatBinding: binding => formatBinding(binding, false)});
  const undo = registry.get('undo');
  assert.equal(undo.label, 'Undo');
  assert.equal(undo.icon, 'undo');
  assert.equal(undo.category, 'edit');
  assert.equal(undo.shortcut, 'Ctrl+U', 'the user binding, not the default');
  assert.deepEqual(registry.get('redo').shortcutParts, [], 'an unbound command shows no shortcut');
  assert.equal(registry.get('mirror').shortcut, 'Shift+H', 'default bindings when the user has none');
  assert.equal(registry.get('play').shortcut, 'Space', 'the declared hotkey alias');
  assert.equal(registry.get('zoom-25').label, 'Zoom to 25%', 'the zoom presets built at run time have catalog labels');
  assert.equal(registry.get('zoom-400').label, 'Zoom 400', 'runtime ids without metadata still get a label');
  assert.equal(registry.get('new').enabled, false, 'a command without an implementation is not available');
  assert.equal(humanizeId('export-png-sequence'), 'Export png sequence');
});

test('availability: requirements, modes, hooks and toggles', () => {
  let context = {mode: 'animate', figure: false, handles: true};
  const registry = new CommandRegistry({
    actions: actions(), context: () => context,
    requirements: {figure: ctx => ctx.figure || 'Select a figure first'},
    availability: (id, ctx) => (id === 'save' && ctx.saving ? {enabled: false, reason: 'Saving…'} : null),
    checked: (id, ctx) => (id === 'toggle-handles' ? ctx.handles : undefined),
  });
  assert.deepEqual([registry.get('mirror').enabled, registry.get('mirror').reason], [false, 'Select a figure first']);
  context = {...context, figure: true};
  assert.equal(registry.get('mirror').enabled, true);
  const part = registry.get('delete-single-segment');
  assert.deepEqual([part.hidden, part.enabled, part.reason, part.mode], [true, false, 'In Build', 'rig'], 'Build-only commands are hidden elsewhere');
  assert.equal(registry.get('delete-single-segment', {mode: 'rig', figure: true}).hidden, false);
  assert.equal(registry.get('toggle-handles').checked, true);
  assert.equal(registry.get('toggle-handles', {handles: false}).checked, false);
  assert.equal(registry.get('undo').checked, undefined, 'plain commands have no checked state');
  context = {...context, saving: true};
  assert.deepEqual([registry.get('save').enabled, registry.get('save').reason], [false, 'Saving…']);
  registry.define('export', {when: () => ({hidden: true})});
  assert.equal(registry.get('export').hidden, true, 'define() adds a per-command hook');
});

test('a requirement the app does not answer makes the command unavailable and is reported once', () => {
  const errors = [];
  const registry = new CommandRegistry({actions: {...actions(), 'check-updates': () => {}}, requirements: {figure: () => true}, onError: error => errors.push(error.message)});
  assert.deepEqual([registry.get('check-updates').enabled, registry.get('check-updates').reason], [false, ''], 'desktop-only commands stay off on the web');
  registry.get('check-updates');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /desktop:updates/);
  assert.equal(registry.get('mirror').enabled, true, 'answered requirements still count');
  const failing = new CommandRegistry({actions: actions(), requirements: {figure: () => { throw new Error('no editor'); }}, onError: error => errors.push(error.message)});
  assert.equal(failing.get('mirror').enabled, false, 'a failing test reads as unavailable');
  assert.equal(errors.at(-1), 'no editor');
});

test('labels, category names and reasons translate through catalog keys', () => {
  const italian = {'common.undo': 'Annulla', 'menu.file': 'File', 'overlays.category.camera': 'Fotocamera', 'overlays.inMode': 'In {mode}',
    'overlays.mode.rig': 'Costruzione'};
  const registry = new CommandRegistry({actions: actions(), onError: () => {},
    localization: {t: (key, params = {}) => (italian[key] ?? key).replace(/\{(\w+)\}/g, (token, name) => params[name] ?? token)}});
  assert.equal(registry.label('undo'), 'Annulla');
  assert.equal(registry.label('redo'), 'Redo', 'an untranslated key falls back to the English label');
  assert.equal(registry.categoryLabel('camera'), 'Fotocamera');
  assert.equal(registry.categoryLabel('drawing'), 'Drawing', 'an untranslated category keeps its English name');
  assert.equal(registry.get('delete-single-segment', {mode: 'animate'}).reason, 'In Costruzione');
  assert.equal(new CommandRegistry({actions: actions()}).modeReason('draw'), 'In Draw');
});

test('run() goes through the app dispatch wrapper and records recents', () => {
  const calls = [];
  const registry = new CommandRegistry({
    actions: actions(), requirements: {figure: () => false},
    dispatch: (id, element, event) => { calls.push(['dispatch', id, element, event]); return id; },
    runHotkey: (id, event) => { calls.push(['hotkey', id, event]); },
  });
  const event = {type: 'keydown'};
  assert.deepEqual(registry.run('undo', {event, element: 'button', source: 'menu'}), {ran: true, reason: '', result: 'undo'});
  assert.deepEqual(registry.run('mirror'), {ran: false, reason: ''}, 'an unavailable command does not run');
  registry.run('tool-hand', {event, source: 'palette'});
  registry.run('redo', {source: 'hotkey'});
  registry.define('command-palette', {label: 'Search commands…', run: () => calls.push(['defined'])});
  registry.run('command-palette');
  assert.deepEqual(calls, [['dispatch', 'undo', 'button', event], ['hotkey', 'tool-hand', event], ['dispatch', 'redo', null, null], ['defined']]);
  assert.deepEqual(registry.recent(), ['command-palette', 'tool-hand', 'undo'], 'hotkey runs are not recents');
  registry.setRecent(['nope', 'save', 'save']);
  assert.deepEqual(registry.recent(), ['save']);
});

test('list() ranks palette rows: matches first, recents early, internal and alias ids left out', () => {
  const all = Object.fromEntries([...ACTIONS].map(id => [id, () => {}]));   // with zoom-25, which app.mjs builds at run time
  const registry = new CommandRegistry({actions: all, runHotkey: () => {}, context: () => ({mode: 'animate'}), requirements: everyRequirement()});
  const flip = registry.list({query: 'flip vert'});
  assert.equal(flip[0].id, 'mirror-vertical');
  assert.deepEqual(flip[0].match.ranges, [[0, 4], [5, 9]]);
  assert.equal(registry.list({query: 'fh'})[0].id, 'mirror', 'word-start abbreviations match');
  assert.equal(registry.list({query: 'mirror'})[0].id, 'mirror', 'keywords find renamed commands, and runnable ones rank first');
  const ids = registry.list().map(row => row.id);
  for (const hidden of ['close-dialog', 'builder-order', 'attach-figure', 'play-pan', 'handle-left', 'drawing-opacity-50'])
    assert.ok(!ids.includes(hidden), `${hidden} is not a palette row`);
  assert.ok(ids.includes('zoom-25'), 'runtime actions are listed');
  const split = registry.list({query: 'split'}).find(row => row.id === 'split-segment');
  assert.deepEqual([split.enabled, split.reason], [false, 'In Build'], 'other workspaces stay findable, with a reason');
  registry.recordRecent('export');
  assert.equal(registry.list()[0].id, 'export', 'recents lead the empty query');
  assert.equal(registry.list({query: 'e'}).length > 10, true);
});

test('items() turns a menu model into resolved menu items', () => {
  const registry = new CommandRegistry({actions: actions(), context: () => ({mode: 'animate'}), checked: () => true, hotkeys: {mac: false}});
  const items = registry.items(['undo', null, {label: 'Canvas'}, 'toggle-handles', 'delete-single-segment', {command: 'save', label: 'Save now'},
    {label: 'More', submenu: ['redo']}]);
  assert.equal(items.length, 6, 'the Build-only command is left out');
  assert.deepEqual(items[0], {command: 'undo', label: 'Undo', icon: 'undo', shortcut: 'Ctrl+Z', keyshortcuts: 'Control+Z', danger: false, disabled: false, reason: ''});
  assert.equal(items[1], null);
  assert.deepEqual(items[2], {label: 'Canvas'});
  assert.equal(items[3].checked, true);
  assert.equal(items[4].label, 'Save now', 'model overrides win');
  assert.equal(items[5].submenu[0].command, 'redo');
});

test('menu items show Command shortcuts on macOS and Ctrl elsewhere', () => {
  const item = mac => new CommandRegistry({actions: actions(), context: () => ({mode: 'animate'}), hotkeys: {mac}}).items(['undo', 'toggle-unselected-handles']);
  assert.deepEqual(item(false).map(row => [row.shortcut, row.keyshortcuts]), [['Ctrl+Z', 'Control+Z'], ['Ctrl+H', 'Control+H']]);
  assert.deepEqual(item(true).map(row => [row.shortcut, row.keyshortcuts]), [['Cmd+Z', 'Meta+Z'], ['Cmd+Shift+H', 'Meta+Shift+H']],
    'macOS defaults, with Command+H left to the system');
});

test('fuzzyMatch() is case and accent insensitive and reports ranges', () => {
  assert.deepEqual(fuzzyMatch('SAVE', 'Save as…').ranges, [[0, 4]]);
  assert.deepEqual(fuzzyMatch('colour', 'Reset colours').ranges, [[6, 12]]);
  assert.ok(fuzzyMatch('modifica', 'Modificà'));
  assert.equal(fuzzyMatch('xyz', 'Undo'), null);
  assert.equal(fuzzyMatch('ud', 'Send backward'), null, 'scattered letters do not match');
  assert.ok(fuzzyMatch('undo', 'Undo').score > fuzzyMatch('undo', 'Undo history').score, 'an exact label wins');
});

test('fuzzyMatch() takes a short query as an abbreviation only of word starts and runs', () => {
  assert.equal(fuzzyMatch('flip', 'Make movieclip from frames fill layers'), null, 'letters scattered over words');
  assert.ok(fuzzyMatch('flip', 'Flip view'), 'a substring');
  assert.ok(fuzzyMatch('fl', 'Fit layers'), 'word starts');
  assert.ok(fuzzyMatch('mcf', 'Make clip frames'), 'word starts');
  assert.ok(fuzzyMatch('mkclp', 'Make clip'), 'longer queries keep the looser abbreviation');
});
