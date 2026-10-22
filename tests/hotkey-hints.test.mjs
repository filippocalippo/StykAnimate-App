import test from 'node:test';
import assert from 'node:assert/strict';
import {HotkeyManager} from '../src/hotkeys.mjs';
import {hotkeyCommandId, refreshHotkeyHints} from '../src/hotkey-hints.mjs';
import {tooltipContent} from '../src/ui/ui-tooltip.mjs';

/** Just enough of an element for the hint writer and the tooltip's content rule. */
class Node {
  constructor(attributes = {}, {text = '', id = '', parent = null, kbd = null} = {}) {
    this.attributes = new Map(Object.entries(attributes));
    this.textContent = text; this.id = id; this.parent = parent; this.kbd = kbd;
    const node = this;
    this.dataset = new Proxy({}, {
      get: (target, key) => node.attributes.get(`data-${String(key).replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}`),
      set: (target, key, value) => { node.attributes.set(`data-${String(key).replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}`, String(value)); return true; },
    });
  }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  hasAttribute(name) { return this.attributes.has(name); }
  querySelector(selector) { return selector === 'kbd' ? this.kbd : null; }
}
const root = nodes => ({querySelectorAll: () => nodes});
const hotkeys = (bindings, mac = false) => new HotkeyManager({bindings, mac});

test('a control shows the shortcut of its own command, including the aliases of the Build part commands and drawing tools', () => {
  const keys = hotkeys();
  assert.equal(hotkeyCommandId(new Node({'data-action': 'undo'}), keys), 'undo');
  assert.equal(hotkeyCommandId(new Node({'data-tool': 'select'}), keys), 'tool-select');
  assert.equal(hotkeyCommandId(new Node({'data-tool': 'drawing-brush'}), keys), 'drawing-brush', 'Draw tools are their own hotkey ids');
  assert.equal(hotkeyCommandId(new Node({'data-tool': 'tweener'}), keys), null, 'no shortcut command, no hint');
  assert.equal(hotkeyCommandId(new Node({'data-action': 'play'}, {id: 'play-button'}), keys), 'play-pan');
  assert.equal(hotkeyCommandId(new Node({'data-action': 'duplicate-segment'}), keys), 'duplicate');
  assert.equal(hotkeyCommandId(new Node({'data-action': 'mirror-segment-vertical'}), keys), 'mirror-vertical');
  assert.equal(hotkeyCommandId(new Node({'data-action': 'delete-single-segment'}), keys), 'delete');
  assert.equal(hotkeyCommandId(new Node({'data-hotkey-command': 'add-frame', 'data-action': 'other'}), keys), 'add-frame');
  assert.equal(hotkeyCommandId(new Node({'data-action': 'scene-settings'}), keys), null);
});

test('hints move a title into the name, keep the accessible name and never write a title', () => {
  const keys = hotkeys({undo: ['Mod+KeyU', 'Mod+Alt+KeyZ']});
  const titled = new Node({'data-action': 'previous-frame', title: 'Previous frame · ←'});
  const labelled = new Node({'data-action': 'undo', title: 'Undo · Ctrl+Z', 'aria-label': 'Undo'});
  const worded = new Node({'data-action': 'save', title: 'Save project · Ctrl+S'}, {text: 'Save'});
  const named = new Node({'data-action': 'toggle-range-edit', 'data-hotkey-title': 'Select multiple frames to edit them together', title: 'Edit selected frames'});
  const menuRow = new Node({'data-action': 'redo'}, {kbd: {textContent: 'stale'}});
  refreshHotkeyHints(keys, root([titled, labelled, worded, named, menuRow]));

  assert.deepEqual([titled.getAttribute('title'), titled.dataset.hotkeyTitle, titled.getAttribute('aria-label'), titled.dataset.hotkeyHint,
    titled.getAttribute('aria-keyshortcuts')], [null, 'Previous frame', 'Previous frame', ',', ',']);
  assert.deepEqual([labelled.getAttribute('title'), labelled.dataset.hotkeyTitle, labelled.getAttribute('aria-label'), labelled.dataset.hotkeyHint,
    labelled.getAttribute('aria-keyshortcuts')], [null, 'Undo', 'Undo', 'Ctrl+U / Ctrl+Alt+Z', 'Control+U Control+Alt+Z']);
  assert.deepEqual([worded.getAttribute('title'), worded.dataset.hotkeyTitle, worded.hasAttribute('aria-label')], [null, 'Save project', false],
    'a visible word stays the accessible name');
  assert.deepEqual([named.getAttribute('title'), named.dataset.hotkeyTitle], [null, 'Select multiple frames to edit them together'],
    'an explicit data-hotkey-title wins over a stale title');
  assert.equal(menuRow.kbd.textContent, 'Ctrl+Shift+Z / Ctrl+Y');

  // A command without a binding loses its aria-keyshortcuts; the hint is empty.
  const unbound = hotkeys({undo: []});
  refreshHotkeyHints(unbound, root([labelled]));
  assert.deepEqual([labelled.dataset.hotkeyHint, labelled.hasAttribute('aria-keyshortcuts')], ['', false]);
  // A stand-in without bindings (a kit fixture) leaves aria-keyshortcuts to the control's owner.
  const owned = new Node({'data-action': 'delete-single-segment', 'aria-keyshortcuts': 'Delete', 'data-tooltip': 'Delete part'});
  refreshHotkeyHints({label: () => 'Delete'}, root([owned]));
  assert.deepEqual([owned.dataset.hotkeyHint, owned.getAttribute('aria-keyshortcuts')], ['Delete', 'Delete']);
});

test('the tooltip names a control by data-tooltip, data-hotkey-title or aria-label; a native title keeps its own tip', () => {
  const shortcut = () => 'Ctrl+Z';
  assert.deepEqual(tooltipContent(new Node({'data-hotkey-title': 'Undo', 'aria-label': 'Undo'}), {shortcut}), {label: 'Undo', shortcut: 'Ctrl+Z'});
  assert.deepEqual(tooltipContent(new Node({'data-tooltip': 'Bring to front', title: 'Bring to front'}), {shortcut: () => ''}),
    {label: 'Bring to front', shortcut: ''}, 'data-tooltip wins over a title');
  assert.equal(tooltipContent(new Node({'aria-label': 'Scene properties', title: 'Scene properties'})), null, 'no second tooltip over a native title');
  assert.equal(tooltipContent(new Node({'aria-label': 'Save'}, {text: 'Save'})), null, 'a visible word with no shortcut adds nothing');
  assert.equal(tooltipContent(new Node({'data-tooltip': ''})), null, 'an empty data-tooltip opts out');
});

test('hints use Command on macOS', () => {
  const labelled = new Node({'data-action': 'undo', title: 'Undo', 'aria-label': 'Undo'});
  refreshHotkeyHints(hotkeys(undefined, true), root([labelled]));
  assert.deepEqual([labelled.dataset.hotkeyHint, labelled.getAttribute('aria-keyshortcuts')], ['Cmd+Z', 'Meta+Z']);
});
