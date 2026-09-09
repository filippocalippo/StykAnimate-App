import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyDocument, createObject, createFrame} from '../src/demo.mjs';
import {buildGeometry, evaluatedNativeFrame} from '../src/pivot/geometry.mjs';
import {animationChannelId, composeAnimationChannels, sampleAnimationChannel, animationEndTick, validateAnimationDocument} from '../src/animation-channels.mjs';

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-5, `${a} != ${b}`);
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
const compose = (report, frame, tick) => composeAnimationChannels(report, frame, tick, {resolveGeometry: buildGeometry});

test('empty channels and not-yet-started channels preserve exact native object identity and values', () => {
  const report = fixture(), native = evaluatedNativeFrame(report, 0, .3);
  assert.equal(compose(report, native, 6), native);
  set(report, [channel(target(1), 'x', [[10, 250]])]);
  assert.equal(compose(report, native, 6), native); assert.equal(native.objects[0].root_x, 130);
});

test('independent scalar curves replace only their own property and preserve unrelated objects', () => {
  const report = fixture(), native = evaluatedNativeFrame(report, 0, .5), before = structuredClone(native);
  set(report, [channel(target(1), 'x', [[0, 100], [20, 500]]), channel(target(1), 'opacity', [[0, 1], [20, .2]])]);
  const output = compose(report, native, 10);
  near(output.objects[0].root_x, 300); assert.equal(output.objects[0].field28, 102);
  assert.equal(output.objects[0].root_y, native.objects[0].root_y); assert.equal(output.objects[0].angles, native.objects[0].angles);
  assert.equal(output.objects[1], native.objects[1]); assert.deepEqual(native, before);
});

test('sparse curves interpolate and hold accurately without sampling or baking the native animation', () => {
  const linear = channel(target(1), 'x', [[7, 10], [100000, 40]]);
  assert.equal(sampleAnimationChannel(linear, 6), undefined); near(sampleAnimationChannel(linear, 50003.5), 25);
  assert.equal(sampleAnimationChannel(linear, 200000), 40);
  linear.keys[0].interpolation = 'hold'; assert.equal(sampleAnimationChannel(linear, 99999), 10);
  const rotation = channel(target(1), 'rotation', [[0, 0], [10, Math.PI * 2]]); near(sampleAnimationChannel(rotation, 5), Math.PI);
});

test('camera and scene channels drive native camera fields and explicit ARGB background overrides', () => {
  const report = fixture(); set(report, [channel({kind: 'camera'}, 'x', [[0, 0], [10, 100]]), channel({kind: 'camera'}, 'scale', [[0, 1], [10, 2]]),
    channel({kind: 'scene'}, 'color', [[0, 0xffff0000], [10, 0xff0000ff]])]);
  const frame = report.keyframes[0], output = compose(report, frame, 5);
  assert.equal(output.camera.is_default, false); near(output.camera.x, 50); near(output.camera.scale, 1.5);
  assert.equal(output._stykBackgroundColor, 0xff800080); assert.equal(output.objects, frame.objects);
  set(report, [channel({kind: 'scene'}, 'backgroundId', [[0, 1], [10, 2]])]);
  const held = compose(report, frame, 5); assert.equal(held.background_id, 1); assert.equal(held.background_mix, 0);
});

test('rotation channels rotate joined descendants once and child rotation keys remain absolute', () => {
  const report = fixture(), frame = report.keyframes[0]; frame.objects[1].join = {target_object_slot: 0, target_unique_id: 1, target_handle_id: 1};
  set(report, [channel(target(1), 'rotation', [[0, .5]]), channel(target(2), 'rotation', [[0, .2]])]);
  const output = compose(report, frame, 0);
  near(output.objects[0].angles[0] - frame.objects[0].angles[0], .5);
  near(output.objects[1].angles[0] - frame.objects[1].angles[0], .2);
  assert.deepEqual(output.objects[1].join, frame.objects[1].join);
});

test('joined figure position channels translate their connected component without breaking attachment', () => {
  const report = fixture(), frame = report.keyframes[0]; frame.objects[1].join = {target_object_slot: 0, target_unique_id: 1, target_handle_id: 1};
  const before = buildGeometry(report, frame), oldRoot = before.objects.get(1).root;
  set(report, [channel(target(2), 'x', [[0, oldRoot.x + 35]]), channel(target(2), 'y', [[0, oldRoot.y - 20]])]);
  const output = compose(report, frame, 0), after = buildGeometry(report, output);
  near(after.objects.get(1).root.x - oldRoot.x, 35); near(after.objects.get(1).root.y - oldRoot.y, -20);
  near(after.objects.get(0).root.x - before.objects.get(0).root.x, 35); assert.ok(output.objects[1].join);
});

