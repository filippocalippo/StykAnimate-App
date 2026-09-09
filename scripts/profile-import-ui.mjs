import { chromium } from 'playwright';
import { createRequire } from 'node:module';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), require = createRequire(import.meta.url);
const { startBackend } = require('../desktop/backend.cjs'); const backend = await startBackend({ appRoot }); let browser;
try {
  try { browser = await chromium.launch({ headless: true }); } catch { browser = await chromium.launch({ channel: 'chrome', headless: true }); }
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } }); await page.goto(backend.origin);
  await page.waitForFunction(() => window.styk?.ready); const cdp = await page.context().newCDPSession(page), results = [];
  await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 1000 });
  for (const file of ['Goku_Broly_Movie_by_Killer1.piv', 'PIVOT ANIMATOR SCENE TEST/Shroobs_JJK_Pack.piv']) {
    await page.evaluate(() => {
      const meter = window.__importProfile = { longTasks: [], load: [], render: [], started: performance.now() };
      meter.observer = new PerformanceObserver(list => { for (const entry of list.getEntries()) meter.longTasks.push({ start: entry.startTime - meter.started, duration: entry.duration }); }); meter.observer.observe({ type: 'longtask' });
      meter.originalLoad = window.styk.editor.load;
      window.styk.editor.load = function(...args) { const start = performance.now(); const result = meter.originalLoad.apply(this, args); meter.load.push(performance.now() - start); return result; };
      meter.originalRender = window.styk.state.renderer.render;
      window.styk.state.renderer.render = function(...args) { const start = performance.now(); const result = meter.originalRender.apply(this, args); meter.render.push(performance.now() - start); return result; };
    });
    await cdp.send('Profiler.start');
    await page.locator('#file-input').setInputFiles(path.resolve(appRoot, '..', file));
    await page.waitForFunction(() => !window.styk.state.importing && window.styk.state.lastImport?.document_chunks > 0);
    const result = await page.evaluate(async () => {
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const meter = window.__importProfile; meter.openMs = performance.now() - meter.started;
      await new Promise(resolve => setTimeout(resolve, 650)); meter.observer.disconnect();
      window.styk.editor.load = meter.originalLoad; window.styk.state.renderer.render = meter.originalRender;
      return { openMs: meter.openMs, editorLoadWithListenersMs: meter.load, renderMs: meter.render, longTasks: meter.longTasks, backend: window.styk.state.renderer.stats.backend,
        importTimings: window.styk.state.lastImport, frames: window.styk.editor.report.keyframes.length, figures: window.styk.editor.report.figure_types.length };
    });
    const { profile } = await cdp.send('Profiler.stop'); const times = new Map(), nodes = new Map(profile.nodes.map(node => [node.id, node]));
    for (let i = 0; i < profile.samples.length; i++) { const node = nodes.get(profile.samples[i]), label = `${node.callFrame.functionName || '(anonymous)'} ${node.callFrame.url}:${node.callFrame.lineNumber + 1}`; times.set(label, (times.get(label) || 0) + (profile.timeDeltas[i] || 0) / 1000); }
    result.topCpuFunctions = [...times].sort((a, b) => b[1] - a[1]).slice(0, 25); results.push({ file, ...result });
  }
  await mkdir(path.join(appRoot, 'artifacts'), { recursive: true });
  const result = { measuredAt: new Date().toISOString(), results, note: 'Actual Chrome application file-input imports with sampled CPU attribution. Includes initial preparation warmup650msafteropen; Electron runtime profiling remains separate.' };
  const encoded = JSON.stringify(result, null, 2);
  await writeFile(path.join(appRoot, 'artifacts', `import-ui-profile-${result.measuredAt.replace(/[:.]/g, '-')}.json`), encoded);
  await writeFile(path.join(appRoot, 'artifacts', 'import-ui-profile.json'), encoded); console.log(encoded);
} finally { await browser?.close(); backend.stop(); }
