import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {emptyDocument, createFrame, createObject} from '../src/demo.mjs';
import {composeAnimationChannels, validateAnimationDocument} from '../src/animation-channels.mjs';
import {evaluatedFrame, timeline} from '../src/pivot/geometry.mjs';
import {materializePivotDocument} from '../src/pivot-export-materialize.mjs';
import {compilePlaybackPacket} from '../src/playback-worker.mjs';
import {animationPropertyState} from '../src/animation-property-state.mjs';

const target = {kind: 'figure', uid: 1};
function fixture() {
  const report = emptyDocument(), figure = report.figure_types[0];
  report.keyframes = [0, 100, 0].map(x => createFrame([1, 2, 3].map(uid => createObject(figure, uid, x, 200)), 10));
  return new Editor({demo: false}).load(report);
}
function sample(report, tick) {
  const row = timeline(report).findLast(row => row.start <= tick);
  return evaluatedFrame(report, row.index, row.count ? (tick - row.start) / row.count : 0, tick);
}
const order = frame => frame.object_draw_order.map(slot => frame.objects[slot].unique_id);

test('Z-index is a sparse held channel; ties retain pose order and source objects remain intact', () => {
  const e = fixture(), before = structuredClone(e.report.keyframes);
  e.addAnimationKey(target, 'zIndex', 5, 10);
  e.addAnimationKey(target, 'zIndex', 10, -10);
  assert.deepEqual(order(sample(e.report, 4)), [1, 2, 3]);
  assert.deepEqual(order(sample(e.report, 9.999)), [2, 3, 1]);
  assert.deepEqual(order(sample(e.report, 10)), [1, 2, 3]);
  assert.equal(e.animationChannel(target, 'zIndex').keys[0].interpolation, 'constant');
  assert.deepEqual(e.report.keyframes, before);
  const base = e.report.keyframes[0];
  const composed = composeAnimationChannels(e.report, base, 6);
  assert.equal(composed.objects[1], base.objects[1]);
  assert.equal(composed.objects[0].angles, base.objects[0].angles);
  e.addAnimationKey({kind: 'figure', uid: 2}, 'zIndex', 5, 10);
  assert.deepEqual(order(sample(e.report, 5)), [3, 1, 2]);
});

test('Z-index respects layer boundaries and never renumbers attachment slots', () => {
  const e = fixture(), layer = e.createLayer('Front');
  for (const frame of e.report.keyframes) frame.objects[1].join = {target_object_slot: 0, target_unique_id: 1, target_handle_id: 1};
  e._invalidate(); const root = {...e.geometry.objects.get(1).root};
  e.assignFiguresToLayer([3], layer.id);
  e.addAnimationKey(target, 'zIndex', 0, 1000000);
  assert.deepEqual(order(e.evaluatedFrame), [2, 1, 3]);
  assert.deepEqual(e.evaluatedFrame.objects.map(o => o.unique_id), [1, 2, 3]);
  assert.equal(e.evaluatedFrame.objects[1].join.target_object_slot, 0);
  assert.deepEqual(e.geometry.objects.get(1).root, root);
});

test('invalid depth and continuous easing reject atomically, including persisted documents', () => {
  const e = fixture();
  for (const value of [NaN, Infinity, 1.5, 1000001, -1000001]) assert.throws(() => e.addAnimationKey(target, 'zIndex', 0, value));
  assert.equal(e.animationChannels.length, 0);
  const key = e.addAnimationKey(target, 'zIndex', 0, 1), channel = e.animationChannel(target, 'zIndex');
  const before = e.report._styk.animation;
  assert.throws(() => e.setAnimationKey(channel.id, key.id, {interpolation: 'linear'}), /Constant/);
  assert.equal(e.report._styk.animation, before);
  const report = structuredClone(e.serialize()); report._styk.animation.channels[0].keys[0].interpolation = 'linear';
  assert.throws(() => validateAnimationDocument(report), /Constant/);
});

test('depth preview, cancellation, undo, redo, duplication and save/reopen preserve stacking', () => {
  const e = fixture(); e.seek(5);
  e.beginAnimationEdit(target, 'zIndex'); e.previewAnimationEdit(3);
  assert.deepEqual(order(e.evaluatedFrame), [2, 3, 1]); e.cancelAnimationEdit();
  assert.deepEqual(order(e.evaluatedFrame), [1, 2, 3]);
  e.beginAnimationEdit(target, 'zIndex'); e.previewAnimationEdit(3); e.commitAnimationEdit();
  e.undo(); assert.deepEqual(order(e.evaluatedFrame), [1, 2, 3]);
  e.redo(); assert.deepEqual(order(e.evaluatedFrame), [2, 3, 1]);
  const channel = e.animationChannel(target, 'zIndex');
  e.duplicateAnimationKeys([{channelId: channel.id, keyIds: [channel.keys[0].id]}], 5);
  const restored = new Editor({demo: false}).load(structuredClone(e.serialize()));
  assert.deepEqual(order(sample(restored.report, 7)), [2, 3, 1]);
  assert.equal(restored.animationChannel(target, 'zIndex').keys[1].interpolation, 'constant');
});

