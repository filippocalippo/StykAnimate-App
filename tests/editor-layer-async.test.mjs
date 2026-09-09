import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {Editor} from '../src/editor.mjs';
import {PlaybackCache} from '../src/playback.mjs';
import {emptyDocument, createFrame, createObject} from '../src/demo.mjs';
import {planLayerMembershipMigration, planLayerMembershipMigrationSteps, LAYER_MIGRATION_LIMITS} from '../src/editor-layer-migration.mjs';
import {buildGeometry} from '../src/pivot/geometry.mjs';
const clone = value => structuredClone(value);
function fixture() {
  const report = emptyDocument(), figure = report.figure_types[0];
  report.keyframes = [0, 1, 2].map(i => createFrame([createObject(figure, 1, 100 + i * 20, 150),
    createObject(figure, 2, 300, 170, {join: {target_object_slot: 0, target_handle_id: 4, target_unique_id: 1}}), createObject(figure, 3, 500, 200)], 4));
  const editor = new Editor({demo: false}).load(report); editor.createLayer('Destination');
  editor.addAnimationKeys([{target: {kind: 'layer', id: 'layer-1'}, property: 'pose', tick: 0, value: {frameId: editor.getFrameId(0)}},
    {target: {kind: 'layer', id: 'layer-1'}, property: 'pose', tick: 8, value: {frameId: editor.getFrameId(2)}}]);
  return editor;
}
function wire(plan) {
  if (!plan) return null;
  const old = new Map((plan.beforeAnimation?.channels ?? []).map(channel => [channel.id, channel])), next = new Map(plan.afterAnimation.channels.map(channel => [channel.id, channel]));
  return {version: 1, channelUpdates: [...new Set([...old.keys(), ...next.keys()])].filter(id => old.get(id) !== next.get(id)).map(id => ({id, channel: next.get(id) ?? null})),
    channelOrder: [...next.keys()], nextKeyId: plan.afterAnimation.nextKeyId, frameSources: plan.frameSources, nextFrameIdentity: plan.nextFrameIdentity,
    sampledTicks: plan.sampledTicks, affectedLayerIds: plan.affectedLayerIds, hadFrameSourceTable: plan.hadFrameSourceTable, sourceBytes: plan.sourceBytes};
}
function planner(editor) { return async params => wire(planLayerMembershipMigration({report: editor.report, _nextFrameIdentity: params.nextFrameIdentity}, params.uids, params.targetLayerId, {deletedLayerId: params.deletedLayerId, worker: true})); }
function points(editor) {
  return Array.from({length: editor.totalTicks}, (_, tick) => {
    editor.seek(tick); const frame = editor.evaluatedFrame, geometry = buildGeometry(editor.report, frame);
    return [...geometry.objects.values()].map(g => ({uid: g.obj.unique_id, root: g.root, joints: [...g.joints]})).sort((a, b) => a.uid - b.uid);
  });
}
test('background assignment preserves every composed pose, independent history sources, one undo and reusable redo assets', async () => {
  const editor = fixture(), expected = points(editor), before = clone(editor.serialize()), history = editor._undo.length;
  const progress = []; editor.setLayerMigrationPlanner(planner(editor));
  await editor.assignFiguresToLayerAsync([2], 'layer-2', {onProgress: value => progress.push(value)});
  assert.equal(editor._undo.length, history + 1); assert.deepEqual(points(editor), expected); assert.equal(editor.layerForUid(2), 'layer-2');
  assert.ok(progress.some(value => value.phase === 'staging'));
  const command = editor._undo.at(-1), change = command.frameSourceChanges[0], owned = editor.report._styk.frameSources[change.id], immutable = clone(change.after.value);
  assert.notEqual(owned, change.after.value); assert.notEqual(owned.objects[0], change.after.value.objects[0]);
  editor.select(1, 0); editor.addSegment({parentId: 1, length: 10, angle: .2});
  assert.deepEqual(change.after.value, immutable, 'Shared Rig mutations must never corrupt immutable source snapshots');
  editor.undo(); const after = clone(editor.serialize()); editor.undo(); assert.deepEqual(editor.serialize(), before);
  editor.redo(); assert.equal(editor.report._styk.frameSources[change.id], owned); assert.deepEqual(editor.serialize(), after); assert.deepEqual(points(editor), expected);
});
test('cancel during source staging publishes no assignment, source, identity or history change', async () => {
  const editor = fixture(), before = clone(editor.serialize()), revision = editor.revision, identity = editor._nextFrameIdentity, controller = new AbortController();
  await assert.rejects(editor.assignFiguresToLayerAsync([2], 'layer-2', {planMigration: planner(editor), signal: controller.signal,
    onProgress: () => controller.abort()}), {name: 'AbortError'});
  assert.deepEqual(editor.serialize(), before); assert.equal(editor.revision, revision); assert.equal(editor._nextFrameIdentity, identity);
});
test('an edit or document replacement while a background job runs rejects its stale result', async () => {
  const editor = fixture(); let resolve;
  const planned = wire(planLayerMembershipMigration(editor, [2], 'layer-2'));
  const pending = editor.assignFiguresToLayerAsync([2], 'layer-2', {planMigration: () => new Promise(done => { resolve = done; })});
  editor.select(1); editor.moveSelection(1, 0); const current = clone(editor.serialize()); resolve(planned);
  await assert.rejects(pending, /changed/); assert.deepEqual(editor.serialize(), current);
  const second = editor.assignFiguresToLayerAsync([2], 'layer-2', {planMigration: () => new Promise(done => { resolve = done; })});
  editor.load(emptyDocument()); resolve(planned); await assert.rejects(second, /changed/); assert.equal(editor.report.keyframes[0].objects.length, 0);
});
test('malformed worker poses fail validation before any publication', async () => {
  const editor = fixture(), before = clone(editor.report), plan = wire(planLayerMembershipMigration(editor, [2], 'layer-2'));
  Object.values(plan.frameSources)[0].objects[0].angles[0] = NaN;
  await assert.rejects(editor.assignFiguresToLayerAsync([2], 'layer-2', {planMigration: async () => plan}), /finite/);
  assert.deepEqual(editor.report, before);
});
test('background deletion preserves default membership, channel order and exact undo', async () => {
  const editor = fixture(), before = clone(editor.serialize()), expected = points(editor); editor.setLayerMigrationPlanner(planner(editor));
  await editor.deleteLayerAsync('layer-1', {targetLayerId: 'layer-2'});
  assert.equal(editor.report._styk.layers.defaultLayerId, 'layer-2'); assert.equal(editor.layerForUid(3), 'layer-2'); assert.deepEqual(points(editor), expected);
  editor.undo(); assert.deepEqual(editor.serialize(), before);
});
test('generator keeps only destination actors and their ancestor closure, with cancellable progress beyond synchronous limits', () => {
  const editor = fixture(), before = clone(editor.report), plan = planLayerMembershipMigration(editor, [2], 'layer-2');
  for (const frame of Object.values(plan.frameSources)) assert.deepEqual(frame.objects.map(object => object.unique_id), [1, 2]);
  editor.addAnimationKey({kind: 'layer', id: 'layer-1'}, 'pose', LAYER_MIGRATION_LIMITS.maxTicks + 5, {frameId: editor.getFrameId(2)});
  const unchanged = clone(editor.report), identity = editor._nextFrameIdentity;
  const iterator = planLayerMembershipMigrationSteps(editor, [2], 'layer-2', {worker: true}), first = iterator.next();
  assert.equal(first.done, false); assert.ok(first.value.total > LAYER_MIGRATION_LIMITS.maxTicks); iterator.return();
  assert.deepEqual(editor.report, unchanged); assert.equal(editor._nextFrameIdentity, identity); assert.equal(before.keyframes.length, editor.report.keyframes.length);
  const bounded = planLayerMembershipMigrationSteps(editor, [2], 'layer-2', {worker: true, maxSourceBytes: 1});
  assert.throws(() => bounded.next(), /source memory budget/); assert.deepEqual(editor.report, unchanged);
});

