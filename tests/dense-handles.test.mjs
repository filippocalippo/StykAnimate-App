// Joints in dense frames (docs/SCENE-EDITING.md, "Joints in dense frames"): the count that decides the rule, the descriptors
// drawing and picking share under it, and the engine's geometry groups, built only when something reads them.
import test from 'node:test';
import assert from 'node:assert/strict';
import {DENSE_HANDLE_BUDGET, definitionHandleCount, denseHandles, frameHandleCount, getPivotHandles, pickCanvasHandle, pickCanvasSegment, rescalePivotHandles} from '../src/canvas-interactions.mjs';
import {createDemo, createFrame, createObject} from '../src/demo.mjs';
import {isStatic} from '../src/pivot/read-view.mjs';
import {engineBuilt} from './support/engine-node.mjs';
import {ownedEditor} from './support/owned-editor.mjs';
import {shownLimits} from '../src/engine/engine-shown.mjs';

const EAGER_SEGMENTS = shownLimits.eagerSegments;

/** The demo walker, `count` of them in a row over two keyframes that pose them differently. */
function crowd(count) {
  const report = createDemo(), walker = report.figure_types[0];
  report.figure_types = [walker];
  report.keyframes = [0, 1].map(key => createFrame(Array.from({length: count}, (_, i) => {
    const object = createObject(walker, i + 1, 120 + i * 140, 300 + key * 9);
    object.angles = object.angles.map((angle, joint) => angle + key * (joint + 1) * .05);
    return object;
  }), 4));
  return report;
}
/** Whether a group of the engine's geometry has been built (its segments are a value, not the getter that builds them). */
const built = group => Object.hasOwn(group, "segments");
/** A read of the frame on show from nothing held: every group new and not built. */
const freshRead = editor => { editor._shown.release(); return editor._shown.geometry(editor.evaluatedFrame); };
const BUILT = ['joints', 'segments', 'polys', 'drawables', 'solvedAngles', 'solvedLengths'];
const sameGroup = (actual, expected, label) => {
  assert.deepStrictEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), `${label}: the same fields`);
  for (const name of [...BUILT, 'slot', 'obj', 'fig', 'root', 'bounds', 'drawn']) assert.deepStrictEqual(actual[name], expected[name], `${label}: ${name}`);
};

test('a frame\'s joints are counted from the definitions: an origin per free figure and its moving joints, hidden and locked figures left out', () => {
  const report = crowd(3), walker = report.figure_types[0], moving = walker.segments.filter(segment => !isStatic(segment)).length;
  assert.equal(definitionHandleCount(walker), moving);
  const frame = report.keyframes[0], figureOf = () => walker;
  assert.equal(frameHandleCount(frame, figureOf), 3 * (1 + moving));
  assert.equal(frameHandleCount(frame, figureOf, {hiddenUids: new Set([1]), lockedUids: new Set([2])}), 1 + moving);
  const joined = {...frame, objects: frame.objects.map((object, i) => i === 2 ? {...object, join: {target_object_slot: 0, target_handle_id: 1}} : object)};
  assert.equal(frameHandleCount(joined, figureOf), 3 * moving + 2, 'a joined figure has no origin of its own');
  // On above the budget; once on, it holds until the frame has fewer than three quarters of it.
  assert.equal(denseHandles(DENSE_HANDLE_BUDGET), false);
  assert.equal(denseHandles(DENSE_HANDLE_BUDGET + 1), true);
  assert.equal(denseHandles(DENSE_HANDLE_BUDGET * .8, true), true);
  assert.equal(denseHandles(DENSE_HANDLE_BUDGET * .75, true), false);
  assert.equal(denseHandles(DENSE_HANDLE_BUDGET * .8, false), false);
});

