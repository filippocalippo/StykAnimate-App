import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyDocument, createFrame, createObject} from '../src/demo.mjs';
import {validateCameraMotion} from '../src/camera-motion.mjs';
import {createCameraMotion} from './support/camera-motion.mjs';
import {worldToScreen} from '../src/renderer-geometry.mjs';
import {ownedEditorSync, ownedEditorFor} from './support/owned-editor.mjs';
import {ownerReferences} from './support/owner-references.mjs';
import {pivotDocument} from './support/engine-export.mjs';

const refs = ownerReferences(import.meta.url);

const near = (a, b, tolerance, label = '') => assert.ok(Math.abs(a - b) <= tolerance, `${label} ${a} != ${b}`);
/** Figure 1 walks right by 20px per frame for 30 frames, then stands still; figure 2 stays at x=700. */
function fixture(options = {layerTimeline: true, propertyChannels: true}) {
  const report = emptyDocument(), figure = report.figure_types[0];
  report.keyframes = [createFrame([createObject(figure, 1, 100, 250), createObject(figure, 2, 700, 250)], 30),
    createFrame([createObject(figure, 1, 700, 250), createObject(figure, 2, 700, 250)], 30),
    createFrame([createObject(figure, 1, 700, 250), createObject(figure, 2, 700, 250)], 1)];
  const editor = ownedEditorFor({demo: false, ...options}, report);
  if (editor.report._styk?.layerSheet) editor.sheetSetEasing([editor.layerForUid(1)], 0, 60, {interpolation: 'linear'});
  return editor;
}
const params = patch => ({lag: 0, fadeIn: 0, fadeOut: 0, ...patch});
function follow(editor, targets = [{uid: 1, weight: 1}], patch = {}, timing = {start: 0, duration: 60}) {
  const id = editor.addCameraMotion('follow', {...timing, targets});
  editor.setCameraMotion(id, {params: params(patch)}); return id;
}
/** The camera the engine shoots the frame at `tick` with: the authored camera, follow travel, then the presets' impulses. */
const shot = (editor, tick) => { editor.seek(tick); return editor._shown.shot() ?? editor.evaluatedFrame.camera; };
/** The centre of the figure `uid`'s drawn extent at `tick` (the engine's geometry), and the frame as the shot sees it. */
function centerOf(editor, tick, uid = 1) {
  const camera = shot(editor, tick), frame = {...editor.evaluatedFrame, camera};
  const group = [...editor.geometry.objects.values()].find(entry => entry?.obj.unique_id === uid);
  const xs = group.segments.flatMap(s => [s.start.x, s.end.x]), ys = group.segments.flatMap(s => [s.start.y, s.end.y]);
  return {frame, point: {x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2}};
}
/** Where the figure `uid` lands on a 960 x 540 screen at `tick`. */
const onScreen = (editor, tick, uid) => { const {frame, point} = centerOf(editor, tick, uid); return worldToScreen(point, {report: editor.report, frame}); };

test('a rigid follow keeps the figure centred in the output frame', () => {
  const editor = fixture(); follow(editor);
  for (const tick of [0, 7, 15, 29, 45]) {
    const p = onScreen(editor, tick);
    near(p.x, 480, 2, `x at ${tick}`); near(p.y, 270, 2, `y at ${tick}`);
  }
  editor.seek(5);
  assert.equal(editor.evaluatedFrame.camera?.x ?? 0, 0, 'authored camera keys are untouched');
});

test('framing offset, axes and influence', () => {
  const editor = fixture(); follow(editor, undefined, {offsetX: -120, followY: 0});
  near(onScreen(editor, 20).x, 360, 2, 'offset');
  near(shot(editor, 20)?.y ?? 0, 0, 1e-9, 'vertical off');
  const half = fixture(); follow(half, undefined, {strength: .5});
  const free = 100 + 20 * 20, x = shot(half, 20)?.x ?? 0;
  assert.ok(x > 0 && x < free, 'half influence moves part of the way');
});

