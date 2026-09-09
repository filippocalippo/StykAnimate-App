import test from 'node:test';
import assert from 'node:assert/strict';
import {PlaybackCache} from '../src/playback.mjs';
import {compilePlaybackPacket, createPlaybackWorkerEndpoint} from '../src/playback-worker.mjs';
import {Editor} from '../src/editor.mjs';
import {createFrame, createObject, emptyDocument} from '../src/demo.mjs';
import {playbackProperties, applyPlaybackPatch} from '../src/playback-patch.mjs';
import {beginNativePropertyEdit, previewNativePropertyEdit, commitNativePropertyEdit} from '../src/native-property-edit.mjs';
const fixture = () => {
  const report = emptyDocument(); report.keyframes = [100, 200, 300].map(x => createFrame([createObject(report.figure_types[0], 1, x, 200)], 100));
  return new Editor({demo: false}).load(report);
};

test('worker pose presence samples the original integer tick at a floating point boundary', async () => {
  const editor = fixture(); editor.nativePoseChannel({kind: 'layer', id: 'layer-1'});
  editor.addAnimationKey({kind: 'layer', id: 'layer-1'}, 'pose', 29, {frameId: null});
  assert.notEqual(29 / 100 * 100, 29);
  assert.equal((await compilePlaybackPacket(editor.report, 28)).objectCount, 1);
  assert.equal((await compilePlaybackPacket(editor.report, 29)).objectCount, 0);
  assert.equal((await compilePlaybackPacket(editor.report, 30)).objectCount, 0);
});

test('editor event metadata distinguishes native membership edits and reports every changed range frame', () => {
  const editor = fixture(); let event;
  editor.addEventListener('change', next => {if (next.detail.kind === 'edit') event = next.detail;});
  editor.addFigure(); assert.equal(event.structural, true); assert.equal(event.layers, true); assert.notEqual(event.layerMetadata, true);
  editor.createLayer('Independent'); assert.equal(event.layerMetadata, true); assert.equal(event.layers, true);
  editor.select(1); editor.moveSelectionInFrames(30, 0, [0, 1, 2]);
  assert.deepEqual(event.frameIndices, [0, 1, 2]); assert.equal(event.structural, false); assert.notEqual(event.layerMetadata, true);
  const duration = beginNativePropertyEdit(editor, 'duration', {indices: [0, 2]});
  previewNativePropertyEdit(duration, 80); assert.deepEqual(event.frameIndices, [0]);
  commitNativePropertyEdit(duration);
  assert.deepEqual(event.frameIndices, [0, 2]); assert.deepEqual(event.changedFrames, [0, 2]);
  assert.equal(event.timing, true); assert.equal(event.live, false);
  assert.deepEqual(editor.report.keyframes.map(frame => frame.duration_raw), [80, 100, 80]);
});

test('superseding an unacknowledged patch retains the native-frame and forced-source union', async () => {
  const editor = fixture(), report = editor.report, sourceId = editor.captureFrameSource(report.keyframes[0]);
  let listener, held, hold = false, committed;
  const cache = new PlaybackCache({workerFactory: () => {
    const endpoint = createPlaybackWorkerEndpoint(message => {
      const copy = structuredClone(message);
      if (hold && message.type === 'loaded') {held = copy; committed(); return;}
      queueMicrotask(() => listener({data: copy}));
    });
    return {postMessage(message) {const copy = structuredClone(message); queueMicrotask(() => endpoint(copy));},
      addEventListener(type, callback) {if (type === 'message') listener = callback;}, terminate() {}};
  }});
  try {
    cache.load(report); await cache.prepareRange([0]);
    report.keyframes[0].objects[0].root_x = 444;
    report._styk.frameSources[sourceId].objects[0].root_x = 777;
    hold = true; const committedPromise = new Promise(resolve => {committed = resolve;});
    cache.updateDocument({frameIndices: [0], sourceIds: [sourceId], revision: 1});
    const pending = cache.prepareRange([0]), rejected = assert.rejects(pending, {name: 'AbortError'});
    await committedPromise;
    report.keyframes[1].objects[0].root_x = 555;
    report._styk.frameSources[sourceId].objects[0].root_x = 888;
    editor.nativePoseChannel({kind: 'layer', id: 'layer-1'});
    editor.addAnimationKey({kind: 'layer', id: 'layer-1'}, 'pose', 50, {frameId: sourceId});
    hold = false; cache.updateDocument({frameIndices: [1], sourceIds: [sourceId], revision: 2});
    listener({data: held}); await rejected;
    await cache.prepareRange([0, 50, 100]);
    assert.equal(cache.get(0).transforms[4], 444); assert.equal(cache.get(50).transforms[4], 888);
    assert.equal(cache.stats.patchFrames, 2); assert.equal(cache.stats.patchSourceUpserts, 1);
    assert.equal(cache._frameUpdates.size, 0); assert.equal(cache._sourceUpdates.size, 0);
    assert.equal(cache.documentRevision, 2);
  } finally {cache.dispose();}
});

test('header deletions remove old properties and source tables without changing retained assets', () => {
  const editor = fixture(), report = editor.report, id = editor.captureFrameSource();
  report.optionalNativeHeader = {opaque: 123}; report._styk.optionalMetadata = {opaque: 456};
  const mirror = structuredClone(report), frames = mirror.keyframes, figures = mirror.figure_types, backgrounds = mirror.backgrounds;
  delete report.optionalNativeHeader; delete report._styk.optionalMetadata; delete report._styk.frameSources;
  applyPlaybackPatch(mirror, {properties: playbackProperties(report), frames: [], sources: [{id, frame: null}], hasFrameSources: false});
  assert.equal(Object.hasOwn(mirror, 'optionalNativeHeader'), false);
  assert.equal(Object.hasOwn(mirror._styk, 'optionalMetadata'), false); assert.equal(Object.hasOwn(mirror._styk, 'frameSources'), false);
  assert.equal(mirror.keyframes, frames); assert.equal(mirror.figure_types, figures); assert.equal(mirror.backgrounds, backgrounds);
});

test('a document replacement after its final chunk ACK cannot overwrite the new ACK waiter', {timeout: 3000}, async () => {
  const first = fixture().report, second = fixture().report; second.keyframes[0].objects[0].root_x = 919;
  let listener, finalChunkAck, notifyAck, heldRevision;
  const ready = new Promise(resolve => {notifyAck = resolve;});
  const cache = new PlaybackCache({timeoutMs: 200, workerFactory: () => {
    const endpoint = createPlaybackWorkerEndpoint(message => {
      const copy = structuredClone(message);
      if (message.type === 'load-ack' && message.revision === heldRevision && message.sequence === 1) {
        finalChunkAck = copy; notifyAck(); return;
      }
      queueMicrotask(() => listener({data: copy}));
    });
    return {postMessage(message) {if (message.type === 'load-chunk' && heldRevision === undefined) heldRevision = message.revision;
      const copy = structuredClone(message); queueMicrotask(() => endpoint(copy));},
      addEventListener(type, callback) {if (type === 'message') listener = callback;}, terminate() {}};
  }});
  try {
    cache.load(first); const original = cache.prepareRange([0]), rejected = assert.rejects(original, {name: 'AbortError'});
    await ready;
    listener({data: finalChunkAck}); cache.load(second);
    await rejected; await cache.prepareRange([0]);
    assert.equal(cache.get(0).transforms[4], 919);
    assert.equal(cache.failure, undefined);
  } finally {cache.dispose();}
});
