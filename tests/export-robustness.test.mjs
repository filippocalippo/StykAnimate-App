import test from 'node:test';
import assert from 'node:assert/strict';
import {exportMemoryPlan} from '../src/export-memory.mjs';
import {exportAnimation} from '../src/image-export.mjs';
import {encodeNativeVideo} from '../src/native-video-export.mjs';
import {encodeVfwVideo} from '../src/vfw-video-export.mjs';

const MiB = 1024 * 1024;
test('export plans bound working pixels on small devices without lowering output quality', () => {
  for (const deviceMemory of [.5, 1, 2, 4, 8, undefined]) {
    const plan = exportMemoryPlan(640, 360, 'sprites', {deviceMemory});
    assert.equal(plan.width, 640); assert.equal(plan.renderWidth, 1280);
    assert.ok(plan.frameWorkingBytes + plan.scratchBytes + plan.assetBytes <= plan.maxWorkingBytes);
    assert.ok(plan.tileSize * plan.factor + 8 <= 1032);
  }
  // Legal dimensions never refuse: a small-device 4K plan reports the working
  // floor the export genuinely needs instead of an export_memory_limit error.
  const floor = exportMemoryPlan(3840, 2160, 'sprites', {deviceMemory: 1});
  assert.equal(floor.width, 3840);
  assert.ok(floor.maxWorkingBytes >= floor.frameWorkingBytes + floor.scratchBytes + floor.assetBytes);
  assert.ok(floor.assetBytes >= 4 * MiB);
  assert.equal(exportMemoryPlan(3840, 2160, 'sprites', {deviceMemory: 4}).width, 3840);
  for (const budget of [0, Infinity, NaN, 1024, 2049 * MiB])
    assert.throws(() => exportMemoryPlan(32, 32, 'edges', {maxWorkingBytes: budget}));
});

test('larger memory tiers admit larger exports and small tiers fall back to the working floor', () => {
  const floored = exportMemoryPlan(8192, 4096, 'edges', {deviceMemory: 4});
  assert.equal(floored.width, 8192);
  assert.ok(floored.maxWorkingBytes >= floored.frameWorkingBytes + floored.scratchBytes + floored.assetBytes);
  const plan = exportMemoryPlan(8192, 4096, 'edges', {deviceMemory: 16});
  assert.equal(plan.width, 8192);
  assert.equal(plan.maxWorkingBytes, 1024 * MiB);
  assert.equal(exportMemoryPlan(8192, 8192, 'edges', {deviceMemory: 32}).maxWorkingBytes, 2048 * MiB);
});

function environment(t, respond = message => ({id: message.id, ok: true})) {
  const workers = [], canvases = [], bitmaps = [];
  const bitmap = (width = 32, height = 32) => {
    const value = {width, height, closed: false, close() {this.closed = true;}};
    bitmaps.push(value); return value;
  };
  class Canvas extends EventTarget {
    constructor() {super(); canvases.push(this); this.width = this.height = 32;
      this.context = {canvas: this, isContextLost: () => this.lost, setTransform() {}, clearRect() {}, drawImage() {}};}
    getContext() {return this.context;}
  }
  class Worker extends EventTarget {
    constructor() {super(); workers.push(this);}
    postMessage(message) {
      const response = respond(message, bitmap);
      if (!response) return;
      queueMicrotask(() => {const event = new Event('message'); event.data = response; this.dispatchEvent(event);});
    }
    terminate() {this.terminated = true;}
  }
  for (const [key, value] of Object.entries({Worker, OffscreenCanvas: Canvas,
    document: {createElement: () => new Canvas()}, createImageBitmap: async canvas => bitmap(canvas.width, canvas.height)})) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, {value, configurable: true, writable: true});
    t.after(() => {if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];});
  }
  return {workers, canvases, bitmaps};
}
test('image and native video workers have bounded waits and cancel native jobs on timeout', async t => {
  const state = environment(t, () => null);
  const options = {width: 32, height: 32, fps: 24, totalFrames: 1, timeoutMs: 10, renderFrame: () => ({width: 32, height: 32})};
  await assert.rejects(exportAnimation({...options, format: 'png-sequence'}), /timed out/);
  let cancelled = 0;
  const desktop = Object.fromEntries(['beginVideoFrame','writeVideoChunk','endVideoFrame','finishVideoExport','readVideoChunk'].map(name => [name, async () => {}]));
  desktop.beginVideoExport = async () => ({token: 'test', maxChunkBytes: 1024});
  desktop.cancelVideoExport = async token => {assert.equal(token, 'test'); cancelled++;};
  await assert.rejects(encodeNativeVideo({...options, format: 'mp4', desktop}), /timed out/);
  assert.equal(cancelled, 1);
  const vfw = Object.fromEntries(['beginVfwFrame','writeVfwChunk','endVfwFrame','finishVfwExport','readVfwChunk'].map(name => [name, async () => {}]));
  vfw.beginVfwExport = async () => ({token: 'test', frameBytes: 32 * 32 * 3, maxChunkBytes: 1024});
  vfw.cancelVfwExport = desktop.cancelVideoExport;
  await assert.rejects(encodeVfwVideo({...options, codecId: 'vfw:x64:12345678', desktop: vfw}), /timed out/);
  assert.equal(cancelled, 2); assert.ok(state.workers.every(worker => worker.terminated));
});
