import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor, emptyDocument} from '../src/editor.mjs';
import {applyLayerOrder, layerVisible, layerLocked, validateLayerState} from '../src/layers.mjs';

const userIds = editor => editor.layers.filter(layer => !layer.permanent).map(layer => layer.id);
const setOf = values => new Set(values);
const blank = () => { const editor = new Editor({demo: false}); editor.addFigure(); editor.markSaved(); return editor; };

test('capturing existing authored figures preserves layer hierarchy caches while maintaining source retention counts', () => {
  const editor = blank(), uid = editor.selectedUid; editor.adoptNativePoseTrack({kind: 'layer', id: 'layer-1'});
  const revision = editor.layerRevision, descriptors = editor.layers, members = editor.getLayerFigureUids('layer-1'), count = editor._layerUidCounts.get(uid);
  const events = []; editor.addEventListener('change', event => events.push(event.detail));
  editor.beginTranslationDrag(); editor.moveSelection(10, 2); editor.commitDrag();
  assert.equal(editor.layerRevision, revision); assert.equal(editor.layers, descriptors); assert.equal(editor.getLayerFigureUids('layer-1'), members);
  assert.equal(editor._layerUidCounts.get(uid), count + 1); assert.equal(events.at(-1).layers, undefined);
  editor.undo(); assert.equal(editor.layerRevision, revision); editor.redo(); assert.equal(editor.layerRevision, revision);
  editor.addFigure(); assert.ok(editor.layerRevision > revision); assert.equal(editor.getLayerFigureUids('layer-1').length, 2);
});

test('pose snapshots omit runtime caches before cloning and retain independent unknown fields', () => {
  const editor = blank(), frame = editor.evaluatedFrame, object = frame.objects[0];
  object.extra_native_fields = {values: [4, 8]};
  Object.defineProperty(object, 'runtime_segments', {enumerable: true, configurable: true, get() { throw new Error('Transient cache should never be visited'); }});
  const id = editor.captureFrameSource(frame), source = editor.getFrameById(id);
  assert.equal(Object.hasOwn(source.objects[0], 'runtime_segments'), false); assert.deepEqual(source.objects[0].extra_native_fields, object.extra_native_fields);
  object.extra_native_fields.values[0] = 99; assert.equal(source.objects[0].extra_native_fields.values[0], 4);
  delete object.runtime_segments;
});

test('authored pose commit retains exact displayed geometry during notification and releases it on later edits', () => {
  const editor = blank(); editor.adoptNativePoseTrack({kind: 'layer', id: 'layer-1'}); editor.geometry;
  editor.beginTranslationDrag(); editor.moveSelection(12, -3); const preview = editor.geometry;
  let notified;
  editor.addEventListener('change', event => { if (event.detail.animation && !editor.dragging) notified = editor.geometry; });
  editor.commitDrag(); assert.equal(notified, preview); assert.equal(editor.geometry, preview); assert.equal(editor._authoredCommitPreview, null);
  const source = editor.evaluatedFrame; editor._invalidate({viewOnly: true});
  assert.notEqual(editor.evaluatedFrame, source);
  const rebuilt = editor.geometry;
  for (const [slot, original] of preview.objects) {
    const next = rebuilt.objects.get(slot); assert.deepEqual(next.root, original.root);
    assert.deepEqual([...next.joints], [...original.joints]);
  }
  editor.beginTranslationDrag(); editor.moveSelection(1, 0); editor.commitDrag(); assert.notEqual(editor.geometry, preview);
  editor.undo(); assert.equal(editor._authoredCommitPreview, null);
});

test('native imports start with one user layer containing all project figure identities', () => {
  const editor = new Editor();
  assert.deepEqual(editor.layers.map(({id, kind, permanent}) => ({id, kind, permanent})), [
    {id: 'scene', kind: 'scene', permanent: true}, {id: 'camera', kind: 'camera', permanent: true},
    {id: 'layer-1', kind: 'layer', permanent: false},
  ]);
  const nativeUids = new Set(editor.report.keyframes.flatMap(frame => frame.objects.map(object => object.unique_id)));
  assert.deepEqual(setOf(editor.getLayerFigureUids('layer-1')), nativeUids);
  assert.equal(editor.activeLayerId, 'layer-1');
  assert.deepEqual(editor.report._styk.layers.assignments, {});
  for (const uid of nativeUids) assert.equal(editor.layerForUid(uid), 'layer-1');
  assert.deepEqual(editor.getLayerFigureUids('scene'), []);
});

