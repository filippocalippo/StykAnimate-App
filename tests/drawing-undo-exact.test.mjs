// Undo and redo of drawing strokes restore the pixels exactly, whether the replay is applied in the commit itself (up to 4 MiB of
// replacement tiles, 256 of them) or prepared in the pixel worker (more). Each stroke commits through the engine owner; the cel's tiles
// are compared byte for byte with the state before and after the stroke after every undo and redo.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {DrawingResources} from '../src/drawing-resources.mjs';
import {DrawingHistory} from '../src/drawing-history.mjs';
import {drawingMetadata} from '../src/drawing-model.mjs';
import {drawingEngineOperation} from '../src/engine/engine-drawing-worker.mjs';
import {loadDrawingEngine} from '../src/engine/engine-drawing.mjs';
import {TILE_BYTES} from '../src/drawing-tiles.mjs';
import {installEngineOwner} from '../src/engine/engine-owner.mjs';
import {engineBuilt, nodeEngine} from './support/engine-node.mjs';

const SYNC_TILES = 256;

/** A drawing history whose spill files live in memory. */
const memoryDisk = () => {
  const records = new Map();
  return {
    async request(kind, data) {
      if (kind === 'begin') records.set(data.record, []);
      if (kind === 'append') records.get(data.record).push(structuredClone(data.tiles));
      if (kind === 'finish') return {result: {storedBytes: records.get(data.record).flat().length * TILE_BYTES}};
      if (kind === 'info') return {result: {parts: records.get(data.record).length, tiles: records.get(data.record).flat().length}};
      if (kind === 'read') return {tiles: structuredClone(records.get(data.record)[data.part])};
      if (kind === 'remove') records.delete(data.record);
      return {};
    },
    async close() { records.clear(); },
  };
};
/** The pixel worker answered in this thread by the drawing raster engine; `calls` counts its `prepare-tiles` requests. */
const engineWorker = () => {
  const worker = {
    prepares: 0,
    async request(kind, data) {
      if (kind === 'prepare-tiles') worker.prepares++;
      let reply;
      await drawingEngineOperation({id: 0, kind, ...structuredClone(data)}, message => { reply = message; });
      if (reply.error) throw Object.assign(new Error(reply.error), {messageKey: reply.messageKey});
      return reply;
    },
    dispose() {},
  };
  return worker;
};

const random = seed => () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
/** What a stroke leaves in one tile: noise, a single sparse pixel group, a compact uniform colour, or nothing (the tile erased). */
function painted(rand, kind) {
  if (kind === 'erase') return null;
  if (kind === 'uniform') return Uint8ClampedArray.from([1 + Math.floor(rand() * 254), Math.floor(rand() * 256), Math.floor(rand() * 256), 1 + Math.floor(rand() * 255)]);
  const pixels = new Uint8ClampedArray(TILE_BYTES);
  if (kind === 'sparse') {
    const x = Math.floor(rand() * 60), y = Math.floor(rand() * 60);
    for (let dy = 0; dy < 3; dy++) for (let dx = 0; dx < 3; dx++) pixels.set([Math.floor(rand() * 256), Math.floor(rand() * 256), Math.floor(rand() * 256), 1 + Math.floor(rand() * 255)], ((y + dy) * 64 + x + dx) * 4);
  } else for (let i = 0; i < TILE_BYTES; i += 4) pixels.set([Math.floor(rand() * 256), Math.floor(rand() * 256), Math.floor(rand() * 256), i % 40 ? 1 + Math.floor(rand() * 255) : 0], i);
  return pixels;
}
const KINDS = ['noise', 'sparse', 'noise', 'uniform'];

const visible = pixels => pixels.some((v, i) => i % 4 === 3 && v);
/** The cel's pixels as tile key -> bytes, without the tiles that hold nothing visible (they are not part of the picture). */
function picture(surface) {
  const out = new Map();
  for (const tile of surface.store) if (visible(tile.pixels)) out.set(`${tile.tx},${tile.ty}`, Buffer.from(tile.pixels));
  return out;
}
/** What the cel must hold, worked out from the strokes alone (never read back from the store under test). */
class Model {
  tiles = new Map();
  /** The tile as a full copy (a compact uniform colour expanded). */
  static full(pixels) { return pixels.byteLength === 4 ? Uint8ClampedArray.from({length: TILE_BYTES}, (_, i) => pixels[i % 4]) : Uint8ClampedArray.from(pixels); }
  before(tx, ty) { const tile = this.tiles.get(`${tx},${ty}`); return tile ? Uint8ClampedArray.from(tile) : null; }
  paint(tiles) { for (const t of tiles) { const key = `${t.tx},${t.ty}`; if (t.after) this.tiles.set(key, Model.full(t.after)); else this.tiles.delete(key); } }
  picture() { return new Map([...this.tiles].filter(([, pixels]) => visible(pixels)).map(([key, pixels]) => [key, Buffer.from(pixels)])); }
}
function assertPicture(surface, expected, message) {
  const actual = picture(surface);
  assert.deepEqual([...actual.keys()].sort(), [...expected.keys()].sort(), `${message}: the same tiles`);
  for (const [key, bytes] of expected) assert.ok(bytes.equals(actual.get(key)), `${message}: tile ${key} differs`);
}

