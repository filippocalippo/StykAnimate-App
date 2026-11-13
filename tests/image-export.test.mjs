import test from 'node:test';
import assert from 'node:assert/strict';
import {exportAnimation} from '../src/image-export.mjs';
import {crc32, validatePNGFrame} from '../src/image-codecs.mjs';
import {deflateSync} from 'node:zlib';

const options = {width: 2, height: 2, fps: 24, totalFrames: 3};
const frame = () => ({width: 2, height: 2, blob: new Blob(['png'], {type: 'image/png'})});

function environment(t, respond = message => ({id: message.id, ok: true})) {
  const workers = [], requests = [];
  class Worker extends EventTarget {
    constructor() {super(); workers.push(this);}
    postMessage(message, transfer) {
      requests.push({message, transfer});
      const response = respond(message);
      queueMicrotask(() => {const event = new Event('message'); event.data = response; this.dispatchEvent(event);});
    }
    terminate() {this.terminated = true;}
  }
  for (const [key, value] of Object.entries({Worker, OffscreenCanvas: undefined, createImageBitmap: undefined})) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, {value, configurable: true, writable: true});
    t.after(() => {if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];});
  }
  return {workers, requests};
}

for (const format of ['apng', 'png-sequence']) {
  test(`${format} forwards worker PNGs sequentially with sink backpressure and no bitmap API`, async t => {
    let acknowledged = 0, written = 0;
    const {workers, requests} = environment(t, message => {
      if (message.operation === 'frame') acknowledged++;
      return {id: message.id, ok: true, output: new Blob([message.operation])};
    });
    const progress = [], sink = {streamed: true,
      async write() {await Promise.resolve(); written++;},
      async finish() {return {saved: true};},
      async abort() {throw new Error('Unexpected abort');}};
    const result = await exportAnimation({...options, format, sink,
      renderFrame() {throw new Error('Unexpected canvas round trip');},
      renderPNGFrame(index) {assert.equal(index, acknowledged); assert.equal(written, index + 1); return frame();},
      onProgress: value => progress.push(value.completed)});
    assert.deepEqual(result, {saved: true});
    assert.deepEqual(progress, [1, 2, 3]);
    assert.equal(requests[0].message.config.encodedPNG, true);
    assert.ok(requests.filter(r => r.message.operation === 'frame').every(r => r.message.png instanceof Blob && r.transfer.length === 0));
    assert.ok(workers.every(worker => worker.terminated));
  });
}

test('direct PNG frames enforce dimensions, MIME type and nonempty output before encoding', async t => {
  const {workers, requests} = environment(t);
  for (const invalid of [{...frame(), width: 3}, {...frame(), blob: new Blob(['png'])}, {...frame(), blob: new Blob([], {type: 'image/png'})}]) {
    let aborted = false;
    await assert.rejects(exportAnimation({...options, format: 'apng', renderPNGFrame: () => invalid,
      sink: {write() {}, abort() {aborted = true;}}}), /wrong dimensions/);
    assert.equal(aborted, true);
  }
  assert.equal(requests.filter(r => r.message.operation === 'frame').length, 0);
  assert.ok(workers.every(worker => worker.terminated));
});

test('cancellation during PNG rendering sends no stale frame and aborts the sink', async t => {
  const {workers, requests} = environment(t), controller = new AbortController();
  let aborted = false;
  await assert.rejects(exportAnimation({...options, format: 'png-sequence', signal: controller.signal,
    renderPNGFrame: async () => {controller.abort(); return frame();},
    sink: {write() {}, abort() {aborted = true;}}}), {name: 'AbortError'});
  assert.equal(aborted, true);
  assert.equal(requests.filter(r => r.message.operation === 'frame').length, 0);
  assert.ok(workers.every(worker => worker.terminated));
});

test('a PNG renderer failure propagates and releases the worker', async t => {
  const {workers} = environment(t);
  await assert.rejects(exportAnimation({...options, format: 'apng', renderPNGFrame() {throw new Error('Expected PNG failure');}}), /Expected PNG failure/);
  assert.ok(workers.every(worker => worker.terminated));
});

test('PNG callbacks do not replace the GIF, JPEG or SVG renderers', async t => {
  environment(t);
  for (const format of ['gif', 'jpeg-sequence', 'svg-sequence'])
    await assert.rejects(exportAnimation({...options, format, renderPNGFrame: frame}), /renderer/);
});