test('existing order commands cross numeric depths, with one undoable change and unchanged earlier playback', () => {
  for (const command of [e => e.moveSelectionLayer(-1), e => e.sendToBack(), e => e.orderFiguresInFrames(-1, [1])]) {
    const e = fixture(); e.addAnimationKey(target, 'zIndex', 0, 10); e.select(1); e.seek(10);
    const before = order(e.evaluatedFrame), count = e._undo.length; command(e);
    assert.notDeepEqual(order(e.evaluatedFrame), before);
    assert.equal(e._undo.length, count + 1);
    assert.deepEqual(order(sample(e.report, 0)), [2, 3, 1]);
    validateAnimationDocument(e.report);
    e.undo(); assert.deepEqual(order(e.evaluatedFrame), before);
    e.redo(); assert.notDeepEqual(order(e.evaluatedFrame), before);
  }
});

test('depth is identical in worker playback and materialized Pivot output', async () => {
  const e = fixture(); e.addAnimationKey(target, 'zIndex', 0, 2); e.addAnimationKey(target, 'zIndex', 10, -2);
  const exported = materializePivotDocument(e.serialize());
  for (const tick of [0, 5, 9, 10, 20]) {
    const expected = order(sample(e.report, tick));
    assert.deepEqual(order(sample(exported, tick)), expected);
    const packet = await compilePlaybackPacket(e.report, tick);
    assert.deepEqual(packet.groups.map(group => e.report.keyframes[0].objects[group.slot].unique_id), expected);
  }
  assert.ok(exported.keyframes.every(frame => frame.objects.every(object => object._stykZIndex === undefined)));
});

test('pose edits only key scalar channels whose evaluated values actually change', () => {
  const e = fixture();
  for (const [property, value] of [['x', 0], ['y', 200], ['scale', 1], ['opacity', 1], ['zIndex', 2]]) e.addAnimationKey(target, property, 0, value);
  const untouched = ['y', 'scale', 'opacity', 'zIndex'].map(property => e.animationChannel(target, property));
  e.select(1); e.seek(5); e.moveSelection(20, 0);
  assert.ok(e.animationChannel(target, 'x').keys.some(key => key.tick === 5));
  untouched.forEach(channel => assert.equal(e.animationChannel(target, channel.property), channel));
  e.undo(); assert.equal(e.animationChannel(target, 'x').keys.length, 1);
});

test('provenance distinguishes pose keys, interpolation, scalar overrides and shared style values', () => {
  const e = fixture(), state = property => animationPropertyState(e, target, property);
  assert.equal(state('x').poseKeyed, true); assert.equal(state('x').keyed, false);
  assert.equal(state('outlineOpacity').source, 'shared');
  e.seek(5); assert.equal(state('x').poseKeyed, false); assert.equal(state('x').poseAnimated, true);
  assert.equal(state('x').previousKey.tick, 0); assert.equal(state('x').nextKey.tick, 10);
  e.addAnimationKey(target, 'x', 10, 400);
  assert.equal(state('x').source, 'pose'); assert.equal(state('x').nextKey.tick, 10);
  e.seek(10); assert.equal(state('x').keyed, true); assert.equal(state('x').poseKeyed, false);
  e.seek(15); assert.equal(state('x').source, 'property'); assert.equal(state('x').nextKey, null);
});

test('provenance follows independent pose retiming, passthrough and scalar key deletion', () => {
  const e = fixture(), pose = e.nativePoseChannel(target);
  e.moveAnimationKeys([{channelId: pose.id, keyIds: [pose.keys[1].id]}], 2);
  e.seek(12); assert.equal(animationPropertyState(e, target, 'x').poseKeyed, true);
  const key = e.addAnimationKey(target, 'x', 5, 50), channel = e.animationChannel(target, 'x');
  e.deleteAnimationKeys([{channelId: channel.id, keyIds: [key.id]}]);
  assert.equal(animationPropertyState(e, target, 'x').source, 'pose');
  const report = structuredClone(e.serialize());
  report._styk.animation.channels.find(c => c.property === 'x').keys = [{id: 'pass', tick: 12, value: 50, interpolation: 'linear', passthrough: true}];
  e.load(report); e.seek(12);
  const state = animationPropertyState(e, target, 'x');
  assert.equal(state.keyed, false); assert.equal(state.poseKeyed, true);
});

test('long masked pose intervals use bounded key reads during repeated inspector updates', () => {
  let reads = 0;
  const keys = Array.from({length: 50000}, (_, tick) => ({tick, value: {frameId: 'pose'}, get hidden() { reads++; return false; }}));
  const scalar = {keys: [{tick: 0, value: 1}, {tick: 49999, value: 2}], property: 'x'};
  const editor = {tick: 100, animationChannel: () => scalar, nativePoseChannel: () => ({keys})};
  animationPropertyState(editor, target, 'x'); reads = 0;
  for (let tick = 100; tick < 200; tick++) { editor.tick = tick; animationPropertyState(editor, target, 'x'); }
  assert.ok(reads < 500, `Masked poses were scanned ${reads} times`);
});
