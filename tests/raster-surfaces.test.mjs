import test from 'node:test';
import assert from 'node:assert/strict';
import {RasterSurfacePool} from '../src/raster-surfaces.mjs';

test('serial rasterization retains one context and releases pixel storage between captures', () => {
  const previous = globalThis.OffscreenCanvas; let created = 0, resets = 0;
  globalThis.OffscreenCanvas = class {
    constructor(width, height) { created++; this.width = width; this.height = height; this.context = {canvas: this, reset() { resets++; }}; }
    getContext() { return this.context; }
  };
  try {
    const pool = new RasterSurfacePool(); let context;
    for (let i = 0; i < 1000; i++) {
      const lease = pool.acquire(300 + i % 17, 200 + i % 11);
      context ??= lease.context; assert.equal(lease.context, context);
      assert.equal(lease.surface.width, 300 + i % 17); assert.equal(lease.surface.height, 200 + i % 11);
      pool.release(); assert.equal(lease.surface.width, 1); assert.equal(lease.surface.height, 1);
    }
    assert.equal(created, 1); assert.equal(resets, 999);
    pool.dispose(); assert.equal(pool.context, null); assert.equal(pool.surface, null);
    assert.notEqual(pool.acquire(20, 30).context, context); assert.equal(created, 2); pool.dispose();
  } finally {globalThis.OffscreenCanvas = previous;}
});

test('overlapping raster leases fail before overwriting an active object', () => {
  const previous = globalThis.OffscreenCanvas;
  globalThis.OffscreenCanvas = class {
    constructor(width, height) { this.width = width; this.height = height; }
    getContext() { return {canvas: this}; }
  };
  try {
    const pool = new RasterSurfacePool(), active = pool.acquire(100, 200);
    assert.throws(() => pool.acquire(1, 1), /concurrently/);
    assert.equal(active.surface.width, 100); assert.equal(active.surface.height, 200);
    pool.release(); assert.equal(pool.acquire(80, 90).surface, active.surface); pool.dispose();
  } finally {globalThis.OffscreenCanvas = previous;}
});
