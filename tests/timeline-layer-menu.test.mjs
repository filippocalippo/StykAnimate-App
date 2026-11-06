import test from 'node:test';
import assert from 'node:assert/strict';
import {ownedEditorSync} from './support/owned-editor.mjs';
import {emptyDocument} from '../src/demo.mjs';
import {timelineLayerMenuGroups} from '../src/timeline-menu.mjs';
import {timelineLayerFolderMethods} from '../src/timeline-layer-folders.mjs';

function fixture() {
  const {editor} = ownedEditorSync({demo: false, layerTimeline: true}, emptyDocument(), {recorded: false});
  editor.createLayer('Drawing'); editor.createLayer('Foreground');
  const host = {
    editor, selectedTrackId: 'layer-2', ids: ['layer-2'], labels: [], focusedLayerIds: null,
    _run: action => action(), ...timelineLayerFolderMethods,
    focusSelectedLayers(options) { if (options) editor.setLayerFocus(options.ids, {lock: options.lock ?? false}); else editor.clearLayerFocus(); },
    reorderLayer(direction) { const order = editor.report._styk.layers.order; editor.moveLayerTo(this.selectedTrackId, order.indexOf(this.selectedTrackId) - direction); },
    newLayer(kind) { return kind === 'drawing' ? editor.createDrawingLayer() : editor.createLayer(); },
    deleteLayer() { return editor.deleteLayer(this.selectedTrackId); },
  };
  return {host, editor, rows: () => timelineLayerMenuGroups(host).flat().filter(Boolean)};
}
const find = (rows, key) => rows.find(row => row.labelKey === key);
const children = (rows, key) => find(rows, key).submenu.flat().filter(Boolean);

test('a compact layer menu retains common edits and groups related commands without changing selection or the document', () => {
  const {host, editor, rows} = fixture(), before = editor.serialize();
  const menu = rows();
  assert.ok(menu.filter(row => !row.heading).length <= 7, 'ordinary layer menu fits seven command rows');
  assert.ok(find(menu, 'layerTimeline.renameLayer'));
  assert.ok(find(menu, 'layerTimeline.layerColor'));
  assert.ok(find(menu, 'layerTimeline.deleteLayer').danger);
  const organize = children(menu, 'timelineMenu.organize');
  for (const key of ['layerFolders.newFolder', 'layerFolders.group', 'layerTimeline.moveLayerUp', 'layerTimeline.moveLayerDown']) assert.ok(find(organize, key), key);
  assert.deepEqual(host.ids, ['layer-2']);
  assert.deepEqual(editor.serialize(), before);
  find(organize, 'layerTimeline.moveLayerUp').action();
  assert.deepEqual(editor.report._styk.layers.order, ['layer-1', 'layer-3', 'layer-2']);
  editor.undo(); assert.deepEqual(editor.serialize(), before);
});

test('focus submenu uses the complete selected layer set and releases session locks through Show all', () => {
  const {host, editor, rows} = fixture(), before = editor.serialize();
  host.ids = ['layer-2', 'layer-3'];
  const focus = children(rows(), 'timelineMenu.focus');
  assert.ok(find(focus, 'layerTimeline.focusSelectedLayers'));
  find(focus, 'timelineOrganization.focusAndLock').action();
  assert.deepEqual([...editor.getLayerFocus().ids], ['layer-2', 'layer-3']);
  assert.equal(editor.isLayerFocusLocked('layer-1'), true);
  assert.deepEqual(editor.serialize(), before, 'focus never authors saved locks');
  host.focusedLayerIds = editor.getLayerFocus().ids;
  find(children(rows(), 'timelineMenu.focus'), 'layerTimeline.showAllLayers').action();
  assert.equal(editor.getLayerFocus(), null);
});

test('visibility, saved lock, colour and creation commands retain their existing editor semantics', () => {
  const {editor, rows} = fixture();
  find(children(rows(), 'timelineMenu.visibilityAndLock'), 'layerTimeline.hideLayer').action();
  assert.equal(editor.getLayer('layer-2').visible, false); editor.undo();
  find(children(rows(), 'timelineMenu.visibilityAndLock'), 'layerTimeline.lockLayer').action();
  assert.equal(editor.getLayer('layer-2').savedLocked, true);
  assert.equal(find(rows(), 'layerTimeline.deleteLayer'), undefined);
  find(children(rows(), 'timelineMenu.visibilityAndLock'), 'layerTimeline.unlockLayer').action();
  const colors = children(rows(), 'layerTimeline.layerColor');
  find(colors, 'layerTimeline.color.violet').action();
  assert.equal(editor.getLayer('layer-2').color, 'violet');
  assert.equal(find(children(rows(), 'layerTimeline.layerColor'), 'layerTimeline.color.violet').checked, true);
  find(children(rows(), 'timelineMenu.newLayer'), 'layerTimeline.newDrawingLayer').action();
  assert.ok(editor.layers.at(-1).drawing);
});

test('focus locks and stack boundaries remain reflected in menu availability, including fixed tracks', () => {
  const {host, editor, rows} = fixture();
  editor.setLayerFocus(['layer-3'], {lock: true});
  assert.equal(find(children(rows(), 'timelineMenu.visibilityAndLock'), 'layerTimeline.lockLayer').disabled, true);
  assert.equal(find(rows(), 'layerTimeline.deleteLayer'), undefined);
  host.selectedTrackId = 'layer-3'; host.ids = ['layer-3'];
  assert.equal(find(children(rows(), 'timelineMenu.organize'), 'layerTimeline.moveLayerUp').disabled, true);
  host.selectedTrackId = 'camera'; host.ids = ['camera'];
  assert.equal(find(rows(), 'timelineMenu.focus'), undefined);
  assert.equal(find(rows(), 'layerTimeline.renameLayer'), undefined);
  assert.equal(find(children(rows(), 'timelineMenu.visibilityAndLock'), 'layerTimeline.lockLayer').disabled, true);
  assert.equal(find(children(rows(), 'timelineMenu.organize'), 'layerTimeline.moveLayerUp'), undefined);
});

test('Organize moves multiple selected layers into a folder in one undoable action', () => {
  const {host, editor, rows} = fixture();
  const folder = editor.createLayerFolder('Shot');
  host.ids = ['layer-2', 'layer-3'];
  const before = editor.serialize(), history = editor._undo.length;
  const destinations = children(children(rows(), 'timelineMenu.organize'), 'layerFolders.move');
  assert.equal(destinations.length, 1);
  destinations[0].action();
  assert.equal(editor._undo.length, history + 1);
  assert.equal(editor.getLayer('layer-2').folderId, folder.id);
  assert.equal(editor.getLayer('layer-3').folderId, folder.id);
  editor.undo(); assert.deepEqual(editor.serialize(), before);
});
