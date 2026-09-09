import { _electron as electron } from 'playwright';
import { mkdir, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baseline = process.argv.includes('--baseline');
const labelArgument = process.argv.indexOf('--label');
const label = labelArgument >= 0 ? process.argv[labelArgument + 1] : baseline ? 'baseline-0.1.0' : 'source-bytes';
if (!/^[a-z0-9-]+$/i.test(label)) throw new Error('Benchmark labels use letters, digits and hyphens.');
const output = path.join(appRoot, 'artifacts');
await mkdir(output, { recursive: true });
const app = await electron.launch({
  executablePath: baseline ? path.join(appRoot, 'release', 'baseline-0.1.0', 'StykAnimate.exe') : undefined,
  args: baseline ? [] : [appRoot], cwd: appRoot, timeout: 45000,
  env: { ...process.env, STYK_USER_DATA_DIR: path.join(output, `native-import-${label}-profile`) },
});
const results = [];
try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => window.styk?.ready, undefined, { timeout: 20000 });
  for (const relative of ['Goku_Broly_Movie_by_Killer1.piv', 'PIVOT ANIMATOR SCENE TEST/Shroobs_JJK_Pack.piv']) {
    const fixture = path.resolve(appRoot, '..', relative);
    const sourceSize = (await stat(fixture)).size;
    await app.evaluate(({ dialog }, filename) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] }); }, fixture);
    await app.evaluate(() => {
      const meter = globalThis.__stykMainImportMeter = { gaps: [], last: performance.now() };
      meter.timer = setInterval(() => { const now = performance.now(); meter.gaps.push(now - meter.last); meter.last = now; }, 5);
    });
    const measurement = await page.evaluate(async () => {
      const gaps = [], longTasks = [];
      let last = performance.now();
      const timer = setInterval(() => { const now = performance.now(); gaps.push(now - last); last = now; }, 5);
      const observer = new PerformanceObserver((list) => { for (const entry of list.getEntries()) longTasks.push(entry.duration); });
      observer.observe({ type: 'longtask' });
      const started = performance.now();
      try {
        await window.styk.actions.open();
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const totalMs = performance.now() - started;
        gaps.push(performance.now() - last);
        return {
          totalMs, transport: window.stykDesktop.importTransport || 'expanded-document-v0',
          frameCount: window.styk.editor.report.keyframes.length,
          figureCount: window.styk.editor.frame.objects.length,
          renderer: window.styk.state.renderer.stats.backend,
          timings: window.styk.state.lastImport,
          rendererTimerMaxGapMs: Math.max(0, ...gaps),
          rendererLongTaskCount: longTasks.length,
          rendererLongestTaskMs: Math.max(0, ...longTasks),
        };
      } finally { clearInterval(timer); observer.disconnect(); }
    });
    const mainEventLoop = await app.evaluate(() => {
      const meter = globalThis.__stykMainImportMeter;
      clearInterval(meter.timer);
      meter.gaps.push(performance.now() - meter.last);
      const sorted = meter.gaps.sort((a, b) => a - b);
      delete globalThis.__stykMainImportMeter;
      return { sampleCount: sorted.length, maxTimerGapMs: Math.max(0, ...sorted), p95TimerGapMs: sorted[Math.floor((sorted.length - 1) * .95)] || 0 };
    });
    assert.ok(measurement.frameCount > 1, 'Native open must load the complete project into the actual editor.');
    assert.equal(measurement.renderer, 'WebGPU');
    results.push({ file: relative, sourceBytes: sourceSize, ...measurement, mainEventLoop });
  }
  await writeFile(path.join(output, `native-import-${label}.json`), JSON.stringify({ label, measuredAt: new Date().toISOString(), note: 'Single cold import per file. Timer gaps include OS scheduling and test overhead, not exclusively JavaScript blocking. Full UI time includes decoding, worker/object transfer, editor validation, geometry, and rendering. No input-to-display latency measurement.', results }, null, 2));
  console.log(JSON.stringify(results, null, 2));
} finally {
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
}
