import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {emptyDocument, createObject, createFrame} from '../src/demo.mjs';
import {buildGeometry, evaluatedFrame} from '../src/pivot/geometry.mjs';
import {solveIKPoints, ikChain, validateIK} from '../src/ik.mjs';
import {materializePivotDocument} from '../src/pivot-export-materialize.mjs';
import {nativeFigureDocument} from '../src/native-figure.mjs';
import {getPivotHandles} from '../src/canvas-interactions.mjs';

const near = (a, b, tolerance = 1e-4) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);
const point = (a, b, tolerance) => { near(a.x, b.x, tolerance); near(a.y, b.y, tolerance); };
export function fixture(options = {}) {
  const document = emptyDocument(), figure = document.figure_types[0], base = figure.segments[0];
  figure.segments = [
    {...base, segment_id: 11, parent_id: 0, length: 90, angle_rad: .8, aux_code: 0, is_static: false},
    {...base, segment_id: 22, parent_id: 11, length: 90, angle_rad: 2, aux_code: 0, is_static: false},
    {...base, segment_id: 33, parent_id: 22, length: 35, angle_rad: 0, aux_code: 0, is_static: false},
    {...base, segment_id: 44, parent_id: 0, length: 90, angle_rad: 2.1, aux_code: 0, is_static: false},
    {...base, segment_id: 55, parent_id: 44, length: 90, angle_rad: 1.2, aux_code: 0, is_static: false},
    {...base, segment_id: 66, parent_id: 55, length: 35, angle_rad: Math.PI, aux_code: 0, is_static: false},
  ];
  figure.segment_count = figure.segments.length;
  document.keyframes = [createFrame([createObject(figure, 1, 300, 150)], 8)];
  const editor = new Editor({demo: false, ...options}).load(document); editor.select(1, 1); return editor;
}
const g = e => e.geometry.objects.get(0);

test('Both follows a full circular drag without mirroring across the original knee axis', () => {
  for (const pinned of [true, false]) for (const side of [-1, 1]) {
    const e = fixture(); e.setNodeIK({enabled: true, pinned, bendDirection: side});
    e.poseJoint(420, 150); e.setNodeIK({bendDirection: 0});
    let previous = g(e).joints.get(11);
    e.beginDrag();
    for (let i = 1; i <= 240; i++) {
      const angle = i * Math.PI / 120, target = {x: 300 + 120 * Math.cos(angle), y: 150 + 120 * Math.sin(angle)};
      e.poseJoint(target.x, target.y);
      const posed = g(e), knee = posed.joints.get(11);
      point(posed.joints.get(22), target); near(posed.segments[2].angle, 0);
      assert.ok(Math.hypot(knee.x - previous.x, knee.y - previous.y) < 3, `knee snapped at step ${i}`);
      const cross = (target.x - 300) * (knee.y - 150) - (target.y - 150) * (knee.x - 300);
      assert.equal(Math.sign(cross), side); previous = knee;
    }
    e.commitDrag();
  }
});

test('Both switches once through a fully folded limb, preserving knee continuity at the root', () => {
  for (const pinned of [true, false]) for (const side of [-1, 1]) {
    const e = fixture(); e.setNodeIK({enabled: true, pinned, bendDirection: side});
    e.poseJoint(360, 150); e.setNodeIK({bendDirection: 0});
    let previous = g(e).joints.get(11);
    e.beginDrag();
    for (let x = 359; x >= 240; x--) {
      e.poseJoint(x, 150); const knee = g(e).joints.get(11);
      point(g(e).joints.get(22), {x, y: 150});
      assert.ok(Math.hypot(knee.x - previous.x, knee.y - previous.y) < 2, `fold snapped at x=${x}`);
      assert.equal(Math.sign(knee.y - 150), side); previous = knee;
    }
    e.commitDrag();
    const saved = e.serialize(), reopened = new Editor({demo: false}).load(saved);
    point(g(reopened).joints.get(11), previous);
    e.undo(); e.redo(); point(g(e).joints.get(11), previous);
  }
});

