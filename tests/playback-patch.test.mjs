import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {PlaybackCache} from '../src/playback.mjs';
import {createPlaybackWorkerEndpoint, compilePlaybackPacket} from '../src/playback-worker.mjs';
import {applyDocumentChunk} from '../src/document-transport.mjs';
import {playbackProperties, applyPlaybackPatch} from '../src/playback-patch.mjs';
import {Editor} from '../src/editor.mjs';
import {createDemo} from '../src/demo.mjs';
import {invalidateEvaluationCaches} from '../src/pivot/geometry.mjs';
const factory = messages => () => {
  const worker = new Worker(new URL('./playback-node-worker.mjs', import.meta.url));
  return {postMessage(message, transfer) {messages.push(structuredClone(message)); worker.postMessage(message, transfer);}, terminate: () => worker.terminate(),
    addEventListener: (name, callback) => worker.on(name, value => callback(name === 'message' ? {data: value} : value))};
};
const patches = messages => {
  const values = new Map();
  for (const message of messages) if (message.type === 'patch-chunk') values.set(message.revision, applyDocumentChunk(values.get(message.revision), message.chunk));
  return [...values.values()];
};
const fixture = () => new Editor({demo: false}).load(createDemo());
async function matches(cache, report, tick) {
  await cache.prepareRange([tick]); const actual = cache.get(tick), expected = await compilePlaybackPacket(report, tick, {scale: cache.scale});
  assert.deepEqual(actual.shapes, expected.shapes); assert.deepEqual(actual.transforms, expected.transforms); assert.deepEqual(actual.frame, expected.frame);
}

test('patches retain assets and historical sources while replacing native frames, authored values and layer order', async () => {
  const editor = fixture(), report = editor.report, messages = [], cache = new PlaybackCache({workerFactory: factory(messages)});
  const oldId = editor.captureFrameSource(report.keyframes[0]);
  try {
    cache.load(report, {revision: editor.revision}); await matches(cache, report, 0); const firstWire = messages.length;
    report.keyframes[0].objects[0].root_x += 40; report.keyframes[1].objects[1].root_y += 30;
    editor.addAnimationKeys([{target: {kind: 'figure', uid: report.keyframes[0].objects[0].unique_id}, property: 'scale', tick: 0, value: 1.25}]);
    const layer = editor.createLayer('Foreground'); editor.assignFiguresToLayer([report.keyframes[0].objects[0].unique_id], layer.id);
    cache.updateDocument({frameIndices: [0, 1], revision: editor.revision}); await matches(cache, report, 0); await matches(cache, report, 2);
    assert.equal(cache.stats.loadKind, 'patch'); assert.equal(cache.stats.patchFrames, 2); assert.equal(cache.stats.patchSourceUpserts, 0);
    const wire = messages.slice(firstWire), patch = patches(wire).at(-1);
    assert.equal(wire.some(message => message.type === 'load-chunk'), false);
    assert.equal(Object.hasOwn(patch.properties, 'figure_types'), false); assert.equal(Object.hasOwn(patch.properties, 'backgrounds'), false);
    assert.equal(Object.hasOwn(patch.properties._styk, 'frameSources'), false); assert.deepEqual(patch.sources, []);
    assert.equal(cache._mirrorSources.get(oldId), report._styk.frameSources[oldId]);
    assert.ok(cache.stats.maxChunkBytes <= 64 * 1024);
  } finally {cache.dispose();}
});

test('new, replaced, forced in-place and removed source frames cross the mirror without historical copies', async () => {
  const editor = fixture(), report = editor.report, messages = [], cache = new PlaybackCache({workerFactory: factory(messages)});
  const oldId = editor.captureFrameSource(report.keyframes[0]);
  try {
    cache.load(report); await cache.prepareRange([0]); messages.length = 0;
    const id = editor.captureFrameSource(report.keyframes[1]);
    cache.updateDocument(); await cache.prepareRange([0]);
    assert.deepEqual(patches(messages).at(-1).sources.map(entry => entry.id), [id]);
    const replacement = structuredClone(report._styk.frameSources[id]); replacement.objects[0].root_x = 321; report._styk.frameSources[id] = replacement;
    cache.updateDocument(); await cache.prepareRange([0]); assert.equal(cache.stats.patchSourceUpserts, 1);
    replacement.objects[0].root_x = 654; cache.updateDocument({sourceIds: [id]}); await cache.prepareRange([0]);
    assert.equal(patches(messages).at(-1).sources[0].frame.objects[0].root_x, 654);
    delete report._styk.frameSources[id]; cache.updateDocument(); await cache.prepareRange([0]);
    assert.deepEqual(patches(messages).at(-1).sources, [{id, frame: null}]);
    assert.equal(cache._mirrorSources.has(id), false); assert.equal(cache._mirrorSources.has(oldId), true);
    delete report._styk.frameSources; cache.updateDocument(); await cache.prepareRange([0]);
    assert.equal(patches(messages).at(-1).hasFrameSources, false); assert.equal(cache._mirrorSources.size, 0);
  } finally {cache.dispose();}
});

