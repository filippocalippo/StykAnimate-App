/** Actual-app measurement for 3D (spatial) figures: whole-figure and head
 * turns through editor commands, seeks and playback, with optional copies of
 * the figure and CPU throttling. Reads but never saves the input.
 *
 * Start the app first: node scripts/serve.mjs --port 47851
 * Usage: node scripts/benchmark-spatial-figures.mjs <file.styk> [label] [cpuThrottle=1] [copies=1]
 * STYK_BASELINE_CLIENT=<git ref> serves index.html and src/ from that commit instead.
 * Results: artifacts/spatial-figures/<label>-t<throttle>-n<copies>-<file>.json
 */
import {chromium} from '../tests/support/playwright.mjs';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {decodeDocument} from '../tests/support/native-files.mjs';

const [file, label = 'current', throttleArg = '1', copiesArg = '1'] = process.argv.slice(2);
if (!file) throw new Error('Provide a .styk animation containing a spatial figure.');
const throttle = Number(throttleArg), copies = Number(copiesArg);
if (!(throttle >= 1) || !Number.isInteger(copies) || copies < 1 || copies > 16) throw new Error('Use a throttle of at least 1 and 1–16 copies.');
// A single copy opens through the app's file input; only copies are built here.
const {document} = copies > 1 ? await decodeDocument(await readFile(file), 'styk') : {document: null};
// A larger scene: evenly spaced copies of the first object in every frame.
if (copies > 1) for (const frame of document.keyframes) {
  const base = frame.objects[0];
  frame.objects = Array.from({length: copies}, (_, i) => ({...structuredClone(base), object_slot: i, unique_id: base.unique_id + i * 1000,
    root_x: base.root_x + (i - (copies - 1) / 2) * 220 * (base.scale ?? 1)}));
  frame.object_draw_order = frame.objects.map((_, i) => i);
}
const browser = await chromium.launch({channel: 'chrome', headless: true});
const result = {file, label, throttle, copies, cpu: os.cpus()[0].model.trim(), measuredAt: new Date().toISOString()};
try {
  const page = await browser.newPage({viewport: {width: 1600, height: 1000}}), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  if (process.env.STYK_BASELINE_CLIENT) {
    const ref = process.env.STYK_BASELINE_CLIENT, files = new Map();result.client = ref;
    await page.context().route(url => url.pathname === '/' || url.pathname === '/index.html' || url.pathname.startsWith('/src/'), async route => {
      const pathname = new URL(route.request().url()).pathname, name = pathname === '/' ? 'index.html' : pathname.slice(1);
      if (!files.has(name)) { try { files.set(name, execFileSync('git', ['show', `${ref}:${name}`], {maxBuffer: 64 * 1024 * 1024})); } catch { files.set(name, null); } }
      const body = files.get(name);
      if (!body) return route.fulfill({status: 404, body: ''});
      await route.fulfill({body, contentType: name.endsWith('.css') ? 'text/css' : name.endsWith('.html') ? 'text/html' : 'text/javascript'});
    });
  }
  await page.goto(process.env.STYK_URL ?? 'http://127.0.0.1:47851'); await page.waitForFunction(() => window.styk?.ready);
  if (!document) {
    await page.evaluate(() => { for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close(); styk.editor.markSaved(); });
    const started = Date.now(); await page.locator('#file-input').setInputFiles(file);
    await page.waitForFunction(name => !styk.state.importing && styk.editor.name === name, path.basename(file, path.extname(file)), {timeout: 600000});
    result.openMs = Date.now() - started;
  }
  await page.evaluate(report => {
    for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
    if (report) styk.editor.load(report);
    styk.editor.markSaved(); styk.fit();
    const renderer = styk.state.renderer, render = renderer.render.bind(renderer);
    globalThis.__renders = [];
    renderer.render = options => { const start = performance.now(); try { return render(options); } finally { __renders.push(performance.now() - start); } };
    // One update is the command plus the app's next presented frame.
    globalThis.__frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    globalThis.__stats = values => { if (!values.length) return null; values = [...values].sort((a, b) => a - b);
      return {n: values.length, median: +values[values.length >> 1].toFixed(1), p95: +values[Math.floor(values.length * .95)].toFixed(1), max: +values.at(-1).toFixed(1)}; };
  }, document);
  result.backend = await page.evaluate(() => styk.state.renderer.stats.backend);
  const cdp = await page.context().newCDPSession(page);
  if (throttle > 1) await cdp.send('Emulation.setCPUThrottlingRate', {rate: throttle});
  const turn = (name, whole) => page.evaluate(async ({name, whole}) => {
    const e = styk.editor, bone = s => s._stykRig?.spatial?.origin;
    const index = name ? e.figure.segments.findIndex(s => s.name === name && bone(s)) : e.figure.segments.findIndex(s => bone(s) && !s._stykRig.spatial.parent);
    if (index < 0) return null;
    e.select(e.report.keyframes[e.tick].objects[0].unique_id, index); await __frame();
    const command = [], update = [], render = [];
    e.beginDrag('Benchmark turn'); const start = e.getSpatialPose().turn;
    for (let i = 0; i < 30; i++) {
      __renders.length = 0; const a = performance.now();
      e.setSpatialPose({turn: start + Math.sin(i * .25) * .8}, {wholeFigure: whole});
      const b = performance.now(); await __frame(); const c = performance.now();
      if (i >= 4) { command.push(b - a); update.push(c - a); render.push(__renders.reduce((sum, v) => sum + v, 0)); }
    }
    e.cancelDrag(); await __frame();
    return {command: __stats(command), render: __stats(render), update: __stats(update)};
  }, {name, whole});
  result.turnFigure = await turn(null, true);
  result.turnHead = await turn('Head', false);
  result.seek = await page.evaluate(async () => {
    const e = styk.editor, update = [], render = [], total = e.report.keyframes.length;
    for (let i = 0; i < 16; i++) {
      __renders.length = 0; const a = performance.now(); e.seek((i * 7 + 3) % total); await __frame(); await __frame();
      if (i >= 2) { update.push(performance.now() - a); render.push(__renders.reduce((sum, v) => sum + v, 0)); }
    }
    return {update: __stats(update), render: __stats(render)};
  });
  result.playback = await page.evaluate(async () => {
    const state = styk.state, e = styk.editor; state.loop = false; e.seek(0); await __frame(); await styk.actions.play();
    const started = performance.now();
    while (state.playing && performance.now() - started < 20000) await new Promise(resolve => setTimeout(resolve, 100));
    if (state.playing) await styk.actions.play();
    const p = styk.performance().presentation, intervals = p.intervalsMs ?? [];
    return {fps: p.fps && +p.fps.toFixed(1), target: p.targetFps, frames: p.totalFrames, bufferingMs: Math.round(p.bufferingMs), bufferingEvents: p.bufferingEvents,
      startupMs: p.startupMs && Math.round(p.startupMs), intervals: __stats(intervals), over100ms: intervals.filter(v => v > 100).length};
  });
  result.memory = await page.evaluate(() => performance.memory ? {usedMiB: Math.round(performance.memory.usedJSHeapSize / 2 ** 20)} : null);
  result.errors = errors;
  const directory = 'artifacts/spatial-figures'; await mkdir(directory, {recursive: true});
  const target = path.join(directory, `${label}-t${throttle}-n${copies}-${path.basename(file)}.json`);
  await writeFile(target, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally { await browser.close(); }