test('moving the root through a Both pin keeps the knee continuous and the foot planted', () => {
  const e = fixture(); e.setNodeIK({enabled: true}); e.poseJoint(360, 150);
  const foot = g(e).joints.get(33); let previous = g(e).joints.get(11);
  e.select(1, -1); e.beginTranslationDrag();
  for (let dx = 1; dx <= 120; dx++) {
    e.moveSelection(dx, 0, {fromStart: true}); const knee = g(e).joints.get(11);
    point(g(e).joints.get(33), foot);
    assert.ok(Math.hypot(knee.x - previous.x, knee.y - previous.y) < 2, `root crossing snapped at ${dx}`);
    previous = knee;
  }
  e.commitDrag();
});

test('Both stays continuous through folded animation and is independent of seek order', () => {
  const e = fixture(); e.setNodeIK({enabled: true}); e.poseJoint(360, 150);
  const a = structuredClone(e.frame); delete a._styk;
  e.select(1, -1); e.moveSelection(120, 0);
  const b = structuredClone(e.frame); delete b._styk;
  e.report.keyframes = [a, b];
  const source = JSON.stringify(e.report), knees = [];
  for (let i = 0; i <= 120; i++) {
    const frame = evaluatedFrame(e.report, 0, i / 120), posed = buildGeometry(e.report, frame).objects.get(0), knee = posed.joints.get(11);
    point(posed.joints.get(22), {x: 360, y: 150});
    if (i) assert.ok(Math.hypot(knee.x - knees[i - 1].x, knee.y - knees[i - 1].y) < 2, `animated fold snapped at ${i}`);
    knees.push(knee);
  }
  for (let i = 120; i >= 0; i--) point(buildGeometry(e.report, evaluatedFrame(e.report, 0, i / 120)).objects.get(0).joints.get(11), knees[i]);
  assert.equal(JSON.stringify(e.report), source);
});

test('Both retains its bend through extension, stretch and subpixel target jitter', () => {
  for (const stretch of [false, true]) for (const side of [-1, 1]) {
    const e = fixture(); e.setNodeIK({enabled: true, allowStretch: stretch, bendDirection: side});
    e.poseJoint(420, 150); e.setNodeIK({bendDirection: 0});
    e.beginDrag();
    for (let i = 0; i < 80; i++) e.poseJoint(480 + (i % 2 ? 1e-7 : -1e-7), 150 + (i % 3 - 1) * 1e-7);
    e.poseJoint(600, 150); e.poseJoint(420, 150); e.commitDrag();
    assert.equal(Math.sign(g(e).joints.get(11).y - 150), side);
  }
});

test('float32-sized target noise at a folded endpoint cannot spin the knee', () => {
  const e = fixture(); e.setNodeIK({enabled: true}); e.poseJoint(360, 150);
  e.beginDrag();
  for (let x = 359; x >= 300; x--) e.poseJoint(x, 150);
  const knee = g(e).joints.get(11);
  for (let i = 0; i < 100; i++) {
    e.poseJoint(300 + Math.cos(i) * 2e-5, 150 + Math.sin(i) * 2e-5);
    point(g(e).joints.get(11), knee); point(g(e).joints.get(22), {x: 300, y: 150});
  }
  e.poseJoint(299, 150);
  assert.ok(Math.hypot(g(e).joints.get(11).x - knee.x, g(e).joints.get(11).y - knee.y) < 1);
  e.commitDrag();
});

test('long Both chains follow a target across the original pose axis without a whole-chain reflection', () => {
  const e = fixture(); e.select(1, 2); e.setNodeIK({enabled: true, chainLength: 3});
  e.poseJoint(420, 150); let previous = g(e).joints.get(11);
  e.beginDrag();
  for (let i = 1; i <= 240; i++) {
    const angle = i * Math.PI / 120;
    e.poseJoint(300 + 120 * Math.cos(angle), 150 + 120 * Math.sin(angle));
    const knee = g(e).joints.get(11);
    assert.ok(Math.hypot(knee.x - previous.x, knee.y - previous.y) < 12, `long-chain jump at ${i}`);
    previous = knee;
  }
  e.commitDrag();
});

test('stretch reaches distant targets without changing rest lengths or unrelated branches', () => {
  const e = fixture(); e.setNodeIK({enabled: true}); e.poseJoint(600, 150);
  point(g(e).joints.get(22), {x: 480, y: 150});
  const original = e.object.lengths.slice();
  e.setNodeIK({allowStretch: true});
  point(g(e).joints.get(22), {x: 600, y: 150});
  near(g(e).segments[0].length, 150); near(g(e).segments[1].length, 150);
  near(g(e).segments[2].length, 35); near(g(e).segments[3].length, 90);
  near(g(e).segments[2].angle, 0); assert.deepEqual(e.object.lengths, original);
  e.setNodeIK({allowStretch: false}); point(g(e).joints.get(22), {x: 480, y: 150});
  e.undo(); point(g(e).joints.get(22), {x: 600, y: 150});
  e.poseJoint(400, 230); point(g(e).joints.get(22), {x: 400, y: 230});
  near(g(e).segments[0].length, 90); near(g(e).segments[1].length, 90);
});

