import test from 'node:test';
import assert from 'node:assert/strict';
import {createTypeahead, findTypeahead, menuKeyAction, normalizeMenu} from '../src/ui/ui-menu.mjs';
import {nextRovingIndex} from '../src/ui/roving-focus.mjs';
import {CommandRegistry} from '../src/ui/command-registry.mjs';
import {kitText, translator} from '../src/ui/ui-strings.mjs';

const registryItems = {
  undo: {label: 'Undo', icon: 'undo', shortcut: 'Ctrl+Z', enabled: true},
  paste: {label: 'Paste', icon: 'clipboard', shortcut: 'Ctrl+V', enabled: false, reason: 'Nothing copied yet'},
  'toggle-handles': {label: 'Joints', icon: 'nodes', shortcut: 'Shift+J', enabled: true, checked: true},
  'split-segment': {label: 'Split', hidden: true},
};
const resolve = id => registryItems[id] ?? null;

test('normalizeMenu resolves commands, roles, shortcuts and reasons', () => {
  const entries = normalizeMenu(['undo', 'paste', 'toggle-handles', {command: 'undo', label: 'Undo move', shortcut: false},
    {label: 'Custom', run: () => {}, shortcut: 'F2', danger: true}, {label: 'Zoom', radio: true, checked: false, group: 'zoom'}], {resolve});
  assert.deepEqual(entries.map(entry => [entry.label, entry.role, entry.shortcut, entry.disabled, entry.reason]), [
    ['Undo', 'menuitem', 'Ctrl+Z', false, ''],
    ['Paste', 'menuitem', 'Ctrl+V', true, 'Nothing copied yet'],
    ['Joints', 'menuitemcheckbox', 'Shift+J', false, ''],
    ['Undo move', 'menuitem', '', false, ''],
    ['Custom', 'menuitem', 'F2', false, ''],
    ['Zoom', 'menuitemradio', '', false, ''],
  ]);
  assert.equal(entries[2].checked, true);
  assert.equal(entries[0].checked, undefined);
  assert.equal(entries[4].danger, true);
  assert.equal(typeof entries[4].run, 'function');
  assert.equal(entries[5].group, 'zoom');
});

test('a shortcut formatter supplies display text unless the item gives its own', () => {
  const shortcut = id => `⌘${id.length}`;
  const [auto, explicit, none] = normalizeMenu(['undo', {command: 'undo', shortcut: 'Ctrl Z'}, {command: 'paste', shortcut: false}], {resolve, shortcut});
  assert.deepEqual([auto.shortcut, explicit.shortcut, none.shortcut], ['⌘4', 'Ctrl Z', '']);
});

test('hidden items, empty submenus, stray separators and empty group labels are left out', () => {
  const entries = normalizeMenu([null, {label: 'Canvas'}, 'split-segment', '-', {label: 'Edit'}, 'undo', null, null, {label: 'Build', submenu: ['split-segment']},
    {label: 'More', submenu: () => ['undo']}, null], {resolve});
  assert.deepEqual(entries.map(entry => entry.type === 'item' ? entry.label : entry.type === 'label' ? `[${entry.label}]` : '-'), ['[Edit]', 'Undo', '-', 'More']);
  assert.equal(entries.at(-1).shortcut, '', 'submenu rows show a chevron, not a shortcut');
  assert.deepEqual(normalizeMenu(() => ['undo'], {resolve}).map(entry => entry.label), ['Undo'], 'a model can be a function');
  assert.deepEqual(normalizeMenu(['split-segment', {command: 'split-segment', hidden: false, label: 'Split anyway'}], {resolve}).map(entry => entry.label), ['Split anyway']);
});