async function painting() {
  await nodeEngine();
  await loadDrawingEngine();
  const editor = new Editor({demo: false, layerTimeline: true, propertyChannels: true});
  const worker = engineWorker(), history = new DrawingHistory({disk: memoryDisk()});
  const resources = new DrawingResources(editor.report, {history, worker});
  resources.busy = true;
  const owner = installEngineOwner(editor, {verify: true});
  assert.ok(owner.ready(), 'the document has its session');
  editor.createDrawingLayer();
  let first = editor.prepareDrawingCel();
  const surface = await resources.surface(first.figure);
  /** A stroke's commit, on the target the editor prepares for it (as the controller does for each stroke). */
  const commit = (tiles, label = 'Brush stroke') => { const target = first ?? editor.prepareDrawingCel(); first = null; return editor.commitDrawingPixels(target, tiles, label); };
  const model = new Model();
  const stroke = (rand, first, count, {erase = 0} = {}) => {
    // As the controller records a stroke: each tile names what the cel held (a copy) and what the stroke left.
    const tiles = [];
    for (let i = 0; i < count; i++) {
      const tx = first + i;
      const kind = erase && i < erase ? 'erase' : KINDS[i % KINDS.length];
      tiles.push({tx, ty: 0, before: model.before(tx, 0), after: painted(rand, kind)});
    }
    model.paint(tiles);
    return tiles;
  };
  return {editor, owner, resources, history, worker, commit, surface, stroke, model, async dispose() { owner.release(); resources.dispose(); await history.dispose(); }};
}

const sizes = [{count: 100, worker: false}, {count: SYNC_TILES, worker: false}, {count: SYNC_TILES + 1, worker: true}, {count: 300, worker: true}];

for (const {count, worker: usesWorker} of sizes) {
  test(`${count} tiles: undo, redo and undo again restore a stroke's pixels exactly (${usesWorker ? 'prepared in the worker' : 'applied in the commit'})`, {skip: !engineBuilt}, async () => {
    const {editor, worker, commit, surface, stroke, model, resources, dispose} = await painting();
    try {
      const rand = random(count), blank = model.picture();
      commit(stroke(rand, 0, count));
      const painted = model.picture();
      assertPicture(surface, painted, 'the stroke');
      assert.ok(painted.size > 0);
      for (let round = 0; round < 3; round++) {
        assert.equal(await editor.undo(), true);
        assertPicture(surface, blank, `undo ${round}`);
        assert.equal(await editor.redo(), true);
        assertPicture(surface, painted, `redo ${round}`);
      }
      assert.equal(await editor.undo(), true);
      assertPicture(surface, blank, 'final undo');
      assert.equal(worker.prepares > 0, usesWorker, usesWorker ? 'a replay this large is prepared in the worker' : 'a replay this small never waits for the worker');
      assert.equal(resources.workingBytes, 0, 'no preparation holds memory afterwards');
    } finally { await dispose(); }
  });

  test(`${count} tiles: several overlapping strokes and an erase undo and redo through every state`, {skip: !engineBuilt}, async () => {
    const {editor, commit, surface, stroke, model, resources, dispose} = await painting();
    try {
      const rand = random(count * 7 + 1), states = [model.picture()];
      // Each stroke overlaps the one before (so its `before` sides are real pixels), the third also erases tiles the others painted.
      const specs = [[0, count, {}], [Math.floor(count / 2), count, {}], [Math.floor(count / 4), count, {erase: Math.floor(count / 3)}]];
      for (const [first, size, options] of specs) {
        commit(stroke(rand, first, size, options));
        states.push(model.picture());
        assertPicture(surface, states.at(-1), 'the stroke');
      }
      assert.equal(new Set(states.map(state => [...state.values()].map(b => b.toString('base64')).join())).size, 4, 'every stroke changed the picture');
      const visit = async (direction, index) => {
        assert.equal(await editor[direction](), true);
        assertPicture(surface, states[index], `${direction} -> state ${index}`);
        const d = drawingMetadata(editor.prepareDrawingCel().figure);
        if (d.version === 2) assert.deepEqual(d.bounds, surface.store.bounds, `${direction} -> state ${index}: the cel's bounds follow the pixels`);
        assert.equal(resources.stats.tiles, surface.store.size, 'the store accounts for exactly its tiles');
      };
      await visit('undo', 2); await visit('undo', 1); await visit('redo', 2); await visit('undo', 1); await visit('undo', 0);
      await visit('redo', 1); await visit('redo', 2); await visit('redo', 3);
      await visit('undo', 2); await visit('redo', 3); await visit('undo', 2); await visit('undo', 1); await visit('undo', 0);
      assert.equal(editor.canUndo && editor.undoLabel === 'Brush stroke', false, 'nothing of the strokes is left to undo');
      assert.equal(resources.workingBytes, 0);
    } finally { await dispose(); }
  });
}