test('user layer creation, rename, reorder and deletion form reversible sparse history', () => {
  const editor = new Editor(), before = editor.serialize();
  const originalFrames = editor.report.keyframes, firstFrame = editor.frame;
  const created = editor.createLayer('  Foreground  ');
  assert.equal(created.name, 'Foreground'); assert.equal(editor.activeLayerId, created.id);
  editor.renameLayer(created.id, 'Characters');
  editor.moveLayerTo(created.id, 0);
  assert.deepEqual(userIds(editor), [created.id, 'layer-1']);
  editor.deleteLayer(created.id);
  assert.deepEqual(userIds(editor), ['layer-1']); assert.equal(editor.activeLayerId, 'layer-1');
  assert.equal(editor.report.keyframes, originalFrames); assert.equal(editor.frame, firstFrame);
  for (const command of editor._undo) {
    assert.equal(command.kind, 'layers');
    assert.equal('before' in command, false); assert.equal('after' in command, false);
    assert.ok(JSON.stringify(command).length < 2200, 'Layer history must not copy scene frames.');
  }
  while (editor.canUndo) editor.undo();
  assert.deepEqual(editor.serialize(), before);
  while (editor.canRedo) editor.redo();
  assert.deepEqual(userIds(editor), ['layer-1']);
});

test('Scene and Camera are permanent tracks and the final user layer cannot be removed', () => {
  const editor = new Editor(), before = editor.serialize();
  for (const id of ['scene', 'camera']) {
    assert.throws(() => editor.renameLayer(id, 'Changed'), /permanent/);
    assert.throws(() => editor.deleteLayer(id), /cannot be deleted/);
    assert.throws(() => editor.moveLayerTo(id, 0), /valid user layer/);
    assert.throws(() => editor.assignFiguresToLayer([editor.selectedUid], id), /user layers/);
  }
  assert.throws(() => editor.deleteLayer('layer-1'), /at least one/);
  assert.throws(() => editor.reorderLayers(['scene', 'camera', 'layer-1']), /every user layer/);
  assert.deepEqual(editor.serialize(), before); assert.equal(editor.canUndo, false);
  editor.setActiveLayer('camera'); assert.equal(editor.activeLayerId, 'camera');
  assert.equal(editor.canUndo, false); assert.equal(editor.dirty, false);
});

test('figure layer assignments persist across every frame without changing native objects or joins', () => {
  const editor = blank(), parent = editor.selectedUid, child = editor.duplicateFigure().unique_id;
  editor.joinTo(parent, 2); editor.duplicateFrame();
  const beforeFrames = structuredClone(editor.report.keyframes), refs = editor.report.keyframes.map(frame => frame.objects);
  const foreground = editor.createLayer('Foreground').id;
  editor.assignFiguresToLayer([child, child], foreground);
  assert.equal(editor.layerForUid(child), foreground); assert.equal(editor.layerForUid(parent), 'layer-1');
  assert.deepEqual(editor.getLayerFigureUids(foreground), [child]);
  assert.deepEqual(editor.getLayerFigureUids('layer-1'), [parent]);
  assert.deepEqual(editor.report.keyframes, beforeFrames);
  editor.report.keyframes.forEach((frame, index) => assert.equal(frame.objects, refs[index]));
  editor.selectFrame(0); assert.equal(editor.layerForUid(child), foreground);
  editor.undo(); assert.equal(editor.layerForUid(child), 'layer-1'); assert.deepEqual(editor.getLayerFigureUids(foreground), []);
  editor.redo(); assert.equal(editor.layerForUid(child), foreground); assert.deepEqual(editor.report.keyframes, beforeFrames);
});

test('deleting the default layer reassigns implicit and explicit membership and restores it on undo', () => {
  const editor = new Editor(), source = editor.getLayerFigureUids('layer-1').slice();
  const second = editor.createLayer('Second').id, third = editor.createLayer('Third').id;
  editor.assignFiguresToLayer([source[0]], third);
  editor.assignFiguresToLayer([source[1]], 'layer-1');
  editor.setActiveLayer('layer-1'); const before = editor.serialize();
  editor.deleteLayer('layer-1');
  assert.equal(editor.report._styk.layers.defaultLayerId, second); assert.equal(editor.activeLayerId, second);
  for (const uid of source.slice(1)) assert.equal(editor.layerForUid(uid), second);
  assert.equal(editor.layerForUid(source[0]), third);
  assert.deepEqual(setOf(editor.getLayerFigureUids(second)), setOf(source.slice(1)));
  editor.undo(); assert.deepEqual(editor.serialize(), before);
  editor.redo(); assert.doesNotThrow(() => validateLayerState(editor.report._styk.layers));
});