test('registry items render through normalizeMenu unchanged', () => {
  for (const [mac, undo, redo] of [[false, 'Ctrl+Z', 'Ctrl+Shift+Z'], [true, 'Cmd+Z', 'Cmd+Shift+Z']]) {
    const registry = new CommandRegistry({actions: {undo() {}, redo() {}}, requirements: {}, context: () => ({mode: 'animate'}), hotkeys: {mac}});
    const entries = normalizeMenu(registry.items(['undo', 'redo', null, 'split-segment']), {resolve: id => registry.get(id)});
    assert.deepEqual(entries.map(entry => [entry.command, entry.label, entry.shortcut, entry.disabled]), [['undo', 'Undo', undo, false], ['redo', 'Redo', redo, false]], mac ? 'macOS' : 'Windows and Linux');
  }
});

test('typeahead: keys typed within 700 ms build one query', () => {
  let time = 0;
  const typeahead = createTypeahead({now: () => time});
  assert.equal(typeahead.push('S'), 's');
  time = 300;
  assert.equal(typeahead.push('a'), 'sa');
  time = 1200;
  assert.equal(typeahead.push('p'), 'p', 'a pause starts over');
  typeahead.reset();
  assert.equal(typeahead.buffer, '');
});

test('findTypeahead cycles on a repeated letter and stays on a longer match', () => {
  const labels = ['New animation', 'Open project…', 'Save', 'Save as…', 'Settings…', ' Paste'];
  assert.equal(findTypeahead(labels, 's', -1), 2);
  assert.equal(findTypeahead(labels, 's', 2), 3, 'the next item starting with the letter');
  assert.equal(findTypeahead(labels, 'ss', 3), 4, 'repeating a letter keeps cycling');
  assert.equal(findTypeahead(labels, 's', 4), 2, 'and wraps');
  assert.equal(findTypeahead(labels, 'save', 3), 3, 'a longer query may stay put');
  assert.equal(findTypeahead(labels, 'se', 2), 4);
  assert.equal(findTypeahead(labels, 'p', 0), 5, 'leading spaces are ignored');
  assert.equal(findTypeahead(labels, 'x', 0), -1);
  assert.equal(findTypeahead([], 'a', 0), -1);
});

test('menu keys: arrows wrap, Home and End jump, nothing reaches the hotkeys', () => {
  const at = (key, state = {}, extra = {}) => menuKeyAction({key, ...extra}, {index: 1, count: 4, ...state});
  assert.deepEqual(at('ArrowDown'), {type: 'move', index: 2});
  assert.deepEqual(at('ArrowDown', {index: 3}), {type: 'move', index: 0});
  assert.deepEqual(at('ArrowUp', {index: 0}), {type: 'move', index: 3});
  assert.deepEqual(at('ArrowDown', {index: -1}), {type: 'move', index: 0}, 'no focused item: the first');
  assert.deepEqual(at('ArrowUp', {index: -1}), {type: 'move', index: 3}, 'no focused item: the last');
  assert.deepEqual([at('Home'), at('PageDown')], [{type: 'move', index: 0}, {type: 'move', index: 3}]);
  assert.deepEqual(at('ArrowDown', {count: 0}), {type: 'swallow'});
  assert.deepEqual(at('h'), {type: 'typeahead', character: 'h'}, 'letters search the menu instead of picking a tool');
  assert.deepEqual(at('s', {}, {ctrlKey: true}), {type: 'swallow'}, 'shortcuts are swallowed while a menu is open');
  assert.deepEqual(at('F5'), {type: 'swallow'});
  assert.deepEqual(at('a', {}, {isComposing: true}), {type: 'swallow'});
});