test('stretched native and baked Pivot exports reproduce the pose without modifying the source', () => {
  const e = fixture(); e.setNodeIK({enabled: true, allowStretch: true}); e.poseJoint(600, 200);
  const original = JSON.stringify(e.serialize()), displayed = g(e);
  for (const report of [e.serialize(), nativeFigureDocument(e.report, {figureUid: 1}), materializePivotDocument(e.report)]) {
    const reopened = new Editor({demo: false}).load(report), actual = g(reopened);
    for (const [id, p] of displayed.joints) point(actual.joints.get(id), p);
  }
  assert.equal(JSON.stringify(e.serialize()), original);
  e.setNodeIK({pinned: false});
  for (const [id, p] of displayed.joints) point(g(e).joints.get(id), p);
  e.setNodeIK({enabled: false});
  for (const [id, p] of displayed.joints) point(g(e).joints.get(id), p);
});

test('unpinned stretch uses the gesture baseline and retracts without cumulative length changes', () => {
  const e = fixture(); e.setNodeIK({enabled: true, pinned: false, allowStretch: true});
  e.beginDrag(); e.poseJoint(600, 150); near(g(e).segments[0].length, 150);
  e.poseJoint(660, 150); near(g(e).segments[0].length, 180);
  e.poseJoint(400, 230); near(g(e).segments[0].length, 90);
  point(g(e).joints.get(22), {x: 400, y: 230}); e.commitDrag();
});

test('releasing a stretched pin bakes only its own chain and leaves other pinned rest lengths intact', () => {
  for (const patch of [{pinned: false}, {enabled: false}]) {
    const e = fixture(); e.setNodeIK({enabled: true, allowStretch: true}); e.poseJoint(600, 150);
    e.select(1, 4); e.setNodeIK({enabled: true, allowStretch: true}); e.poseJoint(0, 150);
    e.select(1, 1); e.setNodeIK(patch);
    near(g(e).segments[0].length, 150); near(g(e).segments[3].length, 150);
    near(e.object.lengths[0], 150); near(e.object.lengths[3], 90);
    e.select(1, 4); e.poseJoint(200, 230);
    near(g(e).segments[3].length, 90); near(g(e).segments[0].length, 150);
  }
});

test('Both preserves either incoming bend side while Left and Right choose opposite solutions', () => {
  for (const n of [2, 4]) for (const side of [-1, 1]) {
    const input = Array.from({length: n + 1}, (_, i) => ({x: i * 6, y: Math.sin(Math.PI * i / n) * 6 * side}));
    const lengths = Array.from({length: n}, (_, i) => Math.hypot(input[i + 1].x - input[i].x, input[i + 1].y - input[i].y));
    const automatic = structuredClone(input), opposite = structuredClone(input), target = {x: n * 5, y: 0};
    solveIKPoints(automatic, lengths, target, 0); solveIKPoints(opposite, lengths, target, -side);
    point(automatic.at(-1), target, .01); point(opposite.at(-1), target, .01);
    assert.ok(automatic[1].y * side > 0); assert.ok(opposite[1].y * side < 0);
  }
  const e = fixture(); e.setNodeIK({enabled: true}); assert.equal(e.getIKSettings().bendDirection, 0);
  for (const pinned of [true, false]) for (const side of [-1, 1]) {
    e.setNodeIK({pinned, bendDirection: side}); e.poseJoint(400, 150);
    assert.ok((g(e).joints.get(11).y - 150) * side > 0);
  }
});

