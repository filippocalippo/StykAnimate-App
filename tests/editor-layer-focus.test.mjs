import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {ownedEditorSync, ownedEditorFor, ownedEditorWithDrawings} from './support/owned-editor.mjs';
import {emptyDocument, createFrame, createObject} from '../src/demo.mjs';
import {figureFocusLocked, layerFocusLocked} from '../src/editor-layer-focus.mjs';
import {createLayerState, layerLocked} from '../src/layers.mjs';
import {createDrawingFigure} from '../src/drawing-model.mjs';
import {DrawingController} from '../src/drawing-controller.mjs';
import {clipboardSnapshot, restoreClipboard, pasteSheetClipboard} from '../src/shared-clipboard.mjs';
import {organizeTimelineRows, timelineOrganizationMethods} from '../src/timeline-organization.mjs';

function fixture({joined = false} = {}) {
  const report = emptyDocument(), figure = report.figure_types[0];
  report.keyframes = [createFrame([
    createObject(figure, 1, 100, 100),
    createObject(figure, 2, 400, 100, joined ? {join: {target_object_slot: 0, target_unique_id: 1, target_handle_id: 1}} : {}),
    createObject(figure, 3, 600, 100),
  ], 10)];
  const editor = ownedEditorFor({demo: false, layerTimeline: true}, report);
  editor.createLayer('Hands'); editor.createLayer('Reference');
  editor.assignFiguresToLayer([2], 'layer-2'); editor.assignFiguresToLayer([3], 'layer-3');
  editor.select(1); editor.markSaved();
  return editor;
}

test('view-only multi-layer focus survives selecting reference artwork and changes no saved data', () => {
  const editor = fixture(), before = editor.serialize(), revision = editor.revision, history = editor._undo.length;
  editor.setLayerFocus(['layer-1', 'layer-2']);
  assert.deepEqual([...editor.getLayerFocus().ids], ['layer-1', 'layer-2']);
  assert.deepEqual(editor.serialize(), before);
  assert.equal(editor.revision, revision); assert.equal(editor.dirty, false); assert.equal(editor._undo.length, history);
  assert.ok(editor.getLayers().every(layer => !layer.locked));
  editor.select(3);
  assert.equal(editor.selectedUid, 3);
  assert.deepEqual([...editor.getLayerFocus().ids], ['layer-1', 'layer-2']);
  assert.equal(editor.clearLayerFocus(), true); assert.equal(editor.getLayerFocus(), null);
});

test('Focus and lock preserves saved locks, visibility, history and source report copies', () => {
  const editor = fixture(); editor.setLayerLocked('layer-2', true); editor.setLayerVisible('layer-3', false); editor.markSaved();
  const before = editor.serialize(), revision = editor.revision, history = editor._undo.length;
  editor.setLayerFocus(['layer-1', 'layer-2'], {lock: true});
  assert.equal(editor.getLayer('layer-1').locked, false);
  assert.equal(editor.getLayer('layer-2').locked, true); assert.equal(editor.getLayer('layer-2').savedLocked, true);
  assert.equal(editor.getLayer('layer-3').locked, true); assert.equal(editor.getLayer('layer-3').savedLocked, false);
  assert.equal(editor.getLayer('camera').focusLocked, true); assert.equal(editor.getLayer('scene').focusLocked, true);
  assert.equal(layerLocked(editor.report, 3), true); assert.equal(layerLocked(before, 3), false);
  assert.equal(figureFocusLocked(editor.report, 3), true); assert.equal(layerFocusLocked(before, 'camera'), false);
  assert.deepEqual(editor.serialize(), before);
  assert.equal(editor.revision, revision); assert.equal(editor.dirty, false); assert.equal(editor._undo.length, history);
  editor.select(3); assert.equal(editor.selectedUid, 1);
  editor.selectMany([1, 2, 3]); assert.deepEqual([...editor.selectedUids], [1, 2]);
  editor._selectIds(new Set([1, 3])); assert.deepEqual([...editor.selectedUids], [1]);
  editor.clearLayerFocus();
  assert.equal(editor.getLayer('layer-3').locked, false); assert.equal(editor.getLayer('layer-2').locked, true);
  assert.equal(editor.getLayer('layer-3').visible, false);
});

test('temporary locks reject off-focus sheet edits before publication', () => {
  const editor = ownedEditorFor({demo: false, layerTimeline: true}, fixture().report); editor.createDrawingLayer('Sketch'); editor.select(1); editor.markSaved();
  editor.setLayerFocus(['layer-1', 'layer-2'], {lock: true});
  const before = editor.serialize(), history = editor._undo.length;
  assert.throws(() => editor.sheetInsertKey(['layer-3'], 3), /Unlock Reference/);
  assert.throws(() => editor.sheetInsertKey(['scene'], 3), /Unlock Scene/);
  assert.throws(() => editor.scaleFiguresInFrames(2, undefined, {uids: [3], atPlayhead: true}), /Unlock Reference/);
  assert.deepEqual(editor.serialize(), before); assert.equal(editor._undo.length, history);
});

