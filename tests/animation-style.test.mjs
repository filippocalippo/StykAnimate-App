import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {emptyDocument, createObject, createFrame} from '../src/demo.mjs';
import {animationChannelId, composeAnimationChannels, animationPropertyValue, validateAnimationDocument, validateAnimationValue} from '../src/animation-channels.mjs';
import {resolveInstanceFigure, animationStyleValue} from '../src/animation-style.mjs';
import {validateObjectChanges} from '../src/pivot/model.mjs';
import {buildGeometry, evaluatedFrame} from '../src/pivot/geometry.mjs';

const figureTarget = {kind: 'figure', uid: 1};
const segmentTarget = {kind: 'segment', uid: 1, handleId: 1};
function fixture() {
  const report = emptyDocument(), figure = report.figure_types[0];
  figure.segment_decode = {global_style: {u28: 1082130432, outline_thickness: 4, u30: 0, rgb: [20, 30, 40]}};
  figure.segments[0].secondary = {rgb: [230, 90, 10], a: 0};
  figure.segments[0].flags |= 512;
  report.keyframes = [createFrame([createObject(figure, 1, 100, 200), createObject(figure, 2, 400, 200)], 20), createFrame([], 1)];
  return report;
}
function channel(target, property, values) {
  return {id: animationChannelId(target, property), target, property, keys: values.map(([tick, value], i) => ({id: `k${i}`, tick, value, interpolation: 'linear'}))};
}
function set(report, channels) { report._styk.animation = {version: 1, nextKeyId: 100, channels}; }

test('style identities retain exact instance and native handle, and reject invalid values', () => {
  assert.equal(animationChannelId(segmentTarget, 'opacity'), 'segment:1%2F1:opacity');
  assert.notEqual(animationChannelId(segmentTarget, 'opacity'), animationChannelId({...segmentTarget, handleId: 2}, 'opacity'));
  assert.notEqual(animationChannelId(segmentTarget, 'opacity'), animationChannelId(figureTarget, 'opacity'));
  for (const handleId of [0, -1, 1.5, 65536]) assert.throws(() => animationChannelId({...segmentTarget, handleId}, 'opacity'), /handle/);
  for (const [target, property] of [[figureTarget, 'outlineOpacity'], [segmentTarget, 'opacity'], [segmentTarget, 'gradientOpacity']]) {
    for (const value of [-.1, 1.1, NaN, null]) assert.throws(() => validateAnimationValue(target, property, value));
    assert.equal(validateAnimationValue(target, property, 0), 0);
    assert.equal(validateAnimationValue(target, property, 1), 1);
  }
});

test('independent opacity curves only copy selected instance and touched segment records', () => {
  const report = fixture(), frame = report.keyframes[0], figure = report.figure_types[0], before = structuredClone(report);
  set(report, [channel(figureTarget, 'outlineOpacity', [[0, 1], [20, 0]]), channel(segmentTarget, 'opacity', [[0, 1], [20, 0]]), channel(segmentTarget, 'gradientOpacity', [[0, 0], [20, 1]])]);
  const composed = composeAnimationChannels(report, frame, 5), resolved = resolveInstanceFigure(figure, composed.objects[0]);
  assert.equal(composed.objects[1], frame.objects[1]); assert.equal(composed.objects[0].angles, frame.objects[0].angles);
  assert.equal(resolved.segment_decode.global_style.u30, 64); assert.equal(resolved.segments[0].transparency, 64); assert.equal(resolved.segments[0].secondary.a, 191);
  assert.equal(resolved.segments[1], figure.segments[1]); assert.equal(resolved.image_assets, figure.image_assets); assert.equal(resolved.text_assets, figure.text_assets);
  assert.deepEqual(figure, before.figure_types[0]); assert.deepEqual(frame, before.keyframes[0]);
  assert.equal(animationPropertyValue(report, composed, segmentTarget, 'opacity'), .75);
  assert.equal(animationPropertyValue(report, composed, figureTarget, 'outlineOpacity'), .75);
  assert.equal(validateAnimationDocument(report), report);
});

test('geometry uses resolved style and preserves interpolated runtime segment pose for style-only edits', () => {
  const report = fixture(), frame = report.keyframes[0];
  frame.objects[0].runtime_segments = [{length: 114, bend_rad: .4}];
  set(report, [channel(segmentTarget, 'opacity', [[0, .2]])]);
  const composed = composeAnimationChannels(report, frame, 0), geometry = buildGeometry(report, composed);
  const item = geometry.objects.get(0).segments.find(item => item.index === 0);
  assert.equal(composed.objects[0].runtime_segments, frame.objects[0].runtime_segments);
  assert.equal(item.length, 114); assert.equal(item.bend, .4); assert.ok(Math.abs(item.alpha - .2) < 1e-9);
  assert.equal(geometry.objects.get(1).segments.find(item => item.index === 0).alpha, 1);
});

test('handle-targeted styles survive segment table reordering and remain dormant for missing handles', () => {
  const report = fixture(), figure = report.figure_types[0];
  figure.segments.reverse();
  set(report, [channel(segmentTarget, 'opacity', [[0, .4]])]);
  let composed = composeAnimationChannels(report, report.keyframes[0], 0), resolved = resolveInstanceFigure(figure, composed.objects[0]);
  assert.equal(resolved.segments.at(-1).segment_id, 1); assert.equal(resolved.segments.at(-1).transparency, 153);
  assert.equal(resolved.segments[0], figure.segments[0]);
  figure.segments = figure.segments.filter(segment => segment.segment_id !== 1);
  composed = composeAnimationChannels(report, report.keyframes[0], 0); assert.equal(composed, report.keyframes[0]);
  assert.equal(animationStyleValue(figure, composed.objects[0], segmentTarget, 'opacity'), undefined);
});