test('IK retains normal circular handle descriptors and accepts older metadata without stretch', () => {
  const e = fixture(), options = {selectedUid: 1, selectedJoint: 1};
  const before = getPivotHandles(e.geometry, options).find(h => h.id === 22);
  e.setNodeIK({enabled: true});
  const after = getPivotHandles(e.geometry, options).find(h => h.id === 22);
  for (const key of ['kind', 'color', 'radius', 'screenRadius', 'action']) assert.equal(after[key], before[key]);
  point(after.point, before.point); assert.equal(before.ik, false); assert.equal(after.ik, true);
  assert.equal(getPivotHandles(e.geometry, {...options, builder: true}).find(h => h.id === 22).ik, false);
  const legacy = structuredClone(e.object); delete legacy._stykIK[22].allowStretch; validateIK(legacy);
  legacy._stykIK[22].allowStretch = 'yes'; assert.throws(() => validateIK(legacy), /Invalid IK/);
  assert.throws(() => e.setNodeIK({allowStretch: 1}), /Invalid IK/);
});

test('IK enables pinned without changing the visible pose; foot has independent orientation', () => {
  const e = fixture(), before = g(e);
  e.setNodeIK({enabled: true});
  assert.equal(e.getIKSettings().pinned, true); assert.equal(e.getIKSettings().chainLength, 2);
  for (const [id, p] of before.joints) point(g(e).joints.get(id), p);
  const target = {x: 365, y: 265}; e.poseJoint(target.x, target.y);
  point(g(e).joints.get(22), target); near(g(e).segments[2].angle, before.segments[2].angle);
  for (const i of [0, 1]) near(g(e).segments[i].length, 90);
  e.rotateIKTarget(.4); near(g(e).segments[2].angle, .4);
});

test('both feet remain in world space while root translates and rotates; unrelated limbs are retained', () => {
  const e = fixture(); e.setNodeIK({enabled: true}); e.select(1, 4); e.setNodeIK({enabled: true});
  const before = g(e); e.select(1, -1); e.moveSelection(12, -15);
  for (const id of [22, 55, 33, 66]) point(g(e).joints.get(id), before.joints.get(id));
  e.rotateSelection(.1);
  for (const id of [22, 55, 33, 66]) point(g(e).joints.get(id), before.joints.get(id));
});

test('unpin/disable bake the visible pose without a jump and unpinned IK still poses the limb', () => {
  const e = fixture(); e.setNodeIK({enabled: true}); e.select(1, -1); e.moveSelection(15, -10); e.select(1, 1);
  const before = g(e); e.setNodeIK({pinned: false});
  for (const [id, p] of before.joints) point(g(e).joints.get(id), p);
  e.poseJoint(365, 260); point(g(e).joints.get(22), {x: 365, y: 260});
  e.select(1, -1); e.moveSelection(10, 7); point(g(e).joints.get(22), {x: 375, y: 267});
  e.select(1, 1); e.setNodeIK({pinned: true}); const pinned = g(e); e.setNodeIK({enabled: false});
  for (const [id, p] of pinned.joints) point(g(e).joints.get(id), p);
  assert.equal(e.object._stykIK, undefined);
});

test('FK edits to the outgoing foot remain editable while the ankle is pinned', () => {
  const e = fixture(); e.setNodeIK({enabled: true}); e.select(1, 2); e.rotateJoint(.3);
  near(g(e).segments[2].angle, .3); const p = g(e).joints.get(22);
  e.select(1, -1); e.moveSelection(10, -10); point(g(e).joints.get(22), p); near(g(e).segments[2].angle, .3);
});

test('gesture previews produce one history entry; cancellation, undo, redo and serialization preserve targets', () => {
  const e = fixture(); e.setNodeIK({enabled: true}); const saved = e.serialize(), count = e._undo.length;
  e.beginDrag(); for (let i = 0; i < 20; i++) e.poseJoint(350 + i, 265); e.commitDrag();
  assert.equal(e._undo.length, count + 1); const after = e.serialize();
  e.undo(); assert.deepEqual(e.serialize(), saved); e.redo(); assert.deepEqual(e.serialize(), after);
  e.beginDrag(); e.poseJoint(340, 250); e.cancelDrag(); assert.deepEqual(e.serialize(), after);
  const loaded = new Editor({demo: false}).load(JSON.parse(JSON.stringify(after))); loaded.select(1, 1);
  point(g(loaded).joints.get(22), g(e).joints.get(22)); assert.deepEqual(loaded.getIKSettings(), e.getIKSettings());
});

