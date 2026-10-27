// The drawing raster engine (Rust, src/engine/engine-drawing.mjs) behind the drawing workers'
// interfaces: every pixel-worker request, the stroke worker's protocol, the brush model and the undo
// codec answer, and the engine hands its memory back. The crate's own parity suite
// (engine/crates/styk-drawing/tests/parity.rs) checks the kernels against the recorded answers of the
// JavaScript engine it replaced; this checks the facades.
// Node 24's Math.pow is the platform's; the engine's is V8's own (D16), so the run pins Node to it.
import '../engine/tools/v8-pin.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import english from '../src/locales/en.mjs';
import {loadDrawingEngine, StrokeEngine, RustBrushStroke, paintStroke, encodeHistoryChunk, decodeHistoryChunk, drawingEngineMemory, releaseDrawingEngineMemory, drawingEngineGeneration} from '../src/engine/engine-drawing.mjs';
import {drawingEngineOperation} from '../src/engine/engine-drawing-worker.mjs';
import {normalizeBrush} from '../src/drawing-brush.mjs';
import {TileStore, TILE} from '../src/drawing-tiles.mjs';
import {encodeTileBlob} from '../src/drawing-tile-codec.mjs';
import {encodeRGBAPNG, drawingPNGDataURL} from '../src/drawing-png.mjs';
import {lassoMask, ellipsePoints} from '../src/drawing-pixels.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const engine = await loadDrawingEngine();