test('menu keys: activation, submenus, the menubar and closing', () => {
  const at = (key, state = {}) => menuKeyAction({key}, {index: 0, count: 3, ...state});
  assert.deepEqual([at('Enter'), at(' ')], [{type: 'activate'}, {type: 'activate'}]);
  assert.deepEqual(at('Enter', {index: -1}), {type: 'swallow'});
  assert.deepEqual([at('Enter', {submenu: true}), at('ArrowRight', {submenu: true})], [{type: 'open-submenu'}, {type: 'open-submenu'}]);
  assert.deepEqual(at('ArrowRight'), {type: 'swallow'});
  assert.deepEqual(at('ArrowRight', {menubar: true}), {type: 'menubar', delta: 1}, 'Right in a menubar menu opens the next menu');
  assert.deepEqual(at('ArrowLeft', {menubar: true}), {type: 'menubar', delta: -1});
  assert.deepEqual(at('ArrowLeft', {nested: true, menubar: true}), {type: 'close-submenu'}, 'Left in a submenu goes back to its row');
  assert.deepEqual(at('ArrowRight', {nested: true, menubar: true}), {type: 'menubar', delta: 1});
  assert.deepEqual(at('Escape'), {type: 'close', reason: 'escape'});
  assert.deepEqual(at('Escape', {nested: true}), {type: 'close-submenu'});
  assert.deepEqual(at('Tab'), {type: 'close', reason: 'tab'});
});

test('roving focus: arrows by orientation, skipping disabled items, looping or not', () => {
  assert.equal(nextRovingIndex('ArrowRight', 0, 4), 1);
  assert.equal(nextRovingIndex('ArrowDown', 0, 4), null, 'a horizontal toolbar ignores Up and Down');
  assert.equal(nextRovingIndex('ArrowDown', 0, 4, {orientation: 'vertical'}), 1);
  assert.equal(nextRovingIndex('ArrowLeft', 0, 4), 3, 'wraps');
  assert.equal(nextRovingIndex('ArrowLeft', 0, 4, {loop: false}), 0, 'stays at the start without looping');
  const skip = index => index === 1 || index === 2;
  assert.equal(nextRovingIndex('ArrowRight', 0, 4, {skip}), 3);
  assert.equal(nextRovingIndex('Home', 3, 4, {skip: index => index === 0}), 1);
  assert.equal(nextRovingIndex('End', 0, 4, {skip: index => index === 3}), 2);
  assert.equal(nextRovingIndex('ArrowRight', 0, 1), 0, 'a single item keeps focus');
  assert.equal(nextRovingIndex('ArrowRight', 0, 0), null);
});

test('labelKeys translate items, submenus and group labels; shortcuts carry aria-keyshortcuts', () => {
  const t = key => ({'menu.arrange': 'Disponi', 'menu.canvas': 'Tela'})[key] ?? key;
  const entries = normalizeMenu([{label: 'Canvas', labelKey: 'menu.canvas'}, 'undo', {label: 'Arrange', labelKey: 'menu.arrange', submenu: ['undo']},
    {label: 'Keep', labelKey: 'menu.unknown', run() {}}], {resolve: id => ({...registryItems[id], keyshortcuts: 'Control+Z'}), t});
  assert.deepEqual(entries.map(entry => entry.label), ['Tela', 'Undo', 'Disponi', 'Keep'], 'an unknown key keeps the English label');
  assert.equal(entries[1].keyshortcuts, 'Control+Z');
  assert.equal(entries[2].keyshortcuts, '', 'a submenu row has no shortcut');
  const explicit = normalizeMenu([{command: 'undo', shortcut: 'F2'}], {resolve: id => ({...registryItems[id], keyshortcuts: 'Control+Z'})});
  assert.equal(explicit[0].keyshortcuts, '', "a hand-written shortcut does not borrow the command's keys");
});

test("the kit's own words come from t, else from the English fragments", () => {
  assert.equal(kitText(null, 'overlays.palette.goToFrame', {frame: 12}), 'Go to frame 12');
  assert.equal(kitText(null, 'common.close'), 'Close', 'reused keys fall back to en.mjs');
  assert.equal(kitText(key => (key === 'common.close' ? 'Chiudi' : key), 'common.close'), 'Chiudi');
  assert.equal(kitText(() => { throw new Error('bad catalog'); }, 'overlays.dismiss'), 'Dismiss');
  assert.equal(kitText(null, 'overlays.not-a-key'), 'overlays.not-a-key');
  assert.equal(translator({t: key => `t:${key}`})('x'), 't:x');
  assert.equal(translator(null), null);
});
