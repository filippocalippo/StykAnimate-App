import { chromium } from 'playwright';
import { createRequire } from 'node:module';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), require = createRequire(import.meta.url);
const { startBackend } = require('../desktop/backend.cjs');
const backend = await startBackend({ appRoot }); let browser;
try {
  try { browser = await chromium.launch({ headless: true }); } catch { browser = await chromium.launch({ channel: 'chrome', headless: true }); }
  const page = await browser.newPage(); await page.goto(`${backend.origin}/api/health`);
  const result = await page.evaluate(async () => {
    const { Editor } = await import('/src/editor.mjs');
    const { validateScene } = await import('/src/pivot/model.mjs');
    const { buildGeometry } = await import('/src/pivot/geometry.mjs');
    const results = [], epoch = () => performance.timeOrigin + performance.now();
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    for (const path of ['Goku_Broly_Movie_by_Killer1.piv', 'PIVOT ANIMATOR SCENE TEST/Shroobs_JJK_Pack.piv']) {
      const worker = new Worker('/tests/import-profile-worker.mjs', { type: 'module' }), pending = new Map();
      worker.onmessage = ({ data }) => pending.get(data.type)?.({ ...data, receivedEpoch: epoch() });
      worker.onerror = error => { throw error; };
      const next = type => new Promise(resolve => pending.set(type, resolve));
      const ready = next('ready'); worker.postMessage({ type: 'load', path }); const metrics = (await ready).metrics;
      const variants = [];
      for (const compact of [false, true]) {
        const longTasks = []; let phase = 'receive';
        const observer = new PerformanceObserver(list => { for (const entry of list.getEntries()) longTasks.push({ duration: entry.duration, start: entry.startTime }); });
        observer.observe({ type: 'longtask' });
        const response = next('document'), sent = next('sent'); const transferStart = performance.now(); worker.postMessage({ type: 'send', compact });
        const { document: report, postedEpoch, receivedEpoch } = await response; const { senderSerializeMs } = await sent;
        await wait(40); const receiveLongTasks = longTasks.splice(0);
        const timings = { workerSenderSerializeMs: senderSerializeMs, workerToReceiverMs: receivedEpoch - postedEpoch, receiveLongTasks };
        let started = performance.now(); validateScene(report); timings.validateMs = performance.now() - started; await wait(20);
        const editor = new Editor({ demo: false }); started = performance.now(); editor.load(report); timings.editorLoadWithoutListenersMs = performance.now() - started; await wait(20);
        started = performance.now(); const geometry = buildGeometry(report, report.keyframes[0]); timings.firstGeometryMs = performance.now() - started; timings.firstGeometryDrawables = geometry.drawables.length; await wait(20);
        started = performance.now(); const cloned = structuredClone(report); timings.mainStructuredCloneMs = performance.now() - started; await wait(20);
        const serializerWorker = new Worker('/tests/import-profile-worker.mjs', { type: 'module' });
        started = performance.now(); serializerWorker.postMessage({ type: 'profile-clone-only', report }); timings.playbackSnapshotPostMs = performance.now() - started;
        serializerWorker.terminate(); observer.disconnect();
        variants.push({ compact, ...timings, remainingLongTasks: longTasks });
      }
      await wait(60);
      const longTasks = [], chunkedReport = { figure_types: [], keyframes: [], backgrounds: [] };
      const observer = new PerformanceObserver(list => { for (const entry of list.getEntries()) longTasks.push({ duration: entry.duration }); }); observer.observe({ type: 'longtask' });
      const gapSamples = []; let last = performance.now(); const timer = setInterval(() => { const now = performance.now(); gapSamples.push(now - last); last = now; }, 5);
      pending.set('chunk', ({ index, chunk }) => {
        if (chunk.header) Object.assign(chunkedReport, chunk.header); else chunkedReport[chunk.table].push(...chunk.values);
        worker.postMessage({ type: 'ack', index });
      });
      const complete = next('chunk-end'); worker.postMessage({ type: 'send-chunked' }); const chunked = await complete;
      await wait(40); clearInterval(timer); observer.disconnect();
      const validationStart = performance.now(); validateScene(chunkedReport);
      variants.push({ chunked: true, chunks: chunked.chunks, workerSenderSerializeMs: chunked.senderSerializeMs, workerToReceiverMs: chunked.receivedEpoch - chunked.postedEpoch,
        validateMs: performance.now() - validationStart, receiveLongTasks: longTasks, maxTimerGapMs: Math.max(...gapSamples), figures: chunkedReport.figure_types.length, frames: chunkedReport.keyframes.length });
      worker.terminate(); results.push({ path, ...metrics, variants });
    }
    return { measuredAt: new Date().toISOString(), results, note: 'Isolated Chrome stage profiling. Main worker-to-receiver interval includes sender serialization, scheduling and receiver deserialization. Compact variant removes runtime_segments for measurement only; audit separately identifies semantic runtime overrides.' };
  });
  await mkdir(path.join(appRoot, 'artifacts'), { recursive: true }); await writeFile(path.join(appRoot, 'artifacts', 'import-stage-profile.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally { await browser?.close(); backend.stop(); }
