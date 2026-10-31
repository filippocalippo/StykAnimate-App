import test from 'node:test';
import assert from 'node:assert/strict';
import {newOwnedEditor} from './support/owned-editor.mjs';
import {builderFixture} from '../scripts/builder-benchmark-fixture.mjs';

/** `prepare(report)` changes the document before it opens. */
function fixture(prepare = null) {
  const report = builderFixture(5, 2), figure = report.figure_types[0];
  figure.segments.forEach((segment, index) => {
    segment.parent_id = [0, 1, 2, 1, 4][index];
    segment.angle_rad = [.3, .6, .9, -.4, -.7][index];
    segment.bend_rad = .1 * (index + 1);
  });
  report.keyframes[0].objects[0].angles = figure.segments.map(segment => segment.angle_rad);
  report.keyframes.push(structuredClone(report.keyframes[0]));
  report.keyframes[1].objects[0].angles = figure.segments.map(segment => segment.angle_rad + .2);
  prepare?.(report);
  const editor = newOwnedEditor({}); editor.load(report); editor.select(1, 1);
  return editor;
}
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);
test('branch flip reflects attached figures only on selected handles', () => {
  const e = fixture(report => {
    const frame = report.keyframes[0], attached = structuredClone(frame.objects[1]);
    attached.unique_id = 3; attached.object_slot = 2;
    attached.join = {target_object_slot: 0, target_unique_id: 1, target_handle_id: 3};
    frame.objects[1].join = {target_object_slot: 0, target_unique_id: 1, target_handle_id: 5};
    frame.objects.push(attached); frame.object_draw_order.push(2); frame.object_draw_order_unique_ids.push(3);
  });
  e.selectBranch(1, 1);
  const before = e.geometry, selected = before.objects.get(0), pivot = selected.segments[1].start;
  const sibling = structuredClone(e.frame.objects[1].angles);
  e.mirrorFigure('horizontal');
  const after = e.geometry;
  for (const [id, point] of before.objects.get(2).joints) {
    near(after.objects.get(2).joints.get(id).x, 2 * pivot.x - point.x);
    near(after.objects.get(2).joints.get(id).y, point.y);
  }
  assert.deepEqual(e.frame.objects[1].angles, sibling);
  assert.deepEqual(after.objects.get(1).root, before.objects.get(1).root);
});
for (const axis of ['horizontal', 'vertical']) {
  test(`${axis} selected parts, root, and undo`, () => {
    const e = fixture(); e.toggleSegment(1, 3);
    const before = structuredClone(e.object), document = JSON.stringify(e.serialize());
    const geometry = e.geometry.objects.get(0), undo = e._undo.length;
    e.mirrorFigure(axis);
    const after = e.geometry.objects.get(0);
    for (let i = 0; i < 5; i++) {
      near(e.object.angles[i], [1, 3].includes(i) ? axis === 'horizontal' ? Math.PI - before.angles[i] : -before.angles[i] : before.angles[i]);
      near(after.segments[i].bend, geometry.segments[i].bend * ([1, 3].includes(i) ? -1 : 1));
    }
    assert.deepEqual(after.root, geometry.root);
    assert.deepEqual(after.segments[0].end, geometry.segments[0].end);
    assert.equal(e.object.image_text_flags, before.image_text_flags);
    assert.equal(e._undo.length, undo + 1);
    const flipped = JSON.stringify(e.serialize());
    e.undo(); assert.equal(JSON.stringify(e.serialize()), document);
    e.redo(); assert.equal(JSON.stringify(e.serialize()), flipped);
    e.undo(); e.select(1, -1); e.mirrorFigure(axis);
    e.object.angles.forEach((angle, i) => near(angle, axis === 'horizontal' ? Math.PI - before.angles[i] : -before.angles[i]));
  });
  test(`${axis} branch range preserves sibling branch`, () => {
    const e = fixture(); e.selectBranch(1, 1);
    const before = e.report.keyframes.map(frame => structuredClone(frame.objects[0]));
    e.mirrorFiguresInFrames(axis, [0, 1]);
    for (let frame = 0; frame < 2; frame++) {
      e.seek(e.timeline[frame].start);
      e.object.angles.forEach((angle, i) => near(angle, [1, 2].includes(i) ? axis === 'horizontal' ? Math.PI - before[frame].angles[i] : -before[frame].angles[i] : before[frame].angles[i]));
    }
  });
}
