// Motion-path trails are the engine's (docs/MOTION-PATHS.md): the session samples where a joint (or the camera) is at each
// tick, from its document or, while a trail point is dragged, from the document as the drag shows it; the interface holds what
// it sent (`MotionTrails`), draws it and hit-tests it. An editor the engine owns, read the way the overlay reads.
import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyDocument, createObject, createFrame} from '../src/demo.mjs';
import {MotionTrails, motionPathTargets, pickMotionPathPoint, projectMotionPath} from '../src/motion-path.mjs';
import {engineBuilt} from './support/engine-node.mjs';
import {ownedEditor} from './support/owned-editor.mjs';

const options = {demo: false, layerTimeline: true};
const near = (a, b, tolerance = 1e-4) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);
const point = (a, b, tolerance = 1e-4) => { near(a.x, b.x, tolerance); near(a.y, b.y, tolerance); };
const rootTarget = {kind: 'node', uid: 1, handleId: 0, joint: -1};

/** Three stored poses, x = 100, 300, 500, ten ticks each. */
function fixture() {
  const report = emptyDocument(), figure = report.figure_types[0];
  report.keyframes = [100, 300, 500].map(x => createFrame([createObject(figure, 1, x, 200)], 10));
  return report;
}
/** Two figures whose limbs swing while the bodies travel. */
function swingFixture() {
  const report = emptyDocument(), figure = report.figure_types[0];
  report.keyframes = Array.from({length: 4}, (_, k) => createFrame([1, 2].map(uid => {
    const object = createObject(figure, uid, 100 + k * 80 + uid * 300, 200);
    object.angles = object.angles.map((a, j) => j ? a + Math.sin(k + j) * .6 : a);
    return object;
  }), 6));
  return report;
}
async function open(report = fixture()) {
  const {editor, owner} = await ownedEditor(options, report);
  editor.select(1);
  return {editor, owner, trails: new MotionTrails(editor, {budgetMs: Infinity})};
}

test('a trail has a point for every planned tick, marks the keys and answers a hit test', {skip: !engineBuilt}, async () => {
  const {editor, owner, trails} = await open();
  try {
    const [trail] = trails.read([rootTarget]);
    assert.equal(trail.complete, true);
    assert.equal(trail.ticks[0], 0);
    assert.equal(trail.points.size, trail.ticks.length);
    near(trail.points.get(0).x, 100); near(trail.points.get(5).x, 200); near(trail.points.get(10).x, 300); near(trail.points.get(20).x, 500);
    assert.ok(trail.points.get(0).key && trail.points.get(10).key && !trail.points.get(5).key);
    assert.equal(pickMotionPathPoint(trail, {x: 200, y: 200}, {project: p => p, radius: 9}).tick, 5);
    assert.equal(pickMotionPathPoint(trail, {x: -500, y: -500}, {project: p => p, radius: 9}), null);
    assert.equal(trails.read([rootTarget])[0], trail, 'a trail that has not changed is the one already held');
  } finally { owner.release(); }
});

test('the camera trail is the canvas centre moved by the camera', {skip: !engineBuilt}, async () => {
  const report = fixture();
  report.keyframes[1].camera = {x: 50, y: -20, scale: 1, angle_rad: 0, is_default: false};
  const {editor, owner, trails} = await open(report);
  try {
    const [trail] = trails.read([{kind: 'camera'}]);
    near(trail.points.get(0).x, editor.report.canvas_width / 2);
    near(trail.points.get(10).x, editor.report.canvas_width / 2 + 50);
    near(trail.points.get(10).y, editor.report.canvas_height / 2 - 20);
  } finally { owner.release(); }
});

test('a read samples within its budget and the trail completes over the next reads', {skip: !engineBuilt}, async () => {
  const {editor, owner} = await open();
  try {
    const trails = new MotionTrails(editor, {budgetMs: 0});
    const [first] = trails.read([rootTarget]);
    assert.equal(first.complete, false);
    assert.ok(first.points.size > 0 && first.points.size < first.ticks.length);
    let trail = first;
    for (let calls = 0; !trail.complete && calls < 100; calls++) [trail] = trails.read([rootTarget]);
    assert.ok(trail.complete);
    assert.equal(trail.points.size, trail.ticks.length);
    near(trail.points.get(10).x, 300);
  } finally { owner.release(); }
});

test('a committed edit keeps the old trail while it is sampled again', {skip: !engineBuilt}, async () => {
  const {editor, owner} = await open();
  try {
    const trails = new MotionTrails(editor, {budgetMs: 0});
    let [trail] = trails.read([rootTarget]);
    while (!trail.complete) [trail] = trails.read([rootTarget]);
    near(trail.points.get(10).x, 300);
    assert.ok(editor.beginMotionPathEdit(rootTarget, 10));
    editor.updateMotionPathEdit({x: 500, y: 400});
    editor.commitMotionPathEdit();
    [trail] = trails.read([rootTarget]);
    assert.equal(trail.complete, false);
    assert.ok(trail.points.size > 0, 'the points of the old document stay while the new one is sampled');
    while (!trail.complete) [trail] = trails.read([rootTarget]);
    near(trail.points.get(10).x, 500);
    near(trail.points.get(0).x, 100);
  } finally { owner.release(); }
});

