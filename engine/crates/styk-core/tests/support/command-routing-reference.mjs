// Execute the actual capture/bubble handlers, not a transcription of their gates.
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
globalThis.stykDesktop = {};
Object.defineProperty(globalThis, 'navigator', {configurable: true, value: {platform: 'Win32'}});
const {HotkeyManager, isHotkeyInput} = await import('../../../../../src/hotkeys.mjs');
const app = readFileSync(new URL('../../../../../src/app.mjs', import.meta.url), 'utf8');
const start = app.indexOf('const SHELL_FIELD_KEYS =');
const end = app.indexOf("window.addEventListener('blur',", start);
assert.ok(start >= 0 && end > start, 'reference keydown/keyup listeners must exist');
const install = new Function('document', 'guarded', 'state', 'overlays', 'isHotkeyInput', 'hotkeys',
  'hotkeyScopes', 'actions', 'refreshOriginDragModifiers', 'vfxInspector', 'home', '$', 'cancelDrag', app.slice(start, end));

const cases = {
  controls: ['select', 'checkbox', 'radio', 'other', 'text', 'none'].flatMap(role => [
    {role, code: 'Delete'}, {role, code: 'KeyH', shiftKey: true, scopes: ['builder']},
    ...['F9', 'F10', 'F12', 'KeyB'].map(code => ({role, code, scopes: ['builder']})),
  ]),
  history: ['text', 'select', 'checkbox'].flatMap(role => [
    {role, code: 'KeyZ', ctrlKey: true, vfx: true},
    {role, code: 'KeyZ', ctrlKey: true, shiftKey: true, vfx: true},
    {role, code: 'KeyY', ctrlKey: true, vfx: true},
    {role, code: 'KeyZ', ctrlKey: true},
    {role, code: 'KeyZ', ctrlKey: true, vfx: true, overlay: true},
  ]),
  drag: [
    {code: 'Escape', shiftKey: true, drag: true},
    {code: 'Escape', ctrlKey: true, drag: true},
    {code: 'Escape', shiftKey: true},
    {code: 'Escape', shiftKey: true, drag: true, role: 'select'},
    {code: 'Escape', shiftKey: true, drag: true, overlay: true},
    {code: 'KeyH', shiftKey: true, drag: true},
  ],
  repeat: ['text', 'select', 'none'].flatMap(role => [
    {role, code: 'F6', repeat: true}, {role, code: 'F6', ctrlKey: true, repeat: true},
    {role, code: 'KeyM', ctrlKey: true, altKey: true, repeat: true},
    {role, code: 'KeyL', ctrlKey: true, altKey: true, repeat: true},
    {role, code: 'F6', shiftKey: true, repeat: true},
    {role, code: 'F6', repeat: true, overlay: true},
  ]),
};
const results = cases[process.argv[2]].map(spec => {
  const listeners = [], runs = [];
  const role = spec.role ?? 'none';
  const target = {
    closest: () => role === 'none' ? null : target,
    matches: () => role === 'checkbox' || role === 'radio',
  };
  const actions = new Proxy({}, {get: (_, id) => () => runs.push(id)});
  const hotkeys = new HotkeyManager({mac: false, run: id => actions[id]()});
  install({addEventListener: (type, listener, capture = false) => listeners.push({type, listener, capture})},
    fn => fn, {home: false, drag: spec.drag, polygon: false}, {blocksHotkeys: () => !!spec.overlay},
    isHotkeyInput, hotkeys, () => spec.scopes ?? [], actions, () => {},
    {ownsHistoryTarget: () => !!spec.vfx}, {blocksKey: () => false}, () => ({hidden: true}), () => runs.push('cancel-drag'));
  const event = {...spec, target, defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }};
  for (const {listener} of listeners.filter(row => row.type === 'keydown').sort((a, b) => Number(b.capture) - Number(a.capture))) {
    listener(event); if (event.stopped) break;
  }
  return {...spec, runs};
});
process.stdout.write(JSON.stringify(results));
