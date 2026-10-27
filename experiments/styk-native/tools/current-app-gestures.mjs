#!/usr/bin/env node
// Zoom and pan gestures in the current StykAnimate desktop app (Electron,
// WebGPU), for comparison with `styk-native --bench`. Gestures are real wheel
// input sent through Chromium: Ctrl+wheel zooms fit → 11× → fit over 4 s, then
// plain wheel pans back and forth at 8× for 3 s. Records requestAnimationFrame
// intervals and main-thread long tasks during each gesture.
//
//   STYK_PYTHON=.venv/bin/python node tools/current-app-gestures.mjs <file> [tick]
import {createRequire} from 'node:module';
import {mkdtemp} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
process.chdir(repo);
const {_electron: electron} = await import(`${repo}/tests/support/playwright.mjs`);
const [file, tickArg] = process.argv.slice(2);
if (!file) {
  console.error('usage: node tools/current-app-gestures.mjs <file> [tick]');
  process.exit(2);
}
const source = path.resolve(file), tick = Number(tickArg ?? 0);
const profile = await mkdtemp(path.join(os.tmpdir(), 'styk-gestures-'));
// STYK_RENDERER=canvas selects the Canvas 2D path browsers without WebGPU use.
if (process.env.STYK_RENDERER) {
  const {mkdir, writeFile} = await import('node:fs/promises');
  await mkdir(profile, {recursive: true});
  await writeFile(path.join(profile, 'editor-settings.json'), JSON.stringify({rendererMode: process.env.STYK_RENDERER}));
}
const app = await electron.launch({executablePath: createRequire(import.meta.url)('electron'), args: [repo], cwd: repo, timeout: 60000,
  env: {...process.env, STYK_DEBUG: '1', STYK_USER_DATA_DIR: profile}});
