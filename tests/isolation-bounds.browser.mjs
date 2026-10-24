import {chromium} from './support/playwright.mjs';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
const {startDesktopHost} = createRequire(import.meta.url)('../desktop/web-host.cjs');
const backend = await startDesktopHost({appRoot:process.cwd()}); let browser;
try {
  browser = await chromium.launch({channel:'chrome', headless:true});
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${backend.origin}/tests/fixtures/blank.html`);
  const result = await page.evaluate(async () => {
    const {drawGeometry} = await import('/src/pivot/geometry.mjs');
    const fig = {segment_decode:{global_style:{u28:0}}}, outlined = {segment_decode:{global_style:{u28:new Uint32Array(new Float32Array([2.5]).buffer)[0],u30:40,rgb:[20,20,20]}}};
    const line = (slot, opacity, x, y, dx, dy, width, kind = 'line', figure = fig) => ({type:'line', slot, opacity, alpha:1, rgb:[35 + slot * 60, 100, 220 - slot * 50],
      start:{x,y}, end:{x:x+dx,y:y+dy}, points:[{x,y},{x:x+dx,y:y+dy}], thickness:width, length:Math.hypot(dx,dy), seg:{segment_kind:kind}, obj:{scale:1}, fig:figure});
    const circle = (slot, opacity, x, y, length, width, kind) => ({...line(slot, opacity, x, y, length, 0, width, 'line'), type:'circle', seg:{segment_kind:kind}});
    // Thick square caps at 45 degrees reach beyond half-width padding; groups
    // overlap so a stale scratch region from one layer would show in the next.
    const groups = [
      [line(0,.5,40,40,60,60,28,'squareLine'), line(0,.5,40,100,60,-60,22,'squareLine'), line(0,.5,70,70,0,5,40), circle(0,.5,90,90,30,6,'circle')],
      [line(1,.4,20,150,130,-20,18,'squareLine'), circle(1,.4,120,40,24,0,'circleFill'), line(1,.4,125,40,-50,50,9)],
      [line(2,.6,60,60,40,-8,12,'line',outlined), line(2,.6,100,52,-4,40,12,'line',outlined)],
      [line(3,.7,-40,-30,20,15,30,'squareLine'), line(3,.7,190,190,40,40,30,'squareLine')],
    ];
    const cases = [];
    for (const [scale, angle] of [[.5,0],[1,0],[2,0],[1.5,.35],[.75,-1.1]]) {
      const size = 180, transform = ctx => { ctx.setTransform(1,0,0,1,0,0); ctx.translate(size / 2, size / 2); ctx.rotate(angle); ctx.scale(scale, scale); ctx.translate(-90, -90); };
      const surface = () => { const canvas = new OffscreenCanvas(size, size), ctx = canvas.getContext('2d', {willReadFrequently:true}); ctx.fillStyle = '#f4efe6'; ctx.fillRect(0, 0, size, size); transform(ctx); return ctx; };
      const actual = surface(); drawGeometry(actual, {drawables:groups.flat()});
      // The original algorithm: each translucent group drawn opaque on a cleared
      // whole-canvas layer, then composited at its opacity.
      const expected = surface();
      for (const group of groups) {
        const layer = new OffscreenCanvas(size, size), ctx = layer.getContext('2d', {willReadFrequently:true}); ctx.setTransform(expected.getTransform());
        drawGeometry(ctx, {drawables:group.map(item => ({...item, opacity:1}))});
        expected.save(); expected.setTransform(1,0,0,1,0,0); expected.globalAlpha = group[0].opacity; expected.imageSmoothingEnabled = false; expected.drawImage(layer, 0, 0); expected.restore();
      }
      const a = actual.getImageData(0, 0, size, size).data, b = expected.getImageData(0, 0, size, size).data;
      let differing = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) differing++;
      cases.push({scale, angle, differing});
    }
    return cases;
  });
  assert.deepEqual(errors, []);
  for (const entry of result) assert.equal(entry.differing, 0, `Bounded isolation changed pixels at scale ${entry.scale}, angle ${entry.angle}.`);
  console.log(JSON.stringify(result));
} finally { await browser?.close(); backend.stop(); }