test('temporary locks keep off-focus layers out of the sheet selection', () => {
  const editor = ownedEditorFor({demo: false, layerTimeline: true}, fixture().report); editor.createDrawingLayer('Sketch'); editor.select(1); editor.markSaved();
  editor.setLayerFocus(['layer-1', 'layer-2'], {lock: true});
  assert.equal(editor.selectSheetLayer('layer-3'), false); assert.equal(editor.selectedUid, 1);
  assert.equal(editor.selectSheetLayer('layer-2'), true); assert.equal(editor.selectedUid, 2);
  editor.seek(2); assert.equal(editor.selectedUid, 2);
});

test('connected, branch, same-definition, invert and marquee selection respect temporary locks', () => {
  const editor = fixture({joined: true}); editor.setLayerFocus(['layer-1'], {lock: true});
  editor.selectConnected(1); assert.deepEqual([...editor.selectedUids], [1]);
  editor.selectBranch(1, 0); assert.deepEqual([...editor.selectedUids], [1]);
  assert.equal(editor.toggleSegment(2, 0), false); assert.equal(editor.selectBranch(2, 0), false);
  editor.selectSameDefinition(); assert.deepEqual([...editor.selectedUids], [1]);
  editor.invertSelection(); assert.equal(editor.selectedUids.size, 0);
  editor.selectMarquee([1, 2, 3]); assert.deepEqual([...editor.selectedUids], [1]);
  editor.selectMarquee([2, 3], {mode: 'add'}); assert.deepEqual([...editor.selectedUids], [1]);
});

test('posing a focused parent cannot commit changes to an off-focus joined attachment', () => {
  const editor = fixture({joined: true}); editor.setLayerFocus(['layer-1'], {lock: true}); editor.select(1, 0);
  const before = editor.serialize(), history = editor._undo.length;
  editor.beginDrag('Rotate parent'); editor.rotateJoint(.2);
  assert.throws(() => editor.commitDrag(), /Unlock Hands/);
  assert.equal(editor._drag, null); assert.equal(editor._authoredPoseEdit, null);
  assert.deepEqual(editor.serialize(), before); assert.equal(editor._undo.length, history);
});

test('deleting focused layers prunes the focus and deleting its last layer releases every temporary lock', () => {
  const editor = fixture(); editor.setLayerFocus(['layer-1', 'layer-2'], {lock: true});
  editor.deleteLayer('layer-2'); assert.deepEqual([...editor.getLayerFocus().ids], ['layer-1']);
  editor.deleteLayer('layer-1'); assert.equal(editor.getLayerFocus(), null);
  assert.ok(editor.getLayers().every(layer => !layer.focusLocked));
  editor.undo(); assert.equal(editor.getLayerFocus(), null);
});

test('replacing a document releases focus on both the replacement and retained old report', () => {
  const editor = fixture(), previous = editor.report;
  editor.setLayerFocus(['layer-1'], {lock: true});
  editor.load(emptyDocument());
  assert.equal(editor.getLayerFocus(), null); assert.equal(layerFocusLocked(previous, 'scene'), false);
  assert.ok(editor.getLayers().every(layer => !layer.focusLocked));
});

test('invalid focus changes are atomic and identical focus changes preserve the shared set', () => {
  const editor = fixture(); editor.setLayerFocus(['layer-1'], {lock: true});
  const focus = editor.getLayerFocus(), revision = editor.layerRevision;
  assert.throws(() => editor.setLayerFocus(['layer-1', 'missing']));
  assert.throws(() => editor.setLayerFocus([])); assert.throws(() => editor.setLayerFocus(['scene']));
  assert.throws(() => editor.setLayerFocus(['layer-1'], {lock: 'yes'}));
  assert.equal(editor.getLayerFocus(), focus); assert.equal(editor.layerRevision, revision);
  assert.equal(editor.setLayerFocus(['layer-1'], {lock: true}), false); assert.equal(editor.getLayerFocus(), focus);
});