test('pins solve at interpolated ticks and native export bakes identical visible geometry', () => {
  const e = fixture(); e.setNodeIK({enabled: true});
  const target = g(e).joints.get(22), a = structuredClone(e.frame), b = structuredClone(e.frame);
  delete a._styk; delete b._styk; b.objects[0].root_x += 20; b.objects[0].root_y -= 12;
  e.report.keyframes = [a, b]; e._invalidate({timing: true});
  const before = JSON.stringify(e.report), materialized = materializePivotDocument(e.report);
  for (let tick = 0; tick < 8; tick++) {
    const frame = evaluatedFrame(e.report, 0, tick / 8, tick), live = buildGeometry(e.report, frame).objects.get(0);
    point(live.joints.get(22), target); near(live.segments[2].angle, 0);
    const baked = buildGeometry(materialized, materialized.keyframes[tick]).objects.get(0);
    for (const [id, p] of live.joints) point(baked.joints.get(id), p);
    assert.equal(materialized.keyframes[tick].objects[0]._stykIK, undefined);
  }
  assert.equal(JSON.stringify(e.report), before);
});

test('target movement interpolates, while pin state changes are discrete', () => {
  const e = fixture(); e.setNodeIK({enabled: true});
  const a = structuredClone(e.frame), b = structuredClone(e.frame), first = a.objects[0]._stykIK[22].target;
  b.objects[0]._stykIK[22].target.x += 20; b.objects[0]._stykIK[22].target.rotation = .4;
  e.report.keyframes = [a, b];
  const frame = evaluatedFrame(e.report, 0, .5), posed = buildGeometry(e.report, frame).objects.get(0);
  point(posed.joints.get(22), {x: first.x + 10, y: first.y}); near(posed.segments[2].angle, .2);
  b.objects[0]._stykIK[22].pinned = false;
  assert.equal(evaluatedFrame(e.report, 0, .5).objects[0]._stykIK[22].pinned, true);
});

test('analytic solver handles unreachable, folded, straight, zero length and bend-side cases', () => {
  for (const target of [{x: 5, y: 5}, {x: 100, y: 0}, {x: 0, y: 0}, {x: -5, y: -2}]) for (const side of [-1, 1]) {
    const points = [{x: 0, y: 0}, {x: 10, y: 0}, {x: 20, y: 0}];
    solveIKPoints(points, [10, 10], target, side);
    for (let i = 0; i < 2; i++) near(Math.hypot(points[i + 1].x - points[i].x, points[i + 1].y - points[i].y), 10);
    if (Math.hypot(target.x, target.y) <= 20) point(points[2], target);
  }
  const zero = [{x: 0, y: 0}, {x: 0, y: 0}, {x: 0, y: 0}]; solveIKPoints(zero, [0, 0], {x: 3, y: 4});
  assert.ok(zero.every(p => Number.isFinite(p.x) && Number.isFinite(p.y)));
});

test('long-chain solve is bounded, escapes straight singularity and preserves every length', () => {
  for (const n of [3, 8, 64]) {
    const points = Array.from({length: n + 1}, (_, i) => ({x: i * 10, y: 0})), lengths = Array(n).fill(10);
    const result = solveIKPoints(points, lengths, {x: n * 7, y: 5});
    assert.ok(result.iterations <= 32);
    for (let i = 0; i < n; i++) near(Math.hypot(points[i + 1].x - points[i].x, points[i + 1].y - points[i].y), 10);
    assert.ok(result.error < .1, `${n}-chain residual ${result.error}`);
  }
});

test('stable handle IDs, chain bounds, overlapping controllers and malformed metadata are guarded', () => {
  const e = fixture(); assert.deepEqual(ikChain(e.figure, 22, 2), [0, 1]);
  assert.throws(() => e.setNodeIK({enabled: true, chainLength: 3}), /Chain length/);
  e.setNodeIK({enabled: true}); e.select(1, 0);
  assert.throws(() => e.setNodeIK({enabled: true}), /share bones/);
  const bad = structuredClone(e.object); bad._stykIK[22].target.x = NaN;
  assert.throws(() => validateIK(bad), /Invalid IK/);
});

test('authored property-channel posing retains IK metadata through key creation and undo', () => {
  const e = fixture({propertyChannels: true}); e.setNodeIK({enabled: true});
  assert.equal(e.getIKSettings().pinned, true); const before = g(e).joints.get(22);
  e.select(1, -1); e.moveSelection(15, -10); point(g(e).joints.get(22), before);
  e.undo(); point(g(e).joints.get(22), before); e.redo(); point(g(e).joints.get(22), before);
  assert.ok(e.animationChannels.some(c => c.property === 'pose'));
});

