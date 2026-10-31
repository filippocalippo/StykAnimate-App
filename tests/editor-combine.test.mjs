// Combining a figure with everything joined to it runs in the engine session (`combineJoinedFigure`, styk-edit/src/combine.rs).
// The documents are written whole before they open, so that the joined figures share the keyframe the command combines in.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {emptyDocument, createObject, createFrame, defaultFigure} from '../src/demo.mjs';
import {validateScene} from '../src/pivot/model.mjs';
import {roundTrip} from './support/codec.mjs';
import {ownedEditorFor} from './support/owned-editor.mjs';

const near = (a, b, epsilon = 1e-4) => assert.ok(Math.abs(a - b) <= epsilon, `${a} != ${b}`);
/** The ends of every segment, as the frame draws them: a combined figure draws what the group drew (the order of the segments is the group's). */
function segmentEnds(editor) {
  return [...editor.geometry.objects.values()].flatMap(object => object.segments.map(shape => [shape.start.x, shape.start.y, shape.end.x, shape.end.y]))
    .sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3]);
}
function sameDrawing(before, after) {
  assert.equal(after.length, before.length);
  before.forEach((row, index) => row.forEach((value, column) => near(after[index][column], value, 1e-3)));
}
/** A figure with a curved segment and a fill, a copy of it joined to its fourth joint, and optionally a third figure it hangs from. */
function group({outside = false} = {}) {
  const report = emptyDocument(), figure = report.figure_types[0];
  figure.segments[2].bend_rad = 0.5;
  figure.polyfills = [{polyfill_id: 1, segment_ids: [0, 7, 9], color_rgb: [226, 68, 145], alpha_raw: 128, color_alpha: 1 - 128 / 255, z_order: 0}];
  const copy = {...structuredClone(figure), figure_type_id: 2};
  report.figure_types.push(copy);
  const objects = [createObject(figure, 1, 300, 240), createObject(copy, 2, 0, 0, {scale: 0.6, color_override_raw: 0x80224466, join: {target_object_slot: 0, target_unique_id: 1, target_handle_id: 4}})];
  if (outside) {
    const third = {...defaultFigure(3), name: 'Outside'};
    report.figure_types.push(third);
    objects.push(createObject(third, 3, 600, 240));
    objects[0].join = {target_object_slot: 2, target_unique_id: 3, target_handle_id: 0};
  }
  report.keyframes = [createFrame(objects, 4)];
  return report;
}
const open = report => { const editor = ownedEditorFor({demo: false}, report); editor.select(1); return editor; };

test('combine joined figures keeps the drawing of curved segments, circles and fills, the root identity and exact undo', () => {
  const editor = open(group()), before = editor.serialize(), drawing = segmentEnds(editor);
  editor.combineJoinedFigure(1, {name: 'Merged rig'});
  assert.equal(editor.report.keyframes[0].objects.length, 1); assert.equal(editor.object.unique_id, 1); assert.equal(editor.figure.name, 'Merged rig');
  assert.equal(editor.figure.segments.length, 20); assert.equal(editor.figure.polyfills.length, 2);
  sameDrawing(drawing, segmentEnds(editor)); assert.doesNotThrow(() => validateScene(editor.serialize()));
  const combined = editor.serialize();
  editor.undo(); assert.deepEqual(editor.serialize(), before);
  editor.redo(); assert.deepEqual(editor.serialize(), combined); sameDrawing(drawing, segmentEnds(editor));
});

test('combine retains an external parent attachment and remaps its shifted object slot', () => {
  const editor = open(group({outside: true})), drawing = segmentEnds(editor);
  editor.combineJoinedFigure(1);
  const objects = editor.report.keyframes[0].objects;
  assert.equal(objects.length, 2);
  const combined = objects.find(object => object.unique_id === 1);
  assert.equal(combined.join.target_unique_id, 3); assert.equal(objects[combined.join.target_object_slot].unique_id, 3);
  sameDrawing(drawing, segmentEnds(editor)); assert.doesNotThrow(() => validateScene(editor.serialize()));
});

test('combine refuses a single figure, unrepresentable opacity and outlines without changing the document', () => {
  const single = emptyDocument(); single.keyframes = [createFrame([createObject(single.figure_types[0], 1, 300, 240)], 4)];
  const alone = open(single), start = alone.serialize();
  assert.throws(() => alone.combineJoinedFigure(1), /Join at least two figures/); assert.deepEqual(alone.serialize(), start);
  const faded = group(); faded.keyframes[0].objects[1].field28 = 50;
  const editor = open(faded), before = editor.serialize();
  assert.throws(() => editor.combineJoinedFigure(1), /opacity/); assert.deepEqual(editor.serialize(), before);
  const outlined = group(); outlined.figure_types[0].segment_decode = {global_style: {outline_thickness: 2, u30: 0, rgb: [0, 0, 0]}};
  const outlinedEditor = open(outlined), outlinedBefore = outlinedEditor.serialize();
  assert.throws(() => outlinedEditor.combineJoinedFigure(1), /outlines/); assert.deepEqual(outlinedEditor.serialize(), outlinedBefore);
});

test('combined joined vectors roundtrip through actual native PIV and STK writers', async () => {
  const editor = open(group()); editor.combineJoinedFigure(1);
  const document = editor.serialize(), figureTypeId = document.keyframes[0].objects[0].figure_type_id;
  const decoded = {};
  for (const kind of ['piv', 'stk']) decoded[kind] = await roundTrip({document, format: kind, figureTypeId});
  const reopened = new Editor({demo: false}).load(decoded.piv);
  assert.equal(reopened.report.keyframes[0].objects.length, 1);
  const figure = decoded.stk.figure_types.find(f => f.segments.length === 20);
  assert.ok(figure); assert.equal(figure.polyfills.length, 2);
});
