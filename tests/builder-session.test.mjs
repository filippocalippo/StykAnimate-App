import test from 'node:test';
import assert from 'node:assert/strict';
import {ownedEditorFor} from './support/owned-editor.mjs';

import {BuilderSession} from '../src/builder-session.mjs';
import {emptyDocument, createObject, createFrame, defaultFigure} from '../src/demo.mjs';
import {validateScene} from '../src/pivot/model.mjs';
import {isDrawingLayer} from '../src/drawing-model.mjs';
import {figureDocument} from './support/engine-export.mjs';

/** One scene with two figures: the bound figure has two instances, the other
 * figure is an unjoined neighbor used to prove builder edits stay scoped. */
function fixture({layerTimeline = false} = {}) {
  const report = emptyDocument(), walker = report.figure_types[0];
  report.figure_types.push({...defaultFigure(2), name: 'Neighbor', segments: [walker.segments[0]]});
  report.keyframes = [0, 1].map(i => createFrame([
    createObject(walker, 1, 180 + 60 * i, 160, {angles: walker.segments.map(s => s.angle_rad + i * .1)}),
    createObject(walker, 2, 640, 160),
    createObject(report.figure_types[1], 3, 480, 320),
  ], 4));
  return ownedEditorFor({demo: false, layerTimeline}, report);
}
/** An editor the engine owns, on a document with a drawing layer (the active one) the session made. */
const editorWithDrawing = options => { const editor = ownedEditorFor(options); editor.createDrawingLayer(); return editor; };
/** Every stored pose frame of the document: its keyframes and the retained sources. */
const storedFrames = editor => [...editor.report.keyframes, ...Object.values(editor.report._styk.frameSources ?? {})];
const figure = (editor, typeId) => editor.report.figure_types.find(f => f.figure_type_id === typeId);
const objectsOf = (editor, typeId, frame = editor.frame) => frame.objects.filter(o => o.figure_type_id === typeId);

test('entering Build from a drawing or fixed track chooses an editable figure layer', () => {
  for (const source of ['drawing', 'scene', 'camera']) {
    const options = {demo: false, layerTimeline: true}, figureLayer = 'layer-1';
    const editor = source === 'drawing' ? editorWithDrawing(options) : ownedEditorFor(options);
    if (source !== 'drawing') editor.selectSheetLayer(source);
    editor.select(null);
    const revision = editor.revision;
    const session = new BuilderSession(editor).begin();
    assert.equal(editor.activeLayerId, figureLayer);
    assert.equal(editor.revision, revision, 'selecting an existing layer does not author a command');
    editor.addSegment({length: 60, angle: 0}); session.sync();
    editor.addSegment({length: 30, angle: 1});
    assert.equal(editor.figure.segments.length, 2);
    assert.equal(editor.layerForUid(editor.selectedUid), figureLayer);
    editor.undo(); assert.equal(editor.figure.segments.length, 1);
    editor.redo(); assert.equal(editor.figure.segments.length, 2);
    session.resolve('discard');
    assert.equal(editor.report.figure_types.some(f => f.figure_type_id === session.typeId), false);
  }
});

test('Build creates a figure layer when all existing figure layers are locked or hidden', () => {
  const editor = editorWithDrawing({demo: false, layerTimeline: true});
  editor.setLayerLocked('layer-1', true);
  const hidden = editor.createLayer('Hidden'); editor.setLayerVisible(hidden.id, false);
  editor.select(null);
  const session = new BuilderSession(editor).begin();
  const target = editor.getLayer(editor.activeLayerId);
  assert.equal(isDrawingLayer(target), false);
  assert.equal(target.locked, false); assert.equal(target.visible, true);
  editor.addSegment({length: 60}); session.sync();
  assert.equal(editor.layerForUid(editor.selectedUid), target.id);
  session.resolve('discard');
  assert.equal(editor.getLayer(target.id), null, 'discard also removes the automatically created layer');
  assert.equal(editor.getLayer('layer-1').locked, true);
  assert.equal(editor.getLayer(hidden.id).visible, false);
});

test('edit session binds to the selected figure and tracks bound instances', () => {
  const editor = fixture();
  editor.select(1);
  const session = new BuilderSession(editor).begin();
  assert.equal(session.mode, 'edit');
  assert.equal(session.typeId, editor.figure.figure_type_id);
  assert.equal(session.uid, 1);
  assert.deepEqual([...session.boundUids].sort(), [1, 2]);
  assert.equal(session.preferredUid, 1);
  assert.equal(session.changed, false);
});