/** Soft and hard discs, a uniform tile, empty space between, negative coordinates. */
function artwork(seed = 3) {
  let s = seed; const rnd = () => (s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 2 ** 32;
  const store = new TileStore();
  for (let k = 0; k < 6; k++) {
    const cx = -80 + rnd() * 300, cy = -60 + rnd() * 220, r = 8 + rnd() * 36, c = [rnd() * 255 | 0, rnd() * 255 | 0, rnd() * 255 | 0], soft = k % 2;
    for (let y = Math.floor(cy - r); y < cy + r; y++) for (let x = Math.floor(cx - r); x < cx + r; x++) {
      const d = Math.hypot(x + .5 - cx, y + .5 - cy); if (d > r) continue;
      const tile = store.writable(Math.floor(x / TILE), Math.floor(y / TILE)), i = ((y - tile.ty * TILE) * TILE + x - tile.tx * TILE) * 4;
      tile.pixels.set([...c, Math.round((soft ? 1 - d / r : Math.min(1, r - d)) * 255)], i);
    }
  }
  store.set(3, 2, new Uint8ClampedArray([12, 200, 40, 255]));
  return store;
}
const tilesOf = store => [...store].map(t => ({tx: t.tx, ty: t.ty, pixels: t.pixels.slice().buffer}));
/** Runs one request on a copy of its data and returns the worker's single reply. */
async function ask(data) {
  const replies = [];
  await drawingEngineOperation(structuredClone(data), message => replies.push(message));
  assert.equal(replies.length, 1);
  return replies[0];
}
const answers = async (name, data) => {
  const reply = await ask(data);
  assert.ok(!reply.error, `${name}: ${reply.error}`);
  assert.equal(reply.id, data.id, name);
  return reply;
};
const refuses = async (name, data) => assert.ok((await ask(data)).error, `${name} is refused`);

test('the drawing engine module loads in Node', () => {
  assert.ok(engine, 'src/engine/pkg/styk_drawing.js is built (npm run engine:build)');
  assert.ok(drawingEngineMemory() > 0);
});

test('every pixel-worker request is answered', async () => {
  const art = artwork(), tiles = tilesOf(art), bounds = {x: -160, y: -128, width: 448, height: 384};
  const lasso = lassoMask(ellipsePoints({x: -40, y: -30}, {x: 150, y: 120}, 48));
  const fill = await answers('fill', {id: 1, kind: 'fill', tiles, bounds, options: {x: 20, y: 30, color: [200, 10, 10, 255], tolerance: 16, expansion: 1, gap: 2, clip: null, maxBytes: 768 * 1024 * 1024}});
  assert.ok(fill.tiles.length > 0 && fill.tiles.every(t => t.after), 'a fill changes tiles and records their undo sides');
  await answers('fill clipped', {id: 2, kind: 'fill', tiles, bounds, options: {x: 20, y: 30, color: [0, 0, 255, 128], tolerance: 40, expansion: 0, gap: 0, clip: lasso, maxBytes: 768 * 1024 * 1024}});
  await refuses('fill with fractional bounds', {id: 3, kind: 'fill', tiles, bounds: {...bounds, x: .5}, options: {x: 0, y: 0, color: [1, 2, 3, 255]}});
  const wand = await answers('wand', {id: 4, kind: 'flood-mask', tiles, bounds, options: {x: 20, y: 30, tolerance: 16, gap: 1}});
  assert.ok(wand.mask?.mask?.some(Boolean), 'the wand selects pixels');
  await answers('wand outside', {id: 5, kind: 'flood-mask', tiles, bounds, options: {x: 9999, y: 30, tolerance: 16, gap: 0}});
  for (const options of [{kind: 'blur', radius: 6}, {kind: 'hsl', hue: 90, saturation: 20, lightness: -10, mask: lasso}, {kind: 'brightness', brightness: 20, contrast: 30}, {kind: 'invert', mask: lasso}])
    await answers(`filter ${options.kind}`, {id: 6, kind: 'filter', tiles, bounds, options});
  await refuses('an unknown filter', {id: 6, kind: 'filter', tiles, bounds, options: {kind: 'emboss'}});
  await answers('fill mask', {id: 7, kind: 'fill-mask', tiles, mask: lasso, color: [10, 250, 10, 200]});
  const points = ellipsePoints({x: -50, y: -40}, {x: 130, y: 110}, 64);
  const selected = await answers('select', {id: 8, kind: 'select', tiles, points, maxBytes: 384 * 1024 * 1024});
  await answers('select by mask', {id: 9, kind: 'select', tiles, mask: lasso, maxBytes: 384 * 1024 * 1024});
  const source = selected.tiles.map(t => ({tx: t.tx, ty: t.ty, pixels: t.full ? art.get(t.tx, t.ty).pixels.slice().buffer : t.pixels, alphaBounds: t.alphaBounds}));
  await answers('commit selection', {id: 10, kind: 'selection', tiles, selection: {matrix: [.9, .3, -.3, .9, 14.5, -6], tiles: source, remove: false, filter: 'smooth', maxBytes: 384 * 1024 * 1024}});
  await answers('delete selection', {id: 11, kind: 'selection', tiles, selection: {matrix: [1, 0, 0, 1, 0, 0], tiles: source, remove: true, filter: 'nearest'}});
  const copied = await answers('copy', {id: 12, kind: 'copy-selection', tiles: source.slice(0, 4).map((t, i) => i % 2 ? {tx: t.tx, ty: t.ty, png: encodeRGBAPNG(new Uint8ClampedArray(t.pixels), 64, 64).buffer} : t), maxBytes: 384 * 1024 * 1024});
  const clip = {version: 2, pixelsPerUnit: 2, world: {x: 0, y: 0}, matrix: [1, 0, 0, 1, 0, 0], bounds: {x: -256, y: -256, width: 768, height: 768}, tiles: copied.tiles};
  await answers('paste', {id: 13, kind: 'paste', tiles, clip, matrix: [1.1, 0, .2, 1, 33, 7], filter: 'smooth', maxBytes: 384 * 1024 * 1024});
  for (const ratio of [.5, 2, .25]) await answers(`resample ${ratio}`, {id: 14, kind: 'resample', tiles, ratio, filter: 'smooth', maxBytes: 384 * 1024 * 1024});
  await answers('encode PNGs', {id: 15, kind: 'encode-pngs', tiles});
  const url = await encodeTileBlob(art);
  const decoded = await answers('decode tiles', {id: 16, kind: 'decode-tiles', url, levels: 3});
  assert.equal(decoded.tiles.length, tiles.length);
  const shards = [await answers('decode a shard', {id: 17, kind: 'decode-tiles', url, levels: 3, shard: [0, 2]}), await answers('decode the other', {id: 17, kind: 'decode-tiles', url, levels: 3, shard: [1, 2]})];
  assert.equal(shards[0].tiles.length + shards[1].tiles.length, tiles.length, 'the shards partition the cel');
  const legacy = drawingPNGDataURL(encodeRGBAPNG(new Uint8ClampedArray(130 * 70 * 4).map((_, i) => i % 4 === 3 ? (i % 11 ? 255 : 0) : (i * 7) & 255), 130, 70));
  await answers('decode legacy', {id: 18, kind: 'decode-legacy', url: legacy, crop: {x: -17, y: 40}});
  const keys = [...art].map(t => `${t.tx},${t.ty}`);
  for (const request of [{celId: 'a', keep: keys, tiles: tiles.slice(0, 3), partial: true}, {celId: 'a', tiles: tiles.slice(3), partial: true}, {celId: 'a', keep: keys, tiles: []}, {celId: 'b', keep: keys.slice(1), tiles: tiles.slice(1, 2)}, {celId: 'c', keep: ['0,0'], tiles: []}])
    assert.ok(await ask({id: 19, kind: 'encode-tiles', ...request}), `publish ${request.celId}`);
  await refuses('an unknown request', {id: 20, kind: 'nothing'});
});

test('commit preparation expands compact colours and keeps full tiles in their buffers', async () => {
  const art = artwork(5), [first] = [...art];
  const input = [{tx: 0, ty: 0, pixels: first.pixels.slice().buffer}, {tx: 1, ty: 0, pixels: new Uint8ClampedArray([1, 2, 3, 4]).buffer}, {tx: 2, ty: 0, pixels: null}, {tx: 3, ty: 0, pixels: new Uint8ClampedArray([1, 2, 3, 0]).buffer}];
  const reply = await answers('prepare', {id: 1, kind: 'prepare-tiles', tiles: input});
  assert.equal(reply.tiles.length, 4);
  assert.equal(reply.tiles[0].pixels.byteLength, TILE * TILE * 4);
  assert.equal(reply.tiles[1].pixels.byteLength, TILE * TILE * 4, 'a compact colour is expanded');
  assert.equal(reply.tiles[2].pixels, null);
  assert.equal(reply.tiles[3].pixels, null, 'a fully transparent colour is no tile');
});

test('the stroke worker protocol paints batches and records undo sides', () => {
  const base = artwork(7);
  for (const settings of [{size: 14, taperIn: 20, taperOut: 60, color: [10, 20, 30], seed: 4}, {size: 30, hardness: .3, flow: .4, tip: 'chalk', texture: .5, grain: 'paper', color: [200, 0, 100], seed: 9},
    {size: 26, blend: 'smudge', smudgeLength: .7, colorRate: .2, color: [255, 255, 0], seed: 2}, {size: 20, erase: true, seed: 1}, {size: 18, blend: 'multiply', alphaLock: true, color: [0, 128, 255], seed: 3, mask: lassoMask(ellipsePoints({x: 0, y: 0}, {x: 120, y: 90}, 40))}]) {
    const strokes = new StrokeEngine();
    strokes.begin(1, settings);
    const sent = new Set(), brush = normalizeBrush(settings), batches = [];
    let pending = [], seq = 0, version = -1;
    const stroke = new RustBrushStroke(brush, shape => pending.push(shape));
    const flush = () => {
      const tail = brush.taperOut > 0 && stroke.tailVersion !== version ? stroke.tailShapes() : undefined;
      if (tail) version = stroke.tailVersion;
      const tiles = [];
      for (const d of tail ? [...pending, ...tail] : pending) for (let ty = Math.floor(d.top / TILE); ty * TILE < d.bottom; ty++) for (let tx = Math.floor(d.left / TILE); tx * TILE < d.right; tx++) {
        if (sent.has(`${tx},${ty}`)) continue; sent.add(`${tx},${ty}`); tiles.push({tx, ty, pixels: base.get(tx, ty)?.pixels.slice().buffer ?? null});
      }
      batches.push(strokes.dabs(1, ++seq, pending, tiles, tail)); pending = [];
    };
    for (let i = 0; i < 80; i++) { const t = i / 79; stroke.sample({x: -30 + t * 260, y: 40 + Math.sin(t * 6) * 50, pressure: .2 + .8 * Math.abs(Math.sin(t * 3)), time: i * 4}); if (i % 9 === 8) flush(); }
    stroke.finish(); flush();
    assert.equal(strokes.dabs(1, 1, [], [], undefined), null, 'a batch already answered is ignored');
    const changes = strokes.end(1);
    assert.equal(strokes.end(1), null, 'a stroke ends once');
    const name = JSON.stringify(settings, (k, v) => k === 'mask' ? undefined : v);
    assert.ok(batches.some(batch => batch?.tiles.length), name);
    assert.ok(changes.length > 0 && changes.every(c => c.before !== undefined && c.after !== undefined), `${name} records its undo sides`);
    strokes.engine.free();
  }
  const refused = new StrokeEngine();
  refused.begin(2, {size: 10});
  assert.throws(() => refused.dabs(2, 1, [{x: 5, y: 5, radius: 5, opacity: 1, flow: 1, cos: 1, sin: 0, left: 0, top: 0, right: 10, bottom: 10}], [], undefined), error => error.messageKey === 'errors.drawingStrokeEngine.aBrushDabReachedDrawingPixelsThatWere');
  refused.engine.free();
});

test('the brush model gives the controller dab shapes, tails and the pen curve', () => {
  for (const settings of [{size: 16, taperIn: 30, taperOut: 70, seed: 5}, {size: 9, stabilization: .6, stabilizerMode: 'string', pressureCurve: [.1, .5, .4, .95], seed: 6}, {size: 40, scatter: 1.5, sizeJitter: .5, angleJitter: 1, roundness: .4, angleMode: 'tilt', tip: 'bristle', seed: 7}]) {
    const brush = normalizeBrush(settings), shapes = [];
    const stroke = new RustBrushStroke(brush, shape => shapes.push(shape), {seed: brush.seed + 7919});
    let version = stroke.tailVersion;
    for (let i = 0; i < 70; i++) {
      const t = i / 69;
      stroke.sample({x: t * 200, y: Math.cos(t * 5) * 40, pressure: .1 + .9 * t, time: i * 3, ax: Math.cos(t * 4), ay: Math.sin(t * 4)});
      assert.ok(stroke.tailVersion >= version, 'the tail version never goes back');
      version = stroke.tailVersion;
      for (const shape of stroke.tailShapes()) assert.ok(Number.isFinite(shape.x) && shape.radius > 0);
    }
    const before = shapes.length;
    stroke.finish();
    assert.ok(shapes.length >= before && shapes.length > 10, JSON.stringify(settings));
    assert.ok(shapes.every(shape => shape.left <= shape.x && shape.right >= shape.x && shape.top <= shape.y && shape.bottom >= shape.y), 'every dab lies within its bounds');
    assert.equal(stroke.tailShapes().length, 0, 'a finished stroke has no provisional tail left to paint');
    if (settings.pressureCurve) assert.ok(stroke.pressure(.3) > .3, 'the soft pen curve lifts light pressure');
  }
});

test('a stroke painted straight into a store is the stroke the engine paints', () => {
  const store = new TileStore(), samples = Array.from({length: 40}, (_, i) => ({x: 10 + i * 4, y: 30 + Math.sin(i / 5) * 12, pressure: 1, time: i * 5}));
  assert.ok(paintStroke(store, {size: 10, color: [200, 30, 40], pressureSize: false, seed: 2}, samples).length > 0);
  assert.ok(store.size > 0);
  const once = store.readRect(0, 0, 200, 64);
  const again = new TileStore();
  paintStroke(again, {size: 10, color: [200, 30, 40], pressureSize: false, seed: 2}, samples);
  assert.deepEqual(again.readRect(0, 0, 200, 64), once, 'the same stroke, the same pixels');
});

test('undo chunks encode and decode', () => {
  const art = artwork(9), [a, b] = [...art];
  const tiles = [{tx: 0, ty: 0, before: null, after: a.pixels.slice()}, {tx: -9, ty: 4, before: new Uint8ClampedArray([1, 2, 3, 4]), after: b.pixels.slice()}, {tx: 2 ** 31 - 1, ty: -(2 ** 31), before: b.pixels.slice(), after: null}];
  const bytes = encodeHistoryChunk(tiles);
  assert.deepStrictEqual(decodeHistoryChunk(bytes), tiles);
  assert.throws(() => decodeHistoryChunk(bytes.subarray(0, 40)), error => error.messageKey === 'errors.drawingHistoryCodec.drawingUndoDataIsDamaged');
  assert.throws(() => encodeHistoryChunk([]), error => error.messageKey === 'errors.drawingHistoryCodec.invalidDrawingHistoryChunkSize');
});

test('every error the drawing engine can raise has the editor\'s message', () => {
  const keys = new Set();
  for (const dir of ['engine/crates/styk-drawing/src', 'engine/crates/styk-drawing-wasm/src'])
    for (const file of readdirSync(path.join(root, dir))) for (const [, key] of readFileSync(path.join(root, dir, file), 'utf8').matchAll(/"(errors\.[A-Za-z0-9.]+)"/g)) keys.add(key);
  assert.ok(keys.size > 50);
  assert.deepEqual([...keys].filter(key => !Object.hasOwn(english, key)), []);
});

// Last: it replaces this thread's instance.
test('an instance gives back the memory a large job grew it to, and work goes on', async () => {
  const art = artwork(11), replies = [], generation = drawingEngineGeneration();
  // A 9-megapixel blur needs more than an instance may keep: the pixel worker replaces it afterwards.
  await drawingEngineOperation({id: 1, kind: 'filter', tiles: tilesOf(art), bounds: {x: -1500, y: -1500, width: 3000, height: 3000}, options: {kind: 'blur', radius: 8}}, message => replies.push(message));
  assert.ok(!replies[0].error, replies[0].error);
  assert.equal(drawingEngineGeneration(), generation + 1, 'the grown instance was replaced');
  assert.ok(drawingEngineMemory() < 32 * 2 ** 20, `the replacement starts small (${drawingEngineMemory()} bytes)`);
  // A 2-megapixel blur stays within the allowance; a smaller limit releases it.
  await drawingEngineOperation({id: 2, kind: 'filter', tiles: tilesOf(art), bounds: {x: -700, y: -700, width: 1400, height: 1400}, options: {kind: 'blur', radius: 8}}, message => replies.push(message));
  const grown = drawingEngineMemory();
  assert.ok(grown > 64 * 2 ** 20 && drawingEngineGeneration() === generation + 1, `kept within the allowance (${grown} bytes)`);
  assert.equal(releaseDrawingEngineMemory(64 * 2 ** 20), true);
  assert.ok(drawingEngineMemory() < 32 * 2 ** 20);
  assert.equal(releaseDrawingEngineMemory(64 * 2 ** 20), false, 'a small instance is kept');
  // The pixel worker answers on the fresh instance; a stroke engine renews itself between strokes.
  await answers('fill after the replacement', {id: 3, kind: 'fill', tiles: tilesOf(art), bounds: {x: -160, y: -128, width: 448, height: 384}, options: {x: 20, y: 30, color: [9, 9, 9, 255]}});
  const strokes = new StrokeEngine();
  strokes.begin(4, {size: 12, seed: 1});
  const dab = {x: 10.5, y: 12.25, radius: 6, opacity: 1, flow: 1, cos: 1, sin: 0, left: 4, top: 6, right: 17, bottom: 19};
  assert.ok(strokes.dabs(4, 1, [dab], [{tx: 0, ty: 0, pixels: null}]).tiles.length > 0);
  assert.ok(strokes.end(4).length > 0);
  strokes.engine.free();
});