test('encoded PNG validation rejects truncated streams, corrupt CRCs and absent compressed pixels', () => {
  const chunk = (type, data) => {
    const name = new TextEncoder().encode(type), bytes = new Uint8Array(data.length + 12), view = new DataView(bytes.buffer);
    view.setUint32(0, data.length); bytes.set(name, 4); bytes.set(data, 8);
    view.setUint32(bytes.length - 4, crc32(bytes.subarray(4, bytes.length - 4)));
    return bytes;
  };
  const header = new Uint8Array(13), view = new DataView(header.buffer);
  view.setUint32(0, 2); view.setUint32(4, 2); header[8] = 8; header[9] = 6;
  const signature = new Uint8Array([137,80,78,71,13,10,26,10]);
  const png = (pixels = deflateSync(new Uint8Array(18))) => Buffer.concat([signature, chunk('IHDR', header), chunk('IDAT', pixels), chunk('IEND', new Uint8Array())]);
  const valid = png();
  assert.equal(validatePNGFrame(valid, 2, 2).length, 3);
  assert.throws(() => validatePNGFrame(valid, 3, 2), /dimensions/);
  assert.throws(() => validatePNGFrame(valid.subarray(0, valid.length - 12), 2, 2), /truncated/);
  const corrupt = valid.slice(); corrupt[corrupt.length - 16] ^= 1;
  assert.throws(() => validatePNGFrame(corrupt, 2, 2), /PNG frame/);
  assert.throws(() => validatePNGFrame(png(new Uint8Array()), 2, 2), /no pixels/);
});

for (const [kept, retainedBytes] of [['keeps its first pass', undefined], ['renders twice when the frames do not fit', 32]]) {
  test(`a GIF of pixel frames ${kept}, drawing the next frame while one is encoded`, async t => {
    const log = [];
    const {workers, requests} = environment(t, message => {
      log.push(`${message.operation}${message.pixels ? ' pixels' : message.retained ? ' retained' : ''}`);
      return {id: message.id, ok: true};
    });
    const rendered = [];
    const result = await exportAnimation({...options, format: 'gif', retainedBytes,
      renderFrame() {throw new Error('Unexpected canvas round trip');},
      async renderPixels(index) {rendered.push(index); log.push(`render ${index}`); return {data: new Uint8ClampedArray(16), width: 2, height: 2};}});
    assert.equal(result, undefined);
    const config = requests[0].message.config;
    assert.equal(config.pixels, true);
    assert.equal(config.retain, retainedBytes === undefined);
    assert.deepEqual(rendered, retainedBytes === undefined ? [0, 1, 2] : [0, 1, 2, 0, 1, 2]);
    // Frame 1 is asked for before frame 0 goes to the worker, and so on.
    assert.deepEqual(log.slice(1, 5), ['render 0', 'render 1', 'frame pixels', 'render 2']);
    const second = log.slice(log.indexOf('encode') + 1, -1).filter(entry => entry.startsWith('frame'));
    assert.deepEqual(second, Array(3).fill(retainedBytes === undefined ? 'frame retained' : 'frame pixels'));
    // Pixels are transferred, never copied.
    for (const {message, transfer} of requests.filter(r => r.message.pixels)) assert.deepEqual(transfer, [message.pixels.buffer]);
    assert.ok(workers.every(worker => worker.terminated));
  });
}

test('a pixel frame of the wrong size stops a GIF export before it reaches the worker', async t => {
  const {requests} = environment(t);
  await assert.rejects(exportAnimation({...options, format: 'gif', renderPixels: async () => ({data: new Uint8ClampedArray(12), width: 2, height: 2})}), /wrong dimensions/);
  assert.equal(requests.filter(r => r.message.operation === 'frame').length, 0);
});

test('the export dialog warms an image export worker that the next export takes, and one no export takes ends', async t => {
  const {workers} = environment(t);
  const {prewarmImageExport} = await import('../src/image-export.mjs');
  t.mock.timers.enable({apis: ['setTimeout']});
  prewarmImageExport();
  prewarmImageExport();
  assert.equal(workers.length, 1, 'one warm worker at a time');
  const exported = exportAnimation({...options, format: 'apng', renderPNGFrame: frame});
  t.mock.timers.tick(0);
  await exported;
  assert.equal(workers.length, 1, 'the export took the warm worker');
  prewarmImageExport();
  assert.equal(workers.length, 2);
  t.mock.timers.tick(60000);
  assert.equal(workers[1].terminated, true, 'given up after a minute');
});