test('returning a root or pinned target drag to its start creates no history or source changes', () => {
  const e = fixture(); e.setNodeIK({enabled: true}); const original = e.serialize(), count = e._undo.length, target = g(e).joints.get(22);
  e.beginDrag(); e.poseJoint(350, 260); e.poseJoint(target.x, target.y); e.commitDrag();
  assert.deepEqual(e.serialize(), original); assert.equal(e._undo.length, count);
  e.select(1, -1); e.beginTranslationDrag(); e.moveSelection(15, -12, {fromStart: true}); e.moveSelection(0, 0, {fromStart: true}); e.commitDrag();
  assert.deepEqual(e.serialize(), original); assert.equal(e._undo.length, count);
});

test('duplicated, pasted and imported rigs place their pins with the new copy', () => {
  const e = fixture(); e.setNodeIK({enabled: true}); const original = g(e).joints.get(22);
  e.duplicateFigure(); const copy = e.geometry.objects.get(e.selectedSlot);
  point(copy.joints.get(22), {x: original.x + 24, y: original.y + 24});
  e.select(1, -1); e.copySelection(); e.pasteSelection();
  point(e.geometry.objects.get(e.selectedSlot).joints.get(22), {x: original.x + 24, y: original.y + 24});
  const reusable = nativeFigureDocument(e.report, {figureUid: 1});
  const other = fixture(); other.importFigure(reusable);
  const imported = other.geometry.objects.get(other.selectedSlot), offset = {x: other.report.canvas_width / 2 - 300, y: other.report.canvas_height / 2 - 150};
  point(imported.joints.get(22), {x: original.x + offset.x, y: original.y + offset.y});
});

test('rig splitting preserves chain base and deleting an IK node removes its controller with reversible history', () => {
  const e = fixture(); e.setNodeIK({enabled: true}); const original = e.serialize(), target = g(e).joints.get(22);
  e.splitSegment();
  const c = e.object._stykIK[22]; assert.equal(c.chainLength, 3);
  point(g(e).joints.get(22), target, .02);
  e.undo(); assert.deepEqual(e.serialize(), original);
  e.select(1, 1); e.deleteSegment(); assert.equal(e.object._stykIK, undefined);
  e.undo(); assert.deepEqual(e.serialize(), original);
});

test('curved links, arbitrary segment order, and off-chain branches preserve length and local articulation', () => {
  const e = fixture(); e.figure.segments[0].bend_rad = .3; e.figure.segments[1].bend_rad = -.2; e._invalidate();
  e.setNodeIK({enabled: true}); e.poseJoint(360, 265); point(g(e).joints.get(22), {x: 360, y: 265});
  near(g(e).segments[0].length, 90); near(g(e).segments[0].bend, .3); near(g(e).segments[2].angle, 0);
  const report = e.serialize(), object = report.keyframes[0].objects[0], figure = report.figure_types[0];
  figure.segments.reverse(); object.angles.reverse(); if (object.len_flag) object.lengths.reverse(); if (object.bend_flag) object.bends.reverse();
  point(buildGeometry(report, report.keyframes[0]).objects.get(0).joints.get(22), {x: 360, y: 265});
});

test('a constrained joined figure follows its moving attachment while its target stays planted', () => {
  const e = fixture(); e.duplicateFigure(); const childUid = e.selectedUid;
  e.joinTo(1, 0); e.select(childUid, 1); e.setNodeIK({enabled: true});
  const target = e.geometry.objects.get(e.selectedSlot).joints.get(22);
  e.select(1, -1); e.moveSelection(8, -7);
  const child = e.frame.objects.find(o => o.unique_id === childUid);
  point(e.geometry.objects.get(child.object_slot).joints.get(22), target);
});

test('Simple frame drafts discard IK setup and Add carries the working controllers into the new frame', () => {
  const e = fixture(); e.enableFrameDrafts(); e.setNodeIK({enabled: true});
  e.discardFrameDraft(); assert.equal(e.getIKSettings().enabled, false);
  e.setNodeIK({enabled: true}); const target = g(e).joints.get(22); e.addDraftFrame();
  assert.equal(e.frameIndex, 1); assert.ok(e.frame.objects[0]._stykIK[22].pinned);
  point(g(e).joints.get(22), target);
});