test('a committed patch with an undelivered ACK is correctly undone by the next patch', async () => {
  const editor = fixture(), report = editor.report, messages = []; let listener, held, hold = false, committed;
  const workerFactory = () => {
    const endpoint = createPlaybackWorkerEndpoint(message => {
      const copy = structuredClone(message);
      if (hold && message.type === 'loaded') {held = copy; committed?.(); return;}
      queueMicrotask(() => listener({data: copy}));
    });
    return {postMessage(message) {messages.push(structuredClone(message)); queueMicrotask(() => endpoint(structuredClone(message)));},
      addEventListener(name, callback) {if (name === 'message') listener = callback;}, terminate() {}};
  };
  const cache = new PlaybackCache({workerFactory});
  try {
    cache.load(report); await cache.prepareRange([0]);
    const id = editor.captureFrameSource(report.keyframes[0]); hold = true;
    const waitingForCommit = new Promise(resolve => {committed = resolve;});
    cache.updateDocument(); const pending = cache.prepareRange([0]), rejected = assert.rejects(pending, {name: 'AbortError'});
    await waitingForCommit; assert.ok(held); delete report._styk.frameSources[id]; hold = false;
    cache.updateDocument(); listener({data: held}); await rejected; await matches(cache, report, 0);
    assert.deepEqual(patches(messages).at(-1).sources, [{id, frame: null}]); assert.equal(cache._sourceUpdates.size, 0);
    assert.equal(cache._mirrorSources.has(id), false); assert.equal(cache.stats.loadKind, 'patch');
  } finally {cache.dispose();}
});

test('authored pose tracks immediately sample new and replaced retained sources after patch ACK', async () => {
  const editor = fixture(), report = editor.report, messages = [], cache = new PlaybackCache({workerFactory: factory(messages)});
  try {
    cache.load(report); await cache.prepareRange([0]);
    const id = editor.captureFrameSource(report.keyframes[0]); report._styk.frameSources[id].objects[0].root_x = 876;
    editor.addAnimationKeys([{target: {kind: 'layer', id: 'layer-1'}, property: 'pose', tick: 0, value: {frameId: id}}]);
    cache.updateDocument({revision: editor.revision}); await matches(cache, report, 0); assert.equal(cache.get(0).transforms[4], 876);
    report._styk.frameSources[id] = structuredClone(report._styk.frameSources[id]); report._styk.frameSources[id].objects[0].root_x = 987;
    invalidateEvaluationCaches(report); cache.updateDocument({revision: editor.revision + 1}); await matches(cache, report, 0);
    assert.equal(cache.get(0).transforms[4], 987); assert.equal(cache.stats.patchSourceUpserts, 1);
    assert.equal(cache.stats.loadKind, 'patch'); assert.equal(cache.stats.patchFrames, 0);
  } finally {cache.dispose();}
});

test('view changes merge unfinished patches and topology/definition changes use the explicit full fallback', async () => {
  const editor = fixture(), report = editor.report, messages = [], cache = new PlaybackCache({workerFactory: factory(messages)});
  try {
    cache.load(report); await cache.prepareRange([0]);
    report.keyframes[0].objects[0].root_x = 777;
    cache.updateDocument({frameIndices: [0], revision: 10}); const pending = cache.prepareRange([0]), rejected = assert.rejects(pending, {name: 'AbortError'});
    cache.updateView({scale: 2}); await rejected; await matches(cache, report, 0);
    assert.equal(cache.stats.loadKind, 'patch'); assert.equal(cache.get(0).scale, 2); assert.equal(cache.documentRevision, 10);
    report.figure_types[0] = structuredClone(report.figure_types[0]); cache.updateDocument({revision: 11}); await cache.prepareRange([0]);
    assert.equal(cache.stats.loadKind, 'document');
    report.keyframes.push(structuredClone(report.keyframes[0])); cache.updateDocument({revision: 12}); await cache.prepareRange([0]);
    assert.equal(cache.stats.loadKind, 'document');
  } finally {cache.dispose();}
});

test('malformed complete patches cannot partially change retained worker data', () => {
  const report = createDemo(), before = structuredClone(report), properties = playbackProperties(report);
  assert.throws(() => applyPlaybackPatch(report, {properties: {...properties, fps: 10}, frames: [{index: 999, frame: report.keyframes[0]}], sources: [], hasFrameSources: false}), /targets/);
  assert.deepEqual(report, before);
});
