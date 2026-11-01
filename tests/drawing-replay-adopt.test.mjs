import test from 'node:test';
import assert from 'node:assert/strict';
import {TileStore, TILE_BYTES} from '../src/drawing-tiles.mjs';
import {applyTileChanges} from '../src/drawing-pixels.mjs';

const tile = value => new Uint8ClampedArray(TILE_BYTES).fill(value);

test('a replay can adopt the record\'s tiles frozen, and painting on one copies it first', () => {
  const store = new TileStore(), record = tile(7), changes = [{tx: 0, ty: 0, after: record}];
  applyTileChanges(store, changes, 'after', {share: true});
  const adopted = store.get(0, 0);
  assert.equal(adopted.pixels, record, 'no copy was made');
  assert.equal(adopted.frozen, true);
  const painted = store.writable(0, 0);
  painted.pixels[0] = 99;
  assert.notEqual(painted.pixels, record, 'the first write copies the tile');
  assert.equal(record[0], 7, 'the record keeps the pixels the redo needs');
});

test('without sharing a replay copies, as every other caller of applyTileChanges does', () => {
  const store = new TileStore(), record = tile(5);
  applyTileChanges(store, [{tx: 1, ty: 2, after: record}], 'after');
  assert.notEqual(store.get(1, 2).pixels, record);
  assert.equal(store.get(1, 2).frozen, false);
});

test('a uniform four-byte tile and a removal are applied the same way when sharing', () => {
  const store = new TileStore();
  store.set(3, 3, tile(1));
  applyTileChanges(store, [{tx: 3, ty: 3, after: null}, {tx: 4, ty: 4, after: new Uint8ClampedArray([9, 8, 7, 255])}], 'after', {share: true});
  assert.equal(store.get(3, 3), undefined, 'the tile is gone');
  const filled = store.get(4, 4).pixels;
  assert.equal(filled.byteLength, TILE_BYTES);
  assert.deepEqual([...filled.subarray(0, 4)], [9, 8, 7, 255]);
  assert.deepEqual([...filled.subarray(TILE_BYTES - 4)], [9, 8, 7, 255]);
});
