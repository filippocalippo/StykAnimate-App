import test from 'node:test';
import assert from 'node:assert/strict';
import {newOwnedEditor, ownedEditorFor} from './support/owned-editor.mjs';
import {emptyDocument, createObject, createFrame} from '../src/demo.mjs';
import {geometryOfDocument} from './support/engine-geometry.mjs';
import {exportDocument, pivotDocument, keepsStoredFrames} from './support/engine-export.mjs';
import {roundTrip} from './support/codec.mjs';

/** The two-frame document of the tests; `edit(report)` changes it before the engine opens it. */
function document(edit = null) {
  const report = emptyDocument(), figure = report.figure_types[0];
  figure.segment_decode = {global_style: {u28: 1073741824, outline_thickness: 2, rgb: [30, 40, 50], u30: 0}};
  figure.segments[0].secondary = {rgb: [255, 0, 120], a: 0};
  report.keyframes = [0, 1].map(index => createFrame([createObject(figure, 1, 150 + index * 30, 200), createObject(figure, 2, 350, 200)], index ? 1 : 4));
  edit?.(report);
  return report;
}
const fixture = edit => newOwnedEditor({demo: false}).load(document(edit));
/** The engine's geometry at `tick` of an editor. */
const geometryAt = (editor, tick) => { editor.seek(tick); return editor.geometry; };
const style = geometry => {const figure = geometry.fig; return {outline: figure.segment_decode.global_style.u30, primary: figure.segments[0].transparency, secondary: figure.segments[0].secondary.a};};
function nativeRoundtrip(report, kind = 'piv', figureTypeId) {
  return roundTrip({document: report, format: kind, figureTypeId});
}
test('alpha-only native segments keyed to opaque receive a real native variant', () => {
  const output = pivotDocument(document(report => {
    const segment = report.figure_types[0].segments[0]; delete segment.transparency; segment.color_alpha = .2;
    report.keyframes[0].objects[0]._stykStyle = {segments: {1: {opacity: 1}}};
  }));
  const used = new Set(output.keyframes.flatMap(frame => frame.objects.map(object => object.figure_type_id)));
  const variant = output.figure_types.find(figure => used.has(figure.figure_type_id) && figure.segments[0].transparency === 0);
  assert.ok(variant, 'a figure type of its own for the opaque instance');
  assert.equal(variant.segments[0].color_alpha, 1);
  assert.notEqual(variant.figure_type_id, 1);
});
test('independent outline, primary and gradient endpoint opacity bake into real PIV figure types', async () => {
  const editor = fixture(); editor.addAnimationKeys([
    ...[0, 4].flatMap(tick => [
      {target: {kind: 'figure', uid: 1}, property: 'outlineOpacity', tick, value: tick ? .7 : .3},
      {target: {kind: 'segment', uid: 1, handleId: 1}, property: 'opacity', tick, value: tick ? .8 : .2},
      {target: {kind: 'segment', uid: 1, handleId: 1}, property: 'gradientOpacity', tick, value: tick ? .6 : .4},
    ]),
  ]);
  const report = editor.report, before = structuredClone(report), output = pivotDocument(editor), native = await nativeRoundtrip(output), reopened = ownedEditorFor({demo: false}, native);
  assert.equal(output.keyframes.length, 5); assert.ok(output.keyframes.every(frame => frame.duration_raw === 1));
  assert.deepEqual(report, before); assert.ok(output.keyframes.every(frame => frame.objects.every(object => !object._stykStyle)));
  assert.ok(output.figure_types.length <= 6); assert.equal(output._styk.animation, undefined);
  for (let tick = 0; tick < 5; tick++) {
    const expected = geometryAt(editor, tick), actual = geometryAt(reopened, tick);
    for (const slot of [0, 1]) assert.deepEqual(style(actual.objects.get(slot)), style(expected.objects.get(slot)));
    assert.equal(style(actual.objects.get(1)).primary, 0);
  }
  assert.equal(keepsStoredFrames(native), true);
});
test('captured native style overrides remain exportable after their channels are removed', async () => {
  const editor = fixture(report => { report.keyframes[0].objects[0]._stykStyle = {outlineOpacity: .4, segments: {1: {opacity: .6}}}; });
  assert.equal(editor.animationChannels.length, 0); assert.equal(keepsStoredFrames(editor), false);
  const output = pivotDocument(editor), native = await nativeRoundtrip(output);
  assert.equal(output.keyframes.length, 5); assert.equal(native.keyframes.length, 5);
  assert.equal(style(geometryOfDocument(native, native.keyframes[0]).objects.get(0)).primary, 102);
  assert.equal(style(geometryOfDocument(native, native.keyframes[4]).objects.get(0)).primary, 0);
});
test('STK resolves the selected instance and authored tick without changing its shared base', async () => {
  const editor = fixture(); editor.addAnimationKeys([
    {target: {kind: 'segment', uid: 1, handleId: 1}, property: 'opacity', tick: 0, value: 1},
    {target: {kind: 'segment', uid: 1, handleId: 1}, property: 'opacity', tick: 4, value: .2},
  ]);
  const report = editor.report, before = structuredClone(report), result = exportDocument(editor, {format: 'stk', figureTypeId: 1, figureUid: 1, tick: 4});
  assert.notEqual(result.figureTypeId, 1); assert.deepEqual(report, before);
  const native = await nativeRoundtrip(result.document, 'stk', result.figureTypeId), saved = native.figure_types.find(figure => figure.segments[0]?.transparency === 204);
  assert.equal(saved.segments[0].transparency, 204); assert.equal(report.figure_types[0].segments[0].transparency, 0);
  assert.equal(exportDocument(editor, {format: 'stk', figureTypeId: 1, figureUid: 2, tick: 4}).figureTypeId, 1);
});
