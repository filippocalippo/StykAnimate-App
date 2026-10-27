import test from 'node:test';
import assert from 'node:assert/strict';
import {ownedEditorFor} from './support/owned-editor.mjs';
import {emptyDocument, createObject, createFrame} from '../src/demo.mjs';
import {evaluatedAt, geometryOfDocument} from './support/engine-geometry.mjs';
import {falloffWeight} from '../src/motion-path-falloff.mjs';

const near = (a, b, tolerance = 1e-3) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);
const root = {kind: 'node', uid: 1, handleId: 0, joint: -1};
const FALLOFF = {radius: 15, shape: 'smooth'};

/** Five stored poses every 10 frames walking right along y = 200. */
function report() {
  const document = emptyDocument(), figure = document.figure_types[0];
  document.keyframes = [0, 1, 2, 3, 4].map(k => createFrame([createObject(figure, 1, 100 + k * 100, 200)], 10));
  return document;
}
const modes = {
  sheet: () => ownedEditorFor({demo: false, propertyChannels: true, layerTimeline: true}, report()),
};
/** Where the engine puts the first figure at `tick` of a document (the one an editor holds, or the virtual one a gesture shows). */
function rootAt(source, tick) {
  const object = evaluatedAt(source, tick).objects.find(o => o.unique_id === 1);
  return {x: object.root_x, y: object.root_y};
}
const at = (editor, tick) => rootAt(editor.report, tick);

test('falloff weights are 1 at the grab, positive inside the radius and 0 beyond it', () => {
  for (const shape of ['smooth', 'linear', 'sharp', 'flat']) {
    assert.equal(falloffWeight(0, 8, shape), 1);
    for (let d = 1; d <= 8; d++) assert.ok(falloffWeight(d, 8, shape) > 0 && falloffWeight(d, 8, shape) <= 1, `${shape} ${d}`);
    assert.equal(falloffWeight(9, 8, shape), 0);
    assert.equal(falloffWeight(-9, 8, shape), 0);
  }
  assert.ok(falloffWeight(2, 8, 'sharp') < falloffWeight(2, 8, 'linear'));
  assert.ok(falloffWeight(2, 8, 'linear') < falloffWeight(2, 8, 'smooth'));
});

for (const [mode, make] of Object.entries(modes)) {
  test(`${mode}: a falloff drag reshapes the arc in one undo step and leaves the rest alone`, () => {
    const editor = make();
    editor.seek(0); editor.select(1);
    const before = Object.fromEntries([0, 2, 4, 10, 20, 30, 36, 40].map(t => [t, at(editor, t)]));
    const history = editor._undo.length;
    assert.ok(editor.beginMotionPathEdit(root, 20, {falloff: FALLOFF}));
    assert.equal(editor._drag.falloff.radius, 15);
    for (let i = 1; i <= 5; i++) editor.updateMotionPathEdit({x: before[20].x, y: 200 - i * 20});
    // Live: the virtual report is reshaped while the document is untouched.
    near(rootAt(editor._drag.report, 20).y, 100);
    near(rootAt(editor._drag.report, 10).y, 200 - 100 * falloffWeight(10, 15));
    const plan = editor.motionPathFalloff();
    assert.deepEqual(plan.writes.map(w => w.tick), [4, 10, 20, 30, 36]);
    assert.deepEqual([...plan.changed].sort((a, b) => a - b), [4, 10, 20, 30, 36]);
    assert.equal(editor.commitMotionPathEdit(), true);
    assert.equal(editor._undo.length, history + 1, 'one undo step');
    assert.equal(editor.tick, 0, 'the playhead stays');
    near(at(editor, 20).y, 100);
    near(at(editor, 20).x, before[20].x);
    near(at(editor, 10).y, 200 - 100 * falloffWeight(10, 15));
    near(at(editor, 30).y, 200 - 100 * falloffWeight(10, 15));
    for (const tick of [0, 2, 4, 36, 40]) { near(at(editor, tick).y, 200); near(at(editor, tick).x, before[tick].x); }
    assert.doesNotThrow(() => editor.serialize());
    editor.undo();
    for (const tick of [4, 10, 20, 30, 36]) { near(at(editor, tick).y, before[tick].y); near(at(editor, tick).x, before[tick].x); }
    editor.redo();
    near(at(editor, 20).y, 100);
  });

  test(`${mode}: an in-between grab lands exactly under the pointer`, () => {
    const editor = make();
    editor.seek(0); editor.select(1);
    const start = at(editor, 15);
    assert.ok(editor.beginMotionPathEdit(root, 15, {falloff: {radius: 6, shape: 'linear'}}));
    editor.updateMotionPathEdit({x: start.x + 12, y: 120});
    assert.equal(editor.commitMotionPathEdit(), true);
    near(at(editor, 15).x, start.x + 12);
    near(at(editor, 15).y, 120);
    near(at(editor, 10).y, 200 - 80 * falloffWeight(5, 6, 'linear'));
    near(at(editor, 30).y, 200);
  });

  test(`${mode}: motionless and cancelled falloff drags change nothing`, () => {
    const editor = make();
    editor.select(1);
    const history = editor._undo.length, serialized = JSON.stringify(editor.serialize?.() ?? null);
    assert.ok(editor.beginMotionPathEdit(root, 20, {falloff: FALLOFF}));
    assert.equal(editor.commitMotionPathEdit(), false);
    assert.ok(editor.beginMotionPathEdit(root, 20, {falloff: FALLOFF}));
    editor.updateMotionPathEdit({x: 300, y: 90});
    assert.equal(editor.cancelMotionPathEdit(), true);
    assert.equal(editor._undo.length, history);
    assert.equal(JSON.stringify(editor.serialize?.() ?? null), serialized);
  });
}