test('new figures use the active layer while figure duplicates preserve their source layer', () => {
  const editor = blank(), source = editor.selectedUid;
  const second = editor.createLayer('Second').id;
  editor.addFigure(); const added = editor.selectedUid;
  assert.equal(editor.layerForUid(added), second); assert.deepEqual(editor.getLayerFigureUids(second), [added]);
  editor.undo(); assert.deepEqual(editor.getLayerFigureUids(second), []);
  editor.redo(); assert.equal(editor.layerForUid(added), second); assert.deepEqual(editor.getLayerFigureUids(second), [added]);
  editor.select(source); const duplicate = editor.duplicateFigure().unique_id;
  assert.equal(editor.layerForUid(duplicate), 'layer-1');
  editor.setActiveLayer('camera'); editor.addFigure(); assert.equal(editor.layerForUid(editor.selectedUid), 'layer-1');
});

test('visibility, lock, and track state survive native project serialization and reopening', () => {
  const editor = new Editor(), second = editor.createLayer('Actors').id, uid = editor.selectedUid;
  editor.assignFiguresToLayer([uid], second);
  editor.setLayerVisible(second, false); editor.setLayerLocked(second, true);
  editor.setLayerVisible('scene', false); editor.setLayerLocked('camera', true);
  assert.equal(layerVisible(editor.report, uid), false); assert.equal(layerLocked(editor.report, uid), true);
  const saved = editor.serialize(), reopened = new Editor({demo: false}); reopened.load(saved);
  assert.deepEqual(reopened.layers, editor.layers);
  assert.equal(reopened.activeLayerId, second); assert.equal(reopened.layerForUid(uid), second);
  editor.undo(); assert.equal(editor.getLayer('camera').locked, false);
  editor.undo(); assert.equal(editor.getLayer('scene').visible, true);
  editor.undo(); assert.equal(layerLocked(editor.report, uid), false);
  editor.undo(); assert.equal(layerVisible(editor.report, uid), true);
});

test('layer paint grouping is stable and never changes native object slots or attachment references', () => {
  const editor = blank(), parent = editor.selectedUid, child = editor.duplicateFigure().unique_id;
  editor.joinTo(parent, 2); editor.addFigure(); const third = editor.selectedUid;
  editor.addFigure(); const fourth = editor.selectedUid;
  const second = editor.createLayer('Front').id;
  editor.assignFiguresToLayer([parent, third], second);
  const frame = editor.frame;
  frame.object_draw_order = [3, 0, 1, 2]; frame.object_draw_order_unique_ids = [fourth, parent, child, third];
  const before = structuredClone(frame), output = applyLayerOrder(editor.report, frame);
  assert.deepEqual(output.object_draw_order, [3, 1, 0, 2]);
  assert.deepEqual(output.object_draw_order_unique_ids, [fourth, child, parent, third]);
  assert.equal(output.objects, frame.objects); assert.deepEqual(frame, before);
  assert.equal(output.objects[1].join.target_unique_id, parent);
  assert.equal(applyLayerOrder(editor.report, output), output, 'Already grouped frames reuse their reference.');
  editor.moveLayerTo(second, 0);
  assert.deepEqual(applyLayerOrder(editor.report, frame).object_draw_order, [0, 2, 3, 1]);
});

test('object dragging keeps layer indexes, descriptors and revision stable', () => {
  const editor = new Editor(), layer = editor.createLayer('Selected').id;
  editor.assignFiguresToLayer([editor.selectedUid], layer);
  const revision = editor.layerRevision, descriptors = editor.layers, members = editor.getLayerFigureUids(layer), counts = editor._layerUidCounts;
  editor.beginDrag('Move figure');
  for (let index = 0; index < 120; index++) { editor.object.root_x += 1; editor.touch(); }
  editor.commitDrag();
  assert.equal(editor.layerRevision, revision); assert.equal(editor.layers, descriptors);
  assert.equal(editor.getLayerFigureUids(layer), members); assert.equal(editor._layerUidCounts, counts);
  assert.equal(editor._undo.at(-1).kind, 'objects');
  editor.undo(); assert.equal(editor.layerRevision, revision); editor.redo(); assert.equal(editor.layerRevision, revision);
});