test('a group of the engine\'s geometry is built on first read, the same whichever part is read first', {skip: !engineBuilt}, async () => {
  // Small documents, read as a dense frame is: built on first read.
  shownLimits.eagerSegments = 0;
  const {editor, owner} = await ownedEditor({demo: false}, crowd(4));
  try {
    editor.seek(2);
    const a = freshRead(editor), b = freshRead(editor), walker = editor.report.figure_types[0];
    assert.equal(a.objects.size, 4);
    for (const [slot, group] of a.objects) {
      const other = b.objects.get(slot);
      assert.ok(!built(group) && !built(other), 'nothing is built before it is read');
      // What the handles read of a group does not build it.
      assert.equal(group.segmentCount, walker.segments.length);
      const lengths = Array.from({length: group.segmentCount}, (_, index) => group.segmentLength(index));
      assert.deepEqual([...group.segmentLengths()], lengths);
      assert.deepEqual(Array.from({length: group.segmentCount}, (_, n) => group.segmentIndex(n)), walker.segments.map((_, index) => index));
      const zs = Array.from({length: group.segmentCount}, (_, n) => group.segmentZ(n));
      assert.ok(!built(group), 'counting, posed lengths and order do not build the group');
      assert.deepEqual(zs, group.segments.map(shape => shape.z));
      // One built through its segments, the other through its joints: the same group.
      assert.deepEqual(lengths, group.segments.map(shape => shape.length));
      assert.ok(other.joints.get(0) === other.root && built(other));
      sameGroup(group, other, `slot ${slot}`);
      assert.equal(group.segmentLength(3), group.segments[3].length, 'a built group answers its posed lengths from its segments');
    }
  } finally { owner.release(); shownLimits.eagerSegments = EAGER_SEGMENTS; }
});

test('a packet of a few segments is built at once, the same groups as built on first read', {skip: !engineBuilt}, async () => {
  const {editor, owner} = await ownedEditor({demo: false}, crowd(4));
  try {
    editor.seek(2);
    const eager = freshRead(editor);
    assert.ok([...eager.objects.values()].every(group => built(group) && !group.segmentLength), 'a small frame is built at once');
    shownLimits.eagerSegments = 0;
    const lazy = freshRead(editor);
    assert.ok([...lazy.objects.values()].every(group => !built(group)));
    for (const [slot, group] of eager.objects) {
      const other = lazy.objects.get(slot);
      void other.segments;
      for (const name of [...BUILT, 'slot', 'obj', 'fig', 'root', 'bounds', 'drawn']) assert.deepStrictEqual(other[name], group[name], `slot ${slot}: ${name}`);
      assert.deepStrictEqual(Object.keys(other).sort(), Object.keys(group).sort());
    }
  } finally { owner.release(); shownLimits.eagerSegments = EAGER_SEGMENTS; }
});

test('groups kept from older reads hold their values when they take words of their own', {skip: !engineBuilt}, async () => {
  // Small documents, read as a dense frame is: built on first read.
  shownLimits.eagerSegments = 0;
  const {editor, owner} = await ownedEditor({demo: false}, crowd(4));
  try {
    editor.seek(2);
    void editor.geometry;
    // Three reads, each sending other groups: the groups on show come from three packets, so the older ones copy their words.
    editor.select(1, -1); editor.beginTranslationDrag(); editor.moveSelection(9, 0, {fromStart: true});
    void editor.geometry;
    editor.cancelDrag();
    void editor.geometry;
    editor.select(2, -1); editor.beginTranslationDrag(); editor.moveSelection(0, 7, {fromStart: true});
    const shown = editor.geometry;
    assert.ok([...shown.objects.values()].filter(group => !built(group)).length >= 2, 'groups carried from older reads are still not built');
    const lengths = new Map([...shown.objects].map(([slot, group]) => [slot, group.segmentLength(4)]));
    const expected = freshRead(editor);
    for (const [slot, group] of shown.objects) {
      assert.equal(lengths.get(slot), expected.objects.get(slot).segmentLength(4), `slot ${slot}: posed length`);
      sameGroup(group, expected.objects.get(slot), `slot ${slot}`);
    }
    editor.cancelDrag();
  } finally { owner.release(); shownLimits.eagerSegments = EAGER_SEGMENTS; }
});

