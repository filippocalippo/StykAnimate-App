import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyDocument, createFrame, createObject} from '../src/demo.mjs';
import {ownedScope} from './support/owned-scope.mjs';

const open = ownedScope();

const near = (a, b) => assert.ok(Math.abs(a - b) < 2e-5, `${a} != ${b}`);
function fixture({sheet = false, staticJoint = false} = {}) {
  const report = emptyDocument(), figure = report.figure_types[0], base = figure.segments[0];
  figure.segments = [
    {...base, segment_id: 1, parent_id: 0, length: 100, angle_rad: 0, bend_rad: 0,
      aux_code: staticJoint ? 1 : 0, is_static: staticJoint, primitive_code: 0},
    {...base, segment_id: 2, parent_id: 1, length: 60, angle_rad: .5, bend_rad: 0, aux_code: 0, is_static: false},
    {...base, segment_id: 3, parent_id: 0, length: 40, angle_rad: -1, bend_rad: 0, aux_code: 0, is_static: false},
  ];
  figure.segment_count = 3;
  const first = createObject(figure, 1, 100, 100), second = createObject(figure, 1, 300, 100);
  second.bend_flag = 1; second.bends = [.2, 0, 0]; second.len_flag = 1; second.lengths = [120, 60, 40];
  second.angles = second.angles.map(a => a + .3);
  report.keyframes = [createFrame([first], 1), createFrame([second], 1)];
  const e = open({demo: false, layerTimeline: sheet, propertyChannels: sheet}, report);
  e.select(1, 0); return e;
}

test('Build bend publishes one reusable edit and preserves other poses', () => {
  const e = fixture({sheet: true}), before = e.serialize(), definition = e.figure;
  const storedFrames = () => [...e.report.keyframes, ...Object.values(e.report._styk.frameSources ?? {})];
  const sourceBefore = storedFrames().map(f => structuredClone(f.objects[0]));
  const history = e._undo.length;
  e.beginRigDrag({bend: true});
  for (let i = 1; i <= 15; i++) e.bendJoint(200, 100 + i * 2, {snap: false, stretch: true});
  const bend = e.object.bends[0], length = e.object.lengths[0];
  const preview = structuredClone(e.geometry.objects.get(e.selectedSlot).segments.map(s => s.end));
  assert.equal(e.figure, definition); near(e.figure.segments[0].bend_rad, 0);
  assert.equal(e._undo.length, history);
  e.commitDrag(); assert.equal(e._undo.length, history + 1);
  near(e.figure.segments[0].bend_rad, bend); near(e.figure.segments[0].length, length);
  near(e.figure.segments[1].angle_rad, .5 + bend); near(e.figure.segments[2].angle_rad, -1);
  e.geometry.objects.get(e.selectedSlot).segments.forEach((s, i) => {near(s.end.x, preview[i].x); near(s.end.y, preview[i].y);});
  const sources = storedFrames();
  for (let i = 0; i < sources.length; i++) {
    const obj = sources[i].objects[0], old = sourceBefore[i];
    near(obj.angles[1], old.angles[1] + bend); near(obj.angles[2], old.angles[2]);
    if (old.bend_flag) near(obj.bends[0], old.bends[0] + bend);
    if (old.len_flag) near(obj.lengths[0], old.lengths[0] * length / 100);
  }
  const after = e.serialize(); e.undo(); assert.deepEqual(e.serialize(), before);
  e.redo(); assert.deepEqual(e.serialize(), after);
  const reopened = open({demo: false, layerTimeline: true, propertyChannels: true}, after);
  near(reopened.report.figure_types[0].segments[0].bend_rad, bend);
});

test('Build bends static segments, while Animate retains static protection and isolated children', () => {
  const e = fixture({staticJoint: true}), before = e.serialize();
  assert.equal(e.bendJoint(200, 150), false);
  e.beginRigDrag({bend: true}); assert.equal(e.bendJoint(200, 150, {isolate: true, snap: false}), true);
  near(e.object.angles[1], .5); e.commitDrag();
  assert.ok(e.figure.segments[0].bend_rad > .5); near(e.figure.segments[1].angle_rad, .5);
  e.undo(); assert.deepEqual(e.serialize(), before);
});

test('cancelling or returning a Build bend leaves no history or reusable changes', () => {
  const e = fixture(), before = e.serialize(), history = e._undo.length;
  e.beginRigDrag({bend: true}); e.bendJoint(180, 150, {stretch: true}); e.cancelDrag();
  assert.deepEqual(e.serialize(), before); assert.equal(e._undo.length, history);
  e.beginRigDrag({bend: true}); e.bendJoint(180, 150, {snap: false}); e.bendJoint(200, 100, {snap: false});
  assert.equal(e.commitDrag(), false); assert.deepEqual(e.serialize(), before); assert.equal(e._undo.length, history);
});

test('Animate bending stays local to the current pose and leaves the definition intact', () => {
  const e = fixture(), next = structuredClone(e.report.keyframes[1]), definition = structuredClone(e.figure);
  e.beginDrag('Bend joint'); e.bendJoint(200, 140); e.commitDrag();
  assert.deepEqual(e.figure, definition); assert.deepEqual(e.report.keyframes[1], next);
  assert.ok(e.object.bends[0] > .5);
});