test('a figure remains a project layer member until its final native occurrence is deleted', () => {
  const editor = blank(), uid = editor.selectedUid, layer = editor.createLayer('Actor').id;
  editor.assignFiguresToLayer([uid], layer); editor.duplicateFrame();
  editor.deleteFigure();
  assert.deepEqual(editor.getLayerFigureUids(layer), [uid]);
  editor.selectFrame(0); editor.select(uid); editor.deleteFigure();
  assert.deepEqual(editor.getLayerFigureUids(layer), []);
  assert.equal(editor.layerForUid(uid), layer, 'Dormant identities retain their assigned layer for undo.');
  editor.undo(); assert.deepEqual(editor.getLayerFigureUids(layer), [uid]);
  editor.undo(); assert.deepEqual(editor.getLayerFigureUids(layer), [uid]);
  editor.redo(); editor.redo(); assert.deepEqual(editor.getLayerFigureUids(layer), []);
});

test('retained authored pose sources keep their figure identities in user layers after native frame deletion', () => {
  const editor = blank(), uid = editor.selectedUid, layer = editor.createLayer('Actor').id;
  editor.assignFiguresToLayer([uid], layer);
  const frameId = editor.getFrameId(), originalFrame = structuredClone(editor.frame);
  editor.addFrame({blank: true}); editor.adoptNativePoseTrack({kind: 'layer', id: layer});
  const before = editor.serialize();
  editor.selectFrame(0); editor.deleteFrame();
  assert.equal(editor.report.keyframes.length, 1); assert.equal(editor.frame.objects.length, 0);
  assert.equal(editor.frameIndexForId(frameId), -1);
  assert.deepEqual(editor.getFrameById(frameId), originalFrame);
  assert.deepEqual(editor.getLayerFigureUids(layer), [uid], 'Authored source figures still belong to the project.');
  const reopened = new Editor({demo: false}); reopened.load(editor.serialize());
  assert.deepEqual(reopened.getLayerFigureUids(layer), [uid]);
  editor.undo(); assert.deepEqual(editor.serialize(), before);
  assert.equal(editor.frameIndexForId(frameId), 0); assert.deepEqual(editor.getLayerFigureUids(layer), [uid]);
  editor.redo(); assert.deepEqual(editor.getLayerFigureUids(layer), [uid]);
});

test('optional permanent track metadata supplies editable defaults for missing tracks', () => {
  const editor = new Editor(), document = editor.serialize();
  document._styk.layers.fixed = {scene: {visible: false, locked: false}};
  editor.load(document);
  assert.equal(editor.getLayer('camera').visible, true); assert.equal(editor.getLayer('camera').locked, false);
  editor.setLayerLocked('camera', true); assert.equal(editor.getLayer('camera').locked, true);
  editor.undo(); assert.equal(editor.getLayer('camera').locked, false);
  editor.redo(); assert.equal(editor.getLayer('camera').locked, true);
  assert.doesNotThrow(() => validateLayerState(editor.serialize()._styk.layers));
});

test('invalid layer metadata and unsafe layer identifiers never replace or corrupt the active document', () => {
  const editor = new Editor(), report = editor.report, before = editor.serialize();
  for (const id of ['__proto__', 'constructor', 'missing', 'scene']) {
    assert.throws(() => editor.renameLayer(id, 'Invalid'));
    assert.throws(() => editor.assignFiguresToLayer([editor.selectedUid], id));
  }
  assert.throws(() => editor.assignFiguresToLayer([0xffffffff], 'layer-1'), /present/);
  assert.throws(() => editor.setLayerLocked('layer-1', 1), /boolean/);
  const bad = emptyDocument(); bad._styk = {layers: structuredClone(editor.report._styk.layers)};
  bad._styk.layers.assignments['17'] = 'layer-999';
  assert.throws(() => editor.load(bad), /assignment/); assert.equal(editor.report, report);
  assert.deepEqual(editor.serialize(), before);
});