test('while a point is dragged the trail follows the drag, and it is the document again when the drag is cancelled', {skip: !engineBuilt}, async () => {
  const {editor, owner, trails} = await open();
  try {
    let [trail] = trails.read([rootTarget]);
    near(trail.points.get(10).x, 300);
    const revision = editor.revision;
    assert.ok(editor.beginMotionPathEdit(rootTarget, 10));
    editor.updateMotionPathEdit({x: 500, y: 400});
    [trail] = trails.read([rootTarget]);
    near(trail.points.get(10).x, 500); near(trail.points.get(15).x, 500);
    near(trail.points.get(0).x, 100);
    const between = trail.points.get(9).x;
    assert.ok(between > 100 && between < 500, 'the ticks between the keys are tweened to the moved one');
    editor.updateMotionPathEdit({x: 550, y: 300});
    [trail] = trails.read([rootTarget]);
    near(trail.points.get(10).x, 550); near(trail.points.get(15).x, 525);
    editor.cancelMotionPathEdit();
    [trail] = trails.read([rootTarget]);
    near(trail.points.get(10).x, 300); near(trail.points.get(15).x, 400);
    assert.equal(editor.revision, revision);
  } finally { owner.release(); }
});

test('the trail of a drag is the trail the commit makes', {skip: !engineBuilt}, async () => {
  const {editor, owner, trails} = await open();
  try {
    assert.ok(editor.beginMotionPathEdit(rootTarget, 10));
    editor.updateMotionPathEdit({x: 500, y: 400});
    const [live] = trails.read([rootTarget]);
    const during = [...live.points.values()].map(({tick, x, y}) => [tick, x, y]);
    assert.equal(editor.commitMotionPathEdit(), true);
    const [committed] = trails.read([rootTarget]);
    assert.deepEqual([...committed.points.values()].map(({tick, x, y}) => [tick, x, y]), during);
  } finally { owner.release(); }
});

test('with a budget a drag is sampled over reads, the ticks it changes first', {skip: !engineBuilt}, async () => {
  const {editor, owner} = await open();
  try {
    const trails = new MotionTrails(editor, {budgetMs: Infinity});
    trails.read([rootTarget]);
    assert.ok(editor.beginMotionPathEdit(rootTarget, 10));
    editor.updateMotionPathEdit({x: 550, y: 300});
    trails.budgetMs = 0;
    let trail, calls = 0;
    do { [trail] = trails.read([rootTarget]); assert.ok(++calls < 100); } while (!trail.complete);
    near(trail.points.get(10).x, 550); near(trail.points.get(15).x, 525);
    editor.cancelMotionPathEdit(); calls = 0;
    do { [trail] = trails.read([rootTarget]); assert.ok(++calls < 100); } while (!trail.complete);
    near(trail.points.get(10).x, 300); near(trail.points.get(15).x, 400);
  } finally { owner.release(); }
});

test('pointer input reads what the last read left, and nothing once the document has changed', {skip: !engineBuilt}, async () => {
  const {editor, owner, trails} = await open();
  try {
    const [trail] = trails.read([rootTarget]);
    assert.equal(trails.peek(rootTarget), trail);
    editor.updateObject({root_x: 120});
    assert.equal(trails.peek(rootTarget), null, 'a trail of the document as it was is not hit tested');
    assert.notEqual(trails.read([rootTarget])[0], trail);
  } finally { owner.release(); }
});

test('a ranged trail follows the playhead and keeps the samples it has', {skip: !engineBuilt}, async () => {
  const {editor, owner, trails} = await open();
  try {
    editor.seek(10);
    const [before] = trails.read([rootTarget], {range: 4});
    assert.deepEqual(before.ticks, [6, 7, 8, 9, 10, 11, 12, 13, 14]);
    const shared = before.points.get(10);
    editor.seek(12);
    const [after] = trails.read([rootTarget], {range: 4});
    assert.deepEqual([after.ticks[0], after.ticks.at(-1)], [8, 16]);
    assert.deepEqual(after.points.get(10), shared);
    assert.equal(after.points.has(6), false);
    // A playhead beyond the end does not start the trail over.
    editor.seek(30, {allowBeyondEnd: true});
    const [late] = trails.read([rootTarget], {range: 4});
    assert.equal(late.ticks.at(-1), editor.totalTicks - 1);
    assert.equal(trails.read([rootTarget], {range: 4})[0], late);
  } finally { owner.release(); }
});