test('holding and releasing falloff mid-drag switches the same gesture', () => {
  const editor = modes.sheet();
  editor.select(1);
  const history = editor._undo.length;
  assert.ok(editor.beginMotionPathEdit(root, 20));
  editor.updateMotionPathEdit({x: 300, y: 150});
  assert.ok(editor.setMotionPathFalloff(FALLOFF));
  assert.ok(editor._drag.falloff);
  near(rootAt(editor._drag.report, 20).y, 150);
  near(rootAt(editor._drag.report, 10).y, 200 - 50 * falloffWeight(10, 15));
  assert.ok(editor.setMotionPathFalloff({radius: 25, shape: 'smooth'}));
  near(rootAt(editor._drag.report, 10).y, 200 - 50 * falloffWeight(10, 25));
  assert.ok(editor.setMotionPathFalloff(null));
  assert.equal(editor._drag.falloff, undefined);
  editor.updateMotionPathEdit({x: 300, y: 140});
  assert.equal(editor.commitMotionPathEdit(), true);
  assert.equal(editor._undo.length, history + 1);
  near(at(editor, 20).y, 140);
  near(at(editor, 10).y, 200);
  assert.equal(editor.report.keyframes.length, 5);
});

test('a camera trail reshapes with falloff too', () => {
  const editor = modes.sheet();
  const camera = {kind: 'camera'}, centre = {x: editor.report.canvas_width / 2, y: editor.report.canvas_height / 2};
  assert.ok(editor.beginMotionPathEdit(camera, 20, {falloff: FALLOFF}));
  editor.updateMotionPathEdit({x: centre.x + 60, y: centre.y});
  assert.equal(editor.commitMotionPathEdit(), true);
  const cameraAt = tick => evaluatedAt(editor.report, tick).camera;
  near(Number(cameraAt(20).x), 60);
  near(Number(cameraAt(10).x), 60 * falloffWeight(10, 15));
  near(Number(cameraAt(36).x ?? 0), 0);
  // Figures keep their poses.
  near(at(editor, 10).y, 200);
});

test('joint trails rotate neighbouring keys partially toward the moved arc', () => {
  const editor = modes.sheet(), figure = editor.report.figure_types[0];
  const joint = figure.segments.findIndex(s => !s.is_static && s.parent_id !== 0 && !figure.segments.some(c => c.parent_id === s.segment_id));
  const target = {kind: 'node', uid: 1, handleId: Number(figure.segments[joint].segment_id), joint};
  const angle = tick => evaluatedAt(editor.report, tick).objects[0].angles[joint];
  const before = [10, 20, 30].map(angle);
  assert.ok(editor.beginMotionPathEdit(target, 20, {falloff: FALLOFF}));
  // The grabbed joint is where the pose of tick 20 puts its limb tip.
  const origin = [...geometryOfDocument(editor.report, evaluatedAt(editor.report, 20)).objects.values()][0].segments[joint].end;
  editor.updateMotionPathEdit({x: origin.x + 25, y: origin.y - 25});
  assert.equal(editor.commitMotionPathEdit(), true);
  const after = [10, 20, 30].map(angle), turn = i => Math.abs(Math.atan2(Math.sin(after[i] - before[i]), Math.cos(after[i] - before[i])));
  assert.ok(turn(1) > 0.05, 'the grabbed key turns');
  assert.ok(turn(0) > 1e-4 && turn(0) < turn(1), 'the neighbour turns less');
  assert.ok(turn(2) > 1e-4 && turn(2) < turn(1));
});

test('sheet holds: writes resolve onto held keys without duplicates or edge keys', () => {
  const editor = modes.sheet();
  const track = () => editor.report._styk.layerSheet.tracks['layer-1'];
  editor.sheetSetEasing(['layer-1'], 0, 40, {interpolation: 'constant'});
  editor.seek(0); editor.select(1);
  const keyTicks = track().keys.map(k => k.tick), before = at(editor, 20);
  assert.ok(editor.beginMotionPathEdit(root, 15, {falloff: FALLOFF}));
  editor.updateMotionPathEdit({x: at(editor, 15).x, y: 120});
  assert.equal(editor.commitMotionPathEdit(), true);
  assert.deepEqual(track().keys.map(k => k.tick), keyTicks, 'holds gain no keys');
  // The grab rewrites its hold; the next hold follows by its own weight.
  near(at(editor, 12).y, 120);
  near(at(editor, 20).y, 200 - 80 * falloffWeight(5, 15));
  near(at(editor, 20).x, before.x);
  near(at(editor, 0).y, 200 - 80 * falloffWeight(15, 15));
});

