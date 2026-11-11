import test from 'node:test';
import assert from 'node:assert/strict';
import {createPoseInputQueue} from '../src/canvas-pose-input.mjs';
import {createFrame, createObject, emptyDocument} from '../src/demo.mjs';
import {ownedEditorFor} from './support/owned-editor.mjs';

function queueFixture() {
  const drag = {}, gesture = {}, delivered = [];
  let current = true, schedules = 0;
  const queue = createPoseInputQueue({apply: event => delivered.push(event),
    isCurrent: (a, b) => current && a === drag && b === gesture, schedule: () => schedules++});
  const enqueue = (event, modifiers = '', angle = null) => queue.enqueue({drag, gesture, event, modifiers, angle, initialAngle: 0});
  return {queue, enqueue, delivered, invalidate: () => current = false, get schedules() { return schedules; }};
}

test('a burst evaluates the latest target once, and flushing release delivers that exact event', () => {
  const fixture = queueFixture(), events = Array.from({length: 100}, (_, x) => ({x}));
  for (const event of events) fixture.enqueue(event);
  assert.deepEqual(fixture.delivered, []);
  assert.equal(fixture.queue.pending.event, events.at(-1));
  assert.equal(fixture.queue.flush(), true);
  assert.deepEqual(fixture.delivered, [events.at(-1)]);
  assert.equal(fixture.queue.flush(), false);
});

test('modifiers publish the preceding stretch/constraint target before replacing it', () => {
  const {queue, enqueue, delivered} = queueFixture();
  enqueue({x: 10, stretch: true}, 'stretch'); enqueue({x: 20, stretch: true}, 'stretch');
  enqueue({x: 30, stretch: false}, 'normal');
  assert.deepEqual(delivered, [{x: 20, stretch: true}]);
  queue.flush(); assert.deepEqual(delivered, [{x: 20, stretch: true}, {x: 30, stretch: false}]);
});

test('cancelled or replaced editor sessions cannot apply a stale target', () => {
  const fixture = queueFixture();
  fixture.enqueue({x: 10}); fixture.invalidate();
  assert.equal(fixture.queue.flush(), false); assert.deepEqual(fixture.delivered, []);
  const cleared = queueFixture(); cleared.enqueue({x: 20}); cleared.queue.clear();
  assert.equal(cleared.queue.flush(), false); assert.deepEqual(cleared.delivered, []);
});

function editorFixture() {
  const report = emptyDocument(), figure = report.figure_types[0], segment = figure.segments[0];
  figure.segments = [{...segment, segment_id: 1, parent_id: 0, angle_rad: 0, length: 100},
    {...segment, segment_id: 2, parent_id: 1, angle_rad: .5, length: 40}];
  figure.segment_count = figure.segments.length;
  report.keyframes = [createFrame([createObject(figure, 1, 200, 200)], 3)];
  const editor = ownedEditorFor({demo: false}, report); editor.select(1, 0);
  return editor;
}
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);

function comparePose(samples, method = 'poseJoint', begin = 'beginDrag', directFirst = null) {
  const direct = editorFixture(), queued = editorFixture();
  direct[begin](); queued[begin]();
  const drag = {}, gesture = queued._drag;
  let count = 0;
  const apply = (editor, sample) => editor[method](sample.x, sample.y,
    {stretch: sample.stretch, isolate: sample.isolate, snap: false});
  if (directFirst) { apply(direct, directFirst); apply(queued, directFirst); }
  const queue = createPoseInputQueue({apply: sample => { count++; apply(queued, sample); },
    isCurrent: (a, b) => a === drag && b === queued._drag, schedule() {}});
  for (const sample of samples) {
    apply(direct, sample);
    queue.enqueue({drag, gesture, event: sample, angle: sample.angle, initialAngle: directFirst?.angle ?? 0,
      modifiers: `${sample.stretch}|${sample.isolate}`});
  }
  queue.flush();
  for (const field of ['angles', 'lengths', 'bends']) {
    assert.equal(queued.object[field].length, direct.object[field].length);
    queued.object[field].forEach((value, i) => near(value, direct.object[field][i]));
  }
  const expected = direct.geometry.objects.get(0), actual = queued.geometry.objects.get(0);
  for (const [id, point] of expected.joints) {
    near(actual.joints.get(id).x, point.x); near(actual.joints.get(id).y, point.y);
  }
  const before = queued._drag.before.map(object => object.angles.slice());
  direct.commitDrag(); queued.commitDrag();
  assert.equal(queued._undo.length, 1);
  const committed = queued.object.angles.slice();
  queued.undo(); assert.deepEqual(queued.object.angles, before[0]);
  queued.redo(); assert.deepEqual(queued.object.angles, committed);
  return count;
}

test('coalesced native posing preserves repeated full rotations and descendant angles', () => {
  const samples = Array.from({length: 721}, (_, i) => {
    const angle = i * Math.PI / 90;
    return {angle, x: 200 + 100 * Math.cos(angle), y: 200 + 100 * Math.sin(angle)};
  });
  const count = comparePose(samples);
  assert.ok(count < samples.length / 10, `Expected bounded pose evaluation, got ${count}`);
});

test('a direct slop-crossing pose becomes the angular baseline for the following coalesced burst', () => {
  const sample = degrees => {
    const angle = degrees * Math.PI / 180;
    return {angle, x: 200 + 100 * Math.cos(angle), y: 200 + 100 * Math.sin(angle)};
  };
  // Tracking this burst from the pointerdown angle zero instead of the
  // applied -100-degree target would lose one native turn on final flush.
  comparePose(Array.from({length: 180}, (_, index) => sample(index - 90)), 'poseJoint', 'beginDrag', sample(-100));
});

test('native pose and bend preserve stretch/isolation transitions before commit', () => {
  const samples = Array.from({length: 100}, (_, i) => {
    const angle = i / 100, radius = 80 + i;
    return {angle, x: 200 + radius * Math.cos(angle), y: 200 + radius * Math.sin(angle),
      stretch: i < 60, isolate: i >= 30 && i < 80};
  });
  comparePose(samples); comparePose(samples, 'bendJoint');
});

test('baseline-owned rig and handle edits preserve exact final geometry and one undo command', () => {
  const samples = Array.from({length: 50}, (_, i) => ({x: 300 + i, y: 220 + i / 2, stretch: i > 20}));
  comparePose(samples, 'editRigJoint', 'beginRigDrag');
  comparePose(samples, 'editHandlePosition', 'beginHandleEditDrag');
});

test('cancel discards a pending native pose without adding history or dirty state', () => {
  const editor = editorFixture(), original = editor.serialize(), drag = {};
  editor.beginDrag(); const gesture = editor._drag;
  const queue = createPoseInputQueue({apply: sample => editor.poseJoint(sample.x, sample.y),
    isCurrent: (a, b) => a === drag && b === editor._drag, schedule() {}});
  queue.enqueue({drag, gesture, event: {x: 250, y: 300}, modifiers: ''});
  queue.clear(); editor.cancelDrag(); queue.flush();
  assert.deepEqual(editor.serialize(), original); assert.equal(editor._undo.length, 0); assert.equal(editor.dirty, false);
});