test('sampling is deterministic in any order', () => {
  const editor = fixture(); follow(editor, undefined, {lag: 6, deadZone: .1, lookAhead: 4, zoomFit: .5});
  const forward = Array.from({length: 60}, (_, tick) => shot(editor, tick));
  const order = Array.from({length: 60}, (_, i) => (i * 37) % 60);
  for (const tick of order) assert.deepEqual(shot(editor, tick), forward[tick], `tick ${tick}`);
});

test('smoothness lags behind a moving figure and settles once it stops', () => {
  const rigid = fixture(); follow(rigid);
  const smooth = fixture(); follow(smooth, undefined, {lag: 10});
  const gap = tick => Math.abs(shot(rigid, tick).x - shot(smooth, tick).x);
  assert.ok(gap(20) > 20, 'the camera trails the walk');
  assert.ok(gap(59) < 6, 'and settles on the standing figure (within 1% of the walk)');
});

test('dead zone lets small moves pass and look ahead leads the motion', () => {
  const still = fixture(); follow(still, [{uid: 2, weight: 1}], {deadZone: .5});
  assert.equal(shot(still, 10)?.x ?? 0, 0, 'a still figure inside the dead zone does not move the camera');
  const lead = fixture(); follow(lead, undefined, {lookAhead: 5});
  near(onScreen(lead, 10).x, 480 - 100, 2, 'five frames ahead of a 20px/frame walk');
});

test('auto zoom frames several figures', () => {
  const editor = fixture(); follow(editor, [{uid: 1, weight: 1}, {uid: 2, weight: 1}], {zoomFit: 1, padding: .1});
  const scale = tick => shot(editor, tick).scale;
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

test('follow drives parallax, unlike shake', () => {
  // The shift a layer's parallax gives its figures is baked into the engine's Pivot export, where it reads as their roots moving.
  const rootX = (editor, tick) => pivotDocument(editor).keyframes[tick].objects.find(o => o.unique_id === 2).root_x;
  const editor = fixture(), layer = editor.layerForUid(2);
  editor.setLayerParallax(layer, {enabled: true, x: .5, y: .5, reference: {x: 0, y: 0}});
  follow(editor);
  const travel = shot(editor, 29).x;
  assert.ok(travel > 150, 'the camera travels with the walk');
  near(rootX(editor, 29), 700 + .5 * travel, 1e-6, 'a half-depth layer moves half as far');
  const shaken = fixture(), other = shaken.layerForUid(2);
  shaken.setLayerParallax(other, {enabled: true, x: .5, y: .5, reference: {x: 0, y: 0}});
  shaken.addCameraMotion('shake', {start: 0, duration: 60});
  near(rootX(shaken, 29), 700, 1e-6, 'an impulse is no travel');
});

refs.test('baking follow reproduces the live camera and keeps it as travel', take => {
  // Baking is a command of the engine session: the camera it keys on every frame shows what the follow and the shake showed.
  // The document is the plain editor's (its reference): the fixture's figures walking, with a linear easing set on the layer sheet.
  const document = JSON.parse(take('fixture'));
  const editor = ownedEditorSync({demo: false, layerTimeline: true, propertyChannels: true}, document, {recorded: false}).editor;
  editor.sheetSetEasing([editor.layerForUid(1)], 0, 60, {interpolation: 'linear'});
  follow(editor, undefined, {lag: 4});
  editor.addCameraMotion('shake', {start: 0, duration: 60});
  const live = [3, 22, 50].map(tick => ({tick, camera: shot(editor, tick)}));
  assert.equal(editor.bakeCameraMotion({start: 0, end: 60}), true);
  assert.ok(editor.getCameraMotions().every(clip => !clip.enabled), 'the motion is silenced where it was baked');
  for (const {tick, camera} of live) {
    const baked = shot(editor, tick);
    near(baked.x, camera.x, 1e-6); near(baked.y, camera.y, 1e-6); near(baked.scale, camera.scale, 1e-9);
  }
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

