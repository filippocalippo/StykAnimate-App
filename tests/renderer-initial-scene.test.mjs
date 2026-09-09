import test from 'node:test';
import assert from 'node:assert/strict';
import {createRenderer} from '../src/renderer.mjs';
import {createFrame, createObject, defaultFigure} from '../src/demo.mjs';
import {backgroundImageAssets, createSceneImages, frameImageAssets} from '../src/scene-preparation.mjs';

function fixture(count = 1, image = false) {
  const figure = defaultFigure(), frame = createFrame(Array.from({length: count}, (_, i) => createObject(figure, i + 1, 20 + i, 40)));
  if (image) frame.background_id = 1;
  return {version: 5, canvas_width: 100, canvas_height: 80, figure_types: [figure], keyframes: [frame],
    backgrounds: image ? [{background_id: 1, kind: 1, asset_url: 'memory:background', mime_type: 'image/png'}] : []};
}
async function graphics() {
  const buffers = [], textures = [], context = {configure() {}, unconfigure() {}, getCurrentTexture: () => ({createView: () => ({})})};
  const resource = () => ({destroyed: false, destroy() {this.destroyed = true;}, createView() {return {};}});
  const queue = {submissions: 0, writeTexture() {}, copyExternalImageToTexture() {}, onSubmittedWorkDone: () => Promise.resolve(),
    submit() {this.submissions++;}, writeBuffer(buffer, offset, data, start = 0, size) {
      const bytes = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data, start, size);
      buffer.bytes.set(bytes, offset);
    }};
  const device = {queue, limits: {maxTextureDimension2D: 4096}, lost: new Promise(() => {}), addEventListener() {}, destroy() {},
    createShaderModule: () => ({getCompilationInfo: async () => ({messages: []})}), createBindGroupLayout: () => ({}), createPipelineLayout: () => ({}),
    createRenderPipelineAsync: async () => ({}), createSampler: () => ({}), createBindGroup: () => ({}),
    createBuffer({size}) {const buffer = {...resource(), size, bytes: new Uint8Array(size)}; buffers.push(buffer); return buffer;},
    createTexture() {const texture = resource(); textures.push(texture); return texture;},
    createCommandEncoder: () => ({finish: () => ({}), beginRenderPass: () => ({setPipeline() {}, setBindGroup() {}, draw() {}, end() {}})}),
  };
  const originals = new Map(['navigator', 'GPUShaderStage', 'GPUBufferUsage', 'GPUTextureUsage'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.defineProperty(globalThis, 'navigator', {configurable: true, value: {gpu: {requestAdapter: async () => ({requestDevice: async () => device, info: {}}), getPreferredCanvasFormat: () => 'bgra8unorm'}}});
  globalThis.GPUShaderStage = {VERTEX: 1, FRAGMENT: 2}; globalThis.GPUBufferUsage = {UNIFORM: 1, COPY_DST: 2, STORAGE: 4};
  globalThis.GPUTextureUsage = {TEXTURE_BINDING: 1, COPY_DST: 2, RENDER_ATTACHMENT: 4};
  const images = new Map(), canvas = {clientWidth: 100, clientHeight: 80, width: 0, height: 0, getContext: () => context};
  const renderer = await createRenderer(canvas, {resources: {url: asset => asset.asset_url, image: url => images.get(url)}});
  return {renderer, images, buffers, textures, queue,
    close() {renderer.destroy(); for (const [key, descriptor] of originals) {if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];}},
  };
}
const imageFactory = () => ({complete: false, naturalWidth: 0, naturalHeight: 0,
  async decode() {this.complete = true; this.naturalWidth = this.naturalHeight = 4;}});

