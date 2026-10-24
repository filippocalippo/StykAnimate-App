import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import backend from '../desktop/web-host.cjs';
const service = await backend.startDesktopHost({appRoot: process.cwd()});
let browser;
try {
  browser = await chromium.launch({channel: 'chrome', headless: true});
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(service.origin + '/tests/fixtures/blank.html');
  const result = await page.evaluate(async () => {
    const {withVfx} = await import('/src/vfx-canvas.mjs');
    const {createVfx} = await import('/src/vfx.mjs');
    const {VfxCPU} = await import('/src/vfx-cpu.mjs');
    const check = (ok, message) => {if (!ok) throw new Error(message);};
    const effect = (type, params) => {const e = createVfx(type, type); Object.assign(e.params, params); return e;};
    // A halo beyond half the GPU surface limit forces the software path.
    const stack = [effect('blur', {radius: 90})];
    let calls = 0, totalPixels = 0;
    const original = VfxCPU.prototype.runPixels;
    VfxCPU.prototype.runPixels = function (pixels, w, h, ...rest) {
      calls++; totalPixels += w * h;
      return original.call(this, pixels, w, h, ...rest);
    };
    try {
      // Deterministic artwork: two opaque rects in document space.
      const paint = ctx => {
        ctx.fillStyle = 'rgba(200,40,40,1)'; ctx.fillRect(30, 40, 80, 60);
        ctx.fillStyle = 'rgba(40,40,200,1)'; ctx.fillRect(60, 90, 50, 50);
      };
      const bounds = {x: 20, y: 20, width: 120, height: 100}, scale = 8;
      const tile = new OffscreenCanvas(512, 512), tileCtx = tile.getContext('2d', {willReadFrequently: true});
      // Two simulated export tiles of one 1024x512 output, sharing the tile
      // context like drawExportSceneTiled does.
      const outputs = []; let hintCalls=0,content='fixture-items';
      const hint=()=>{hintCalls++;return content;};
      withVfx(tileCtx, [], () => {}, {cacheHint:hint});
      check(hintCalls===0,'Unfiltered painting must not evaluate cache fingerprints.');
      for (const tileX of [0, 512]) {
        tileCtx.setTransform(1, 0, 0, 1, 0, 0);
        tileCtx.clearRect(0, 0, 512, 512);
        tileCtx.setTransform(scale, 0, 0, scale, -tileX, 0);
        withVfx(tileCtx, stack, paint, {
          bounds, domainBounds: bounds, scale: 1, cacheHint: hint,
          outputRect: {x: -tileX, y: 0, width: 1024, height: 512},
        });
        tileCtx.setTransform(1, 0, 0, 1, 0, 0);
        outputs.push(tileCtx.getImageData(0, 0, 512, 512).data.slice());
      }
      check(calls === 1, `Shared filtered region was recomputed per tile (${calls} CPU passes).`);
      // Full-width reference: one canvas spanning both tiles.
      const ref = new OffscreenCanvas(1024, 512), refCtx = ref.getContext('2d', {willReadFrequently: true});
      refCtx.setTransform(scale, 0, 0, scale, 0, 0);
      withVfx(refCtx, stack, paint, {
        bounds, domainBounds: bounds, scale: 1, cacheHint: 'fixture-items',
        outputRect: {x: 0, y: 0, width: 1024, height: 512},
      });
      refCtx.setTransform(1, 0, 0, 1, 0, 0);
      let max = 0;
      for (const [half, out] of outputs.entries()) {
        const expected = refCtx.getImageData(half * 512, 0, 512, 512).data;
        for (let i = 0; i < out.length; i++) max = Math.max(max, Math.abs(out[i] - expected[i]));
      }
      check(max === 0, `Cached tile composites diverge from the full-width render (max delta ${max}).`);
      check(hintCalls===2,'Each cached software render evaluates its current content once.');
      const before=calls;content='changed artwork';
      tileCtx.setTransform(scale,0,0,scale,-512,0);
      withVfx(tileCtx,stack,paint,{bounds,domainBounds:bounds,scale:1,cacheHint:hint,
        outputRect:{x:-512,y:0,width:1024,height:512}});
      check(calls===before+1,'Changing a lazy fingerprint invalidates the filtered region.');
      tile.width = tile.height = ref.width = ref.height = 1;
      return {cpuPasses: calls, filteredPixels: totalPixels, maxDelta: max};
    } finally {VfxCPU.prototype.runPixels = original;}
  });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({...result, errors}));
} finally {await browser?.close(); await service.stop();}
