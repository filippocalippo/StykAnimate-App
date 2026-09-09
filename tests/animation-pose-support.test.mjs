import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyDocument, createFrame, createObject} from '../src/demo.mjs';
import {evaluatedNativeFrame, buildGeometry} from '../src/pivot/geometry.mjs';
import {composePoseChannels} from '../src/animation-pose.mjs';

test('retiming a joined parent rotates retained child bones once without mutating the source pose', () => {
  const report = emptyDocument(), parentFigure = report.figure_types[0], childFigure = structuredClone(parentFigure);
  childFigure.figure_type_id = 2;
  const bone = {parent: -1, handleId: null, reversed: false, angle_rad: .25, bend_rad: .1, length: 17};
  childFigure._styk = {animationOrigin: {handleId: 0, rotationHandleId: null, reversed: false, support: {
    version: 1, rotation: 0, path: [],
    bones: [bone, ...childFigure.segments.map(segment => ({parent: -1, handleId: segment.segment_id, reversed: false,
      angle_rad: 0, bend_rad: segment.bend_rad ?? 0, length: segment.length}))],
    vertices: Object.fromEntries([[0, -1], ...childFigure.segments.map((segment, index) => [segment.segment_id, index + 1])]),
  }}};
  report.figure_types.push(childFigure);
  report._styk.layers = {order: ['parent', 'child'], defaultLayerId: 'parent', assignments: {1: 'parent', 2: 'child'}};
  report.keyframes = [0, Math.PI / 2].map((angle, index) => {
    const parent = createObject(parentFigure, 1, 100, 200), child = createObject(childFigure, 2, 300, 400);
    parent.angles[0] = angle; child.angles.fill(0);
    child.join = {target_object_slot: 0, target_unique_id: 1, target_handle_id: 1};
    child._stykAnimationOrigin = {x: 300, y: 400, ghosts: {'0': {angle_rad: .25, bend_rad: .1, length: 17}}};
    const frame = createFrame([parent, child], 10); frame._styk = {frameId: `pose-${index}`}; return frame;
  });
  report._styk.animation = {channels: [{id: 'parent-pose', target: {kind: 'layer', id: 'parent'}, property: 'pose',
    keys: [{id: 'key-1', tick: 0, value: {frameId: 'pose-1'}, interpolation: 'linear'}]}]};
  const before = structuredClone(report), sourceGhosts = report.keyframes[0].objects[1]._stykAnimationOrigin.ghosts;
  const output = composePoseChannels(report, report.keyframes[0], 0, {sampleNative: evaluatedNativeFrame, resolveGeometry: buildGeometry});
  const child = output.objects.find(object => object.unique_id === 2), ghost = child._stykAnimationOrigin.ghosts['0'];
  assert.equal(ghost.angle_rad, .25 + Math.PI / 2); assert.equal(ghost.bend_rad, .1); assert.equal(ghost.length, 17);
  assert.ok(child.angles.every(angle => angle === Math.PI / 2));
  assert.notEqual(child._stykAnimationOrigin.ghosts, sourceGhosts); assert.deepEqual(report, before);
});
