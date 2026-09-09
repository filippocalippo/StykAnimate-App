import { chromium } from 'playwright';
import { createRequire } from 'node:module';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), require = createRequire(import.meta.url);
const { startBackend } = require('../desktop/backend.cjs'); const backend = await startBackend({ appRoot }); let browser;
const source = process.argv[2] || 'C:/Users/aleri/Downloads/16 Akane vs Akato Segundo round (3).piv';
try {
  try { browser = await chromium.launch({ headless: true }); } catch { browser = await chromium.launch({ channel: 'chrome', headless: true }); }
  const page = await browser.newPage(); await page.goto(`${backend.origin}/api/health`);
  await page.evaluate(() => { document.body.innerHTML = '<input id="source" type="file">'; });
  await page.locator('#source').setInputFiles(source);
  const result = await page.evaluate(async () => {
    const { ImportClient } = await import('/src/import-client.mjs'), { PlaybackCache } = await import('/src/playback.mjs');
    const quantiles = values => { const sorted = [...values].sort((a, b) => a - b); return { count: values.length, p50: sorted[Math.floor(sorted.length * .5)] || 0, p95: sorted[Math.floor(sorted.length * .95)] || 0, max: sorted.at(-1) || 0 }; };
    let stage = 'import'; const longTasks = [], failures = [], frames = [], gaps = []; let last = performance.now();
    const timer = setInterval(() => { const now = performance.now(); gaps.push({ stage, ms: now - last }); last = now; }, 5);
    const observer = new PerformanceObserver(list => { for (const entry of list.getEntries()) longTasks.push({ stage, ms: entry.duration }); }); observer.observe({ type: 'longtask' });
    const importer = new ImportClient(), cache = new PlaybackCache({ onError: error => failures.push(error.message), onReady: packet => frames.push({ tick: packet.tick,
      compileMs: packet.compileMs, timings: packet.timings, bytes: packet.byteLength, primitives: packet.shapeCount, objects: packet.objectCount, bitmaps: packet.compatibility.length }) });
    try {
      const start = performance.now(), result = await importer.importFile(document.querySelector('#source').files[0]);
      const importedAt = performance.now(), report = result.document;
      let objectCount = 0, segments = 0, maxFigureSegments = 0, spriteAssets = 0, textAssets = 0, maxFrameObjects = 0;
      for (const figure of report.figure_types) { segments += figure.segments.length; maxFigureSegments = Math.max(maxFigureSegments, figure.segments.length); spriteAssets += figure.image_assets?.length || 0; textAssets += figure.text_assets?.length || 0; }
      for (const frame of report.keyframes) { objectCount += frame.objects.length; maxFrameObjects = Math.max(maxFrameObjects, frame.objects.length); }
      stage = 'snapshot'; cache.load(report, { scale: 1 }); const loadReturnMs = performance.now() - importedAt;
      const ready = cache.prepareRange([0]); await ready; const firstReadyAt = performance.now();
      const initialSnapshotStats = { ...cache.stats };
      stage = 'frame-delta'; const frame = report.keyframes[0], selected = frame.objects.find(object => !object.join), originalX = selected.root_x;
      selected.root_x += .25; const deltaStart = performance.now(); cache.updateFrame(0, frame, { revision: 2 });
      const deltaReturnMs = performance.now() - deltaStart; await cache.prepareRange([0]);
      const deltaPacket = cache.get(0), selectedGroup = deltaPacket.groups.find(group => group.uid === selected.unique_id);
      if (selectedGroup && deltaPacket.transforms[selectedGroup.transformIndex * 4] !== Math.fround(originalX + .25)) throw new Error('Delta snapshot lost the edited native root.');
      const delta = { returnMs: deltaReturnMs, readyMs: performance.now() - deltaStart, stats: { ...cache.stats }, editedRootVerified: true };
      const requestedTicks = Array.from({ length: Math.min(24, cache.totalTicks) }, (_, tick) => tick);
      stage = 'prepare-ahead'; await cache.prepareRange(requestedTicks, { replacePending: true }); const preparedAt = performance.now();
      stage = 'lookup'; const retainedTicks = requestedTicks.filter(tick => cache.has(tick)); await new Promise(resolve => setTimeout(resolve, 30));
      return { filename: result.filename, importMs: importedAt - start, importTimings: result.timings,
        scene: { figureTypes: report.figure_types.length, keyframes: report.keyframes.length, totalTicks: cache.totalTicks, fps: report.fps, objectCount, segments, maxFigureSegments, spriteAssets, textAssets, maxFrameObjects },
        loadReturnMs, firstReadyMs: firstReadyAt - importedAt, initialSnapshotStats, delta, ahead24Ms: preparedAt - firstReadyAt, stats: { ...cache.stats }, frames,
        requestedTicks, retainedTicks, allPreparedTicksRetained: retainedTicks.length === requestedTicks.length, currentAndNextRetained: cache.has(0) && cache.has(1),
        timerGaps: Object.fromEntries(['import', 'snapshot', 'frame-delta', 'prepare-ahead', 'lookup'].map(name => [name, quantiles(gaps.filter(gap => gap.stage === name).map(gap => gap.ms))])), longTasks, failures,
        memory: performance.memory ? { usedJSHeapSize: performance.memory.usedJSHeapSize, totalJSHeapSize: performance.memory.totalJSHeapSize, jsHeapSizeLimit: performance.memory.jsHeapSizeLimit } : null };
    } finally { importer.dispose(); cache.dispose(); clearInterval(timer); observer.disconnect(); }
  });
  await mkdir(path.join(appRoot, 'artifacts'), { recursive: true });
  const encoded = JSON.stringify({ measuredAt: new Date().toISOString(), ...result, note: 'Actual Akane source imported through the existing parser and module workers; packet preparation and main event-loop timing, without GPU presentation.' }, null, 2);
  await writeFile(path.join(appRoot, 'artifacts', 'akane-worker-profile.json'), encoded); console.log(encoded);
} finally { await browser?.close(); backend.stop(); }