test('initial scene stages complete media and GPU data without changing or submitting the live scene', async () => {
  const app = await graphics();
  try {
    const old = fixture(), incoming = fixture(80, true), renderer = app.renderer;
    renderer.render({report: old, frame: old.keyframes[0], cameraEnabled: false});
    const oldBuffer = renderer.shapeBuffer, oldGeometry = renderer.lastGeometry, oldBytes = oldBuffer.bytes.slice(), submissions = app.queue.submissions;
    await assert.rejects(renderer.prepareInitialScene({report: old, frame: old.keyframes[0]}), /separate incoming/);
    const prepared = await renderer.prepareInitialScene({report: incoming, frame: incoming.keyframes[0], view: {x: 3, y: 7, scale: 1}, cameraEnabled: false, imageFactory});
    assert.equal(renderer.activeReport, old); assert.equal(renderer.lastGeometry, oldGeometry); assert.equal(renderer.shapeBuffer, oldBuffer);
    assert.deepEqual(oldBuffer.bytes, oldBytes); assert.equal(oldBuffer.destroyed, false); assert.equal(app.queue.submissions, submissions);
    assert.equal(app.images.size, 0); assert.equal(prepared.images.get('memory:background').naturalWidth, 4);
    assert.equal(prepared.stage.layout.filter(entry => !entry.g && entry.texture).length, 1);
    assert.throws(() => renderer.activatePreparedScene(prepared, {frame: old.keyframes[0]}), /no longer matches/);
    assert.equal(renderer.shapeBuffer, oldBuffer); assert.equal(oldBuffer.destroyed, false);
    for (const [url, image] of prepared.images) app.images.set(url, image);
    renderer.activatePreparedScene(prepared);
    assert.equal(prepared.activated, true); assert.equal(oldBuffer.destroyed, true); assert.equal(renderer.lastGeometry, prepared.geometry);
    const stagedBuffer = renderer.shapeBuffer, stagedBytes = stagedBuffer.bytes.slice();
    prepared.dispose(); assert.equal(stagedBuffer.destroyed, false, 'Transferred resources belong to the live renderer.');
    renderer.render({report: incoming, frame: incoming.keyframes[0], geometry: prepared.geometry, view: prepared.view, cameraEnabled: false});
    assert.equal(renderer.stats.preparation, 'retained'); assert.equal(renderer.stats.uploadBytes, 0); assert.equal(renderer.stats.compiledObjects, 0);
    assert.deepEqual(stagedBuffer.bytes, stagedBytes); assert.equal(renderer.backgroundsReady(incoming, incoming.keyframes[0]), true);
  } finally {app.close();}
});

test('abort during staged GPU upload destroys only incoming buffers and textures', async () => {
  const app = await graphics();
  try {
    const old = fixture(), incoming = fixture(900, true), renderer = app.renderer, controller = new AbortController();
    renderer.render({report: old, frame: old.keyframes[0], cameraEnabled: false});
    const oldBuffers = new Set(app.buffers), oldTextures = new Set(app.textures), oldBuffer = renderer.shapeBuffer;
    await assert.rejects(renderer.prepareInitialScene({report: incoming, frame: incoming.keyframes[0], cameraEnabled: false,
      signal: controller.signal, imageFactory, sliceMs: .001, yieldControl: async () => {},
      onProgress(progress) {if (progress.phase === 'GPU upload') controller.abort();}}), {name: 'AbortError'});
    assert.equal(renderer.activeReport, old); assert.equal(renderer.shapeBuffer, oldBuffer); assert.equal(oldBuffer.destroyed, false);
    assert.ok(app.buffers.some(buffer => !oldBuffers.has(buffer)), 'Cancellation occurred after actual staging allocation.');
    assert.ok(app.buffers.filter(buffer => !oldBuffers.has(buffer)).every(buffer => buffer.destroyed));
    assert.ok(app.textures.filter(texture => !oldTextures.has(texture)).every(texture => texture.destroyed));
  } finally {app.close();}
});