test('the real playback worker stages and commits a joined migration without resending its retained document', async () => {
  const editor = fixture(), expected = points(editor), before = clone(editor.serialize());
  const cache = new PlaybackCache({workerFactory: () => {
    const worker = new Worker(new URL('./playback-node-worker.mjs', import.meta.url));
    return {postMessage: (message, transfer) => worker.postMessage(message, transfer), terminate: () => worker.terminate(),
      addEventListener(name, callback) {worker.on(name, value => callback(name === 'message' ? {data: value} : value));}};
  }});
  try {
    cache.load(editor.report, {revision: editor.revision}); await cache.prepareRange([0]); const loadChunks = cache.stats.loadChunks;
    editor.setLayerMigrationPlanner((params, options) => cache.planLayerMigration(params, options));
    const progress = []; await editor.assignFiguresToLayerAsync([2], 'layer-2', {onProgress: value => progress.push(value)});
    assert.deepEqual(points(editor), expected); assert.equal(cache.stats.loadChunks, loadChunks);
    assert.ok(progress.some(item => item.phase === 'sampling')); assert.ok(progress.some(item => item.phase === 'staging'));
    editor.undo(); assert.deepEqual(editor.serialize(), before); editor.redo(); assert.deepEqual(points(editor), expected);
    await cache.prepareRange([1]); assert.ok(cache.has(1), 'Read-only planning keeps the prior worker mirror usable until the normal edit patch');
  } finally {cache.dispose();}
});