test('channel validation rejects malformed payloads and keeps hidden native pose references', () => {
  const report = fixture(), pose = channel({kind: 'camera'}, 'pose', [[0, {frameId: 'f0'}], [0, {frameId: 'f1'}], [10, null]]);
  report.keyframes.forEach((frame, index) => { frame._styk = {frameId: `f${index}`}; });
  pose.keys[0].hidden = true; set(report, [pose]); assert.equal(validateAnimationDocument(report), report); assert.equal(animationEndTick(report), 11);
  delete pose.keys[0].hidden; assert.throws(() => validateAnimationDocument(report), /same frame/);
  set(report, [channel(target(1), 'opacity', [[0, 2]])]); assert.throws(() => validateAnimationDocument(report), /opacity/);
  set(report, [channel(target(1), 'x', [[10, 1], [5, 2]])]); assert.throws(() => validateAnimationDocument(report), /sorted/);
});

test('Scene background and color channels compose identically in either creation order', () => {
  const report = fixture(), frame = report.keyframes[0];
  const color = channel({kind: 'scene'}, 'color', [[0, 0xff112233]]), image = channel({kind: 'scene'}, 'backgroundId', [[0, 2]]);
  set(report, [color, image]); const first = compose(report, frame, 0);
  set(report, [image, color]); const second = compose(report, frame, 0);
  assert.deepEqual(first, second); assert.equal(second.background_id, 2); assert.equal(second._stykBackgroundColor, 0xff112233);
});

test('joined scalar transforms resolve geometry once and position keys see final rotations and scales', () => {
  const report = fixture(), frame = report.keyframes[0]; frame.objects[1].join = {target_object_slot: 0, target_unique_id: 1, target_handle_id: 1};
  set(report, [channel(target(1), 'rotation', [[0, .8]]), channel(target(1), 'scale', [[0, 1.5]]),
    channel(target(2), 'x', [[0, 250]]), channel(target(2), 'y', [[0, 125]])]);
  let calls = 0;
  const output = composeAnimationChannels(report, frame, 0, {resolveGeometry: (report, frame) => { calls++; return buildGeometry(report, frame); }});
  const geometry = buildGeometry(report, output);
  near(geometry.objects.get(1).root.x, 250); near(geometry.objects.get(1).root.y, 125); assert.equal(calls, 1);
});

test('ten-thousand independently rotated reverse-order joined figures use linear angle reads', () => {
  const report = fixture(), figure = report.figure_types[0], count = 10000; let reads = 0;
  const objects = Array.from({length: count}, (_, index) => {
    const object = createObject(figure, index + 1, 0, 0), angles = object.angles;
    if (index + 1 < count) object.join = {target_object_slot: index + 1, target_unique_id: index + 2, target_handle_id: 1};
    Object.defineProperty(object, 'angles', {enumerable: true, get() { reads++; return angles; }}); return object;
  });
  const frame = createFrame(objects, 1); set(report, objects.map(object => channel(target(object.unique_id), 'rotation', [[0, .4]])));
  const output = compose(report, frame, 0);
  assert.ok(reads < count * 5, `${reads} angle reads for ${count} figures`);
  near(output.objects[0].angles[0], figure.segments[0].angle_rad + .4);
  near(output.objects.at(-1).angles[0], figure.segments[0].angle_rad + .4);
});

test('a null Scene color key restores the independently selected background without erasing color keys', () => {
  const report = fixture(), frame = report.keyframes[0], color = channel({kind: 'scene'}, 'color', [[0, 0xff112233], [5, null], [10, 0xffaabbcc]]);
  set(report, [color, channel({kind: 'scene'}, 'backgroundId', [[0, 0]])]); assert.equal(validateAnimationDocument(report), report);
  assert.equal(compose(report, frame, 4)._stykBackgroundColor, 0xff112233);
  const cleared = compose(report, {...frame, _stykBackgroundColor: 0xff000000}, 7);
  assert.equal(cleared._stykBackgroundColor, undefined); assert.equal(cleared.background_id, 0);
  assert.equal(compose(report, frame, 10)._stykBackgroundColor, 0xffaabbcc);
  assert.equal(color.keys.length, 3);
});

test('a visible terminal pose owns a display frame when a coincident hidden reference follows it', () => {
  const report = fixture(); report.keyframes.forEach((frame, index) => { frame._styk = {frameId: `f${index}`}; });
  const pose = channel({kind: 'camera'}, 'pose', [[30, {frameId: 'f0'}], [30, {frameId: 'f1'}]]);
  pose.keys[1].hidden = true; set(report, [pose]);
  assert.equal(validateAnimationDocument(report), report); assert.equal(animationEndTick(report), 31);
  pose.keys[0].hidden = true; assert.equal(animationEndTick(report), 30);
});
