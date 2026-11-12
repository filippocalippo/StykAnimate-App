// What the StykAnimate menu (the mark, top left) and the canvas's right-click menus list. They stay short: a command
// with a home in File, Edit, View, Joint, Animation, Help or the band is not repeated in the mark's menu, and the
// canvas keeps its rarer commands in submenus.
import test from 'node:test';
import assert from 'node:assert/strict';
import {markMenuItems} from '../src/application-menu.mjs';
import {canvasMenuItems, pasteKindItems, selectionMoreItems} from '../src/canvas-context-menu.mjs';

const commandOf = row => Array.isArray(row) ? row[0] : row?.command ?? null;
/** Each row's command, a submenu's label or a group label, and '-' for a separator. */
const outline = rows => rows.map(row => row === null ? '-' : commandOf(row) ?? (row.submenu ? `${row.label} ▸` : `[${row.label}]`));
const commandsIn = rows => rows.flatMap(row => row?.submenu ? commandsIn(row.submenu) : commandOf(row) ? [commandOf(row)] : []);

test('the mark lists Search commands, the application menus, the open projects and Settings, nothing else', () => {
  const palette = {command: 'command-palette', label: 'Search commands…'};
  const menus = ['File', 'Edit', 'View', 'Joint', 'Animation', 'Help'].map(label => ({label, submenu: [['undo', 'undo', 'Undo']]}));
  assert.deepEqual(outline(markMenuItems({palette, menus})),
    ['command-palette', '-', 'File ▸', 'Edit ▸', 'View ▸', 'Joint ▸', 'Animation ▸', 'Help ▸', '-', 'settings']);
  const projects = {label: 'Open projects', submenu: [{label: 'First', run() {}}]};
  assert.deepEqual(outline(markMenuItems({palette, menus, projects})).slice(-4), ['-', 'Open projects ▸', '-', 'settings']);
});

test('the empty canvas offers Paste with its kinds in a submenu, Select all, the scene and Fit canvas', () => {
  assert.deepEqual(outline(canvasMenuItems({hit: false})), ['paste', 'Paste as ▸', '-', 'select-all', '-', 'scene-settings', 'zoom-reset']);
  assert.deepEqual(commandsIn(canvasMenuItems({hit: false})[1].submenu), ['paste-in-place', 'paste-instance', 'paste-unique']);
});

test("a figure's menu keeps the everyday commands at the top and the rarer ones in More figure actions", () => {
  const join = ['join-figure', 'link', 'Join figure', '', false];
  const figure = canvasMenuItems({hit: true, title: 'Walker', join, single: true});
  assert.deepEqual(outline(figure), ['[Walker]', 'copy', 'paste', 'duplicate', '-', 'Flip ▸', 'join-figure', 'camera-follow',
    'More figure actions ▸', '-', 'edit-in-build-mode', '-', 'delete']);
  assert.deepEqual(commandsIn(figure.find(row => row?.label === 'Flip').submenu), ['mirror', 'mirror-vertical']);
  const more = figure.find(row => row?.label === 'More figure actions').submenu;
  assert.deepEqual(commandsIn(more), [...commandsIn(pasteKindItems()), ...commandsIn(selectionMoreItems())]);
  assert.equal(commandsIn(more).includes('join-figure'), false, 'Join is not repeated in the submenu');

  const joint = canvasMenuItems({hit: true, title: 'Walker', join, joint: true, canDisconnect: false, single: true});
  assert.deepEqual(outline(joint).slice(6, 10), ['join-figure', 'disconnect-segment', 'segment-values', 'camera-follow']);
  assert.equal(joint.find(row => commandOf(row) === 'disconnect-segment')[4], true, 'Disconnect segment is off where the branch cannot come off');

  assert.equal(outline(canvasMenuItems({hit: true, title: 'Clip', movieclip: true})).includes('edit-in-build-mode'), false, 'a movieclip has no Edit in Build');
  assert.equal(canvasMenuItems({hit: true, title: '2 figures', single: false}).find(row => commandOf(row) === 'edit-in-build-mode')[4], true,
    'Edit in Build waits for a single figure');
});

test('selection-more keeps Join among the pose commands', () => {
  const join = ['join-figure', 'link', 'Join figure', '', false];
  assert.deepEqual(commandsIn(selectionMoreItems({join})),
    ['select-same', 'select-invert', 'locate-previous', 'locate-next', 'join-figure', 'add-to-library', 'zoom-selection']);
});
