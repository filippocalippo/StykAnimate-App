import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {emptyDocument, createFrame, createObject} from '../src/demo.mjs';
import {cameraAtTime, cameraTravelAt, validateCameraMotion, createCameraMotion} from '../src/camera-motion.mjs';
import {followStats, followSamplingReport} from '../src/camera-follow.mjs';
import {worldToScreen} from '../src/renderer-geometry.mjs';
import {buildGeometry} from '../src/pivot/geometry.mjs';
import {parallaxResolver} from '../src/layer-parallax.mjs';
import {cameraSamplingReport, sampleMotionBake} from '../src/camera-motion-bake.mjs';

const near = (a, b, tolerance, label = '') => assert.ok(Math.abs(a - b) <= tolerance, `${label} ${a} != ${b}`);
/** Figure 1 walks right by 20px per frame for 30 frames, then stands still; figure 2 stays at x=700. */
function fixture(options = {layerTimeline: true, propertyChannels: true}) {
  const report = emptyDocument(), figure = report.figure_types[0];
  report.keyframes = [createFrame([createObject(figure, 1, 100, 250), createObject(figure, 2, 700, 250)], 30),
    createFrame([createObject(figure, 1, 700, 250), createObject(figure, 2, 700, 250)], 30),
    createFrame([createObject(figure, 1, 700, 250), createObject(figure, 2, 700, 250)], 1)];
  const editor = new Editor({demo: false, ...options}).load(report);
  if (editor.report._styk?.layerSheet) editor.sheetSetEasing([editor.layerForUid(1)], 0, 60, {interpolation: 'linear'});
  return editor;
}
const params = patch => ({lag: 0, fadeIn: 0, fadeOut: 0, ...patch});
function follow(editor, targets = [{uid: 1, weight: 1}], patch = {}, timing = {start: 0, duration: 60}) {
  const id = editor.addCameraMotion('follow', {...timing, targets});
  editor.setCameraMotion(id, {params: params(patch)}); return id;
}
const frameAt = (editor, tick) => { editor.seek(tick); return editor.evaluatedFrame; };
function centerOf(editor, tick, uid = 1) {
  const frame = frameAt(editor, tick), g = [...buildGeometry(editor.report, frame).objects.values()].find(entry => entry.obj.unique_id === uid);
  const xs = g.segments.flatMap(s => [s.start.x, s.end.x]), ys = g.segments.flatMap(s => [s.start.y, s.end.y]);
  return {frame, point: {x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2}};
}
const onScreen = (editor, tick, uid) => { const {frame, point} = centerOf(editor, tick, uid); return worldToScreen(point, {report: editor.report, frame}); };

test('a rigid follow keeps the figure centred in the output frame', () => {
  const editor = fixture(); follow(editor);
  for (const tick of [0, 7, 15, 29, 45]) {
    const p = onScreen(editor, tick);
    near(p.x, 480, 2, `x at ${tick}`); near(p.y, 270, 2, `y at ${tick}`);
  }
  assert.equal(frameAt(editor, 5).camera?.x ?? 0, 0, 'authored camera keys are untouched');
});

test('framing offset, axes and influence', () => {
  const editor = fixture(); follow(editor, undefined, {offsetX: -120, followY: 0});
  const p = onScreen(editor, 20);
  near(p.x, 360, 2, 'offset'); near(cameraAtTime(editor.report, frameAt(editor, 20)).y, 0, 1e-9, 'vertical off');
  const half = fixture(); follow(half, undefined, {strength: .5});
  const free = 100 + 20 * 20, x = cameraAtTime(half.report, frameAt(half, 20)).x;
  assert.ok(x > 0 && x < free, 'half influence moves part of the way');
});

test('sampling is deterministic in any order', () => {
  const editor = fixture(); follow(editor, undefined, {lag: 6, deadZone: .1, lookAhead: 4, zoomFit: .5});
  const forward = Array.from({length: 60}, (_, tick) => cameraAtTime(editor.report, frameAt(editor, tick)));
  const order = Array.from({length: 60}, (_, i) => (i * 37) % 60);
  for (const tick of order) assert.deepEqual(cameraAtTime(editor.report, frameAt(editor, tick)), forward[tick], `tick ${tick}`);
});

test('smoothness lags behind a moving figure and settles once it stops', () => {
  const rigid = fixture(); follow(rigid);
  const smooth = fixture(); follow(smooth, undefined, {lag: 10});
  const gap = tick => Math.abs(cameraAtTime(rigid.report, frameAt(rigid, tick)).x - cameraAtTime(smooth.report, frameAt(smooth, tick)).x);
  assert.ok(gap(20) > 20, 'the camera trails the walk');
  assert.ok(gap(59) < 6, 'and settles on the standing figure (within 1% of the walk)');
});

