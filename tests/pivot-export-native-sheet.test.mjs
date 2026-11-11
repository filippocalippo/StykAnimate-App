import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {engineEditor} from './support/owned-editor.mjs';
import {emptyDocument, createObject, createFrame} from '../src/demo.mjs';
import {evaluatedAt} from './support/engine-geometry.mjs';
import {pivotDocument, exportDocument, keepsStoredFrames} from './support/engine-export.mjs';

/** The imported document of four exposures, in an editor the engine owns; `change(saved)` edits what the engine opens. */
function fixture(change = null) {
  const document = emptyDocument(); document.auto_easing = false;
  document.keyframes = [3, 0, 4, 2].map((duration, index) => ({
    ...createFrame([createObject(document.figure_types[0], 1, 40 + index * 30, 80)], duration),
    opaque: {index, exact: '01'},
  }));
  const editor = engineEditor({demo: false, layerTimeline: true}, document);
  if (!change) return editor;
  const saved = editor.serialize(); change(saved);
  return engineEditor({demo: false, layerTimeline: true}, saved);
}
/** The frame the engine shows for a document at a tick. */
const sample = (report, tick) => evaluatedAt(report, tick);

test('an imported layer sheet retains native exposures, hidden keys and unknown fields without baking', () => {
  const editor = fixture(), before = structuredClone(editor.report);
  assert.equal(keepsStoredFrames(editor), true, 'the native pose inventory is reused');
  const output = pivotDocument(editor);
  assert.equal(output._styk.layerSheet, undefined);
  assert.deepEqual(output.keyframes.map(frame => frame.duration_raw), [3, 0, 4, 2]);
  assert.deepEqual(output.keyframes.map(frame => frame.opaque.index), [0, 1, 2, 3]);
  for (let tick = 0; tick < editor.totalTicks; tick++) {
    const a = sample(editor.report, tick), b = sample(output, tick);
    assert.deepEqual(a.objects, b.objects); assert.deepEqual(a.camera, b.camera);
  }
  assert.deepEqual(editor.report, before, 'export must not modify the editable timeline');
});

test('retimed, authored, shortened and overlaid layer sheets retain the baking path', () => {
  // The sheets the engine opens: one that ends before its last key or holds a legacy animation of the wrong shape is refused there.
  const changes = [
    sheet => {sheet.tracks['layer-1'].keys[1].sourceTick += .5;},
    sheet => {sheet.duration++;},
    sheet => {const key = sheet.tracks['layer-1'].keys[1]; delete key.sourceTick; key.value = {frameId: null};},
    sheet => {sheet.tracks.camera.keys[0].movieclipPatches = [];},
    sheet => {sheet.tracks.scene.keys.pop();},
    sheet => {sheet.tracks.scene.keys[0].futureBehavior = true;},
  ];
  for (const change of changes) {
    const editor = fixture(saved => change(saved._styk.layerSheet));
    assert.equal(keepsStoredFrames(editor), false, change.toString());
  }
});

test('native export eligibility follows edits, undo, redo and saved timeline contents', () => {
  const editor = fixture(), before = structuredClone(editor.report);
  editor.sheetInsertKey(['layer-1'], 1);
  assert.equal(keepsStoredFrames(editor), false);
  const edited = pivotDocument(editor);
  for (let tick = 0; tick < editor.totalTicks; tick++) {
    const a = sample(editor.report, tick), b = sample(edited, tick);
    assert.equal(a.objects[0].root_x, b.objects[0].root_x);
  }
  editor.undo();
  assert.deepEqual(editor.report, before);
  assert.equal(keepsStoredFrames(editor), true);
  const saved = editor.serialize();
  editor.redo();
  assert.equal(keepsStoredFrames(editor), false);
  // The engine holds one document: the reopened one is last.
  const reopened = new Editor({demo: false, layerTimeline: true}).load(saved);
  assert.equal(keepsStoredFrames(reopened), true);
});

test('a saved sheet with separate legacy animation metadata stays on the established evaluator', () => {
  const editor = fixture(saved => { saved._styk.animation = {version: 1, channels: []}; });
  assert.equal(keepsStoredFrames(editor), false);
});
