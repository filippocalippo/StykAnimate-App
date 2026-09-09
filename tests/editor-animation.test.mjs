import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {emptyDocument, createObject, createFrame} from '../src/demo.mjs';
import {animationChannelId} from '../src/animation-channels.mjs';

const figureTarget = {kind: 'figure', uid: 1};
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-5, `${a} != ${b}`);
function fixture() {
  const report = emptyDocument(), figure = report.figure_types[0];
  report.keyframes = [0, 100, 0].map((x, i) => createFrame([createObject(figure, 1, x, 200), createObject(figure, 2, 300 + i * 10, 200)], 10));
  report.keyframes.forEach(frame => { frame.unknown_native = {sentinel: 123}; });
  return new Editor({demo: false}).load(report);
}

test('bulk key insertion is one undo operation and never modifies native frame data', () => {
  const editor = fixture(), frames = editor.report.keyframes, objects = frames[0].objects, before = structuredClone(frames), count = editor._undo.length;
  editor.addAnimationKeys([{target: figureTarget, property: 'x', tick: 0, value: 0}, {target: figureTarget, property: 'x', tick: 10, value: 200},
    {target: figureTarget, property: 'opacity', tick: 0, value: 1}, {target: figureTarget, property: 'opacity', tick: 10, value: .5}]);
  assert.equal(editor.animationChannels.length, 2); assert.equal(editor._undo.length, count + 1);
  assert.equal(editor.report.keyframes, frames); assert.equal(frames[0].objects, objects); assert.deepEqual(frames, before);
  editor.seek(5); near(editor.evaluatedFrame.objects[0].root_x, 100); assert.equal(editor.evaluatedFrame.objects[0].field28, 64);
  const after = structuredClone(editor.report._styk.animation);
  editor.undo(); assert.equal(editor.animationChannels.length, 0); assert.deepEqual(editor.report.keyframes, before);
  editor.redo(); assert.deepEqual(editor.report._styk.animation, after);
});

test('moving one property key changes only its curve, collision rejection is atomic', () => {
  const editor = fixture();
  editor.addAnimationKeys([{target: figureTarget, property: 'x', tick: 0, value: 0}, {target: figureTarget, property: 'x', tick: 10, value: 100},
    {target: figureTarget, property: 'y', tick: 0, value: 200}, {target: figureTarget, property: 'y', tick: 10, value: 300}]);
  const x = editor.animationChannel(figureTarget, 'x'), y = editor.animationChannel(figureTarget, 'y');
  editor.moveAnimationKeys([{channelId: x.id, keyIds: [x.keys[1].id]}], 10);
  assert.equal(editor.animationChannel(figureTarget, 'y'), y); editor.seek(10);
  near(editor.evaluatedFrame.objects[0].root_x, 50); near(editor.evaluatedFrame.objects[0].root_y, 300);
  const current = editor.report._styk.animation, history = editor._undo.length;
  assert.throws(() => editor.moveAnimationKeys([{channelId: x.id, keyIds: [x.keys[1].id]}], -20), /occupies/);
  assert.equal(editor.report._styk.animation, current); assert.equal(editor._undo.length, history);
});

test('scalar previews are bounded, one history entry on commit, and restore exactly on cancellation', () => {
  const editor = fixture(), frames = editor.report.keyframes, before = structuredClone(frames);
  editor.seek(4); editor.beginAnimationEdit(figureTarget, 'x');
  for (let value = 120; value < 220; value++) editor.previewAnimationEdit(value);
  assert.equal(editor._undo.length, 0); assert.equal(editor.report.keyframes, frames); assert.deepEqual(frames, before);
  near(editor.evaluatedFrame.objects[0].root_x, 219); editor.commitAnimationEdit(); assert.equal(editor._undo.length, 1);
  const animation = structuredClone(editor.report._styk.animation);
  editor.beginAnimationEdit(figureTarget, 'x'); editor.previewAnimationEdit(450); editor.cancelAnimationEdit();
  assert.deepEqual(editor.report._styk.animation, animation); assert.equal(editor._undo.length, 1);
  assert.throws(() => editor.previewAnimationEdit(0), /Begin/);
});