test('dead zone lets small moves pass and look ahead leads the motion', () => {
  const still = fixture(); follow(still, [{uid: 2, weight: 1}], {deadZone: .5});
  assert.equal(cameraAtTime(still.report, frameAt(still, 10))?.x ?? 0, 0, 'a still figure inside the dead zone does not move the camera');
  const lead = fixture(); follow(lead, undefined, {lookAhead: 5});
  near(onScreen(lead, 10).x, 480 - 100, 2, 'five frames ahead of a 20px/frame walk');
});

test('auto zoom frames several figures', () => {
  const editor = fixture(); follow(editor, [{uid: 1, weight: 1}, {uid: 2, weight: 1}], {zoomFit: 1, padding: .1});
  const scale = tick => cameraAtTime(editor.report, frameAt(editor, tick)).scale;
  assert.ok(scale(0) > scale(29), 'zooms in as the figures come together');
  for (const tick of [0, 10]) for (const uid of [1, 2]) {
    const p = onScreen(editor, tick, uid);
    assert.ok(p.x > 0 && p.x < 960 && p.y > 0 && p.y < 540, `figure ${uid} stays in frame at ${tick}`);
  }
});

test('overlapping follows cross-fade between figures instead of adding up', () => {
  const editor = fixture();
  follow(editor, [{uid: 1, weight: 1}], {fadeOut: 10}, {start: 0, duration: 30});
  follow(editor, [{uid: 2, weight: 1}], {fadeIn: 10}, {start: 20, duration: 40});
  near(onScreen(editor, 5, 1).x, 480, 2, 'first figure');
  near(onScreen(editor, 40, 2).x, 480, 2, 'second figure');
  const a = onScreen(editor, 25, 1).x, b = onScreen(editor, 25, 2).x;
  assert.ok(a < 480 + 1 && b > 480 - 1, 'the shot sits between the two figures while crossing');
});

test('follow drives parallax without baking, unlike shake', () => {
  const editor = fixture(), layer = editor.layerForUid(2);
  editor.setLayerParallax(layer, {enabled: true, x: .5, y: .5, reference: {x: 0, y: 0}});
  follow(editor);
  const frame = frameAt(editor, 20), travel = cameraTravelAt(editor.report, frame);
  const offset = parallaxResolver(editor.report, frame)(2);
  near(offset.x, .5 * travel.x, 1e-6, 'half-depth layer moves half as far');
  const shaken = fixture(), other = shaken.layerForUid(2);
  shaken.setLayerParallax(other, {enabled: true, x: .5, y: .5, reference: {x: 0, y: 0}});
  shaken.addCameraMotion('shake', {start: 0, duration: 60});
  assert.equal(parallaxResolver(shaken.report, frameAt(shaken, 20))(2).x, 0);
});

test('baking follow reproduces the live camera and keeps it as travel', async () => {
  const editor = fixture(); follow(editor, undefined, {lag: 4});
  editor.addCameraMotion('shake', {start: 0, duration: 60});
  const source = cameraSamplingReport(editor.report);
  assert.ok(source.keyframes.every(frame => frame.objects.every(object => object.unique_id === 1)), 'only the followed figure is sent to the bake');
  assert.equal(source.figure_types.length, 1);
  const frames = await sampleMotionBake(editor.report, {start: 0, end: 60});
  for (const tick of [3, 22, 50]) {
    const live = cameraAtTime(editor.report, frameAt(editor, tick)), baked = frames.find(f => f.tick === tick).camera;
    near(baked.x, live.x, 1e-6); near(baked.y, live.y, 1e-6); near(baked.scale, live.scale, 1e-9);
    const travel = cameraTravelAt(editor.report, frameAt(editor, tick));
    near(baked._parallaxMotionOffset.x, live.x - travel.x, 1e-6, 'only the shake is impulse');
  }
});

test('parameter edits reuse target samples; pose edits resample', () => {
  const editor = fixture(), id = follow(editor, undefined, {lag: 3});
  cameraAtTime(editor.report, frameAt(editor, 10));
  const samples = followStats.samples;
  for (const lag of [5, 9, 14]) { editor.setCameraMotion(id, {params: {lag}}); cameraAtTime(editor.report, frameAt(editor, 10)); }
  assert.equal(followStats.samples, samples, 'smoothness edits reshape cached samples');
  const before = cameraAtTime(editor.report, frameAt(editor, 10)).x;
  editor.seek(0); editor.select(1); editor.updateObject({root_x: 300});
  assert.notEqual(cameraAtTime(editor.report, frameAt(editor, 10)).x, before);
  assert.ok(followStats.samples > samples);
});