test('update keeps shared-definition edits on every instance', () => {
  const editor = fixture();
  editor.select(1);
  const session = new BuilderSession(editor).begin();
  const count = editor.figure.segments.length;
  editor.select(1, 0);
  editor.splitBuilderSegments({branch: false});
  assert.equal(session.changed, true);
  assert.equal(editor.figure.segments.length, count + 1);
  session.resolve('update');
  assert.equal(objectsOf(editor, session.typeId).length, 2);
  assert.equal(editor.frame.objects[0].angles.length, count + 1);
  assert.equal(editor.frame.objects[1].angles.length, count + 1);
  assert.doesNotThrow(() => validateScene({...editor.report, keyframes: storedFrames(editor)}));
  // The commit is history: undo returns the pre-session definition.
  editor.undo();
  assert.equal(figure(editor, session.typeId).segments.length, count);
});

test('discard restores the original definition and object poses', () => {
  const editor = fixture();
  editor.select(1);
  const beforeFigure = structuredClone(editor.figure);
  const beforeAngles = structuredClone(editor.frame.objects[0].angles);
  const history = editor._undo.length;
  const session = new BuilderSession(editor).begin();
  editor.select(1, 0);
  editor.splitBuilderSegments({branch: false});
  editor.updateFigureStyle({name: 'Renamed'});
  assert.equal(session.changed, true);
  session.resolve('discard');
  assert.deepEqual(editor.figure, beforeFigure);
  assert.deepEqual(editor.frame.objects[0].angles, beforeAngles);
  assert.equal(editor._undo.length, history);
  assert.equal(session.changed, false);
  assert.doesNotThrow(() => validateScene({...editor.report, keyframes: storedFrames(editor)}));
});

test('import-new restores the original and adds the edited figure as a new type', () => {
  const editor = fixture({layerTimeline: true});
  editor.select(1);
  const originalId = editor.figure.figure_type_id;
  const original = structuredClone(editor.figure);
  const session = new BuilderSession(editor).begin();
  editor.select(1, 0);
  editor.splitBuilderSegments({branch: false});
  editor.updateFigureStyle({name: 'Edited'});
  const edited = structuredClone(editor.figure);
  const object = session.resolve('import-new');
  assert.deepEqual(figure(editor, originalId), original);
  const added = editor.report.figure_types.find(f => f.figure_type_id !== originalId && f.name === 'Edited');
  // The engine's figure document carries the display aliases an editor the engine owns has already.
  const withoutAliases = segments => segments.map(({flag_bits, is_static, ...segment}) => segment);
  assert.deepEqual(withoutAliases(added.segments), withoutAliases(edited.segments));
  assert.equal(object.figure_type_id, added.figure_type_id);
  assert.ok(editor.selectionFrame.objects.some(o => o.unique_id === object.unique_id));
  // One undoable import command on top of the restored baseline.
  editor.undo();
  assert.ok(!editor.report.figure_types.some(f => f.figure_type_id === added.figure_type_id));
  editor.redo();
  assert.doesNotThrow(() => validateScene({...editor.report, keyframes: storedFrames(editor)}));
});

test('import-new preserves a posed, styled figure after deletion', () => {
  const report = emptyDocument(), definition = report.figure_types[0];
  const pose = createObject(definition, 1, 180, 160, {
    angles: definition.segments.map((s, i) => s.angle_rad + .12 * (i + 1)),
    len_flag: 1, lengths: definition.segments.map((s, i) => s.length * (1 + i / 10)),
    bend_flag: 1, bends: definition.segments.map((s, i) => i / 100), scale: 1.4,
    _stykStyle: {segments: {'1': {color: 0x465a28, opacity: .8, thickness: 13}}},
  });
  report.keyframes = [createFrame([pose, createObject(definition, 2, 500, 160)], 4)];
  const editor = ownedEditorFor({demo: false, propertyChannels: true, layerTimeline: true}, report);
  editor.select(1);
  editor.updateObject({root_x: 200});
  const original = structuredClone(editor.report);
  const session = new BuilderSession(editor).begin();
  editor.select(1, 0); editor.updateSegment({thickness: 18});
  editor.select(1, 3); editor.deleteSingleSegment();
  const edited = structuredClone(figureDocument(editor.report, {figureUid: 1, tick: editor.tick, sourceFrame: editor.selectionFrame}));
  const imported = session.resolve('import-new');
  const expected = edited.keyframes[0].objects[0];
  for (const field of ['angles', 'lengths', 'bends', 'len_flag', 'bend_flag', 'scale', '_stykStyle'])
    assert.deepEqual(imported[field], expected[field], field);
  assert.deepEqual(figure(editor, 1), original.figure_types[0]);
  for (const uid of [1, 2]) assert.deepEqual(
    figureDocument(editor.report, {figureUid: uid, tick: editor.tick, sourceFrame: editor.selectionFrame}),
    figureDocument(original, {figureUid: uid, tick: editor.tick}),
    'Original instances keep their complete appearance');
  editor.undo();
  assert.deepEqual(editor.report, original);
  editor.redo();
  assert.doesNotThrow(() => validateScene({...editor.report, keyframes: storedFrames(editor)}));
});