test('camera/scene and extended-duration keys evaluate through the common editor geometry path', () => {
  const editor = fixture();
  editor.addAnimationKeys([{target: {kind: 'camera'}, property: 'x', tick: 0, value: 0}, {target: {kind: 'camera'}, property: 'x', tick: 40, value: 80},
    {target: {kind: 'scene'}, property: 'color', tick: 0, value: 0xff000000}, {target: {kind: 'scene'}, property: 'color', tick: 40, value: 0xffffffff}]);
  assert.equal(editor.totalTicks, 41); editor.seek(30);
  near(editor.evaluatedFrame.camera.x, 60); assert.equal(editor.evaluatedFrame._stykBackgroundColor, 0xffbfbfbf);
  assert.equal(editor.report.keyframes.length, 3);
  assert.equal(editor.nearestAnimationKey({kind: 'camera'}, 'x', 1).tick, 40);
  assert.equal(editor.nearestAnimationKey({kind: 'camera'}, 'x', -1).tick, 0);
});

test('native layer pose-key mutation adopts real source references in the same history operation', () => {
  const editor = fixture(), layer = editor.layers.find(layer => layer.kind === 'layer' || layer.kind === 'user'), target = {kind: 'layer', id: layer.id};
  const native = editor.nativePoseChannel(target), frames = editor.report.keyframes;
  assert.equal(native.source, 'native'); assert.equal(native.keys.length, 3); assert.ok(native.keys.every(key => editor.getFrameById(key.value.frameId)));
  assert.equal(native.keys[0].interpolation, 'linear'); const count = editor._undo.length;
  editor.deleteAnimationKeys([{channelId: native.id, keyIds: [native.keys[1].id]}]);
  assert.equal(editor._undo.length, count + 1); assert.equal(editor.report.keyframes, frames); assert.equal(frames[1].objects[0].root_x, 100);
  editor.seek(10); near(editor.evaluatedFrame.objects.find(o => o.unique_id === 1).root_x, 0);
  editor.undo(); assert.equal(editor.animationChannels.length, 0); editor.seek(10); near(editor.evaluatedFrame.objects[0].root_x, 100);
});

test('hidden native keys remain distinct, restore independently, and explicit null adds a blank pose', () => {
  const editor = fixture(); editor.report.keyframes[0].duration_raw = 0; editor._invalidate({timing: true});
  const layer = editor.layers.find(layer => layer.kind === 'layer' || layer.kind === 'user'), target = {kind: 'layer', id: layer.id};
  const native = editor.nativePoseChannel(target); assert.equal(native.keys[0].tick, native.keys[1].tick); assert.equal(native.keys[0].hidden, true);
  editor.revealAnimationKey(native.id, native.keys[0].id, 2);
  const restored = editor.animationChannel(target, 'pose'); assert.equal(restored.keys[0].hidden, undefined); assert.equal(restored.keys[1].tick, 2);
  const blank = editor.addAnimationKey(target, 'pose', 7, null); assert.deepEqual(blank.value, {frameId: null});
  editor.seek(7); assert.equal(editor.evaluatedFrame.objects.length, 0);
});

test('key duplication and sparse deletion preserve stable IDs and exact STYK metadata roundtrip', () => {
  const editor = fixture(); const key = editor.addAnimationKey(figureTarget, 'scale', 0, 1.5), id = animationChannelId(figureTarget, 'scale');
  const copied = editor.duplicateAnimationKeys([{channelId: id, keyIds: [key.id]}], 8);
  assert.notEqual(copied[0].keyIds[0], key.id); assert.equal(editor.animationChannel(figureTarget, 'scale').keys[1].tick, 8);
  editor.deleteAnimationKeys([{channelId: id, keyIds: [key.id]}]);
  const saved = editor.serialize(), reopened = new Editor({demo: false}).load(structuredClone(saved));
  assert.deepEqual(reopened.report._styk.animation, saved._styk.animation); reopened.seek(10); near(reopened.evaluatedFrame.objects[0].scale, 1.5);
  assert.equal(reopened.report.keyframes[0].unknown_native.sentinel, 123);
});

test('interpolated pose capture stores only one source frame and invalid bulk edits publish no source assets', () => {
  const editor = fixture(), layer = editor.layers.find(layer => layer.kind === 'layer' || layer.kind === 'user'), target = {kind: 'layer', id: layer.id};
  editor.seek(5); const count = Object.keys(editor.report._styk.frameSources ?? {}).length;
  assert.throws(() => editor.addAnimationKeys([{target, property: 'pose', tick: 5}, {target: figureTarget, property: 'opacity', tick: 5, value: 2}]), /opacity/);
  assert.equal(Object.keys(editor.report._styk.frameSources ?? {}).length, count); assert.equal(editor.animationChannels.length, 0);
  const keys = editor.addAnimationKeys([{target, property: 'pose', tick: 5}, {target: {kind: 'camera'}, property: 'pose', tick: 5}]);
  assert.equal(keys[0].value.frameId, keys[1].value.frameId);
  assert.equal(Object.keys(editor.report._styk.frameSources).length, count + 1);
  assert.equal(editor.getFrameById(keys[0].value.frameId).objects[0].root_x, 50);
});

