import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {emptyDocument, createFrame, createObject} from '../src/demo.mjs';
import {timeline, evaluatedFrame, buildGeometry} from '../src/pivot/geometry.mjs';
import {sampleAnimationChannel, validateAnimationDocument} from '../src/animation-channels.mjs';
import {validateFrameIdentities} from '../src/editor-frames.mjs';
import {validateScene} from '../src/pivot/model.mjs';
import {validateLayerState} from '../src/layers.mjs';

function sample(report, tick) {
  const rows = timeline(report); let index = 0;
  while (index < rows.length - 1 && rows[index + 1].start <= tick) index++;
  const row = rows[index], frame = evaluatedFrame(report, index, row.count ? (tick - row.start) / row.count : 0, tick);
  return {frame, geometry: buildGeometry(report, frame)};
}
function signature(report, tick) {
  const {frame, geometry} = sample(report, tick);
  const round = value => Math.round(value * 1e5) / 1e5;
  return {objects: geometry.drawables.map(shape => ({uid: shape.obj.unique_id, type: shape.type, x: round(shape.start.x), y: round(shape.start.y),
    rgb: shape.rgb, alpha: round(shape.alpha), end: shape.end ? [round(shape.end.x), round(shape.end.y)] : null})),
    camera: Object.fromEntries(['x', 'y', 'scale', 'angle_rad'].map(key => [key, round(frame.camera?.[key] ?? (key === 'scale' ? 1 : 0))])),
    background: [frame.background_id, frame.background_id_b, frame.background_mix, frame._stykBackgroundColor]};
}
function source() {
  const report = emptyDocument();
  report.backgrounds = [{background_id: 4, kind: 2, color: 0xff112233, name: 'A'}, {background_id: 5, kind: 2, color: 0xff887766, name: 'B'}];
  report.keyframes = [50, 90].map((x, i) => {
    const frame = createFrame([createObject(report.figure_types[0], 1, x, 100)], i ? 3 : 4);
    Object.assign(frame, {background_id: 4, background_id_b: 5, background_mix: 73,
      camera: {is_default: false, x: x / 3, y: 17, scale: 1.7, angle_rad: .4}}); return frame;
  }); return report;
}
function destination({easing = false, inside = false} = {}) {
  const report = emptyDocument(); report.auto_easing = easing;
  report.backgrounds = [{background_id: 4, kind: 2, color: 0xffabcdef, name: 'Destination'}];
  report.keyframes = [0, 100, 25, 160].map((x, i) => {
    const object = createObject(report.figure_types[0], 1, x, [300, 220, 280, 360][i]);
    object.angles[0] += [-.3, .5, 1, .2][i];
    return createFrame([object], i === 3 ? 1 : 10);
  });
  const editor = new Editor({demo: false}).load(report);
  editor.adoptNativePoseTrack({kind: 'layer', id: 'layer-1'});
  if (inside) {
    const channel = editor.animationChannel({kind: 'layer', id: 'layer-1'}, 'pose');
    editor.setAnimationKey(channel.id, channel.keys[2].id, {tick: 24});
  }
  editor.addAnimationKeys([
    {target: {kind: 'figure', uid: 1}, property: 'x', tick: 0, value: 15}, {target: {kind: 'figure', uid: 1}, property: 'x', tick: 40, value: 260},
    {target: {kind: 'camera'}, property: 'x', tick: 0, value: 30}, {target: {kind: 'camera'}, property: 'x', tick: 40, value: 60},
    {target: {kind: 'scene'}, property: 'backgroundId', tick: 0, value: 4},
    {target: {kind: 'scene'}, property: 'color', tick: 0, value: 0xff110044}, {target: {kind: 'scene'}, property: 'color', tick: 40, value: 0xff448800},
  ]); return editor;
}
function validate(editor) {
  validateScene(editor.report); validateLayerState(editor.report._styk.layers); validateFrameIdentities(editor.report); validateAnimationDocument(editor.report);
}

test('scalar passthrough has exact interval boundaries and survives serialized channel validation', () => {
  const channel = {id: 'camera::x', target: {kind: 'camera'}, property: 'x', keys: [
    {id: 'a', tick: 0, value: 10, interpolation: 'linear'}, {id: 'b', tick: 9, value: 19, interpolation: 'hold'},
    {id: 'c', tick: 10, value: 0, interpolation: 'hold', passthrough: true}, {id: 'd', tick: 15, value: 20, interpolation: 'linear'},
    {id: 'e', tick: 25, value: 30, interpolation: 'hold'},
  ]};
  assert.equal(sampleAnimationChannel(channel, 8), 18); assert.equal(sampleAnimationChannel(channel, 9), 19);
  assert.equal(sampleAnimationChannel(channel, 10), undefined); assert.equal(sampleAnimationChannel(channel, 14), undefined);
  assert.equal(sampleAnimationChannel(channel, 15), 20); assert.equal(sampleAnimationChannel(channel, 20), 25);
  const document = emptyDocument(); document._styk.animation = {version: 1, channels: [channel]};
  validateAnimationDocument(JSON.parse(JSON.stringify(document)));
  const invalid = structuredClone(document); invalid._styk.animation.channels[0] = {id: 'camera::pose', target: {kind: 'camera'}, property: 'pose', keys: [{id: 'p', tick: 0, value: {frameId: null}, passthrough: true}]};
  assert.throws(() => validateAnimationDocument(invalid), /scalar/);
});