for (const lock of [false, true]) {
  test(`new layers join ${lock ? 'Focus and lock' : 'view-only focus'} before their creation event`, () => {
    const editor = fixture(); editor.setLayerFocus(['layer-1'], {lock});
    const focus = editor.getLayerFocus(), history = editor._undo.length, events = [];
    editor.addEventListener('change', event => {
      if (event.detail.kind === 'edit') events.push(editor.getLayerFocus().ids.has(editor.activeLayerId));
    });
    const layer = editor.createLayer('New artwork');
    assert.equal(editor.getLayerFocus(), focus); assert.deepEqual([...focus.ids], ['layer-1', layer.id]);
    assert.deepEqual(events, [true]); assert.equal(editor._undo.length, history + 1);
    assert.equal(layer.locked, false); assert.equal(layer.savedLocked, false);
    assert.equal(editor.getLayer('layer-2').focusLocked, lock);
    assert.equal(editor.report._styk.layers.byId[layer.id].locked, false);
    editor.undo(); assert.deepEqual([...editor.getLayerFocus().ids], ['layer-1']);
  });

  test(`the first Draw stroke can create and select its layer during ${lock ? 'Focus and lock' : 'view-only focus'}`, () => {
    // Creating the layer is the engine session's: the layer joins the focus the editor holds.
    const {editor} = ownedEditorSync({demo: false, layerTimeline: true}, fixture().report, {recorded: false}); editor.setLayerFocus(['layer-1'], {lock}); editor.selectSheetLayer('layer-1');
    const history = editor._undo.length, selected = [];
    const drawing = {editor, tool: 'brush', state: {}, onStatus() {}, sync() {}, onUI() {},
      getTimeline: () => ({selectTrack: id => selected.push(id)})};
    DrawingController.prototype.ensurePaintLayer.call(drawing);
    const layer = editor.getLayer(drawing.state.selectedTrackId);
    assert.ok(layer.drawing); assert.equal(layer.locked, false); assert.equal(layer.savedLocked, false);
    assert.equal(editor.activeLayerId, layer.id); assert.deepEqual(selected, [layer.id]);
    assert.deepEqual([...editor.getLayerFocus().ids], ['layer-1', layer.id]);
    assert.equal(editor.report._styk.layerSheet.tracks[layer.id].keys.length, 1);
    assert.equal(editor._undo.length, history + 1);
    editor.undo(); assert.deepEqual([...editor.getLayerFocus().ids], ['layer-1']);
  });

  test(`a drawing converted to a movieclip stays focused and selected during ${lock ? 'Focus and lock' : 'view-only focus'}`, () => {
    const report = emptyDocument(), figure = createDrawingFigure({figureTypeId: 1, pixelsPerUnit: 1});
    report.figure_types = [figure]; report.keyframes = [createFrame([createObject(figure, 1, 10, 10)], 2)];
    report._styk ??= {}; report._styk.layers = createLayerState(); report._styk.layers.byId['layer-1'].drawing = {version: 1};
    const editor = ownedEditorFor({demo: false, layerTimeline: true}, report);
    editor.setLayerFocus(['layer-1'], {lock}); editor.select(1);
    const before = editor.serialize(), history = editor._undo.length;
    editor.createMovieclip({start: 0, end: 1, name: 'Clip'});
    const uid = editor.selectedUid, owner = editor.layerForUid(uid), layer = editor.getLayer(owner);
    assert.notEqual(uid, 1); assert.ok(editor.object); assert.ok(editor.figure._styk.movieclip);
    assert.equal(editor.activeLayerId, owner); assert.equal(layer.locked, false); assert.equal(layer.savedLocked, false);
    assert.deepEqual([...editor.getLayerFocus().ids], ['layer-1', owner]);
    assert.equal(editor.report._styk.layers.byId[owner].locked, false);
    assert.equal(editor._undo.length, history + 1);
    editor.undo(); assert.deepEqual(editor.serialize(), before); assert.equal(editor.selectedUid, 1);
    assert.deepEqual([...editor.getLayerFocus().ids], ['layer-1']);
  });
}

test('cross-project frame paste can add missing focused layers without unlocking existing references', async () => {
  const source = fixture(); source.sheetCopyFrames(['layer-1', 'layer-2'], 0, 1);
  const editor = ownedEditorFor({demo: false, layerTimeline: true}, emptyDocument());
  const reference = editor.createLayer('Reference'); editor.setLayerFocus(['layer-1'], {lock: true});
  await restoreClipboard(editor, clipboardSnapshot(source, 'sheet'));
  const before = editor.serialize(), history = editor._undo.length;
  pasteSheetClipboard(editor, ['layer-1'], 0);
  const added = editor.report._styk.layers.order.find(id => !['layer-1', reference.id].includes(id));
  assert.ok(added); assert.deepEqual([...editor.getLayerFocus().ids], ['layer-1', added]);
  assert.equal(editor.getLayer(added).locked, false); assert.equal(editor.getLayer(reference.id).focusLocked, true);
  assert.equal(editor.getLayer(reference.id).savedLocked, false); assert.equal(editor._undo.length, history + 1);
  assert.ok(editor.report._styk.layerSheet.tracks[added].keys.length);
  editor.undo(); assert.deepEqual(editor.serialize(), before); assert.deepEqual([...editor.getLayerFocus().ids], ['layer-1']);
});

