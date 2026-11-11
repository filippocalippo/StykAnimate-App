/** Image decoding must not need the geometry/rendering engine to start. */
import assert from 'node:assert/strict';
import {chromium} from './support/playwright.mjs';
import {createRequire} from 'node:module';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {previewPNG} from './preview-png-fixture.mjs';

const root = path.resolve('.'), output = path.join(root, 'artifacts/image-resources');
await mkdir(output, {recursive: true});
await writeFile(path.join(output, 'fixture.html'), '<!doctype html><title>Image resources</title>');
const source = `data:image/png;base64,${(await previewPNG(32, 16)).toString('base64')}`;
const {startDesktopHost} = createRequire(import.meta.url)('../desktop/web-host.cjs');
const backend = await startDesktopHost({appRoot: root}); let browser;
try {
  browser = await chromium.launch({channel: 'chrome', headless: true});
  const context = await browser.newContext(), blocked = [];
  await context.route('**/src/pivot/geometry.mjs', route => {
    blocked.push(new URL(route.request().url()).pathname); return route.abort();
  });
  const page = await context.newPage(); page.setDefaultTimeout(20000);
  await page.goto(`${backend.origin}/artifacts/image-resources/fixture.html`);
  const result = await page.evaluate(async source => {
    const {PreviewImages} = await import('/src/preview-images.mjs');
    const notifications=[];
    const images = new PreviewImages({maxBytes: 4096,onReady:value=>notifications.push(value)});
    const item = {type: 'image', asset: {url: source}};
    const read = image => {
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
      return Array.from(ctx.getImageData(0, 0, canvas.width, canvas.height).data);
    };
    try {
      // Cancellation before worker readiness must release its pending request.
      const first = images.prepare([item]);
      const cancelled = first.then(() => false, error => error.name === 'AbortError');
      images.clear();
      if (!await cancelled) throw new Error('The cancelled decode resolved successfully.');
      await images.prepare([item], {maxDimension: 8});
      const small = images.get(source), pixels = read(small);
      const smallSize = [small.width, small.height, small.naturalWidth, small.naturalHeight];
      const worker = images.worker;
      await images.prepare([item], {maxDimension: 8});
      if (images.worker !== worker || images.get(source) !== small) throw new Error('Unchanged decoding did not retain its result.');
      // Different request signature, same actual decoded worker bitmap. This
      // must exercise a response, not just the main-thread signature shortcut.
      const sequence=images.sequence;
      await images.prepare([item,item], {maxDimension: 8});
      if(images.sequence!==sequence+1||images.get(source)!==small||notifications.at(-1).unchanged!==true)
        throw new Error('An identical transferred variant replaced the consumer bitmap.');
      if(JSON.stringify(read(small))!==JSON.stringify(pixels))throw new Error('Retained variant pixels changed.');
      await images.prepare([item], {maxDimension: 32});
      const full = images.get(source), fullPixels = read(full);
      if(full===small||notifications.at(-1).unchanged||!notifications.at(-1).resized)
        throw new Error('A higher-resolution decode did not invalidate old pixels.');
      if (images.bytes > images.maxBytes) throw new Error('Image residency exceeded its allowance.');
      return {cancelled: true, smallSize, pixels, fullSize: [full.width, full.height], fullPixels,
        timings: images.lastPreparation, retainedBytes: images.bytes, notifications};
    } finally {images.clear();}
  }, source);
  assert.deepEqual(blocked, [], 'image-only work attempted to load scene geometry');
  assert.deepEqual(result.smallSize, [8, 4, 32, 16]);
  assert.deepEqual(result.fullSize, [32, 16]);
  for (const [pixels, width, height] of [[result.pixels, 8, 4], [result.fullPixels, 32, 16]])
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++)
      assert.deepEqual(pixels.slice((y * width + x) * 4, (y * width + x + 1) * 4), x < width / 2 ? [230, 70, 90, 255] : [35, 180, 90, 255]);
  delete result.pixels; delete result.fullPixels;
  await writeFile(path.join(output, 'report.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {await browser?.close(); backend.stop();}
