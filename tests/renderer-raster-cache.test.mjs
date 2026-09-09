import test from 'node:test';
import assert from 'node:assert/strict';
import {EditorRasterCache} from '../src/renderer-raster-cache.mjs';

function resource(resolution = 1, generation = 0, bytes = 10) {
  return {resolution, generation, bytes, texture: {destroyed: 0, destroy() {this.destroyed++;}}};
}

test('resolution variants survive layout departures and return without replacing siblings', () => {
  const cache = new EditorRasterCache({maxBytes: 100}), artwork = {};
  const low = resource(), high = resource(2);
  cache.set(artwork, low); cache.retain(new Set([low]), 0);
  cache.set(artwork, high); cache.retain(new Set([high]), 0);
  assert.equal(cache.get(artwork, 1, 0), low);
  assert.equal(cache.get(artwork, 2, 0), high);
  cache.retain(new Set(), 0);
  assert.equal(cache.bytes, 20);
  assert.equal(low.texture.destroyed + high.texture.destroyed, 0);
  cache.clear(); cache.clear();
  assert.equal(cache.bytes, 0);
  assert.equal(cache.get(artwork, 1, 0), undefined);
  assert.equal(low.texture.destroyed, 1);
  assert.equal(high.texture.destroyed, 1);
});

test('publication protects the whole active layout and evicts unused resources in LRU order', () => {
  const cache = new EditorRasterCache({maxBytes: 30}), keys = [{}, {}, {}, {}];
  const values = keys.map(key => {const value = resource(); cache.set(key, value); return value;});
  // Allocation can exceed the budget while assembling the next layout.
  assert.equal(cache.bytes, 40);
  cache.get(keys[0], 1, 0);
  cache.retain(new Set([values[1]]), 0);
  assert.equal(values[2].destroyed, true);
  assert.equal(values[0].destroyed, undefined);
  assert.equal(cache.bytes, 30);
  assert.equal(cache.get(keys[2], 1, 0), undefined);
  assert.deepEqual(cache.previous(keys[2]), {resolution: 1, generation: 0, destroyed: true});
  cache.maxBytes = 0;
  cache.retain(new Set([values[0], values[1]]), 0);
  assert.equal(cache.bytes, 20);
  assert.equal(cache.stats.activeBytes, 20);
  cache.retain(new Set(), 0);
  assert.equal(cache.bytes, 0);
  assert.ok(values.every(value => value.texture.destroyed === 1));
});

test('generation changes cannot reuse stale pixels and entry limits bound tiny resources', () => {
  const cache = new EditorRasterCache({maxEntries: 1}), key = {};
  const before = resource(), after = resource(1, 1), other = resource(2, 1);
  cache.set(key, before);
  assert.equal(cache.get(key, 1, 1), undefined);
  cache.set(key, after); cache.retain(new Set([after]), 1);
  assert.equal(before.texture.destroyed, 1);
  assert.equal(cache.get(key, 1, 0), undefined);
  cache.set(key, other); cache.retain(new Set([other]), 1);
  assert.equal(after.texture.destroyed, 1);
  assert.equal(cache.lru.size, 1);
  assert.throws(() => cache.set(key, resource(2, 1)), /already exists/);
});

test('preparation leases protect both layouts until publication or cancellation',()=>{
  const cache=new EditorRasterCache({maxBytes:0}),first=resource(),next=resource();
  cache.set({},first);const lease=cache.lease([first]);cache.set({},next);lease.add(next);
  cache.retain(new Set([next]),0);assert.equal(first.destroyed,undefined);assert.equal(cache.bytes,20);
  lease.release();lease.release();cache.retain(new Set([next]),0);
  assert.equal(first.destroyed,true);assert.equal(next.destroyed,undefined);
  cache.clear();assert.equal(next.texture.destroyed,1);assert.equal(cache.leases.size,0);
});
