import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyDocument, createObject, createFrame} from '../src/demo.mjs';
import {animationChannelId, validateAnimationValue} from '../src/animation-channels.mjs';
import {resolveInstanceFigure, animationStyleValue} from '../src/animation-style.mjs';
import {ownedEditorFor} from './support/owned-editor.mjs';

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

test('captured style validation rejects malformed data before replacing the open document', () => {
  const editor = ownedEditorFor({demo: false}, fixture()), original = editor.report;
  for (const style of [null, [], {outlineOpacity: 2}, {outlineOpacity: NaN}, {segments: []}, {segments: {'01': {opacity: .2}}}, {segments: {0: {opacity: .2}}}, {segments: {1: {opacity: -.1}}}, {segments: {1: {gradientOpacity: '0.5'}}}]) {
    const report = fixture(); report.keyframes[0].objects[0]._stykStyle = style;
    assert.throws(() => editor.load(report), /style|opacity/i); assert.equal(editor.report, original);
  }
});

test('alpha-only native segment records retain effective primary opacity', () => {
  const report = fixture(), figure = report.figure_types[0], object = report.keyframes[0].objects[0];
  delete figure.segments[0].transparency; figure.segments[0].color_alpha = .2;
  assert.equal(animationStyleValue(figure, object, segmentTarget, 'opacity'), .2);
  object._stykStyle = {segments: {1: {opacity: 1}}};
  const resolved = resolveInstanceFigure(figure, object); assert.notEqual(resolved, figure);
  assert.equal(resolved.segments[0].transparency, 0); assert.equal(resolved.segments[0].color_alpha, 1);
});
