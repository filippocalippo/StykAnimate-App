import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyDocument, createObject, createFrame} from '../src/demo.mjs';
import {animationChannelId, animationEndTick, validateAnimationDocument} from '../src/animation-channels.mjs';

const target = uid => ({kind: 'figure', uid});
function fixture() {
  const report = emptyDocument(), figure = report.figure_types[0];
  const a = createObject(figure, 1, 100, 200), b = createObject(figure, 2, 400, 200);
  report.keyframes = [createFrame([a, b], 20), createFrame([{...structuredClone(a), root_x: 200}, {...structuredClone(b), root_x: 500}], 1)];
  return report;
}
function channel(target, property, values) {
  return {id: animationChannelId(target, property), target, property, keys: values.map(([tick, value, interpolation = 'linear'], i) => ({id: `k${i}`, tick, value, interpolation}))};
}
function set(report, channels) { report._styk.animation = {version: 1, nextKeyId: 100, channels}; }

test('channel validation rejects malformed payloads and keeps hidden native pose references', () => {
  const report = fixture(), pose = channel({kind: 'camera'}, 'pose', [[0, {frameId: 'f0'}], [0, {frameId: 'f1'}], [10, null]]);
  report.keyframes.forEach((frame, index) => { frame._styk = {frameId: `f${index}`}; });
  pose.keys[0].hidden = true; set(report, [pose]); assert.equal(validateAnimationDocument(report), report); assert.equal(animationEndTick(report), 11);
  delete pose.keys[0].hidden; assert.throws(() => validateAnimationDocument(report), /same frame/);
  set(report, [channel(target(1), 'opacity', [[0, 2]])]); assert.throws(() => validateAnimationDocument(report), /opacity/);
  set(report, [channel(target(1), 'x', [[10, 1], [5, 2]])]); assert.throws(() => validateAnimationDocument(report), /sorted/);
});

test('a visible terminal pose owns a display frame when a coincident hidden reference follows it', () => {
  const report = fixture(); report.keyframes.forEach((frame, index) => { frame._styk = {frameId: `f${index}`}; });
  const pose = channel({kind: 'camera'}, 'pose', [[30, {frameId: 'f0'}], [30, {frameId: 'f1'}]]);
  pose.keys[1].hidden = true; set(report, [pose]);
  assert.equal(validateAnimationDocument(report), report); assert.equal(animationEndTick(report), 31);
  pose.keys[0].hidden = true; assert.equal(animationEndTick(report), 30);
});
