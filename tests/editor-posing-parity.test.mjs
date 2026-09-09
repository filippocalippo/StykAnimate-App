import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {createFrame, createObject, emptyDocument} from '../src/demo.mjs';
import {arc} from '../src/pivot/geometry.mjs';

const near = (a, b, tolerance = 2e-4) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);
function isolationFixture() {
  const report = emptyDocument(), template = report.figure_types[0].segments[0];
  const s = (id, parent, staticFlag = 0) => ({...template, segment_id: id, parent_id: parent, length: 40,
    angle_rad: 0, bend_rad: 0, aux_code: staticFlag, flags: staticFlag << 8});
  const figure = (id, segments) => ({figure_type_id: id, name: 'Isolation ' + id, segments, polyfills: [], image_assets: [], text_assets: []});
  const root = figure(1, [s(40, 30, 1), s(30, 20), s(20, 10, 1), s(10, 0), s(50, 0)]);
  const allStaticOrigin = figure(2, [s(110, 0, 1), s(120, 110)]);
  const mixedOrigin = figure(3, [s(210, 0, 1), s(220, 0)]);
  const ordinary = figure(4, [s(310, 0)]);
  report.figure_types = [root, allStaticOrigin, mixedOrigin, ordinary];
  const object = (definition, uid, parentSlot, handle) => {
    const o = createObject(definition, uid, 100, 100);
    if (parentSlot !== undefined) o.join = {target_object_slot: parentSlot, target_handle_id: handle};
    return o;
  };
  // Children precede their parent; origin-attached and dynamic-boundary cases
  // deliberately share source definitions but have different propagation scopes.
  report.keyframes = [createFrame([
    object(ordinary, 71, 1, 120), object(allStaticOrigin, 29, 4, 20),
    object(mixedOrigin, 83, 4, 20), object(ordinary, 47, 4, 30),
    object(root, 11), object(ordinary, 97, 4, 0), object(ordinary, 101, 2, 210),
  ], 1)];
  report.keyframes[0].objects.forEach((o, slot) => { o.object_slot = slot; if (o.join) o.join.target_unique_id = report.keyframes[0].objects[o.join.target_object_slot].unique_id; });
  const editor = new Editor({demo: false}).load(report); editor.select(11, 3); return editor;
}
function simple() {
  const report = emptyDocument(), figure = report.figure_types[0], base = figure.segments[0];
  figure.segments = [{...base, segment_id: 1, parent_id: 0, angle_rad: 0, length: 100, bend_rad: 0},
    {...base, segment_id: 2, parent_id: 1, angle_rad: 0, length: 50, bend_rad: 0}];
  report.keyframes = [createFrame([createObject(figure, 1, 0, 0)], 1)];
  const editor = new Editor({demo: false}).load(report); editor.select(1, 0); return editor;
}

test('animation isolation follows static chains and native joined-origin admission without restarting at dynamic boundaries', () => {
  const editor = isolationFixture(), original = editor.serialize(), root = editor.geometry.objects.get(4).segments[3];
  editor.beginDrag(); editor.poseJoint(root.start.x + 40 * Math.cos(0.3), root.start.y + 40 * Math.sin(0.3), {isolate: true}); editor.commitDrag();
  const objects = editor.frame.objects;
  [0, 0, 0.3, 0.3, 0].forEach((angle, i) => near(objects[4].angles[i], angle));
  for (const slot of [0, 1]) for (const angle of objects[slot].angles) near(angle, 0.3);
  for (const slot of [2, 3, 5, 6]) for (const angle of objects[slot].angles) near(angle, 0);
  for (const [slot, object] of objects.entries()) if (object.join) {
    const origin = editor.geometry.objects.get(slot).root; near(object.root_x, origin.x); near(object.root_y, origin.y);
  }
  assert.equal(editor._undo.length, 1); editor.undo(); assert.deepEqual(editor.serialize(), original);
});