const q = values => {
  const a = [...values].sort((x, y) => x - y);
  const at = p => a[Math.round((a.length - 1) * p)] ?? 0;
  return {n: a.length, p50: +at(.5).toFixed(2), p95: +at(.95).toFixed(2), p99: +at(.99).toFixed(2), max: +(a.at(-1) ?? 0).toFixed(2)};
};
try {
  const page = await app.firstWindow({timeout: 60000});
  page.setDefaultTimeout(300000);
  await app.evaluate(({BrowserWindow}) => {const w = BrowserWindow.getAllWindows()[0]; w.setContentSize(1440, 900); w.webContents.setBackgroundThrottling(false); w.show(); w.focus();});
  await page.waitForFunction(() => window.styk?.ready);
  await page.evaluate(() => {for (const d of document.querySelectorAll('dialog[open]')) d.close(); styk.editor.markSaved();});
  const started = Date.now();
  await page.locator('#file-input').setInputFiles(source);
  await page.waitForFunction(n => !styk.state.importing && styk.editor.name === n, path.basename(source, path.extname(source)));
  const importMs = Date.now() - started;
  await page.evaluate(() => {for (const d of document.querySelectorAll('dialog[open]')) d.close();});
  const backend = await page.evaluate(t => {styk.editor.seek(t); styk.fit(); return styk.state.renderer?.stats?.backend;}, tick);
  await page.waitForTimeout(1500);
  const box = await page.locator('#viewport').boundingBox().catch(() => null) ?? {x: 200, y: 100, width: 1000, height: 600};
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  // STYK_CPU_THROTTLE=4 slows the page's CPU like a phone-class processor.
  const throttle = Number(process.env.STYK_CPU_THROTTLE || 1);
  if (throttle > 1) await (await page.context().newCDPSession(page)).send('Emulation.setCPUThrottlingRate', {rate: throttle});
  const scale = () => page.evaluate(() => styk.state.view.scale);
  const record = async gesture => {
    await page.evaluate(() => {
      window.gestureProbe = {raf: [], long: [], active: true};
      let prior = 0;
      const step = now => {if (!gestureProbe.active) return; if (prior) gestureProbe.raf.push(now - prior); prior = now; requestAnimationFrame(step);};
      requestAnimationFrame(step);
      new PerformanceObserver(list => {if (gestureProbe.active) for (const e of list.getEntries()) gestureProbe.long.push(e.duration);}).observe({entryTypes: ['longtask']});
    });
    await gesture();
    return page.evaluate(() => {gestureProbe.active = false; return {raf: gestureProbe.raf, long: gestureProbe.long};});
  };
  const wheel = async (dx, dy, ctrl) => {
    const client = await page.context().newCDPSession(page);
    await client.send('Input.dispatchMouseEvent', {type: 'mouseWheel', x: cx, y: cy, deltaX: dx, deltaY: dy, modifiers: ctrl ? 2 : 0});
    await client.detach();
  };
  const paced = async (count, fn) => {
    const t0 = Date.now();
    for (let i = 0; i < count; i++) {
      await fn(i);
      const due = t0 + (i + 1) * 1000 / 60, wait = due - Date.now();
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
    }
  };
  // ln(11) ≈ 2.4 over 120 continuous events: 0.005 log-zoom per pixel → 4 px.
  // Playback: one pass from the first frame, recording when each new tick appears.
  const playback = await page.evaluate(async () => {
    const s = styk.state, e = styk.editor, ticks = [], long = [];
    const observer = new PerformanceObserver(list => {for (const x of list.getEntries()) long.push(x.duration);});
    observer.observe({entryTypes: ['longtask']});
    s.loop = false; s.loopRange = null; e.seek(0);
    await new Promise(r => setTimeout(r, 500));
    styk.actions.play();
    await new Promise(resolve => {
      const step = now => {
        if (ticks.at(-1)?.tick !== e.tick) ticks.push({tick: e.tick, at: now});
        if (s.playing) requestAnimationFrame(step); else resolve();
      };
      requestAnimationFrame(step);
    });
    observer.disconnect();
    return {ticks, long, total: e.totalTicks, fps: e.report.fps};
  });
  const gaps = playback.ticks.slice(1).map((t, i) => t.at - playback.ticks[i].at);
  const sequential = playback.ticks.every((t, i) => i === 0 || t.tick === playback.ticks[i - 1].tick + 1);
  await page.evaluate(t => {styk.editor.seek(t); styk.fit();}, tick);
  await page.waitForTimeout(1000);
  const before = await scale();
  let peak = before;
  const zoom = await record(() => paced(240, async i => {await wheel(0, i < 120 ? -4 : 4, true); if (i === 125) peak = await scale();}));
  await page.waitForTimeout(800);
  // Zoom to 8× (ln 8 / 0.02 ≈ 104 events), let it settle, then pan.
  await paced(104, () => wheel(0, -4, true));
  await page.waitForTimeout(1500);
  const pan = await record(() => paced(180, i => wheel(Math.sin(i / 180 * 2 * Math.PI * 2) > 0 ? 30 : -30, 0, false)));
  // Resident memory of the whole Electron process tree (main, renderer, GPU, utility, workers).
  const {readdirSync, readFileSync} = await import('node:fs');
  const tree = new Set([app.process().pid]);
  const stats = readdirSync('/proc').filter(n => /^\d+$/.test(n)).map(pid => {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8'), parent = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      const rss = Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1] ?? 0);
      return {pid: Number(pid), parent, rss};
    } catch { return null; }
  }).filter(Boolean);
  for (let grew = true; grew;) {grew = false; for (const p of stats) if (!tree.has(p.pid) && tree.has(p.parent)) {tree.add(p.pid); grew = true;}}
  const rssMiB = Math.round(stats.filter(p => tree.has(p.pid)).reduce((n, p) => n + p.rss, 0) / 1024);
  console.log(JSON.stringify({file: path.basename(source), backend, throttle, importMs, rssMiB, processes: tree.size,
    playback: {fps: playback.fps, frames: playback.ticks.length, ticks: playback.total, sequential,
      wallMs: Math.round(playback.ticks.at(-1).at - playback.ticks[0].at), gaps: q(gaps), longTasks: q(playback.long)},
    zoomRange: [+before.toFixed(3), +peak.toFixed(3)],
    zoom: {intervals: q(zoom.raf), longTasks: q(zoom.long)}, pan: {intervals: q(pan.raf), longTasks: q(pan.long)}}));
} finally {
  await app.close();
}