test('cached timeline duration extends, shrinks on undo, and preserves hidden native trailing poses', () => {
  const editor = fixture(); editor.report.keyframes[2].duration_raw = 0; editor._invalidate({timing: true});
  assert.equal(editor.totalTicks, 20); const oldTimeline = editor.timeline;
  editor.addAnimationKey({kind: 'camera'}, 'x', 100, 50);
  assert.equal(editor.totalTicks, 101); assert.notEqual(editor.timeline, oldTimeline);
  const pose = editor.nativePoseChannel({kind: 'camera'}); assert.equal(pose.keys.at(-1).hidden, true); assert.equal(pose.keys.at(-1).tick, 20);
  editor.undo(); assert.equal(editor.totalTicks, 20); editor.redo(); assert.equal(editor.totalTicks, 101);
});

test('property drags preserve hold interpolation and returning to an unkeyed value creates no history', () => {
  const editor = fixture();
  editor.addAnimationKeys([{target: figureTarget, property: 'x', tick: 0, value: 0, interpolation: 'hold'}]);
  editor.beginAnimationEdit(figureTarget, 'x'); editor.previewAnimationEdit(30); editor.commitAnimationEdit();
  assert.equal(editor.animationChannel(figureTarget, 'x').keys[0].interpolation, 'constant');
  editor.seek(5); const animation = editor.report._styk.animation, count = editor._undo.length;
  editor.beginAnimationEdit(figureTarget, 'opacity'); editor.previewAnimationEdit(.5); editor.previewAnimationEdit(1);
  assert.equal(editor.commitAnimationEdit(), false); assert.equal(editor.report._styk.animation, animation); assert.equal(editor._undo.length, count);
});

test('large scalar key selections and bulk insertions retain atomic history and stable key identities', () => {
  const editor = fixture(), count = 10000;
  const keys = editor.addAnimationKeys(Array.from({length: count}, (_, index) => ({target: figureTarget, property: 'x', tick: index * 2, value: index})));
  const id = animationChannelId(figureTarget, 'x');
  assert.equal(editor.animationChannel(figureTarget, 'x').keys.length, count); assert.equal(editor._undo.length, 1);
  editor.moveAnimationKeys([{channelId: id, keyIds: keys.map(key => key.id)}], 1);
  assert.equal(editor.animationChannel(figureTarget, 'x').keys.at(-1).tick, count * 2 - 1); assert.equal(editor._undo.length, 2);
  editor.undo(); assert.equal(editor.animationChannel(figureTarget, 'x').keys[0].tick, 0);
  editor.report._styk.animation.nextKeyId = 1;
  const key = editor.addAnimationKey(figureTarget, 'x', count * 2, 1);
  assert.ok(!keys.some(existing => existing.id === key.id));
});

test('loading a missing pose source rejects atomically before replacing the open document', () => {
  const editor = fixture(), report = editor.report, invalid = editor.serialize();
  invalid._styk.animation = {version: 1, nextKeyId: 2, channels: [{id: 'camera::pose', target: {kind: 'camera'}, property: 'pose',
    keys: [{id: 'key-1', tick: 0, value: {frameId: 'frame-missing'}, interpolation: 'hold'}]}]};
  assert.throws(() => editor.load(invalid), /missing source frame/); assert.equal(editor.report, report);
});

test('adopting native pose tracks ending in hidden reference keys preserves exact visible duration', () => {
  const editor = fixture(); editor.report.keyframes[2].duration_raw = 0; editor._invalidate({timing: true});
  const ticks = editor.totalTicks; assert.equal(ticks, 20);
  const native = Array.from({length: ticks}, (_, tick) => { editor.seek(tick); return editor.evaluatedFrame.objects[0].root_x; });
  editor.adoptNativePoseTrack({kind: 'layer', id: 'layer-1'});
  assert.equal(editor.totalTicks, ticks, 'A hidden terminal pose must not introduce a visible frame');
  for (let tick = 0; tick < ticks; tick++) { editor.seek(tick); near(editor.evaluatedFrame.objects[0].root_x, native[tick]); }
});
