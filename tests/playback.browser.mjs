import { chromium } from 'playwright';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url), appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { startBackend } = require('../desktop/backend.cjs');
const backend = await startBackend({ appRoot }); let browser;
try {
  try { browser = await chromium.launch({ headless: true }); }
  catch { browser = await chromium.launch({ channel: 'chrome', headless: true }); }
  const page = await browser.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${backend.origin}/api/health`);
  const result = await page.evaluate(async () => {
    const { PlaybackCache } = await import('/src/playback.mjs');
    const { defaultFigure, createObject, createFrame, emptyDocument } = await import('/src/demo.mjs');
    const { createImageFigure } = await import('/src/media-authoring.mjs');
    const { buildGeometry, drawGeometry } = await import('/src/pivot/geometry.mjs');
    const { objectBounds } = await import('/src/renderer-geometry.mjs');
    const assert = (value, message) => { if (!value) throw new Error(message); };
    const quantiles = values => { const sorted = [...values].sort((a, b) => a - b); return { count: sorted.length, p50: sorted[Math.floor(sorted.length * .5)] || 0, p95: sorted[Math.floor(sorted.length * .95)] || 0, max: sorted.at(-1) || 0 }; };
    const report = emptyDocument(), figure = defaultFigure(); report.figure_types = [figure];
    report.keyframes = Array.from({ length: 24 }, (_, frameIndex) => createFrame(Array.from({ length: 1000 }, (_, i) => {
      const object = createObject(figure, i + 1, 25 + i % 40 * 23, 18 + Math.floor(i / 40) * 20, { scale: .055 });
      const phase = frameIndex / 24 * Math.PI * 2; object.root_x += Math.sin(phase + i * .08) * 2;
      object.angles[6] += Math.sin(phase) * .2; object.angles[8] -= Math.sin(phase) * .2; return object;
    })));
    const compiler = [], rafIntervals = []; let measuring = true, prior;
    const raf = now => { if (prior !== undefined) rafIntervals.push(now - prior); prior = now; if (measuring) requestAnimationFrame(raf); }; requestAnimationFrame(raf);
    const cache = new PlaybackCache({ onReady: packet => compiler.push(packet.compileMs) });
    let performanceResult;
    try {
      const started = performance.now(); cache.load(report); const cloned = performance.now();
      await cache.prepareRange(Array.from({ length: 24 }, (_, tick) => tick)); const prepared = performance.now();
      const readMs = [];
      for (let i = 0; i < 300; i++) { const start = performance.now(); for (let tick = 0; tick < 24; tick++) assert(cache.get(tick), `Missing exact tick ${tick}.`); readMs.push((performance.now() - start) / 24); }
      performanceResult = { scene: { figures: 1000, keyframes: 24, fps: 24 }, initialSnapshotMs: cloned - started, prepare24TicksMs: prepared - cloned,
        snapshotLoadMs: cache.stats.loadMs, snapshotSerializationMs: cache.stats.loadSerializationMs, largestSnapshotTaskMs: cache.stats.loadMaxTaskMs, snapshotChunks: cache.stats.loadChunks,
        workerCompileMs: quantiles(compiler), mainPacketLookupMs: quantiles(readMs), preparationRafIntervalMs: quantiles(rafIntervals), bytes: cache.stats.bytes,
        limitBytes: cache.maxBytes, packetCount: cache.stats.readyFrames, mainThreadSceneEvaluations: 0 };
      const priorChunks = cache.stats.loadChunks, viewStarted = performance.now(); cache.updateView({ scale: 1.49 });
      const viewReturnMs = performance.now() - viewStarted; await cache.prepareRange([0]);
      assert(cache.stats.loadChunks === priorChunks, 'Changing zoom retransmitted the unchanged document.');
      performanceResult.viewUpdate = { returnMs: viewReturnMs, readyMs: performance.now() - viewStarted,
        documentChunksTransferred: cache.stats.loadChunks - priorChunks, scale: cache.get(0).scale };
    } finally { measuring = false; cache.dispose(); }

    // Real worker OffscreenCanvas sprite decode + native transparency isolation.
    const source = new OffscreenCanvas(4, 4), sourceCtx = source.getContext('2d');
    sourceCtx.fillStyle = '#8054e7'; sourceCtx.fillRect(0, 0, 4, 4); sourceCtx.fillStyle = '#f4b252'; sourceCtx.fillRect(2, 1, 2, 2);
    const blob = await source.convertToBlob({ type: 'image/png' });
    const dataURL = await new Promise(resolve => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.readAsDataURL(blob); });
    const sprite = createImageFigure({ dataUrl: dataURL, width: 4, height: 4, name: 'Worker sprite' }); sprite.figure_type_id = 7;
    const mediaReport = emptyDocument(); mediaReport.figure_types = [sprite]; mediaReport.keyframes = [createFrame([createObject(sprite, 82, 240, 220, { scale: 8, field28: 71 })])];
    const media = new PlaybackCache();
    let mediaResult;
    try {
      media.load(mediaReport); await media.prepareRange([0]); const packet = media.get(0), item = packet.compatibility[0];
      assert(item?.bitmap instanceof ImageBitmap, 'Worker did not transfer a raster ImageBitmap.');
      assert(!item.items && !item.g, 'Worker transferred a full compatibility scene graph.');
      const expected = new OffscreenCanvas(item.bitmap.width, item.bitmap.height), ctx = expected.getContext('2d');
      const image = new Image(); image.src = dataURL; await image.decode();
      ctx.setTransform(item.resolution, 0, 0, item.resolution, -item.bounds.x * item.resolution, -item.bounds.y * item.resolution);
      drawGeometry(ctx, buildGeometry(mediaReport, mediaReport.keyframes[0]), { url: asset => asset.data_url, image: () => image });
      const actual = new OffscreenCanvas(item.bitmap.width, item.bitmap.height), actualCtx = actual.getContext('2d'); actualCtx.drawImage(item.bitmap, 0, 0);
      const a = actualCtx.getImageData(0, 0, actual.width, actual.height).data, b = ctx.getImageData(0, 0, expected.width, expected.height).data;
      let different = 0, visible = 0; for (let i = 0; i < a.length; i++) { if (a[i] !== b[i]) different++; if (i % 4 === 3 && a[i]) visible++; }
      assert(visible > 0, 'Worker sprite raster is empty.'); assert(different === 0, `Worker sprite raster differs from native reference in ${different} channels.`);
      mediaResult = { transferredBitmap: true, width: actual.width, height: actual.height, referenceDifferingChannels: different, visiblePixels: visible };
      const oldRevision = packet.revision, priorChunks = media.stats.loadChunks; media.updateView({ scale: 2 }); await media.prepareRange([0]);
      assert(media.get(0).revision !== oldRevision && media.get(0).compatibility[0].resolution === 2, 'Zoom invalidation reused stale media.');
      assert(media.stats.loadChunks === priorChunks, 'Zoom invalidation retransmitted media document data.');
    } finally { media.dispose(); }
    // These four visible translucent sprites required over 128 MB before stage
    // cropping. Every retained pixel must equal its original uncropped raster.
    const cropReport = emptyDocument(); cropReport.figure_types = [sprite];
    const cropFrame = createFrame(Array.from({ length: 4 }, (_, i) => createObject(sprite, 100 + i, -250 + i * 10, -180 + i * 10, { scale: 400, field28: 71 })));
    cropFrame.camera = { x: 70, y: -40, angle_rad: .23, scale: 1.2 }; cropReport.keyframes = [cropFrame];
    const croppedCache = new PlaybackCache(), cropImage = new Image(); cropImage.src = dataURL; await cropImage.decode();
    const cropResources = { url: asset => asset.data_url, image: () => cropImage };
    let clippingResult;
    try {
      croppedCache.load(cropReport, { scale: 2 }); await croppedCache.prepareRange([0]);
      const packet = croppedCache.get(0), geometry = buildGeometry(cropReport, cropFrame);
      assert(packet.clipping.originalPixels * 4 > croppedCache.maxBytes, 'Fixture no longer exercises the original frame memory overflow.');
      assert(packet.byteLength < 96 * 1024 * 1024, 'Cropped packet exceeds the GPU memory budget.');
      let different = 0, checkedPixels = 0;
      for (const entry of packet.compatibility) {
        const group = packet.groups.find(group => group.uid === entry.uid), items = geometry.drawables.filter(item => item.slot === group.slot);
        const bounds = objectBounds(items, cropResources), ratio = entry.pixelScale;
        const full = new OffscreenCanvas(Math.ceil(bounds.width * ratio), Math.ceil(bounds.height * ratio)), ctx = full.getContext('2d', { willReadFrequently: true });
        ctx.setTransform(ratio, 0, 0, ratio, -bounds.x * ratio, -bounds.y * ratio); drawGeometry(ctx, { drawables: items }, cropResources);
        const offsetX = Math.round((entry.bounds.x - bounds.x) * ratio), offsetY = Math.round((entry.bounds.y - bounds.y) * ratio);
        const expected = ctx.getImageData(offsetX, offsetY, entry.bitmap.width, entry.bitmap.height).data;
        const surface = new OffscreenCanvas(entry.bitmap.width, entry.bitmap.height), actualCtx = surface.getContext('2d'); actualCtx.drawImage(entry.bitmap, 0, 0);
        const actual = actualCtx.getImageData(0, 0, surface.width, surface.height).data;
        for (let i = 0; i < actual.length; i++) if (actual[i] !== expected[i]) different++;
        checkedPixels += actual.length / 4;
      }
      assert(different === 0, `Stage cropping changed ${different} native raster channels.`);
      clippingResult = { ...packet.clipping, bytes: packet.byteLength, checkedPixels, differingChannels: different };
    } finally { croppedCache.dispose(); }
    return { performance: performanceResult, media: mediaResult, clipping: clippingResult, measuredAt: new Date().toISOString(), limitation: 'Worker preparation and cache lookup only. GPU rendering and display presentation are measured separately by renderer-ui-performance.mjs.' };
  });
  if (errors.length) throw new Error(errors.join('\n'));
  await mkdir(path.join(appRoot, 'artifacts'), { recursive: true });
  await writeFile(path.join(appRoot, 'artifacts', 'playback-worker-performance.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally { await browser?.close(); backend.stop(); }