test('every selected figure has a trail, sampled together as they would be alone', {skip: !engineBuilt}, async () => {
  const {editor, owner, trails} = await open(swingFixture());
  try {
    const targets = motionPathTargets(editor, {joints: 'tips', all: true});
    assert.ok(targets.length > 4, 'the origin and the tips of both figures');
    const batched = trails.read(targets);
    for (const [i, target] of targets.entries()) {
      const [single] = new MotionTrails(editor, {budgetMs: Infinity}).read([target]);
      assert.equal(batched[i].complete, true);
      for (const tick of single.ticks) point(batched[i].points.get(tick), single.points.get(tick));
    }
    // Every trail agrees with the joint of the frame at an in-between tick.
    editor.seek(9);
    for (const [i, target] of targets.entries()) {
      const slot = editor.evaluatedFrame.objects.findIndex(o => o.unique_id === target.uid);
      point(batched[i].points.get(9), editor.geometry.objects.get(slot).joints.get(target.handleId));
    }
  } finally { owner.release(); }
});

test('a trail point carries the body it belongs to, except the origin of the body itself', {skip: !engineBuilt}, async () => {
  const {editor, owner, trails} = await open(swingFixture());
  try {
    const figure = editor.report.figure_types[0];
    const hand = {kind: 'node', uid: 1, handleId: Number(figure.segments.at(-1).segment_id), joint: figure.segments.length - 1};
    const [origin, tip] = trails.read([rootTarget, hand]);
    for (const tick of origin.ticks) {
      assert.equal(origin.points.get(tick).rx, undefined);
      near(tip.points.get(tick).rx, origin.points.get(tick).x);
      near(tip.points.get(tick).ry, origin.points.get(tick).y);
    }
  } finally { owner.release(); }
});

test('a relative trail keeps the body in place, and hit tests use the same positions', {skip: !engineBuilt}, async () => {
  const {editor, owner, trails} = await open(swingFixture());
  try {
    const figure = editor.report.figure_types[0];
    editor.seek(6);
    const hand = {kind: 'node', uid: 1, handleId: Number(figure.segments.at(-1).segment_id), joint: figure.segments.length - 1};
    const [trail] = trails.read([hand]);
    const world = projectMotionPath(trail, p => p, {tick: 6});
    const relative = projectMotionPath(trail, p => p, {tick: 6, relative: true});
    assert.notEqual(world, relative, 'switching the anchor projects again');
    assert.equal(projectMotionPath(trail, p => p, {tick: 6, relative: true}), relative, 'an unchanged projection is reused');
    const anchor = trail.points.get(6);
    relative.samples.forEach((sample, i) => {
      near(relative.xs[i] - (sample.x - sample.rx), anchor.rx);
      near(relative.ys[i] - (sample.y - sample.ry), anchor.ry);
    });
    const at = relative.samples.findIndex(s => s.tick === 18);
    const hit = pickMotionPathPoint(trail, {x: relative.xs[at], y: relative.ys[at]}, {project: p => p, tick: 6, relative: true});
    assert.equal(hit.tick, 18);
    near(hit.x, trail.points.get(18).x, 1e-9);
  } finally { owner.release(); }
});

test('the pose at a trail point covers the figures joined to the target, as the document has it then', {skip: !engineBuilt}, async () => {
  const report = emptyDocument(), figure = report.figure_types[0];
  const child = () => {
    const object = createObject(figure, 2, 0, 0);
    object.join = {target_object_slot: 0, target_handle_id: figure.segments[0].segment_id, target_unique_id: 1};
    return object;
  };
  report.keyframes = [100, 300, 500].map(x => createFrame([createObject(figure, 1, x, 200), child()], 10));
  const {editor, owner, trails} = await open(report);
  try {
    const ghost = trails.ghost({kind: 'node', uid: 2, handleId: 0, joint: -1}, 15);
    assert.ok(ghost.lines.length >= 2, 'the joined parent and child');
    editor.seek(15);
    point({x: ghost.rx, y: ghost.ry}, editor.geometry.objects.get(0).root);
    assert.equal(trails.ghost({kind: 'camera'}, 15), null);
    assert.equal(trails.ghost({kind: 'node', uid: 99, handleId: 0, joint: -1}, 15), null);
  } finally { owner.release(); }
});

test('a trail follows the edits of the same document: retiming, and pose edits', {skip: !engineBuilt}, async () => {
  const {editor, owner, trails} = await open();
  try {
    trails.read([rootTarget]);
    assert.ok(editor.beginMotionPathEdit(rootTarget, 15));
    editor.updateMotionPathEdit({x: 250, y: 330});
    assert.equal(editor.commitMotionPathEdit(), true);
    const [trail] = trails.read([rootTarget]);
    point(trail.points.get(15), {x: 250, y: 330});
    point(trail.points.get(12), {x: 300 + (250 - 300) * 2 / 5, y: 200 + 130 * 2 / 5});
  } finally { owner.release(); }
});

test('a movieclip being edited has trails of its own, and the project\'s are back once it is left', {skip: !engineBuilt}, async () => {
  const {editor, owner, trails} = await open();
  try {
    const clip = editor.createMovieclip({start: 0, end: 6});
    editor.enterMovieclip(clip.figure_type_id);
    const [inside] = trails.read([rootTarget]);
    assert.ok(inside?.points.size, 'the clip\'s session samples its trail');
    assert.equal(trails.peek(rootTarget), inside);
    editor.leaveMovieclip();
    assert.ok(trails.read([rootTarget])[0]);
  } finally { owner.release(); }
});
