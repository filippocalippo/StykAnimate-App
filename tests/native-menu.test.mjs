import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { nativeMenuTemplate, TEXT_EDIT_COMMANDS } = createRequire(import.meta.url)('../desktop/native-menu.cjs');

const menu = platform => {
  const sent = [];
  const template = nativeMenuTemplate({ platform, packaged: true, t: key => key, send: (action, details) => sent.push([action, details]) });
  const items = template.flatMap(entry => [entry, ...(Array.isArray(entry.submenu) ? entry.submenu : [])]);
  return { template, items, sent, find: action => items.find(entry => entry.click && (entry.click(null, null, {}), sent.pop()?.[0] === action)) };
};

test('Windows and Linux menus carry no accelerators, leaving every key to the editor', () => {
  for (const platform of ['win32', 'linux']) {
    const { template, items } = menu(platform);
    assert.deepEqual(items.filter(entry => entry.accelerator).map(entry => entry.label ?? entry.role), [], platform);
    assert.ok(items.some(entry => entry.role === 'quit'), `${platform} keeps Quit in File`);
    assert.ok(!template.some(entry => entry.role === 'appMenu' || entry.role === 'windowMenu'), platform);
  }
});

test('macOS gives text editing, Close and the app and window menus their standard keys', () => {
  const { template, find } = menu('darwin');
  assert.equal(template[0].role, 'appMenu', 'the app menu (Hide Command+H, Quit Command+Q) comes first');
  assert.ok(template.some(entry => entry.role === 'windowMenu'), 'Window menu with Minimize Command+M');
  const keys = Object.fromEntries(['undo', 'redo', 'cut', 'copy', 'paste', 'select-all', 'close-project'].map(action => [action, find(action)?.accelerator]));
  assert.deepEqual(keys, { undo: 'CmdOrCtrl+Z', redo: 'Shift+CmdOrCtrl+Z', cut: 'CmdOrCtrl+X', copy: 'CmdOrCtrl+C', paste: 'CmdOrCtrl+V',
    'select-all': 'CmdOrCtrl+A', 'close-project': 'CmdOrCtrl+W' });
  const file = template.find(entry => entry.label === 'desktop.main.file').submenu;
  assert.deepEqual(file.filter(entry => entry.role).map(entry => [entry.role, entry.accelerator]), [['close', 'Shift+CmdOrCtrl+W']], 'Close Window, not Quit');
  for (const action of ['new', 'open', 'save', 'duplicate', 'delete', 'play'])
    assert.equal(find(action)?.accelerator, undefined, `${action} stays with the customizable editor shortcuts`);
});

test('a menu click reports whether a key equivalent triggered it, and no key is assigned twice', () => {
  const { items, sent } = menu('darwin');
  const copy = items.find(entry => entry.accelerator === 'CmdOrCtrl+C');
  copy.click(null, null, { triggeredByAccelerator: true });
  copy.click(null, null, {});
  assert.deepEqual(sent, [['copy', { fromKeyboard: true }], ['copy', { fromKeyboard: false }]]);
  const accelerators = items.map(entry => entry.accelerator).filter(Boolean);
  assert.equal(new Set(accelerators).size, accelerators.length);
});

test('only native editing commands reach the page', () => {
  assert.deepEqual(TEXT_EDIT_COMMANDS, { undo: 'undo', redo: 'redo', cut: 'cut', copy: 'copy', paste: 'paste', 'select-all': 'selectAll', delete: 'delete' });
  assert.ok(Object.isFrozen(TEXT_EDIT_COMMANDS));
});