test('native follow invalidates in-place poses and history before sampling again', () => {
  const editor = fixture({}); follow(editor, undefined, {lag: 3, lookAhead: 2, zoomFit: .5});
  const camera = () => cameraAtTime(editor.report, frameAt(editor, 0));
  const fresh = () => {
    const copy = new Editor({demo: false}).load(structuredClone(editor.report));
    return cameraAtTime(copy.report, frameAt(copy, 0));
  };
  const before = camera();
  editor.select(1); editor.moveSelection(80, -20);
  assert.notEqual(camera().x, before.x, 'the next camera read follows the moved target');
  assert.deepEqual(camera(), fresh(), 'an edited native pose equals fresh evaluation');
  editor.undo(); assert.deepEqual(camera(), before, 'undo restores the original travel');
  editor.redo(); assert.deepEqual(camera(), fresh(), 'redo follows the target again');
  editor.select(1, 1); editor.rotateJoint(.3);
  assert.deepEqual(camera(), fresh(), 'joint poses invalidate target bounds');
});

test('native follows retain target samples across reads, scrubs and parameter edits', () => {
  const editor = fixture({}), id = follow(editor, undefined, {lag: 3});
  cameraAtTime(editor.report, frameAt(editor, 10));
  const samples = followStats.samples;
  for (const tick of [10, 2, 8, 0, 9]) cameraAtTime(editor.report, frameAt(editor, tick));
  assert.equal(followStats.samples, samples, 'reads and backward seeks reuse the path');
  for (const lag of [5, 9, 14]) { editor.setCameraMotion(id, {params: {lag}}); cameraAtTime(editor.report, frameAt(editor, 10)); }
  assert.equal(followStats.samples, samples, 'parameter changes reshape the same target samples');
});

test('work follows what is viewed and resamples only from the key before an edit', () => {
  const editor = fixture(); follow(editor, undefined, {lag: 4});
  let samples = followStats.samples;
  cameraAtTime(editor.report, frameAt(editor, 12));
  assert.ok(followStats.samples - samples <= 14, 'viewing frame 12 samples about 13 frames, not the clip');
  // The first edit turns imported keys into authored keys, which resamples the whole range once.
  editor.seek(45); editor.select(1); editor.updateObject({root_y: 200});
  cameraAtTime(editor.report, frameAt(editor, 59));
  const full = cameraAtTime(editor.report, frameAt(editor, 59));
  samples = followStats.samples;
  editor.seek(45); editor.select(1); editor.updateObject({root_y: 150});
  const after = cameraAtTime(editor.report, frameAt(editor, 59));
  const resampled = followStats.samples - samples;
  assert.ok(resampled > 0 && resampled <= 31, `an edit at 45 resamples from the key at 30 (${resampled} frames)`);
  assert.notEqual(after.y, full.y);
  // The incremental result equals a fresh evaluation of the same document.
  const fresh = new Editor({demo: false, layerTimeline: true, propertyChannels: true}).load(editor.serialize());
  for (const tick of [10, 35, 50, 59]) {
    const a = cameraAtTime(editor.report, frameAt(editor, tick)), b = cameraAtTime(fresh.report, frameAt(fresh, tick));
    near(a.x, b.x, 1e-6, `x ${tick}`); near(a.y, b.y, 1e-6, `y ${tick}`);
  }
});

test('the projection keeps only followed figures and their join parents', () => {
  const editor = fixture(); editor.seek(0); editor.select(1); editor.joinTo(2, 0);
  const projection = followSamplingReport(editor.report, [1]);
  const uids = new Set([...projection.keyframes, ...Object.values(projection._styk.frameSources ?? {})].flatMap(frame => frame.objects.map(o => o.unique_id)));
  assert.deepEqual([...uids].sort(), [1, 2]);
  const alone = followSamplingReport(fixture().report, [2]);
  assert.deepEqual([...new Set([...alone.keyframes, ...Object.values(alone._styk.frameSources ?? {})].flatMap(f => f.objects.map(o => o.unique_id)))], [2]);
});

test('validation: follow needs figures; older preset clips stay valid', () => {
  assert.throws(() => createCameraMotion('follow', 'a', 0, 10, {targets: []}));
  assert.throws(() => validateCameraMotion({version: 1, clips: [{...createCameraMotion('follow', 'a', 0, 10, {targets: [{uid: 1, weight: 2}]})}]}));
  const shake = createCameraMotion('shake', 'b', 0, 10);
  validateCameraMotion({version: 1, clips: [shake]});
  assert.throws(() => validateCameraMotion({version: 1, clips: [{...shake, targets: [{uid: 1, weight: 1}]}]}));
  assert.throws(() => validateCameraMotion({version: 1, clips: [{...createCameraMotion('follow', 'c', 0, 10, {targets: [{uid: 1, weight: 1}]}), params: {...shake.params}}]}));
  const empty = fixture(); empty.select(null);
  assert.throws(() => empty.addCameraMotion('follow'), /Select the figures/);
  const selected = fixture(); selected.select(1);
  const added = selected.addCameraMotion('follow'), clip = selected.getCameraMotions().find(c => c.id === added);
  assert.deepEqual([clip.targets, clip.start, clip.duration], [[{uid: 1, weight: 1}], 0, 61], 'selected figures, to the end');
});