test('with the figures not selected showing their origin only, a selected figure is whole, picking finds what is drawn and nothing else is built', {skip: !engineBuilt}, async () => {
  // Small documents, read as a dense frame is: built on first read.
  shownLimits.eagerSegments = 0;
  const {editor, owner} = await ownedEditor({demo: false}, crowd(5));
  try {
    editor.seek(1);
    const walker = editor.report.figure_types[0], moving = definitionHandleCount(walker);
    const geometry = editor.geometry, frame = editor.evaluatedFrame;
    const options = {frame, selectedUid: 3, selectedUids: new Set([3]), showUnselected: false, viewScale: 1};
    const handles = getPivotHandles(geometry, options);
    const of = uid => handles.filter(handle => handle.uid === uid);
    assert.equal(of(3).length, 1 + moving, 'the selected figure shows its origin and every moving joint');
    for (const uid of [1, 2, 4, 5]) assert.deepEqual(of(uid).map(handle => handle.kind), ['origin'], `figure ${uid} shows its origin only`);
    for (const group of geometry.objects.values()) if (group.obj.unique_id !== 3) assert.ok(!built(group), `figure ${group.obj.unique_id} is not built`);
    // The origins are the size they are with every group built.
    const whole = getPivotHandles(freshRead(editor), {...options, showUnselected: true});
    for (const handle of handles.filter(item => item.kind === 'origin'))
      assert.equal(handle.screenRadius, whole.find(item => item.uid === handle.uid && item.kind === 'origin').screenRadius, `figure ${handle.uid}: origin size`);
    // Picking reads the same descriptors: a joint of a figure not selected is not there to grab, the selected figure's are.
    const group = uid => [...geometry.objects.values()].find(item => item.obj.unique_id === uid);
    const far = whole.filter(item => item.uid === 2 && item.kind === 'segment')
      .sort((p, q) => Math.hypot(q.point.x - group(2).root.x, q.point.y - group(2).root.y) - Math.hypot(p.point.x - group(2).root.x, p.point.y - group(2).root.y))[0];
    assert.equal(pickCanvasHandle(geometry, far.point, {handles}), null, 'a joint not drawn is not picked');
    assert.equal(pickCanvasSegment(geometry, far.point, {handles}), null, 'nor its segment');
    const joint = of(3).find(item => item.kind === 'segment' && !item.static);
    const hit = pickCanvasHandle(geometry, joint.point, {handles});
    assert.equal(hit.uid, 3); assert.equal(hit.id, joint.id);
    assert.equal(pickCanvasHandle(geometry, group(2).root, {handles}).kind, 'origin', 'an origin is picked where it is drawn');
    for (const item of geometry.objects.values()) if (item.obj.unique_id !== 3) assert.ok(!built(item), `picking did not build figure ${item.obj.unique_id}`);
  } finally { owner.release(); shownLimits.eagerSegments = EAGER_SEGMENTS; }
});

test('a zoom resizes the descriptors to what they would be built as at the new scale', {skip: !engineBuilt}, async () => {
  // Small documents, read as a dense frame is: built on first read.
  shownLimits.eagerSegments = 0;
  const {editor, owner} = await ownedEditor({demo: false}, crowd(3));
  try {
    editor.seek(1);
    const options = {frame: editor.evaluatedFrame, selectedUid: 2, selectedUids: new Set([2]), viewScale: 1, maxDiameter: 12};
    const sizes = list => list.map(({baseRadius, ...handle}) => handle);
    for (const showUnselected of [true, false]) {
      const handles = getPivotHandles(editor.geometry, {...options, showUnselected});
      for (const viewScale of [.05, .4, 2.5, 9, -1.5]) {
        const resized = rescalePivotHandles(handles, {viewScale, maxDiameter: 12}), built = getPivotHandles(editor.geometry, {...options, showUnselected, viewScale});
        // baseRadius is the descriptors' bookkeeping: a size worked out once is kept where the scale makes it irrelevant.
        assert.deepEqual(sizes(resized), sizes(built), `scale ${viewScale}`);
        assert.deepEqual(resized.groups.map(group => [group.uid, group.offset, sizes(group.handles)]), built.groups.map(group => [group.uid, group.offset, sizes(group.handles)]));
        assert.ok(resized.groups.every(group => group.handles.every((handle, i) => handle === resized[group.offset + i])), 'the groups hold the descriptors of the list');
      }
    }
    // Seen whole, a crowd's joints are all the smallest size: the segments' lengths are not read.
    const reads = [];
    const fresh = freshRead(editor);
    for (const group of fresh.objects.values()) { const read = group.segmentLengths.bind(group); group.segmentLengths = () => { reads.push(group.slot); return read(); }; }
    const far = getPivotHandles(fresh, {...options, showUnselected: false, viewScale: .05, maxDiameter: 12});
    assert.deepEqual(reads, []); assert.ok(far.every(handle => handle.screenRadius === 2));
    assert.deepEqual(sizes(rescalePivotHandles(far, {viewScale: 1.3, maxDiameter: 12})), sizes(getPivotHandles(fresh, {...options, showUnselected: false, viewScale: 1.3, maxDiameter: 12})), 'sizes are worked out when they matter again');
    assert.ok(reads.length > 0);
  } finally { owner.release(); shownLimits.eagerSegments = EAGER_SEGMENTS; }
});