test('create session adopts the first drawn figure and imports it on exit', () => {
  const editor = fixture();
  editor.select(null);
  const session = new BuilderSession(editor).begin();
  assert.equal(session.mode, 'create');
  assert.equal(session.figure, null);
  assert.equal(session.boundUids.size, 0);
  const segment = editor.addSegment({type: 'line', start: {x: 100, y: 100}});
  session.sync();
  assert.equal(session.figure?.segments.length, 1);
  assert.equal(session.boundUids.size, 1);
  assert.equal(session.changed, true);
  const typeId = session.typeId;
  session.resolve('import');
  assert.equal(figure(editor, typeId)?.segments.length, 1);
  assert.equal(objectsOf(editor, typeId).length, 1);
});

test('create session discard removes the drawn figure and its object', () => {
  const editor = fixture();
  editor.select(null);
  const history = editor._undo.length;
  const types = editor.report.figure_types.length;
  const session = new BuilderSession(editor).begin();
  editor.addSegment({type: 'line', start: {x: 100, y: 100}});
  session.sync();
  const typeId = session.typeId, uid = session.uid;
  assert.ok(typeId !== null);
  session.resolve('discard');
  assert.equal(editor.report.figure_types.length, types);
  assert.ok(!editor.report.figure_types.some(f => f.figure_type_id === typeId));
  assert.ok(!editor.selectionFrame.objects.some(o => o.unique_id === uid));
  assert.equal(editor._undo.length, history);
});

test('create session draws a visible figure on a materialized layer-sheet cell', () => {
  const report = emptyDocument(), walker = report.figure_types[0];
  report.keyframes = [createFrame([createObject(walker, 1, 200, 200)], 4)];
  const editor = ownedEditorFor({demo: false, propertyChannels: true, layerTimeline: true}, report);
  // A pose edit captures the layer cell into a frame source; afterwards the
  // evaluated frame no longer mirrors report.keyframes[frameIndex].
  editor.select(1);
  editor.updateObject({root_x: 240});
  assert.ok(editor.report._styk.layerSheet.tracks['layer-1'].keys[0].value?.frameId);
  editor.select(null);
  const session = new BuilderSession(editor).begin();
  assert.equal(session.mode, 'create');
  editor.addSegment({type: 'line', start: {x: 100, y: 100}});
  session.sync();
  const typeId = session.typeId, uid = session.uid;
  assert.equal(editor.figure?.segments.length, 1);
  assert.ok(editor.selectionFrame.objects.some(o => o.unique_id === uid));
  // Extending the bound figure still works.
  editor.addSegment({type: 'line', length: 60});
  assert.equal(editor.figure?.segments.length, 2);
  session.resolve('import');
  assert.ok(editor.selectionFrame.objects.some(o => o.unique_id === uid));
  editor.undo();
  editor.undo();
  assert.ok(!editor.report.figure_types.some(f => f.figure_type_id === typeId));
  assert.ok(!editor.selectionFrame.objects.some(o => o.unique_id === uid));
  assert.doesNotThrow(() => validateScene({...editor.report, keyframes: storedFrames(editor)}));
});

test('undo inside a session reduces changed work but never crosses the baseline', () => {
  const editor = fixture();
  editor.select(1);
  const session = new BuilderSession(editor).begin();
  const history = editor._undo.length;
  editor.select(1, 0);
  editor.splitBuilderSegments({branch: false});
  editor.splitBuilderSegments({branch: false});
  assert.equal(editor._undo.length, history + 2);
  editor.undo();
  assert.equal(session.changed, true);
  session.undoSession();
  assert.equal(editor._undo.length, history);
  assert.equal(session.changed, false);
  // Redo is still available after leaving the session.
  editor.redo();
  assert.equal(figure(editor, session.typeId).segments.length, 11);
});