test('secondary opacity never invents a gradient on a plain segment', () => {
  const report = fixture(), target = {...segmentTarget, handleId: 2};
  set(report, [channel(target, 'gradientOpacity', [[0, .5]])]);
  const frame = report.keyframes[0]; assert.equal(composeAnimationChannels(report, frame, 0), frame);
  assert.equal(animationPropertyValue(report, frame, target, 'gradientOpacity'), undefined);
});

test('unchanged alpha bytes reuse native definition and subsequent shared native edits stay visible', () => {
  const report = fixture(), figure = report.figure_types[0], object = report.keyframes[0].objects[0];
  object._stykStyle = {outlineOpacity: 1, segments: {1: {opacity: 1, gradientOpacity: 1}}};
  assert.equal(resolveInstanceFigure(figure, object), figure);
  object._stykStyle.segments[1].opacity = .5;
  let resolved = resolveInstanceFigure(figure, object); assert.equal(resolved.segments[0].transparency, 128);
  figure.segments[0].color_rgb = [10, 20, 30];
  resolved = resolveInstanceFigure(figure, object); assert.deepEqual(resolved.segments[0].color_rgb, [10, 20, 30]);
  assert.equal(resolved.segments[0].secondary, figure.segments[0].secondary);
});

test('style channels on a joined child preserve the complete attachment pose', () => {
  const report = fixture(), frame = report.keyframes[0]; frame.objects[1].join = {target_object_slot: 0, target_unique_id: 1, target_handle_id: 1};
  const before = buildGeometry(report, frame);
  set(report, [channel({...segmentTarget, uid: 2}, 'opacity', [[0, 0]])]);
  const composed = composeAnimationChannels(report, frame, 0), after = buildGeometry(report, composed);
  assert.equal(composed.objects[0], frame.objects[0]); assert.deepEqual(after.objects.get(1).root, before.objects.get(1).root);
  assert.deepEqual([...after.objects.get(1).joints], [...before.objects.get(1).joints]);
});

test('editor style scrub commits one sparse history record and cancel/undo/redo preserve source definitions', () => {
  const editor = new Editor({demo: false}).load(fixture()), before = structuredClone(editor.report.figure_types);
  editor.seek(5); editor.beginAnimationEdit(segmentTarget, 'opacity');
  for (let value = 0; value <= 1; value += .1) editor.previewAnimationEdit(value);
  editor.previewAnimationEdit(.25); editor.commitAnimationEdit(); assert.equal(editor._undo.length, 1);
  assert.equal(editor.animationValue(segmentTarget, 'opacity'), .25);
  editor.beginAnimationEdit(figureTarget, 'outlineOpacity'); editor.previewAnimationEdit(.1); editor.cancelAnimationEdit();
  assert.equal(editor.animationChannel(figureTarget, 'outlineOpacity'), null); assert.equal(editor._undo.length, 1);
  editor.undo(); assert.equal(editor.animationChannels.length, 0); editor.redo(); assert.equal(editor.animationValue(segmentTarget, 'opacity'), .25);
  assert.deepEqual(editor.report.figure_types, before); assert.ok(JSON.stringify(editor._undo[0]).length < 4000);
});

test('native document JSON save/reopen keeps all three style keys without materialized type duplication', () => {
  const report = fixture(); set(report, [channel(figureTarget, 'outlineOpacity', [[0, .5]]), channel(segmentTarget, 'opacity', [[0, .25]]), channel(segmentTarget, 'gradientOpacity', [[0, .75]])]);
  const reopened = JSON.parse(JSON.stringify(report)); validateAnimationDocument(reopened);
  const output = evaluatedFrame(reopened, 0, 0, 0), figure = resolveInstanceFigure(reopened.figure_types[0], output.objects[0]);
  assert.equal(reopened.figure_types.length, 1); assert.equal(figure.segment_decode.global_style.u30, 128); assert.equal(figure.segments[0].transparency, 191); assert.equal(figure.segments[0].secondary.a, 64);
});

test('captured style validation rejects malformed data before replacing the open document', () => {
  const editor = new Editor({demo: false}).load(fixture()), original = editor.report;
  for (const style of [null, [], {outlineOpacity: 2}, {outlineOpacity: NaN}, {segments: []}, {segments: {'01': {opacity: .2}}}, {segments: {0: {opacity: .2}}}, {segments: {1: {opacity: -.1}}}, {segments: {1: {gradientOpacity: '0.5'}}}]) {
    const report = fixture(); report.keyframes[0].objects[0]._stykStyle = style;
    assert.throws(() => editor.load(report), /style|opacity/i); assert.equal(editor.report, original);
  }
  original.keyframes[0].objects[0]._stykStyle = {segments: {1: {opacity: Infinity}}};
  assert.throws(() => validateObjectChanges(original, original.keyframes[0], [1]), /opacity/);
});

test('alpha-only native segment records retain effective primary opacity', () => {
  const report = fixture(), figure = report.figure_types[0], object = report.keyframes[0].objects[0];
  delete figure.segments[0].transparency; figure.segments[0].color_alpha = .2;
  assert.equal(animationStyleValue(figure, object, segmentTarget, 'opacity'), .2);
  object._stykStyle = {segments: {1: {opacity: 1}}};
  const resolved = resolveInstanceFigure(figure, object); assert.notEqual(resolved, figure);
  assert.equal(resolved.segments[0].transparency, 0); assert.equal(resolved.segments[0].color_alpha, 1);
});
