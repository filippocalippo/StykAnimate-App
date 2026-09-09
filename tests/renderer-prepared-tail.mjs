/** Memory and pixel regression for the user's large Akane animation tail. */
import {chromium} from 'playwright';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
const root = process.cwd(), source = process.argv[2] || 'C:/Users/aleri/Downloads/16 Akane vs Akato Segundo round (3).piv';
const output = path.join(root, 'artifacts', 'renderer-prepared-tail'); await mkdir(output, {recursive: true});
const browser = await chromium.launch({channel: 'chrome', headless: true});
try {
  const page = await browser.newPage({viewport: {width: 1400, height: 950}}), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(process.env.STYK_URL || 'http://127.0.0.1:47831'); await page.waitForFunction(() => window.styk?.ready);
  await page.evaluate(() => styk.editor.markSaved()); await page.locator('#file-input').setInputFiles(source);
  await page.waitForFunction(name => !styk.state.importing && styk.editor.name === name, path.basename(source, '.piv'), {timeout: 180000});
  const results = await page.evaluate(async ({gpu128}) => {
    const {createRenderer, cameraMatrix} = await import('/src/renderer.mjs'), {PlaybackCache} = await import('/src/playback.mjs');
    const {buildGeometry, evaluatedFrame, timeline, drawGeometry} = await import('/src/pivot/geometry.mjs');
    const {drawBackground, backgroundBounds} = await import('/src/pivot/background.mjs');
    const report = styk.editor.report, entries = timeline(report), resources = styk.state.renderer.resources;
    const canvas = document.createElement('canvas'), uncroppedCanvas = document.createElement('canvas');
    const renderer = await createRenderer(canvas, {resources, ...(gpu128 ? {preparedCache: {maxBytes: 128 * 1024 * 1024}} : {})}), uncropped = await createRenderer(uncroppedCanvas, {resources});
    const playback = new PlaybackCache({maxFrames: 3}), rows = [];
    const pixelsFromPNG = async url => { const image = new Image(); image.src = url; await image.decode(); const surface = document.createElement('canvas'); surface.width = image.width; surface.height = image.height; const ctx = surface.getContext('2d'); ctx.drawImage(image, 0, 0); return ctx.getImageData(0, 0, surface.width, surface.height).data; };
    const difference = (a, b) => { let sum = 0, mismatch = 0, max = 0, changed = 0; for (let i = 0; i < a.length; i += 4) { let delta = 0; for (let c = 0; c < 4; c++) { const d = Math.abs(a[i + c] - b[i + c]); delta += d; max = Math.max(max, d); } sum += delta; if (delta) changed++; if (delta > 80) mismatch++; } return {mae: sum / a.length, mismatchPercent: mismatch / (a.length / 4) * 100, changedPixels: changed, maxChannel: max}; };
    try {
      for (const scale of [1, 2]) {
        const view = {x: 0, y: 0, scale}, width = Math.ceil(report.canvas_width * scale), height = Math.ceil(report.canvas_height * scale);
        renderer.resize(width, height, 1); uncropped.resize(width, height, 1); renderer.clearPreparedFrames();
        playback.load(report, {scale});
        for (const tick of [...Array.from({length: 13}, (_, i) => 1824 + i), 1838, 1871]) {
          let frameIndex = 0; for (let i = 0; i < entries.length; i++) if (entries[i].start <= tick) frameIndex = i;
          const frame = evaluatedFrame(report, frameIndex, (tick - entries[frameIndex].start) / entries[frameIndex].count), geometry = buildGeometry(report, frame);
          const images = []; for (const s of geometry.drawables) if (s.type === 'image' && s.asset) { const image = resources.image(resources.url(s.asset)); if (image) images.push(image); }
          await Promise.all(images.filter(image => !image.complete).map(image => image.decode()));
          await renderer.prepareBackgrounds(report, frame); await uncropped.prepareBackgrounds(report, frame);
          const start = performance.now(); await playback.prepareRange([tick]); const packet = playback.get(tick);
          if (!packet) throw new Error(`Packet ${tick} missing after preparation.`);
          const preparedMs = performance.now() - start; let key;
          try { key = renderer.prepareFrame(packet, {report, view}); }
          catch (error) { throw new Error(JSON.stringify({message: error.message, tick, scale, packetBytes: packet.byteLength, clipping: packet.clipping, textures: packet.compatibility.map(c => [c.uid, c.bitmap?.width, c.bitmap?.height, c.pixelScale])})); }
          if (!key || !renderer.renderPrepared(key, {report, view})) throw new Error(`Packet ${tick} did not fit the GPU cache or could not render.`);
          await renderer.device.queue.onSubmittedWorkDone(); const actualPNG = canvas.toDataURL('image/png'), gpuStats = structuredClone(renderer.stats);
          uncropped.render({report, frame, geometry, view}); await uncropped.device.queue.onSubmittedWorkDone(); const uncroppedPNG = uncroppedCanvas.toDataURL('image/png');
          const surface = document.createElement('canvas'); surface.width = width; surface.height = height; const ctx = surface.getContext('2d');
          ctx.beginPath(); ctx.rect(0, 0, width, height); ctx.clip(); ctx.transform(...cameraMatrix({report, frame, view}));
          drawBackground(ctx, report, frame, report.canvas_width, report.canvas_height, {...resources, bounds: backgroundBounds(frame, report.canvas_width, report.canvas_height)}); drawGeometry(ctx, geometry, resources);
          const actual = await pixelsFromPNG(actualPNG), original = await pixelsFromPNG(uncroppedPNG), native = ctx.getImageData(0, 0, width, height).data;
          rows.push({tick, frameIndex, scale, objects: frame.objects.length, preparedMs, packetBytes: packet.byteLength, clipping: packet.clipping, bitmapBytes: packet.compatibility.reduce((n, c) => n + (c.bitmap?.width || 0) * (c.bitmap?.height || 0) * 4, 0), compatibilityObjects: packet.compatibility.length,
            gpuStats, uncroppedGpuBytes: uncropped.stats.gpuBytes, differenceFromUncroppedGPU: difference(actual, original), differenceFromCanvas: difference(actual, native), uncroppedDifferenceFromCanvas: difference(original, native), actualPNG, uncroppedPNG, referencePNG: surface.toDataURL('image/png')});
        }
      }
    } finally {playback.dispose(); renderer.destroy(); uncropped.destroy();}
    return rows;
  }, {gpu128: process.argv.includes('--gpu128')});
  for (const row of results) for (const [field, suffix] of [['actualPNG', 'prepared'], ['uncroppedPNG', 'uncropped'], ['referencePNG', 'canvas']]) {
    await writeFile(path.join(output, `${row.tick}-${row.scale}x-${suffix}.png`), Buffer.from(row[field].split(',')[1], 'base64')); delete row[field];
  }
  await writeFile(path.join(output, 'report.json'), JSON.stringify({results, errors, limitation: 'All thirteen previously failing ticks plus two tail controls at two view scales on one NVIDIA GPU; compares cropped worker packets with uncropped GPU and established Canvas, not fresh native Pivot captures.'}, null, 2));
  console.log(JSON.stringify({results: results.map(({gpuStats, ...r}) => ({...r, frameGpuBytes: gpuStats.gpuBytes, cacheGpuBytes: gpuStats.preparedBytes, gpuWarnings: gpuStats.warnings})), errors}, null, 2));
  if (errors.length || results.some(r => r.gpuStats.warnings.length || r.differenceFromCanvas.mae > r.uncroppedDifferenceFromCanvas.mae + .5 || r.differenceFromCanvas.mismatchPercent > r.uncroppedDifferenceFromCanvas.mismatchPercent + .25 || r.differenceFromUncroppedGPU.mae > .5 || r.differenceFromUncroppedGPU.mismatchPercent > .25)) throw new Error('Prepared tail memory or pixel regression; inspect report and captures.');
} finally {await browser.close();}