test('revealing an off-focus selection keeps the focused rows until Show all', () => {
  const rows = [{id: 'camera', kind: 'camera', name: 'Camera'}, {id: 'layer-1', kind: 'layer', name: 'Body'}];
  let resets = 0;
  const timeline = {tracks: rows, selectedTrackId: 'layer-3', focusedLayerIds: new Set(['layer-1']),
    setLayerFilter() { resets++; }, layout: {pinned: false, system: 1}, _offsetY() { return 0; }};
  timelineOrganizationMethods.revealSelectedLayer.call(timeline);
  assert.equal(resets, 0); assert.deepEqual(timeline.tracks, rows);
});

test('folder filtering reveals matching descendants and keeps empty folders available during focus', () => {
  const rows = [{id: 'camera', kind: 'camera', name: 'Camera'},
    {id: 'folder-1', kind: 'folder', name: 'Character', layerIds: ['layer-1', 'layer-2']},
    {id: 'layer-2', kind: 'layer', name: 'Hands'}, {id: 'layer-1', kind: 'layer', name: 'Body'},
    {id: 'folder-2', kind: 'folder', name: 'Empty', layerIds: []},
    {id: 'layer-3', kind: 'layer', name: 'Reference'}];
  assert.deepEqual(organizeTimelineRows(rows, 'character').map(row => row.id), ['camera', 'folder-1', 'layer-2', 'layer-1']);
  assert.deepEqual(organizeTimelineRows(rows, 'hands').map(row => row.id), ['camera', 'folder-1', 'layer-2']);
  assert.deepEqual(organizeTimelineRows(rows, '', new Set(['layer-3'])).map(row => row.id), ['camera', 'folder-2', 'layer-3']);
  assert.deepEqual(organizeTimelineRows(rows, 'empty').map(row => row.id), ['camera', 'folder-2']);
  assert.deepEqual(organizeTimelineRows(rows), rows);
});

test('the engine session holds what Focus and lock holds, and nothing once the lock is off', () => {
  const editor = fixture(), before = editor.serialize(), history = editor._undo.length;
  // An edit that is made and taken back, so the next check starts from the same document.
  const insert = id => { const depth = editor._undo.length; editor.sheetInsertKey([id], 3); while (editor._undo.length > depth) editor.undo(); };
  assert.equal(editor.layerFocusLock(), null);
  editor.setLayerFocus(['layer-1', 'layer-2']); assert.equal(editor.layerFocusLock(), null, 'a focus that only filters holds nothing');
  assert.doesNotThrow(() => insert('layer-3'));
  editor.setLayerFocus(['layer-1', 'layer-2'], {lock: true}); assert.deepEqual(editor.layerFocusLock(), ['layer-1', 'layer-2']);
  assert.throws(() => insert('layer-3'), /Unlock Reference/);
  assert.doesNotThrow(() => insert('layer-2'));
  editor.clearLayerFocus(); assert.equal(editor.layerFocusLock(), null);
  assert.doesNotThrow(() => insert('layer-3'));
  assert.deepEqual(editor.serialize(), before); assert.equal(editor._undo.length, history);
});

test('a saved lock and a focus lock refuse the same edit the same way', () => {
  const saved = fixture(), focused = fixture();
  saved.setLayerLocked('layer-3', true); focused.setLayerFocus(['layer-1', 'layer-2'], {lock: true});
  const message = (editor, edit) => { try { edit(editor); } catch (error) { return error.message; } return null; };
  for (const edit of [e => e.sheetInsertKey(['layer-3'], 3), e => e.assignFiguresToLayer([1], 'layer-3'), e => e.deleteLayer('layer-3'),
    e => e.scaleFiguresInFrames(2, undefined, {uids: [3], atPlayhead: true})])
    assert.equal(message(focused, edit), message(saved, edit)), assert.match(message(focused, edit), /Unlock Reference/);
  assert.equal(focused.getLayer('layer-3').savedLocked, false);
});

test('Focus changes never write the layer revision, which the engine session counts, so no key stands for two states', () => {
  const editor = fixture(), keys = [editor.layerViewKey], revision = editor.layerRevision;
  editor.setLayerFocus(['layer-1'], {lock: true}); keys.push(editor.layerViewKey);
  assert.equal(editor.layerRevision, revision, 'the focus is not a change of the session\'s layers');
  editor.renameLayer('layer-2', 'Renamed'); keys.push(editor.layerViewKey);
  editor.clearLayerFocus(); keys.push(editor.layerViewKey);
  editor.renameLayer('layer-3', 'Renamed too'); keys.push(editor.layerViewKey);
  editor.setLayerFocus(['layer-1']); keys.push(editor.layerViewKey);
  assert.equal(new Set(keys).size, keys.length, `${keys}`);
});
