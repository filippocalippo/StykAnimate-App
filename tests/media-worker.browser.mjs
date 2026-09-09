import { chromium } from 'playwright';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import backendService from '../desktop/backend.cjs';

const root = path.resolve(import.meta.dirname, '..'), output = path.join(root, 'artifacts', 'media-worker');
await mkdir(output, { recursive: true });
const backend = await backendService.startBackend({ appRoot: root });
let browser;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1200, height: 820 }, acceptDownloads: true });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${backend.origin}/api/health`);
  const result = await page.evaluate(async () => {
    const { imageFileToFigure: rawFigure, imageFileToBackground: rawBackground } = await import('/src/media-authoring.mjs');
    const { GIFEncoder } = await import('/src/image-codecs.mjs');
    const checks = [], fixtures = [], assert = (value, message) => { if (!value) throw new Error(message); checks.push(message); };
    const width = 8, height = 6, rgba = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < rgba.length; i += 4) rgba.set([0, 255, 0, 255], i);
    for (let y = 1; y < 5; y++) for (let x = 2; x < 6; x++) rgba.set([240, 30, 20, 255], (y * width + x) * 4);
    const canvas = new OffscreenCanvas(width, height), context = canvas.getContext('2d');
    const encoded = async (type, data = rgba) => { context.putImageData(new ImageData(data, width, height), 0, 0); return canvas.convertToBlob({ type, quality: 1 }); };
    const png = await encoded('image/png');
    const bitmap = () => {
      const stride = (width * 3 + 3) & ~3, bytes = new Uint8Array(54 + stride * height), view = new DataView(bytes.buffer);
      bytes.set([66, 77]); view.setUint32(2, bytes.length, true); view.setUint32(10, 54, true); view.setUint32(14, 40, true);
      view.setInt32(18, width, true); view.setInt32(22, height, true); view.setUint16(26, 1, true); view.setUint16(28, 24, true);
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const source = (y * width + x) * 4, destination = 54 + (height - 1 - y) * stride + x * 3;
        bytes.set([rgba[source + 2], rgba[source + 1], rgba[source]], destination);
      }
      return new Blob([bytes], { type: 'image/bmp' });
    };
    const gif = data => { const encoder = new GIFEncoder({ width, height, fps: 16, totalFrames: 1, maxBytes: 100000, loop: false }); encoder.add(data); return encoder.finish(); };
    const sources = [
      ['Native PNG.png', png], ['Native BMP.bmp', bitmap()], ['Native GIF.gif', gif(rgba)],
      ['Extra JPEG.jpg', await encoded('image/jpeg')], ['Extra WebP.webp', await encoded('image/webp')],
    ];
    const pixels = async url => {
      const image = await createImageBitmap(await (await fetch(url)).blob());
      context.clearRect(0, 0, width, height); context.drawImage(image, 0, 0); image.close();
      return context.getImageData(0, 0, width, height).data;
    };
    let mainScans = 0, activeImports = 0;
    const watching = async (method, args) => { activeImports++; try { return await method(...args); } finally { activeImports--; } };
    const imageFileToFigure = (...args) => watching(rawFigure, args), imageFileToBackground = (...args) => watching(rawBackground, args);
    const prototypes = [CanvasRenderingContext2D.prototype, Object.getPrototypeOf(context)];
    const originals = prototypes.map(prototype => prototype.getImageData);
    prototypes.forEach((prototype, index) => { prototype.getImageData = function (...args) { if (activeImports) mainScans++; return originals[index].apply(this, args); }; });
    try {
      for (const [name, source] of sources) {
        const file = new File([source], name, { type: source.type }), native = /\.(png|bmp|gif)$/.test(name);
        const figure = await imageFileToFigure(file), data = await pixels(figure.image_assets[0].data_url);
        assert(data[(height - 1) * width * 4 + 3] === (native ? 0 : 255), `${name}: automatic transparency matches the actual source format`);
        assert(data[(2 * width + 3) * 4 + 3] === 255, `${name}: figure interior remains opaque`);
        const background = await imageFileToBackground(file), backgroundPixels = await pixels(background.data_url);
        assert(backgroundPixels[(height - 1) * width * 4 + 3] === 255, `${name}: background import preserves opaque pixels`);
        fixtures.push({ name, mimeType: source.type, bytes: [...new Uint8Array(await source.arrayBuffer())] });
      }
      const preserved = await imageFileToFigure(new File([png], 'Keep.png', { type: 'image/png' }), { preserveOpaqueBackground: true });
      assert((await pixels(preserved.image_assets[0].data_url))[(height - 1) * width * 4 + 3] === 255, 'Explicit preserveOpaqueBackground keeps native-format backgrounds');
      const withAlpha = rgba.slice(); withAlpha[(2 * width + 3) * 4 + 3] = 128;
      const alphaPNG = await encoded('image/png', withAlpha);
      const figure = await imageFileToFigure(new File([alphaPNG], 'Alpha.png', { type: 'image/png' })), alphaPixels = await pixels(figure.image_assets[0].data_url);
      assert(alphaPixels[(2 * width + 3) * 4 + 3] === 128 && alphaPixels[(height - 1) * width * 4 + 3] === 255, 'Existing partial PNG alpha wins over color key and preserves matching opaque green');
      const transparent = rgba.slice(); transparent[3] = 0;
      const alphaGIF = gif(transparent), gifFigure = await imageFileToFigure(new File([alphaGIF], 'Alpha.gif', { type: 'image/gif' })), gifPixels = await pixels(gifFigure.image_assets[0].data_url);
      assert(gifPixels[3] === 0 && gifPixels[(height - 1) * width * 4 + 3] === 255, 'Existing GIF transparency wins over color key');
      const disguised = await imageFileToFigure(new File([sources[3][1]], 'Disguised.png', { type: 'image/png' }));
      assert((await pixels(disguised.image_assets[0].data_url))[(height - 1) * width * 4 + 3] === 255, 'Source bytes determine JPEG preservation even when extension and MIME claim PNG');
      let failure;
      try { await imageFileToFigure(new File(['broken'], 'Broken.png', { type: 'image/png' })); } catch (error) { failure = error; }
      assert(Boolean(failure), 'Damaged image fails before an authored asset is returned');
      failure = null; try { await imageFileToFigure(new File([png], 'TooLarge.png', { type: 'image/png' }), { maxPixels: 3 }); } catch (error) { failure = error; }
      assert(failure?.message.includes('dimensions'), 'Native image header rejects excessive dimensions before raster allocation');
      const abort = new AbortController(), pending = imageFileToFigure(new File([png], 'Cancel.png', { type: 'image/png' }), { signal: abort.signal }); abort.abort();
      failure = null; try { await pending; } catch (error) { failure = error; }
      assert(failure?.name === 'AbortError', 'In-flight image decoding can be cancelled');
      const retry = await imageFileToFigure(new File([png], 'Retry.png', { type: 'image/png' }));
      assert(retry.image_assets[0].width === width, 'Image importing remains usable after cancellation and failure');
      assert(mainScans === 0, 'Native image decoding and color-key scans do not call main-thread Canvas pixel reads');
    } finally { prototypes.forEach((prototype, index) => { prototype.getImageData = originals[index]; }); }
    return { checks, fixtures, width, height, mainScans };
  });
  for (const fixture of result.fixtures) await writeFile(path.join(output, fixture.name), Uint8Array.from(fixture.bytes));
  await page.goto(backend.origin);
  await page.waitForFunction(() => window.styk?.ready, undefined, { timeout: 30000 });
  await page.evaluate(async () => { const { emptyDocument } = await import('/src/demo.mjs'); window.styk.editor.load(emptyDocument()); window.styk.editor.markSaved(); });
  for (const [index, fixture] of result.fixtures.slice(0, 3).entries()) {
    const before = await page.evaluate(() => window.styk.editor.report.figure_types.length);
    await page.locator('#media-input').evaluate(input => { input.dataset.mode = 'sprite'; });
    await page.locator('#media-input').setInputFiles({ name: fixture.name, mimeType: fixture.mimeType, buffer: Buffer.from(fixture.bytes) });
    await page.waitForFunction(before => window.styk.editor.report.figure_types.length === before + 1, before);
    await page.evaluate(index => window.styk.editor.updateObject({ root_x: 100 + index * 180, root_y: 170, scale: 14 }), index);
  }
  const imported = await page.evaluate(async () => {
    const objects = window.styk.editor.report.figure_types.filter(figure => figure.image_assets?.length), result = [];
    for (const figure of objects) {
      const image = new Image(); image.src = figure.image_assets[0].data_url; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = 8; canvas.height = 6;
      const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
      result.push({ name: figure.name, keyAlpha: ctx.getImageData(0, 5, 1, 1).data[3], url: figure.image_assets[0].data_url });
    }
    return result;
  });
  assert.equal(imported.length, 3); assert.ok(imported.every(item => item.keyAlpha === 0));
  result.checks.push('Actual PNG/BMP/GIF file-input imports use the native automatic key without extra user prompts');
  const outputs = {};
  for (const format of ['piv', 'stk']) {
    await page.locator('[data-action="export"]').first().click();
    const downloadPromise = page.waitForEvent('download');
    await page.locator(`[data-action="export-${format}"]`).click();
    const download = await downloadPromise, filename = path.join(output, `native-sprites.${format}`); await download.saveAs(filename);
    await page.waitForFunction(() => !document.querySelector('#dialog').open);
    const bytes = await readFile(filename);
    const restored = await page.evaluate(async ({ bytes, format }) => {
      const response = await fetch(`/api/import?filename=native-sprites.${format}`, { method: 'POST', body: Uint8Array.from(bytes), headers: { 'Content-Type': 'application/octet-stream' } });
      if (!response.ok) throw new Error(await response.text()); return (await response.json()).document;
    }, { bytes: [...bytes], format });
    const assets = restored.figure_types.flatMap(figure => figure.image_assets || []);
    assert.equal(assets.length, format === 'piv' ? 3 : 1);
    assert.ok(assets.every(asset => imported.some(source => source.url === asset.data_url)));
    outputs[format] = { bytes: bytes.length, imageAssets: assets.length };
    result.checks.push(`Actual ${format.toUpperCase()} Export and native decoder preserve normalized sprite PNG bytes and transparency`);
  }
  await page.screenshot({ path: path.join(output, 'imported-sprites.png') });
  await page.evaluate(() => {
    globalThis.__delayMedia = true; globalThis.__delayedMediaWorkers = [];
    const NativeWorker = globalThis.Worker;
    globalThis.Worker = class extends NativeWorker {
      constructor(url, options) {
        super(url, options);
        if (String(url).includes('media-image-worker.mjs')) {
          this.record = { pending: false, posted: false, terminated: false, clearedDelay: false };
          globalThis.__delayedMediaWorkers.push(this.record);
        }
      }
      postMessage(data, ...rest) {
        if (this.record && globalThis.__delayMedia) {
          this.record.pending = true;
          this.timer = setTimeout(() => { this.record.pending = false; this.record.posted = true; super.postMessage(data, ...rest); }, 2000);
          return;
        }
        if (this.record) this.record.posted = true;
        return super.postMessage(data, ...rest);
      }
      terminate() {
        if (this.record) {
          this.record.terminated = true;
          if (this.timer) { clearTimeout(this.timer); this.record.clearedDelay = true; this.record.pending = false; }
        }
        return super.terminate();
      }
    };
    window.styk.editor.markSaved(); window.__beforeMediaDocument = window.styk.editor.report;
  });
  const delayedFixture = { name: result.fixtures[0].name, mimeType: result.fixtures[0].mimeType, buffer: Buffer.from(result.fixtures[0].bytes) };
  await page.locator('#media-input').setInputFiles(delayedFixture);
  await page.waitForFunction(() => globalThis.__delayedMediaWorkers.at(-1)?.pending);
  await page.locator('[data-action="menu"]').click(); await page.locator('[data-action="new"]').click();
  await page.waitForFunction(() => window.styk.editor.report !== window.__beforeMediaDocument && globalThis.__delayedMediaWorkers.at(-1)?.terminated);
  const afterNew = await page.evaluate(() => ({ images: window.styk.editor.report.figure_types.filter(figure => figure.image_assets?.length).length, worker: globalThis.__delayedMediaWorkers.at(-1) }));
  assert.equal(afterNew.images, 0); assert.equal(afterNew.worker.posted, false); assert.equal(afterNew.worker.clearedDelay, true);
  result.checks.push('Actual New cancels deferred media-input decoding, clears its timer and leaves no image in the replacement document');
  await page.evaluate(() => { globalThis.__delayMedia = false; });
  await page.locator('#media-input').setInputFiles(delayedFixture);
  await page.waitForFunction(() => window.styk.editor.report.figure_types.filter(figure => figure.image_assets?.length).length === 1);
  result.checks.push('The same image can be selected again immediately after document-replacement cancellation');
  await page.evaluate(() => { window.styk.editor.markSaved(); window.__beforeMediaDocument = window.styk.editor.report; globalThis.__delayMedia = true; });
  await page.locator('#file-input').setInputFiles(delayedFixture);
  await page.waitForFunction(() => globalThis.__delayedMediaWorkers.at(-1)?.pending);
  await page.locator('#file-input').setInputFiles(path.join(output, 'native-sprites.piv'));
  await page.waitForFunction(() => window.styk.editor.report !== window.__beforeMediaDocument && globalThis.__delayedMediaWorkers.at(-1)?.terminated);
  const afterOpen = await page.evaluate(() => ({ images: window.styk.editor.report.figure_types.filter(figure => figure.image_assets?.length).length, worker: globalThis.__delayedMediaWorkers.at(-1) }));
  assert.equal(afterOpen.images, 3); assert.equal(afterOpen.worker.posted, false); assert.equal(afterOpen.worker.clearedDelay, true);
  result.checks.push('Actual PIV Open cancels deferred file-input image decoding without adding it to the reopened document');
  result.documentReplacement = { afterNew, afterOpen };
  assert.deepEqual(errors, []);
  delete result.fixtures; result.outputs = outputs; result.errors = errors;
  await writeFile(path.join(output, 'report.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ checks: result.checks.length, errors }));
} finally { await browser?.close(); backend.stop(); }