test('initial image preparation deduplicates URLs, excludes other frames, and fails on undecodable images', async () => {
  const report = fixture(1, true), current = report.keyframes[0];
  report.backgrounds.push({background_id: 9, kind: 1, asset_url: 'memory:unused'});
  assert.deepEqual(backgroundImageAssets(report, current).map(asset => asset.background_id), [1]);
  const asset = {asset_url: 'memory:sprite'}, geometry = {orderedObjects: [{drawables: [{type: 'image', asset}, {type: 'image', asset}, {type: 'text', asset: {}}]}]};
  assert.deepEqual(frameImageAssets(geometry), [asset]);
  let created = 0;
  const images = createSceneImages({url: asset => asset.asset_url, imageFactory: () => {created++; return imageFactory();}});
  await images.load([asset, {...asset}, ...backgroundImageAssets(report, current)]);
  assert.equal(created, 2); assert.equal(images.images.size, 2); images.dispose(); assert.equal(images.images.size, 0);
  const failed = createSceneImages({url: asset => asset.asset_url, imageFactory: () => ({complete: true, naturalWidth: 0, naturalHeight: 0})});
  await assert.rejects(failed.load([asset]), /could not be decoded/); failed.dispose();
});

test('cancelling an unfinished image decode releases private images without waiting for its network result', async () => {
  const controller = new AbortController(), image = {complete: false, naturalWidth: 0, decode: () => new Promise(() => {})};
  const images = createSceneImages({url: asset => asset.asset_url, signal: controller.signal, imageFactory: () => image});
  const pending = images.load([{asset_url: 'memory:pending'}]);
  controller.abort(); await assert.rejects(pending, {name: 'AbortError'});
  images.dispose(); assert.equal(image.src, ''); assert.equal(images.images.size, 0);
});

test('a stale model revision cancels stalled incoming media without an AbortSignal', async () => {
  const app = await graphics();
  try {
    const old = fixture(), incoming = fixture(1, true), renderer = app.renderer;
    renderer.render({report: old, frame: old.keyframes[0], cameraEnabled: false});
    const oldBuffer = renderer.shapeBuffer; let stale = false;
    const image = {complete: false, naturalWidth: 0, decode: () => new Promise(() => {})};
    const pending = renderer.prepareInitialScene({report: incoming, frame: incoming.keyframes[0], cameraEnabled: false,
      imageFactory: () => image, checkCurrent() {if (stale) throw new DOMException('The document changed.', 'AbortError');}});
    await new Promise(resolve => setTimeout(resolve, 5)); stale = true;
    await assert.rejects(pending, {name: 'AbortError'});
    assert.equal(image.src, ''); assert.equal(renderer.activeReport, old);
    assert.equal(renderer.shapeBuffer, oldBuffer); assert.equal(oldBuffer.destroyed, false);
  } finally {app.close();}
});

test('disposing private image resources rejects pending decode waiters directly', async () => {
  const image = {complete: false, naturalWidth: 0, decode: () => new Promise(() => {})};
  const images = createSceneImages({url: asset => asset.asset_url, imageFactory: () => image});
  const pending = images.load([{asset_url: 'memory:pending'}]);
  images.dispose(); await assert.rejects(pending, {name: 'AbortError'});
  assert.equal(image.src, ''); assert.equal(images.images.size, 0);
});

test('preparation samples the final viewport and activation cannot adopt a mismatched geometry', async () => {
  const app = await graphics();
  try {
    const incoming = fixture(); let views = 0;
    const prepared = await app.renderer.prepareInitialScene({report: incoming, frame: incoming.keyframes[0], cameraEnabled: false,
      getView: () => ({scale: ++views === 1 ? 1 : 2, x: 17, y: 23})});
    assert.equal(prepared.view.scale, 2); assert.equal(prepared.view.x, 17); assert.equal(prepared.view.y, 23);
    assert.throws(() => app.renderer.activatePreparedScene(prepared, {geometry: {...prepared.geometry}}), /no longer matches/);
    const owned = prepared.stage.shapeBuffer; prepared.dispose();
    assert.equal(owned.destroyed, true); assert.throws(() => app.renderer.activatePreparedScene(prepared), /no longer matches/);
  } finally {app.close();}
});
