import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeNativeVideo} from '../src/native-video-export.mjs';

const options = {format: 'mp4', width: 2, height: 2, fps: 24, totalFrames: 3, renderFrame: () => ({width: 2, height: 2})};
async function environment(run) {
  const saved = Object.fromEntries(['Worker', 'OffscreenCanvas', 'createImageBitmap'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const workers = [], bitmaps = [];
  class Worker extends EventTarget {
    constructor() { super(); workers.push(this); }
    postMessage(message) {
      const event = new Event('message');
      event.data = {id: message.id, ok: true, ...(message.operation === 'frame' ? {blob: new Blob([new Uint8Array(600000)])} : {})};
      queueMicrotask(() => this.dispatchEvent(event));
    }
    terminate() { this.terminated = true; }
  }
  Object.assign(globalThis, {Worker, OffscreenCanvas: class {}, createImageBitmap: async canvas => {
    const bitmap = {width: canvas.width, height: canvas.height, close() { this.closed = true; }}; bitmaps.push(bitmap); return bitmap;
  }});
  try { return await run({workers, bitmaps}); }
  finally { for (const [key, descriptor] of Object.entries(saved)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } }
}
function service(overrides = {}) {
  const calls = [], chunkSizes = []; let reading = 0;
  const desktop = {
    beginVideoExport: async config => { calls.push(['begin', config]); return {token: 'job-1', maxChunkBytes: 262144}; },
    beginVideoFrame: async (token, frame) => { assert.equal(token, 'job-1'); calls.push(['frame', frame]); },
    writeVideoChunk: async (token, bytes) => { assert.equal(token, 'job-1'); chunkSizes.push(bytes.byteLength); },
    endVideoFrame: async token => { assert.equal(token, 'job-1'); calls.push(['endFrame']); },
    finishVideoExport: async token => { assert.equal(token, 'job-1'); calls.push(['finish']); return {size: 6}; },
    readVideoChunk: async token => { assert.equal(token, 'job-1'); return {bytes: new Uint8Array(reading++ ? [5, 6] : [1, 2, 3, 4]).buffer, done: reading === 2}; },
    cancelVideoExport: async token => { calls.push(['cancel', token]); },
    ...overrides,
  };
  return {desktop, calls, chunkSizes};
}
test('native renderer transfers lossless frame blobs in bounded chunks and returns correctly typed output', async () => environment(async ({workers, bitmaps}) => {
  const {desktop, calls, chunkSizes} = service(), progress = [];
  const blob = await encodeNativeVideo({...options, desktop, quality: 0.8, onProgress: value => progress.push(value)});
  assert.equal(blob.type, 'video/mp4'); assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())], [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(calls.filter(call => call[0] === 'frame').map(call => call[1]), [0, 1, 2].map(index => ({index, size: 600000})));
  assert.equal(chunkSizes.length, 9); assert.ok(chunkSizes.every(size => size <= 262144));
  assert.deepEqual(progress.filter(value => value.phase === 'rendering').map(value => value.completed), [1, 2, 3]);
  assert.equal(progress.at(-1).phase, 'complete'); assert.ok(workers.every(worker => worker.terminated)); assert.ok(bitmaps.every(bitmap => bitmap.closed));
  assert.ok(!calls.some(call => call[0] === 'cancel'));
}));
test('cancellation stops the native job and releases the frame worker', async () => environment(async ({workers}) => {
  const {desktop, calls} = service(), controller = new AbortController();
  await assert.rejects(() => encodeNativeVideo({...options, desktop, signal: controller.signal, onProgress: value => { if (value.completed === 1) controller.abort(); }}), {name: 'AbortError'});
  assert.ok(calls.some(call => call[0] === 'cancel')); assert.ok(!calls.some(call => call[0] === 'finish'));
  assert.ok(workers.every(worker => worker.terminated));
}));
test('renderer and truncated-output errors reject and clean up the token', async () => environment(async () => {
  let state = service();
  await assert.rejects(() => encodeNativeVideo({...options, desktop: state.desktop, renderFrame: () => { throw new Error('Expected drawing failure'); }}), /Expected drawing failure/);
  assert.ok(state.calls.some(call => call[0] === 'cancel'));
  state = service({readVideoChunk: async () => ({bytes: new Uint8Array([1, 2]).buffer, done: true})});
  await assert.rejects(() => encodeNativeVideo({...options, desktop: state.desktop}), /incomplete/);
  assert.ok(state.calls.some(call => call[0] === 'cancel'));
}));
test('capability and dimension mistakes fail before a native job starts', async () => environment(async () => {
  const {desktop, calls} = service();
  await assert.rejects(() => encodeNativeVideo({...options, desktop, format: 'mkv'}), /WebM, MP4, AVI or WMV/);
  await assert.rejects(() => encodeNativeVideo({...options, desktop, codec: 'rawvideo'}), /supported codec/);
  await assert.rejects(() => encodeNativeVideo({...options, desktop, quality: 1.1}), /quality/);
  await assert.rejects(() => encodeNativeVideo({...options, desktop, width: 10000, height: 10000}), /16 million/);
  await assert.rejects(() => encodeNativeVideo({...options, desktop: {}}), /desktop app/);
  assert.equal(calls.length, 0);
}));
test('a supported explicit codec reaches the native job without changing its container', async () => environment(async () => {
  const {desktop,calls}=service();const blob=await encodeNativeVideo({...options,format:'avi',codec:'ffv1',desktop});
  assert.equal(calls[0][1].format,'avi');assert.equal(calls[0][1].codec,'ffv1');assert.equal(blob.type,'video/x-msvideo');
}));