test('isolated bending keeps the start tangent and turns only the admitted static and joined branches', () => {
  const editor = isolationFixture(), shape = editor.geometry.objects.get(4).segments[3], bend = 0.7;
  const end = arc(shape.start, shape.angle, 40, bend).at(-1);
  editor.bendJoint(end.x, end.y, {isolate: true});
  near(editor.object.angles[3], 0); near(editor.object.bends[3], bend); near(editor.object.angles[2], bend);
  for (const slot of [0, 1]) for (const angle of editor.frame.objects[slot].angles) near(angle, bend);
  for (const slot of [2, 3, 5, 6]) for (const angle of editor.frame.objects[slot].angles) near(angle, 0);
  near(editor.object.angles[0], 0); near(editor.object.angles[1], 0);
});

test('length snapping depends on the starting pose and can be disabled', () => {
  const editor = simple(); editor.updateSegment({length: 140});
  editor.beginDrag(); editor.poseJoint(104, 0, {stretch: true}); near(editor.object.lengths[0], 100);
  editor.poseJoint(103, 0, {stretch: true}); near(editor.object.lengths[0], 100); editor.commitDrag();
  editor.beginDrag(); editor.poseJoint(103, 0, {stretch: true}); near(editor.object.lengths[0], 103); editor.commitDrag();
  editor.updateSegment({length: 140}); editor.poseJoint(104, 0, {stretch: true, snap: false}); near(editor.object.lengths[0], 104);
  editor.updateSegment({length: 140}); editor.poseJoint(104, 0, {stretch: true, snapTolerance: 2}); near(editor.object.lengths[0], 104);
});

test('bend snapping needs a nondefault starting bend and leaves subsequent default-start drags free', () => {
  const editor = simple(); editor.updateSegment({bend_rad: 0.8}); const target = arc({x: 0, y: 0}, 0, 100, 0.04).at(-1);
  editor.beginDrag(); editor.bendJoint(target.x, target.y); near(editor.object.bends[0], 0); editor.commitDrag();
  editor.beginDrag(); editor.bendJoint(target.x, target.y); near(editor.object.bends[0], 0.04); editor.commitDrag();
  editor.updateSegment({bend_rad: 0.8}); editor.bendJoint(target.x, target.y, {snap: false}); near(editor.object.bends[0], 0.04);
});

test('combined bend and stretch reaches the pointer with a fixed start tangent and one undo command', () => {
  const editor = simple(), original = editor.serialize();
  editor.bendJoint(75, 50, {stretch: true}); const shape = editor.geometry.objects.get(0).segments[0];
  near(shape.end.x, 75); near(shape.end.y, 50); near(editor.object.angles[0], 0);
  near(editor.object.angles[1], editor.object.bends[0]); assert.equal(editor._undo.length, 1);
  editor.undo(); assert.deepEqual(editor.serialize(), original);
  editor.updateSegment({primitive_code: 1}); assert.equal(editor.bendJoint(75, 50), false);
});

test('invalid snap settings and full-circle stretching leave the scene unchanged', () => {
  const editor = simple(); editor.updateSegment({bend_rad: Math.PI * 2}); const original = editor.serialize();
  assert.throws(() => editor.poseJoint(10, 10, {stretch: true}), /full-circle/);
  assert.deepEqual(editor.serialize(), original); assert.equal(editor.dragging, false);
  assert.throws(() => editor.poseJoint(10, 10, {snapTolerance: -1}), /negative/);
  assert.throws(() => editor.bendJoint(10, 10, {snapTolerance: NaN}), /finite/);
  assert.deepEqual(editor.serialize(), original);
});

test('numeric multiselection scaling changes selected spacing and leaves unselected joined scales intact', () => {
  const editor = simple(), first = editor.selectedUid, child = editor.duplicateFigure().unique_id;
  editor.joinTo(first, 1); const second = editor.duplicateFigure().unique_id;
  editor.selectMany([first, second]); const before = editor.serialize(), roots = editor.selectedObjects.map(o => ({uid: o.unique_id, x: o.root_x, y: o.root_y}));
  editor.scaleSelected(2, {center: {x: 0, y: 0}});
  for (const root of roots) {
    const object = editor.frame.objects.find(o => o.unique_id === root.uid);
    near(object.root_x, root.x * 2); near(object.root_y, root.y * 2); near(object.scale, 2);
  }
  near(editor.frame.objects.find(o => o.unique_id === child).scale, 1);
  editor.undo(); assert.deepEqual(editor.serialize(), before);
});