test('moveBuilderSegment reparents, reorders, rejects cycles, and undoes', () => {
  const editor = fixture();
  editor.select(1);
  // Every pose's angle of each segment, by segment id.
  const poses = () => editor.report.keyframes.map(frame => objectsOf(editor, 1, frame).map(object =>
    Object.fromEntries(figure(editor, 1).segments.map((segment, index) => [segment.segment_id, object.angles[index]]))));
  const before = poses();
  // Reparent segment 4 (child of 3) onto 6; pose arrays remap by segment id.
  editor.moveBuilderSegment(4, {parentId: 6});
  const moved = figure(editor, 1);
  assert.equal(moved.segments.find(s => s.segment_id === 4).parent_id, 6);
  const ids = moved.segments.map(s => s.segment_id);
  assert.ok(ids.indexOf(4) > ids.indexOf(6));
  assert.deepEqual(poses(), before, 'every segment keeps its own angle in every pose');
  assert.doesNotThrow(() => validateScene({...editor.report, keyframes: storedFrames(editor)}));
  assert.throws(() => editor.moveBuilderSegment(1, {parentId: 4}), /own branch/);
  editor.undo();
  assert.equal(figure(editor, 1).segments.find(s => s.segment_id === 4).parent_id, 3);
  // Sibling reorder: insert segment 2 before sibling 5 under root 1.
  editor.moveBuilderSegment(2, {parentId: 1, beforeId: 5});
  const order = figure(editor, 1).segments.map(s => s.segment_id);
  assert.ok(order.indexOf(2) < order.indexOf(5) && order.indexOf(2) > order.indexOf(1));
  assert.doesNotThrow(() => validateScene({...editor.report, keyframes: storedFrames(editor)}));
});

test('discard survives session history eviction via the captured baseline', () => {
  const editor = fixture();
  editor.select(1);
  const beforeFigure = structuredClone(editor.figure);
  const session = new BuilderSession(editor).begin();
  editor.select(1, 0);
  editor.splitBuilderSegments({branch: false});
  // Simulate eviction: pretend the session's undo entries were dropped.
  editor._undo = [];
  editor._redo = [];
  session.resolve('discard');
  assert.deepEqual(editor.figure, beforeFigure);
  assert.doesNotThrow(() => validateScene({...editor.report, keyframes: storedFrames(editor)}));
});

test('a figure whose creation left the history is discarded from every frame and the library as one entry', () => {
  const report = emptyDocument(), walker = report.figure_types[0];
  report.keyframes = [0, 1].map(i => createFrame([createObject(walker, 1, 200 + 40 * i, 200)], 4));
  const editor = ownedEditorFor({demo: false, layerTimeline: true, propertyChannels: true}, report);
  editor.select(null);
  const session = new BuilderSession(editor).begin();
  editor.addSegment({type: 'line', start: {x: 100, y: 100}});
  session.sync();
  const typeId = session.typeId, uid = session.uid;
  assert.ok(typeId !== null);
  // The new figure is posed at a second key inside its cell as well, so that it lives in more than one frame of the layer.
  editor.seek(2);
  assert.equal(editor.updateObject({root_x: 330}), true);
  const shows = () => storedFrames(editor).filter(frame => frame.objects.some(object => object.figure_type_id === typeId)).length;
  assert.ok(shows() >= 2, 'the figure is in several frames');
  const complete = JSON.stringify(editor.report), entries = editor._undo.length;
  // What eviction leaves: the figure in the document and none of the entries that created it.
  session._removeCreatedFigure(typeId);
  assert.equal(shows(), 0, 'no frame holds an instance');
  assert.ok(!editor.report.figure_types.some(f => f.figure_type_id === typeId), 'the definition left the library');
  assert.ok(editor.report.figure_types.some(f => f.figure_type_id === walker.figure_type_id), 'the other figures stay');
  assert.ok(editor.evaluatedFrame.objects.every(object => object.figure_type_id !== typeId));
  assert.equal(editor.undoLabel, 'Discard new figure');
  assert.equal(editor._undo.length, entries + 1, 'one entry');
  assert.doesNotThrow(() => validateScene({...editor.report, keyframes: storedFrames(editor)}));
  editor.undo();
  assert.equal(JSON.stringify(editor.report), complete, 'one undo brings it back everywhere');
  assert.ok(editor.report.figure_types.some(f => f.figure_type_id === typeId));
  assert.ok(editor.evaluatedFrame.objects.some(object => object.unique_id === uid));
});
