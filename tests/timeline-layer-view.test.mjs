import test from 'node:test';
import assert from 'node:assert/strict';
import {newOwnedEditor} from './support/owned-editor.mjs';
import {emptyDocument} from '../src/demo.mjs';
import {TimelineLayerView} from '../src/timeline-layer-view.mjs';
import {layerFolderRows} from '../src/layer-folders.mjs';

const setup = () => {
  const editor = newOwnedEditor({demo: false, layerTimeline: true}).load(emptyDocument());
  editor.createLayer('Hands'); editor.createLayer('Reference');
  const folder = editor.createLayerFolder('Character', ['layer-1', 'layer-2']);
  const view = new TimelineLayerView(editor);
  return {editor, view, folder, rows: () => layerFolderRows(editor.getLayers().filter(row => row.kind === 'layer').reverse(), editor.report._styk.layers)};
};

test('row filtering changes no artwork, save bytes, undo, or focus locks', () => {
  const {editor, view, folder, rows} = setup();
  editor.setLayerFocus(['layer-1'], {lock: true});
  const before = editor.serialize(), history = editor._undo.length, revision = editor.revision;
  view.setShown(folder.id, false); view.setShown('camera', false);
  assert.deepEqual(view.project(rows()).map(row => row.id), ['layer-3']);
  assert.deepEqual(editor.serialize(), before); assert.equal(editor._undo.length, history); assert.equal(editor.revision, revision);
  assert.equal(editor.getLayerFocus().lock, true); assert.equal(editor.getLayer('layer-2').focusLocked, true);
  view.reset(); assert.equal(view.project(rows()).length, 4); assert.equal(editor.getLayerFocus().lock, true);
  view.destroy();
});

test('folder checkboxes support mixed children and include newly added children', () => {
  const {editor, view, folder} = setup();
  view.setShown(folder.id, false);
  assert.deepEqual(view.folderState(folder.id), {checked: false, mixed: false});
  const added = editor.createLayer('New child', {folderId: folder.id}); assert.equal(view.shown(added.id), false);
  view.setShown('layer-1', true);
  assert.deepEqual(view.folderState(folder.id), {checked: false, mixed: true});
  assert.equal(view.shown('layer-1'), true); assert.equal(view.shown('layer-2'), false); assert.equal(view.shown(added.id), false);
  view.setShown(folder.id, true);
  assert.deepEqual(view.folderState(folder.id), {checked: true, mixed: false}); assert.equal(view.active, false);
  view.destroy();
});

test('only selected retains containers, empty folders and collapsed folder semantics', () => {
  const {editor, view, folder, rows} = setup();
  view.showOnly(['layer-2']);
  assert.deepEqual(view.project(rows()).map(row => row.id), [folder.id, 'layer-2']);
  const collapsed = layerFolderRows(editor.getLayers().filter(row => row.kind === 'layer').reverse(), editor.report._styk.layers, new Set([folder.id]));
  assert.deepEqual(view.project(collapsed).map(row => row.id), [folder.id]);
  view.showOnly([folder.id]); assert.equal(view.shown('layer-1'), true); assert.equal(view.shown('layer-2'), true); assert.equal(view.shown('layer-3'), false);
  const empty = editor.createLayerFolder('Empty'); view.setShown(empty.id, false);
  assert.ok(!view.project(rows()).some(row => row.id === empty.id));
  view.setShown(empty.id, true); assert.ok(view.project(rows()).some(row => row.id === empty.id));
  view.destroy();
});

test('removed metadata is pruned and replacement documents start without a filter', () => {
  const {editor, view, folder} = setup();
  view.setShown(folder.id, false); view.setShown('layer-3', false);
  editor.deleteLayerFolder(folder.id); assert.equal(view.hidden.has(folder.id), false);
  editor.deleteLayer('layer-3'); assert.equal(view.hidden.has('layer-3'), false);
  view.setShown('scene', false); editor.load(emptyDocument()); assert.equal(view.active, false);
  view.destroy(); view.setShown('layer-1', false); editor.load(emptyDocument());
  assert.equal(view.active, true, 'Disposal detaches document listeners');
});
