import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyDocument, createFrame, createObject } from '../src/demo.mjs';
import { evaluatedNativeFrame as evaluatedFrame, buildGeometry, nativeTimeline as timeline } from '../src/pivot/geometry.mjs';
import { composePoseChannels, buildVirtualPoseTrack, invalidatePoseCache } from '../src/animation-pose.mjs';

function fixture() {
  const report = emptyDocument(), figure = report.figure_types[0];
  report._styk.layers = { order: ['layer-1', 'layer-2'], defaultLayerId: 'layer-1', assignments: { 1: 'layer-1', 2: 'layer-2' } };
  report.keyframes = [0, 100, 0].map((x, index) => ({
    ...createFrame([createObject(figure, 1, x, 200), createObject(figure, 2, 10 + index * 10, 300)], 10),
    _styk: { frameId: `f${index}` }, camera: { is_default: false, x: index * 20, y: 0, scale: 1, angle_rad: 0 },
  }));
  return report;
}
const channel = (target, keys) => ({ id: `${target.kind}:${target.id || ''}:pose`, target, property: 'pose',
  keys: keys.map(([tick, frameId], i) => ({ id: `k${i}`, tick, value: frameId === null ? null : { frameId }, interpolation: 'linear' })) });
function sample(report, tick) {
  const entries = timeline(report); let index = entries.findLastIndex(entry => entry.start <= tick);
  index = Math.max(0, index); const entry = entries[index];
  return evaluatedFrame(report, index, entry.count ? (tick - entry.start) / entry.count : 0);
}
const options = { sampleNative: evaluatedFrame, resolveGeometry: buildGeometry };
function compose(report, tick) { return composePoseChannels(report, sample(report, tick), tick, options); }

test('removing an imported layer pose removes its influence without retiming another layer', () => {
  const report = fixture();
  report._styk.animation = { channels: [channel({ kind: 'layer', id: 'layer-1' }, [[0, 'f0'], [20, 'f2']])] };
  const output = compose(report, 10);
  assert.equal(output.objects.find(o => o.unique_id === 1).root_x, 0);
  assert.equal(output.objects.find(o => o.unique_id === 2).root_x, 20);
  assert.equal(report.keyframes[1].objects[0].root_x, 100);
});

test('moving a single layer pose interpolates against its actual new key positions', () => {
  const report = fixture();
  report._styk.animation = { channels: [channel({ kind: 'layer', id: 'layer-1' }, [[0, 'f0'], [15, 'f1'], [20, 'f2']])] };
  assert.ok(Math.abs(compose(report, 10).objects.find(o => o.unique_id === 1).root_x - 100 * 10 / 15) < 1e-8);
  assert.equal(compose(report, 15).objects.find(o => o.unique_id === 1).root_x, 100);
  assert.equal(compose(report, 15).objects.find(o => o.unique_id === 2).root_x, 25);
});

test('pose wrappers share native object storage and preserve source-specific unknown data', () => {
  const report = fixture(); report.keyframes[1].unknown_native = { value: 17 };
  const track = buildVirtualPoseTrack(report, channel({ kind: 'layer', id: 'layer-1' }, [[0, 'f0'], [30, 'f1']]));
  assert.equal(track.frames[0].objects, report.keyframes[0].objects);
  assert.equal(track.frames[1].unknown_native, report.keyframes[1].unknown_native);
  assert.equal(track.frames[0].duration_raw, 30);
  assert.equal(report.keyframes[0].duration_raw, 10);
});

test('independent Camera and Scene poses do not change figure poses', () => {
  const report = fixture(); report.keyframes.forEach((frame, index) => { frame.background_id = index; });
  report._styk.animation = { channels: [
    channel({ kind: 'camera' }, [[0, 'f2']]), channel({ kind: 'scene' }, [[0, 'f1']]),
  ] };
  const output = compose(report, 0);
  assert.equal(output.camera.x, 40); assert.equal(output.background_id, 1);
  assert.equal(output.objects, report.keyframes[0].objects);
});

test('layer pose tracks can add, remove and explicitly blank object presence', () => {
  const report = fixture(), first = report.keyframes[0];
  first.objects = first.objects.filter(o => o.unique_id !== 1);
  first.objects[0].object_slot = 0; first.object_draw_order = [0];
  report._styk.animation = { channels: [channel({ kind: 'layer', id: 'layer-1' }, [[0, 'f1'], [10, null], [20, 'f2']])] };
  assert.deepEqual(compose(report, 0).objects.map(o => o.unique_id).sort(), [1, 2]);
  assert.deepEqual(compose(report, 10).objects.map(o => o.unique_id), [2]);
  assert.deepEqual(compose(report, 20).objects.map(o => o.unique_id).sort(), [1, 2]);
});

test('layer retiming resolves cross-layer attachments by UID and rotates attached children once', () => {
  const report = fixture();
  report.keyframes.forEach((frame, index) => {
    const parent = frame.objects[0], child = frame.objects[1];
    parent.angles[0] = index === 1 ? Math.PI / 2 : 0;
    child.join = { target_object_slot: 0, target_handle_id: 1 };
    child.angles = child.angles.map(() => parent.angles[0]);
  });
  report._styk.animation = { channels: [channel({ kind: 'layer', id: 'layer-1' }, [[0, 'f1']])] };
  const output = compose(report, 0), parent = output.objects.find(o => o.unique_id === 1), child = output.objects.find(o => o.unique_id === 2);
  assert.equal(output.objects[child.join.target_object_slot].unique_id, parent.unique_id);
  assert.ok(child.angles.every(angle => Math.abs(angle - Math.PI / 2) < 1e-10));
  const geometry = buildGeometry(report, output);
  assert.deepEqual(geometry.objects.get(child.object_slot).root, geometry.objects.get(parent.object_slot).joints.get(1));
  assert.equal(report.keyframes[0].objects[1].angles[0], 0);
});

test('a disappearing retimed parent leaves the child at its sampled world position', () => {
  const report = fixture();
  report.keyframes[1].objects[1].join = { target_object_slot: 0, target_handle_id: 1 };
  const expected = buildGeometry(report, report.keyframes[1]).objects.get(1).root;
  report._styk.animation = { channels: [
    channel({ kind: 'layer', id: 'layer-1' }, [[0, null]]), channel({ kind: 'layer', id: 'layer-2' }, [[0, 'f1']]),
  ] };
  const output = compose(report, 0), child = output.objects[0];
  assert.equal(output.objects.length, 1); assert.equal(child.join, null);
  assert.equal(child.root_x, expected.x); assert.equal(child.root_y, expected.y);
});

test('independent poses cannot silently create cyclic joins', () => {
  const report = fixture();
  report.keyframes[0].objects[0].join = { target_object_slot: 1, target_handle_id: 1 };
  report.keyframes[1].objects[1].join = { target_object_slot: 0, target_handle_id: 1 };
  report._styk.animation = { channels: [channel({ kind: 'layer', id: 'layer-2' }, [[0, 'f1']])] };
  assert.throws(() => compose(report, 0), /cyclic figure attachment/);
});

test('retained native frame sources remain usable after their original frame is deleted', () => {
  const report = fixture(), source = report.keyframes[1];
  report._styk.frameSources = { f1: source }; report.keyframes.splice(1, 1);
  report._styk.animation = { channels: [channel({ kind: 'layer', id: 'layer-1' }, [[0, 'f1']])] };
  assert.equal(compose(report, 0).objects.find(o => o.unique_id === 1).root_x, 100);
  invalidatePoseCache(report);
  assert.equal(compose(report, 0).objects.find(o => o.unique_id === 1).root_x, 100);
});