for (const easing of [false, true]) for (const inside of [false, true]) test(`authored insertion preserves every destination tick and copied scene with easing=${easing}, crossing pose key=${inside}`, () => {
  const editor = new Editor({demo: false}).load(source()); editor.copyFrames([0, 1]);
  const target = destination({easing, inside}); editor.load(target.report);
  const before = structuredClone(editor.report), history = editor._undo.length, frames = editor.report.keyframes.slice();
  const original = Array.from({length: 41}, (_, tick) => signature(editor.report, tick));
  const oldIds = new Map(editor.animationChannels.map(channel => [channel.id, channel.keys.map(key => key.id)]));
  assert.equal(editor.pasteFrames(2), 2); validate(editor);
  assert.equal(editor._undo.length, history + 1); assert.equal(editor.report.keyframes[0], frames[0]); assert.equal(editor.report.keyframes[4], frames[2]);
  for (let tick = 0; tick < 41; tick++) assert.deepEqual(signature(editor.report, tick >= 20 ? tick + 7 : tick), original[tick], `Original scene changed at tick ${tick}`);
  for (let tick = 20; tick < 27; tick++) {
    const {frame} = sample(editor.report, tick);
    assert.equal(frame.objects.length, 1); assert.notEqual(frame.objects[0].unique_id, 1, 'Destination actors are absent during the inserted scene');
    assert.equal(frame._stykBackgroundColor, undefined); assert.equal(frame.background_mix, 73, 'Existing background scalar must not erase the copied blend');
    assert.equal(frame.camera.y, 17); assert.equal(frame.camera.scale, 1.7);
  }
  for (const [id, ids] of oldIds) assert.ok(ids.every(idValue => editor.animationChannels.find(channel => channel.id === id).keys.some(key => key.id === idValue)), 'Original editable keys remain');
  const after = structuredClone(editor.report); editor.undo(); validate(editor); assert.deepEqual(editor.report, before);
  editor.redo(); validate(editor); assert.deepEqual(editor.report, after);
  const reopened = new Editor({demo: false}).load(JSON.parse(JSON.stringify(editor.serialize()))); validate(reopened);
  for (const tick of [0, 19, 20, 26, 27, 47]) assert.deepEqual(signature(reopened.report, tick), signature(editor.report, tick));
});

test('paste into the same authored document bypasses scalar overlays on the copied evaluated poses', () => {
  const editor = destination(); editor.copyFrames([1]); const expected = signature(editor.report, 10), before = structuredClone(editor.report);
  editor.pasteFrames(2); validate(editor);
  const actual = signature(editor.report, 20);
  assert.deepEqual(actual.objects, expected.objects); assert.deepEqual(actual.camera, expected.camera);
  assert.equal(editor.report.backgrounds.find(background => background.background_id === actual.background[0]).color, expected.background[3]);
  editor.undo(); assert.deepEqual(editor.report, before);
});

test('local preservation budget rejects atomically without publishing IDs, assets, sources or history', () => {
  const editor = new Editor({demo: false}).load(source()); editor.copyFrames([0]);
  const target = destination(); target.report.keyframes[0].duration_raw = 20000; target._invalidate({timing: true});
  target.addAnimationKeys([{target: {kind: 'camera'}, property: 'pose', tick: 0}, {target: {kind: 'camera'}, property: 'pose', tick: 30000}]);
  editor.load(target.report); const before = structuredClone(editor.report), ids = editor._nextFrameIdentity;
  assert.throws(() => editor.pasteFrames(1), /10,000/); assert.deepEqual(editor.report, before); assert.equal(editor._nextFrameIdentity, ids); assert.equal(editor._undo.length, 0);
});

test('append into an authored tail hides the inserted actors when the original channels resume', () => {
  const editor = new Editor({demo: false}).load(source()); editor.copyFrames([0, 1]); editor.load(destination().report);
  const original = Array.from({length: 41}, (_, tick) => signature(editor.report, tick));
  editor.appendClipboardFrames(); validate(editor);
  for (let tick = 0; tick < 41; tick++) assert.deepEqual(signature(editor.report, tick >= 31 ? tick + 5 : tick), original[tick], `Authored append changed original tick ${tick}`);
  for (let tick = 31; tick < 36; tick++) assert.equal(sample(editor.report, tick).frame.objects.length, 1);
});

test('hidden-only insertion retains source frames without changing any visible authored tick', () => {
  const hidden = source(); hidden.keyframes[0].duration_raw = 0;
  const editor = new Editor({demo: false}).load(hidden); editor.copyFrames([0]); editor.load(destination({easing: true}).report);
  const original = Array.from({length: 41}, (_, tick) => signature(editor.report, tick));
  editor.pasteFrames(1); validate(editor); assert.equal(editor.report.keyframes[1].duration_raw, 0);
  for (let tick = 0; tick < 41; tick++) assert.deepEqual(signature(editor.report, tick), original[tick], `Hidden insertion changed tick ${tick}`);
});

test('not-yet-started scalar channels and null scene color resume without acquiring unintended overrides', () => {
  const target = destination(); target.addAnimationKey({kind: 'scene'}, 'color', 12, null);
  target.addAnimationKeys([{target: {kind: 'camera'}, property: 'scale', tick: 25, value: 2}, {target: {kind: 'camera'}, property: 'scale', tick: 40, value: 3}]);
  const editor = new Editor({demo: false}).load(source()); editor.copyFrames([0]); editor.load(target.report);
  const original = Array.from({length: 41}, (_, tick) => signature(editor.report, tick)); editor.pasteFrames(2); validate(editor);
  for (let tick = 0; tick < 41; tick++) assert.deepEqual(signature(editor.report, tick >= 20 ? tick + 4 : tick), original[tick], `Null/future scalar changed tick ${tick}`);
});
