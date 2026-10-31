// StykAnimate app benchmark: the user-facing measurements, the same code against any checkout (the old JavaScript app on
// main, or the Rust engine) or a packaged build. docs/performance/APP-BENCHMARK.md says how to run and read it.
//   node scripts/benchmark-app.mjs <label> <checkout> <out-dir> doc <file> [runs] [--save] [--only=step,step] [--small=<file>]
//   node scripts/benchmark-app.mjs <label> <checkout> <out-dir> draw [runs]
//   node scripts/benchmark-app.mjs <label> <checkout> <out-dir> free [runs] [--only=empty,home]
//   --executable=<path>  launches a packaged app instead of the checkout (the checkout still supplies the driver)
// Every run starts a fresh app with a fresh profile in an off-screen window that never takes focus
// (STYK_BACKGROUND_WINDOW=1), drives it with real Chromium input (CDP, no OS mouse or keyboard) and writes
// one JSON per run. Latencies are measured in the page: from the moment an input reaches the page to the end
// of the app's paint that first shows its effect (the frame is then handed to the compositor; scan-out adds
// about one display frame on both checkouts alike).
// Measurements that exist in the summary's baselines are never changed here, only added to: a step that a checkout
// cannot do (the old app has no engine counters) is reported as absent, not as a failure.
import path from 'node:path';
import os from 'node:os';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {existsSync, statSync} from 'node:fs';
import {pathToFileURL} from 'node:url';

const args = process.argv.slice(2);
const flags = new Set(args.filter(a => a.startsWith('--')));
const only = args.find(a => a.startsWith('--only='))?.slice(7).split(',') ?? null;
const option = name => args.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;
const executable = option('executable') ? path.resolve(option('executable')) : null;
const smallFile = option('small') ? path.resolve(option('small')) : null;
const [label, rootArg, outArg, scenario, ...rest] = args.filter(a => !a.startsWith('--'));
const root = path.resolve(rootArg), out = path.resolve(outArg);
const file = scenario === 'doc' ? path.resolve(rest[0]) : null;
const runs = Number((scenario === 'doc' ? rest[1] : rest[0]) ?? 3);
const {_electron: electron} = await import(pathToFileURL(path.join(root, 'tests/support/playwright.mjs')).href);
await mkdir(out, {recursive: true});
const sleep = ms => new Promise(r => setTimeout(r, ms));

const q = values => {
  const a = values.filter(v => Number.isFinite(v)).sort((x, y) => x - y);
  if (!a.length) return {n: 0};
  const at = p => a[Math.min(a.length - 1, Math.floor(a.length * p))];
  return {n: a.length, mean: +(a.reduce((s, v) => s + v, 0) / a.length).toFixed(2), p50: +at(.5).toFixed(2),
    p95: +at(.95).toFixed(2), p99: +at(.99).toFixed(2), max: +a.at(-1).toFixed(2)};
};

/** Electron's process types, as the breakdown reports them. */
const typeKey = type => ({Browser: 'browser', Tab: 'renderer', GPU: 'gpu', Utility: 'utility'})[type] ?? 'other';
const sumTypes = rows => { const t = {}; for (const [type, , kib] of rows) t[typeKey(type)] = (t[typeKey(type)] ?? 0) + kib / 1024; return t; };
const roundTypes = t => Object.fromEntries(Object.entries(t).map(([k, v]) => [k, Math.round(v)]));

/** `startupView` is what the app opens on ('editor', or 'home'); `seed` prepares the profile before the app starts;
 *  `probe(page)` resolves when the thing a step times from launch is usable (reported as `probeMs`). */
async function launch({startupView = 'editor', seed = null, probe = null} = {}) {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'styk-bench-'));
  await writeFile(path.join(profile, 'telemetry-state.json'), JSON.stringify({decided: true,
    consent: {analytics: false, diagnostics: false, policyVersion: '2026-09-10', updatedAt: Date.now()}}));
  await seed?.(profile);
  const env = {...process.env, STYK_USER_DATA_DIR: profile, STYK_LIBRARY_DIR: path.join(profile, 'library'),
    STYK_STARTUP_VIEW: startupView, STYK_BACKGROUND_WINDOW: '1'};
  delete env.ELECTRON_RUN_AS_NODE;
  const t0 = Date.now();
  const app = await electron.launch(executable
    ? {args: [], cwd: path.dirname(executable), env, timeout: 120000, executablePath: executable}
    : {args: [root], cwd: root, env, timeout: 120000,
      executablePath: path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')});
  // `byType` keeps, per phase, the per-process-type breakdown of the sample with the most memory and of the last one.
  const memory = {peakMiB: 0, phase: 'start', byPhase: {}, samples: [], byType: {peak: null, byPhase: {}}, lastTypes: null};
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      try {
        const rows = await app.evaluate(({app}) => app.getAppMetrics().map(m => [m.type, m.name ?? '', m.memory.privateBytes ?? m.memory.workingSetSize ?? 0]));
        const kib = rows.reduce((s, r) => s + r[2], 0);
        const mib = kib / 1024;
        const types = sumTypes(rows);
        if (mib > memory.peakMiB) memory.byType.peak = roundTypes(types);
        memory.peakMiB = Math.max(memory.peakMiB, mib);
        const phaseTypes = memory.byType.byPhase[memory.phase] ??= {atPeak: null, last: null, peakMiB: 0};
        if (mib > phaseTypes.peakMiB) { phaseTypes.peakMiB = mib; phaseTypes.atPeak = roundTypes(types); }
        phaseTypes.last = roundTypes(types);
        memory.lastTypes = types;
        memory.byPhase[memory.phase] = Math.max(memory.byPhase[memory.phase] ?? 0, mib);
        memory.samples.push([Date.now() - t0, Math.round(mib), memory.phase]);
      } catch { /* closing */ }
      await sleep(250);
    }
  })();
  const page = await app.firstWindow({timeout: 120000});
  const firstWindowMs = Date.now() - t0;
  const errors = [];
  page.on('pageerror', e => errors.push(String(e.message).slice(0, 300)));
  await page.waitForFunction(() => window.styk?.ready === true || Boolean(window.styk?.editor && window.styk?.actions), null, {timeout: 120000, polling: 20});
  const readyMs = Date.now() - t0;
  const probeMs = probe ? await probe(page).then(() => Date.now() - t0, () => null) : null;
  // The startup prompt queue opens the release notes (and on a first run the privacy prompt) a moment after ready.
  await page.waitForSelector('dialog.release-splash[open]', {timeout: 10000}).catch(() => {});
  await dismiss(page);
  await install(page);
  const cdp = await page.context().newCDPSession(page).catch(() => null);
  // A document with unsaved work can hold the quit behind a native prompt: after 15 s only this run's own process
  // tree is ended (never another Electron app on the machine).
  const close = async () => {
    sampling = false; await sampler;
    const pid = app.process().pid;
    const closed = await Promise.race([app.close().then(() => true, () => true), sleep(15000).then(() => false)]);
    if (!closed && pid) { const {execFileSync} = await import('node:child_process'); try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], {stdio: 'ignore'}); } catch {} }
    await sleep(500);
    await rm(profile, {recursive: true, force: true}).catch(() => {});
  };
  return {app, page, cdp, memory, errors, startup: {firstWindowMs, readyMs}, probeMs, profile, close};
}

/** Memory by process type (the last sample), the renderer's JS heap and the engine's WebAssembly memory right now.
 *  Taken between steps, so it never lands inside a measurement. A reading the checkout cannot give is null. */
async function memoryNow(ctx) {
  const {page, cdp, memory} = ctx;
  const heap = await cdp?.send('Runtime.getHeapUsage').catch(() => null);
  const page_ = await page.evaluate(async () => {
    const out = {usedHeapMiB: performance.memory ? performance.memory.usedJSHeapSize / 1048576 : null, wasm: null};
    try {
      const engine = await (await import('/src/engine/engine.mjs')).loadEngine();
      out.wasm = {memoryMiB: engine.memoryBytes / 1048576, maximumMiB: engine.memoryMaximumBytes / 1048576, detail: engine.memory()};
    } catch { /* the old app has no engine */ }
    return out;
  });
  return {byType: roundTypes(memory.lastTypes ?? {}),
    jsHeapUsedMiB: heap ? +(heap.usedSize / 1048576).toFixed(1) : page_.usedHeapMiB !== null ? +page_.usedHeapMiB.toFixed(1) : null,
    jsHeapTotalMiB: heap ? +(heap.totalSize / 1048576).toFixed(1) : null,
    wasmMiB: page_.wasm ? +page_.wasm.memoryMiB.toFixed(1) : null, wasmMaximumMiB: page_.wasm ? +page_.wasm.maximumMiB.toFixed(1) : null, wasm: page_.wasm?.detail ?? null};
}

/** Page instrumentation: inputs, paints (the app's own presentation record), animation frames, long tasks, and an
 *  optional picture sampler for flicker. */
async function install(page) {
  await page.evaluate(() => {
    const B = window.__bench = {mark: 'idle', inputs: [], pres: [], frames: [], longTasks: [], samples: [], sampling: false, sampleError: null};
    const e = () => window.styk.editor, s = () => window.styk.state;
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'keydown', 'wheel']) {
      window.addEventListener(type, ev => {
        if (B.mark === 'idle') return;
        B.inputs.push({type, t: performance.now(), ts: ev.timeStamp, rev: e().revision, tick: e().tick, mark: B.mark});
      }, {capture: true});
    }
    try { new PerformanceObserver(list => { for (const x of list.getEntries()) B.longTasks.push({start: x.startTime, dur: x.duration, mark: B.mark}); }).observe({type: 'longtask'}); } catch {}
    let lastAt = null;
    const loop = now => {
      if (B.mark !== 'idle') B.frames.push({t: now, mark: B.mark});
      const p = s().lastEditingPresentation;
      if (p && p.at !== lastAt) { lastAt = p.at; if (B.mark !== 'idle') B.pres.push({at: p.at, tick: p.tick, rev: p.revision, drawn: s().renderer?.engineStats?.frames ?? null, mark: B.mark}); }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    // Picture sampler: after any animation-frame callback that drew a new picture, the stage and the overlay are read
    // into a 64x40 luminance strip in the same task (valid for WebGPU and WebGL canvases alike).
    const W = 64, H = 40, c = new OffscreenCanvas(W, H), x = c.getContext('2d', {willReadFrequently: true});
    const raf = window.requestAnimationFrame.bind(window);
    let key = null;
    B.grab = (overlayLayer = document.querySelector('#overlay')) => {
      x.fillStyle = '#000'; x.fillRect(0, 0, W, H);
      const stage = s().renderer?.canvas;
      if (stage) x.drawImage(stage, 0, 0, W, H);
      if (overlayLayer) x.drawImage(overlayLayer, 0, 0, W, H);
      const d = x.getImageData(0, 0, W, H).data, lum = new Array(W * H);
      for (let i = 0; i < W * H; i++) lum[i] = (d[i * 4] * 3 + d[i * 4 + 1] * 6 + d[i * 4 + 2]) / 10 | 0;
      return lum;
    };
    window.requestAnimationFrame = cb => raf(t => {
      cb(t);
      if (!B.sampling && !B.settling) return;
      const p = s().lastEditingPresentation, perf = window.styk.performance?.();
      const k = `${p?.at}|${perf?.presentation?.totalFrames}|${s().renderer?.engineStats?.frames}`;
      if (k === key) return;
      key = k;
      try {
        // A WebGPU canvas holds its picture only until the frame is presented: a picture is read in the callback that drew it.
        const lum = B.grab();
        if (B.settling) B.settled = lum;
        if (!B.sampling) return;
        const stats = s().renderer?.engineStats;
        B.samples.push({t: performance.now(), mark: B.mark, lum, tick: e().tick, drawn: stats?.frames ?? null, redraws: stats?.pictureRedraws ?? null});
      } catch (error) { B.sampleError = String(error?.message ?? error); }
    });
    B.until = (test, timeout = 5000) => new Promise(resolve => {
      const started = performance.now();
      const poll = () => { const v = test(); if (v) return resolve(v); if (performance.now() - started > timeout) return resolve(null); raf(poll); };
      poll();
    });
    B.paints = () => new Promise(r => raf(() => raf(() => raf(r))));
  });
}

const setMark = (page, mark) => page.evaluate(m => { window.__bench.mark = m; }, mark);
const dismiss = page => page.evaluate(() => {
  document.querySelector('.styk-privacy [data-decline]')?.click();
  for (const d of document.querySelectorAll('dialog[open]')) d.close();
});

/** Input → paint latency of one mark, the way a person sees it: each paint that shows something new (a new revision
 *  for edits, a new tick for frame changes, any paint for live strokes) answers every input that arrived since the
 *  previous such paint; its latency is the time since the oldest of them. Inputs no paint answered are counted. */
async function inputLatency(page, mark, {type, change = 'rev'}) {
  return page.evaluate(({mark, type, change}) => {
    const B = window.__bench, pres = B.pres.filter(p => p.mark === mark), inputs = B.inputs.filter(i => i.mark === mark && i.type === type);
    const lat = [], delays = inputs.map(i => i.t - i.ts);
    let next = 0, prev = null;
    for (const p of pres) {
      const shows = change === 'any' || !prev || (change === 'rev' ? p.rev !== prev.rev : p.tick !== prev.tick);
      prev = p;
      if (!shows) continue;
      let first = null;
      while (next < inputs.length && inputs[next].t <= p.at) { first ??= inputs[next]; next++; }
      if (first) lat.push(p.at - first.ts);
    }
    return {lat, delays, inputs: inputs.length, answeredPaints: lat.length, unanswered: inputs.length - next};
  }, {mark, type, change});
}

async function markStats(page, mark) {
  return page.evaluate(mark => {
    const B = window.__bench, f = B.frames.filter(x => x.mark === mark).map(x => x.t), pres = B.pres.filter(p => p.mark === mark);
    const gaps = []; for (let i = 1; i < f.length; i++) gaps.push(f[i] - f[i - 1]);
    const lt = B.longTasks.filter(x => x.mark === mark);
    const span = f.length > 1 ? (f.at(-1) - f[0]) / 1000 : 0;
    return {frameGaps: gaps, longTasks: lt.length, longTaskMs: lt.reduce((s, x) => s + x.dur, 0), longestTaskMs: Math.max(0, ...lt.map(x => x.dur)),
      paints: pres.length, paintsPerSec: span ? pres.length / span : null, seconds: span};
  }, mark);
}

function summarizeGaps(gaps) {
  const s = q(gaps);
  return {...s, over50: gaps.filter(g => g > 50).length, over100: gaps.filter(g => g > 100).length};
}

// ---------- document run ----------
async function openDocument(ctx) {
  const {app, page, memory} = ctx;
  await app.evaluate(({dialog}, f) => {
    dialog.showOpenDialog = async () => ({canceled: false, filePaths: [f]});
    dialog.showMessageBox = async () => ({response: 2, checkboxChecked: false});
  }, file);
  memory.phase = 'open';
  // Open is done when the editor holds another document than the blank one it started with (the blank document has
  // a figure on show too), the import is over and the new document's frame is on show.
  await page.evaluate(() => { window.__bench.before = {report: window.styk.editor.report, name: window.styk.editor.name}; });
  const started = Date.now();
  await page.evaluate(() => { window.styk.actions.open(); });
  await page.waitForFunction(() => { const e = window.styk.editor, b = window.__bench.before;
    return (e.report !== b.report || e.name !== b.name) && !window.styk.state.importing && e.totalTicks > 0 && Array.isArray(e.evaluatedFrame?.objects); },
  null, {timeout: 600000, polling: 50});
  await page.evaluate(() => window.__bench.paints());
  const openMs = Date.now() - started;
  await dismiss(page);
  memory.phase = 'settle';
  await sleep(4000);
  const info = await page.evaluate(() => ({ticks: window.styk.editor.totalTicks, fps: window.styk.editor.report?.fps,
    objects: window.styk.editor.evaluatedFrame.objects.length, backend: window.styk.state.renderer?.stats?.backend}));
  const settled = memory.samples.filter(s => s[2] === 'settle').map(s => s[1]);
  return {openMs, ...info, openPeakMiB: Math.round(memory.byPhase.open ?? 0), settledMiB: settled.length ? settled.at(-1) : null};
}

async function idle(ctx, ms = 3000) {
  const {page} = ctx;
  await setMark(page, 'idle-doc');
  await sleep(ms);
  await setMark(page, 'idle');
  const st = await markStats(page, 'idle-doc');
  return {frameGaps: summarizeGaps(st.frameGaps), longTasks: st.longTasks, longTaskMs: Math.round(st.longTaskMs), paintsPerSec: st.paintsPerSec};
}

async function playback(ctx, mark, seconds = 10) {
  const {page, memory} = ctx;
  await page.evaluate(async () => { window.styk.editor.seek(0); await window.__bench.until(() => window.styk.state.lastEditingPresentation?.tick === 0, 5000); });
  memory.phase = 'play';
  await setMark(page, mark);
  await page.evaluate(() => window.styk.actions.play());
  await sleep(seconds * 1000);
  const result = await page.evaluate(() => {
    const perf = window.styk.performance(), p = perf.presentation;
    return {startupMs: p.startupMs, totalFrames: p.totalFrames, elapsedMs: p.elapsedMs, bufferingMs: p.bufferingMs, bufferingEvents: p.bufferingEvents,
      targetFps: p.targetFps, intervals: p.intervalsMs, playing: window.styk.state.playing, tick: window.styk.editor.tick};
  });
  if (result.playing) await page.evaluate(() => window.styk.actions.play());
  await setMark(page, 'idle');
  memory.phase = 'after-play';
  const st = await markStats(page, mark);
  const iv = result.intervals ?? [], budget = 1000 / (result.targetFps || 24);
  const span = iv.reduce((s, v) => s + v, 0);
  return {startMs: result.startupMs, frames: result.totalFrames, deliveredFps: span ? +(iv.length * 1000 / span).toFixed(2) : null, targetFps: result.targetFps,
    frameIntervals: q(iv), stutters: iv.filter(v => v > budget * 1.5).length, bigStutters: iv.filter(v => v > 100).length,
    bufferingMs: Math.round(result.bufferingMs ?? 0), bufferingEvents: result.bufferingEvents, reachedTick: result.tick,
    uiFrameGaps: summarizeGaps(st.frameGaps), longTasks: st.longTasks, longTaskMs: Math.round(st.longTaskMs)};
}

async function seekSeries(ctx, mark, ticks) {
  const {page} = ctx;
  await setMark(page, mark);
  const lat = await page.evaluate(async ticks => {
    const B = window.__bench, out = [];
    for (const t of ticks) {
      const t0 = performance.now();
      window.styk.editor.seek(t);
      const p = await B.until(() => { const p = window.styk.state.lastEditingPresentation; return p && p.tick === t && p.at >= t0 ? p : null; }, 5000);
      out.push(p ? p.at - t0 : null);
    }
    return out;
  }, ticks);
  await setMark(page, 'idle');
  const st = await markStats(page, mark);
  return {latency: q(lat), timeouts: lat.filter(v => v === null).length, longTasks: st.longTasks, longestTaskMs: Math.round(st.longestTaskMs)};
}

async function frameSteps(ctx, count = 30) {
  const {page} = ctx;
  await page.evaluate(async () => { window.styk.editor.seek(0); await window.__bench.until(() => window.styk.state.lastEditingPresentation?.tick === 0, 5000); });
  await dismiss(page);
  await setMark(page, 'step');
  const lat = [], delays = [];
  for (let i = 0; i < count; i++) {
    const before = await page.evaluate(() => window.styk.editor.tick);
    await page.keyboard.press('Period');
    const r = await page.evaluate(async before => {
      const B = window.__bench, key = B.inputs.filter(i => i.type === 'keydown' && i.mark === 'step').at(-1);
      const p = await B.until(() => { const p = window.styk.state.lastEditingPresentation; return p && p.tick === before + 1 && key && p.at >= key.t ? p : null; }, 5000);
      return {ms: p && key ? p.at - key.t : null, delay: key ? key.t - key.ts : null};
    }, before);
    lat.push(r.ms); delays.push(r.delay);
  }
  await setMark(page, 'idle');
  const tickNow = await page.evaluate(() => ({tick: window.styk.editor.tick, pres: window.styk.state.lastEditingPresentation, keys: window.__bench.inputs.filter(i => i.mark === 'step').length}));
  return {latency: q(lat), unanswered: lat.filter(v => v === null).length, inputDelay: q(delays), debug: tickNow};
}

/** Finds a joint (pose) or a figure origin (move) of the figure with the most joints, centers the view on it and
 *  checks that a click there picks it. */
async function dragTarget(page, kind) {
  return page.evaluate(async kind => {
    const {getPivotHandles, pickCanvasHandle} = await import('/src/canvas-interactions.mjs');
    const {worldToScreen} = await import('/src/renderer-geometry.mjs');
    const e = window.styk.editor, s = window.styk.state;
    const opts = () => ({frame: e.evaluatedFrame, selectedUid: null, selectedUids: new Set(), showUnselected: true, viewScale: s.view.scale});
    let handles = getPivotHandles(e.geometry, opts());
    const counts = new Map(), free = new Set(handles.filter(h => h.action === 'move' && !h.g?.obj?.join).map(h => h.uid));
    for (const h of handles) if (h.action === 'pose' && !h.static && (kind !== 'move' || free.has(h.uid))) counts.set(h.uid, (counts.get(h.uid) ?? 0) + 1);
    const uid = [...counts].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))[0]?.[0];
    const pick = list => {
      const c = list.filter(h => h.uid === uid && (kind === 'move' ? h.action === 'move' : h.action === 'pose' && !h.static && !h.ik && !h.connector && h.kind !== 'origin'));
      return c[Math.floor(c.length / 2)];
    };
    const h = pick(handles);
    if (!h) return {error: 'no handle'};
    const rect = document.querySelector('#viewport').getBoundingClientRect();
    const p0 = worldToScreen(h.point, {report: e.report, frame: e.evaluatedFrame, view: {...s.view, x: 0, y: 0}, cameraEnabled: false});
    s.view.x = rect.width * .5 - p0.x; s.view.y = rect.height * .5 - p0.y; s.dirtyRender = true;
    await window.__bench.paints();
    handles = getPivotHandles(e.geometry, opts());
    const h2 = handles.find(x => x.uid === h.uid && x.id === h.id) ?? h;
    const project = p => worldToScreen(p, {report: e.report, frame: e.evaluatedFrame, view: s.view, cameraEnabled: false});
    const sp = project(h2.point);
    const hit = pickCanvasHandle(e.geometry, h2.point, {...opts(), handles, project, projectionScale: s.view.scale, nearest: true, minRadius: 8});
    const x = rect.left + sp.x, y = rect.top + sp.y;
    return {x, y, uid, joint: h2.joint, hits: hit?.uid === uid && hit?.joint === h2.joint, onStage: document.elementFromPoint(x, y)?.id === 'overlay', at: (() => { const out = []; for (let n = document.elementFromPoint(x, y); n && out.length < 5; n = n.parentElement) out.push(n.tagName + (n.id ? '#' + n.id : '') + '.' + String(n.className).slice(0, 30)); return out; })(), dialogs: [...document.querySelectorAll('dialog[open]')].map(d => d.className),
      room: Math.min(x - rect.left, rect.right - x, y - rect.top, rect.bottom - y), handles: counts.get(uid)};
  }, kind);
}

async function drags(ctx, kind, repeats, moves = 90) {
  const {page} = ctx;
  const results = [];
  for (let r = 0; r < repeats; r++) {
    await dismiss(page);
    const target = await dragTarget(page, kind);
    if (target.error) return {error: target.error};
    const mark = `${kind}-${r}`;
    await setMark(page, mark);
    const rev0 = await page.evaluate(() => window.styk.editor.revision);
    let dragKind = null;
    await page.mouse.move(target.x, target.y);
    await page.mouse.down();
    const started = Date.now();
    for (let i = 1; i <= moves; i++) {
      const a = i / moves * Math.PI * 1.5;
      await page.mouse.move(target.x + Math.sin(a) * 70, target.y - (1 - Math.cos(a)) * 45);
      if (i === 10) dragKind = await page.evaluate(() => window.styk.state.drag?.kind ?? null);
      const next = started + i * 8.33; // ~120 Hz pointer
      const wait = next - Date.now(); if (wait > 1) await sleep(wait);
    }
    const tUp = await page.evaluate(() => performance.now());
    await page.mouse.up();
    await page.evaluate(() => window.__bench.paints());
    const commitMs = await page.evaluate(tUp => { const p = window.__bench.pres.filter(p => p.at >= tUp); return p.length ? p[0].at - tUp : null; }, tUp);
    await setMark(page, 'idle');
    const rev1 = await page.evaluate(() => window.styk.editor.revision);
    const lat = await inputLatency(page, mark, {type: 'pointermove', change: 'any'});
    const st = await markStats(page, mark);
    results.push({dragKind, target, hits: target.hits && target.onStage, changed: rev1 !== rev0, lat: lat.lat, delays: lat.delays, unanswered: lat.unanswered,
      paintsPerSec: st.paintsPerSec, gaps: st.frameGaps, longTasks: st.longTasks, longestTaskMs: st.longestTaskMs, commitMs});
    // Undo the drag; its latency is measured too.
    await setMark(page, `undo-${mark}`);
    const undoMs = await page.evaluate(async () => { const r0 = window.styk.editor.revision, t0 = performance.now(); window.styk.actions.undo();
      const p = await window.__bench.until(() => { const p = window.styk.state.lastEditingPresentation; return p && p.at >= t0 && p.revision !== r0 ? p : null; }, 5000); return p ? p.at - t0 : null; });
    const redoMs = await page.evaluate(async () => { const r0 = window.styk.editor.revision, t0 = performance.now(); window.styk.actions.redo();
      const p = await window.__bench.until(() => { const p = window.styk.state.lastEditingPresentation; return p && p.at >= t0 && p.revision !== r0 ? p : null; }, 5000); return p ? p.at - t0 : null; });
    await page.evaluate(() => window.styk.actions.undo());
    await page.evaluate(() => window.__bench.paints());
    await setMark(page, 'idle');
    results.at(-1).undoMs = undoMs; results.at(-1).redoMs = redoMs;
  }
  const all = k => results.flatMap(r => r[k]);
  return {repeats, dragKind: results[0]?.dragKind, target: results[0]?.target, hits: results.every(r => r.hits), changed: results.every(r => r.changed),
    latency: q(all('lat')), unanswered: results.reduce((s, r) => s + r.unanswered, 0), inputDelay: q(all('delays')),
    paintsPerSec: q(results.map(r => r.paintsPerSec)), uiFrameGaps: summarizeGaps(all('gaps')),
    longTasks: results.reduce((s, r) => s + r.longTasks, 0), longestTaskMs: Math.round(Math.max(...results.map(r => r.longestTaskMs))),
    commitMs: q(results.map(r => r.commitMs)), undoMs: q(results.map(r => r.undoMs)), redoMs: q(results.map(r => r.redoMs))};
}

/** Flicker: a picture that differs from both neighbours while the neighbours agree (A-B-A), or a blank picture
 *  between non-blank ones. `transients` and `blanks` count every one, as they always have.
 *  `reference` (tick → picture, each taken after that tick had fully settled) tells what the document itself does: an
 *  A-B-A whose three ticks also show A-B-A once settled is the animation's content (`contentTransients`); the rest are
 *  artifacts of drawing (`artifactTransients`). Without a reference every one counts as an artifact. */
const STRIP = {W: 64, H: 40, B: 8, T: 12};
function blockDiff(a, b) {
  const {W, B} = STRIP, blocks = (W / B) * (STRIP.H / B), d = new Float64Array(blocks);
  for (let y = 0; y < STRIP.H; y++) for (let x = 0; x < W; x++) { const i = y * W + x; d[((y / B) | 0) * (W / B) + ((x / B) | 0)] += Math.abs(a[i] - b[i]); }
  for (let k = 0; k < blocks; k++) d[k] /= B * B;
  return d;
}
const spread = a => { let m = 0; for (const v of a) m += v; m /= a.length; let s = 0; for (const v of a) s += (v - m) ** 2; return Math.sqrt(s / a.length); };
// Per 8x8 block of the 64x40 strip (40 blocks), so one figure blinking for a frame counts, not only the whole stage.
function blinkBlocks(a, b, c) {
  const blocks = (STRIP.W / STRIP.B) * (STRIP.H / STRIP.B), T = STRIP.T;
  const ab = blockDiff(a, b), bc = blockDiff(b, c), ac = blockDiff(a, c), hit = [];
  for (let k = 0; k < blocks; k++) if (ab[k] > T && bc[k] > T && ac[k] < T / 3) hit.push(k);
  return hit;
}
const isBlink = (a, b, c) => blinkBlocks(a, b, c).length > 0;
const isBlank = (a, b, c) => spread(b) < 2 && spread(a) > 8 && spread(c) > 8;
function flickerOf(samples, reference = null) {
  let transients = 0, blanks = 0, contentTransients = 0, contentBlanks = 0;
  const blinks = [];
  // A tick drawn twice whose second picture differs from the first: a blink of its own, with or without an A-B-A (scrub and playback only).
  let redrawChanges = 0;
  for (let i = 1; i < samples.length; i++) if (samples[i].tick === samples[i - 1].tick && blockDiff(samples[i - 1].lum, samples[i].lum).some(d => d > STRIP.T)) redrawChanges++;
  for (let i = 1; i < samples.length - 1; i++) {
    const a = samples[i - 1].lum, b = samples[i].lum, c = samples[i + 1].lum;
    const settled = reference ? [i - 1, i, i + 1].map(k => reference[samples[k].tick] ?? null) : null;
    const known = settled && settled.every(Boolean);
    if (isBlink(a, b, c)) {
      transients++;
      const hit = blinkBlocks(a, b, c), own = known && isBlink(...settled);
      if (own) contentTransients++;
      if (blinks.length < 12) blinks.push({picture: i, ticks: [i - 1, i, i + 1].map(k => samples[k].tick), drawn: [i - 1, i, i + 1].map(k => samples[k].drawn ?? null), redraws: [i - 1, i, i + 1].map(k => samples[k].redraws ?? null), blocks: hit, content: Boolean(own)});
    }
    if (isBlank(a, b, c)) { blanks++; if (known && isBlank(...settled)) contentBlanks++; }
  }
  return {pictures: samples.length, transients, blanks, referenced: Boolean(reference), blinks, redrawChanges,
    contentTransients: reference ? contentTransients : null, artifactTransients: transients - contentTransients,
    contentBlanks: reference ? contentBlanks : null, artifactBlanks: blanks - contentBlanks};
}

/** One picture per tick: the one the last draw of the tick gave, taken once the tick has fully settled (shown, and nothing
 *  drawn or asked for during the last 250 ms: pictures loaded, nothing pending). It is read in the animation-frame callback
 *  that drew it, as the raw pictures are: a WebGPU canvas holds nothing between frames, so reading it later gave a blank
 *  stage. `onionsOff` matches playback, which shows no onion skins. The tick, the view and the onion setting on show are
 *  restored. A tick that never settles, or that draws nothing, has no picture. */
async function settledPictures(ctx, ticks, {onionsOff = false, view = null} = {}) {
  return ctx.page.evaluate(async ({ticks, onionsOff, view}) => {
    const B = window.__bench, e = () => window.styk.editor, s = () => window.styk.state;
    const wasSampling = B.sampling, home = e().tick, wasView = s().view;
    if (view) s().view = {...view};
    B.sampling = false; B.settling = true;
    if (onionsOff && s().onion) window.styk.actions['toggle-onion']();
    const tick = () => new Promise(r => requestAnimationFrame(r));
    const key = () => { const p = s().lastEditingPresentation; return `${p?.at}|${s().renderer?.engineStats?.frames}|${s().dirtyRender}`; };
    const out = {};
    for (const t of ticks) {
      // Showing the tick already on show draws nothing: step away first so the tick is drawn.
      if (e().tick === t) { const other = t === 0 ? 1 : t - 1; e().seek(other); await B.until(() => s().lastEditingPresentation?.tick === other, 3000); }
      B.settled = null;
      e().seek(t);
      const deadline = performance.now() + 4000;
      await B.until(() => s().lastEditingPresentation?.tick === t, 3000);
      let last = key(), quietSince = performance.now();
      while (performance.now() < deadline) {
        await tick();
        const now = key();
        if (now !== last) { last = now; quietSince = performance.now(); }
        else if (performance.now() - quietSince >= 250) { if (B.settled) out[t] = B.settled; break; }
      }
    }
    if (onionsOff && !s().onion) window.styk.actions['toggle-onion']();
    e().seek(home);
    await B.until(() => s().lastEditingPresentation?.tick === home, 3000);
    B.sampling = wasSampling; B.settling = false;
    s().view = wasView;
    return out;
  }, {ticks, onionsOff, view});
}

/** The pictures playback draws, for the ticks it showed, drawn again while paused with the same call at the view playback had:
 *  each tick's prepared frame through the scene camera, clipped to the artboard, under the overlay playback left, taken once
 *  the frame has all its pictures. Playback's own pictures are compared with these, so a camera move or a clip the paused
 *  editing view does not show is not mistaken for an artifact. The tick and the view on show are restored. The old app has
 *  no prepared frames to draw: it keeps the paused editing view without onion skins. */
async function preparedPictures(ctx, ticks) {
  return ctx.page.evaluate(async ticks => {
    const B = window.__bench, e = () => window.styk.editor, s = () => window.styk.state, playback = window.styk.playback;
    const wasSampling = B.sampling, home = e().tick, wasView = s().view;
    s().view = {...B.playView};
    B.sampling = false;
    const frame = fn => new Promise(resolve => requestAnimationFrame(() => resolve(fn())));
    const out = {};
    for (const t of ticks) {
      e().seek(t);
      await playback.prepareRange([t]);
      if (!await B.until(() => playback.has(t), 4000)) continue;
      for (let attempt = 0; attempt < 60; attempt++) {
        const done = await frame(() => {
          const renderer = s().renderer, packet = playback.get(t);
          if (!packet || !renderer.renderPrepared(packet.key, {view: s().view, cameraEnabled: true})) return false;
          if (renderer.engineSide.stage.pictures_pending()) return false;
          out[t] = B.grab(B.playOverlay);
          return true;
        });
        if (done) break;
        await new Promise(r => setTimeout(r, 30));
      }
    }
    e().seek(home);
    await B.until(() => s().lastEditingPresentation?.tick === home, 3000);
    B.sampling = wasSampling;
    s().view = wasView;
    return out;
  }, ticks);
}

async function flickerPass(ctx) {
  const {page} = ctx;
  const view = await page.evaluate(() => ({...window.styk.state.view}));
  await page.evaluate(() => { window.__bench.samples = []; window.__bench.sampling = true; });
  const out = {}, kept = {};
  const take = async (mark, fn) => {
    await setMark(page, mark);
    try { await fn(); } catch (error) { out[mark] = {error: String(error.message).slice(0, 200)}; }
    await setMark(page, 'idle');
    if (out[mark]?.error) return;
    const samples = await page.evaluate(mark => window.__bench.samples.filter(s => s.mark === mark), mark);
    out[mark] = flickerOf(samples);
    kept[mark] = samples;
  };
  const ticks = await page.evaluate(() => window.styk.editor.totalTicks);
  await take('flicker-scrub', () => page.evaluate(async n => { for (let t = 0; t < n; t++) { window.styk.editor.seek(t); await window.__bench.until(() => window.styk.state.lastEditingPresentation?.tick === t, 3000); } }, Math.min(60, ticks)));
  await take('flicker-play', async () => {
    await page.evaluate(() => window.styk.actions.play());
    await sleep(5000);
    // The view and the overlay playback shows, for the reference pictures (playback fits the view itself).
    await page.evaluate(() => { const B = window.__bench, o = document.querySelector('#overlay'), c = new OffscreenCanvas(o.width, o.height); c.getContext('2d').drawImage(o, 0, 0); B.playOverlay = c; B.playView = {...window.styk.state.view}; });
    await page.evaluate(() => { if (window.styk.state.playing) window.styk.actions.play(); });
  });
  await take('flicker-idle', () => sleep(3000));
  await dismiss(page);
  const target = await dragTarget(page, 'pose');
  if (!target.error) await take('flicker-drag', async () => {
    await page.mouse.move(target.x, target.y); await page.mouse.down();
    for (let i = 1; i <= 60; i++) { const a = i / 60 * Math.PI * 1.5; await page.mouse.move(target.x + Math.sin(a) * 70, target.y - (1 - Math.cos(a)) * 45); await sleep(8); }
    await page.mouse.up(); await page.evaluate(() => window.__bench.paints()); await page.evaluate(() => window.styk.actions.undo());
  });
  out.sampleError = await page.evaluate(() => window.__bench.sampleError);
  // The settled reference comes after every raw pass, so it cannot warm anything they measure.
  const prepared = await page.evaluate(() => Boolean(window.styk.state.renderer?.engineSide && window.styk.playback?.prepareRange));
  for (const [mark, pictures, reference] of [['flicker-scrub', settledPictures, 'paused view'],
    ['flicker-play', prepared ? (c, t) => preparedPictures(c, t) : (c, t, o) => settledPictures(c, t, {...o, onionsOff: true}), prepared ? 'paused, drawn as playback draws' : 'paused view, no onion skins']]) {
    if (!kept[mark]) continue;
    try {
      const wanted = [...new Set(kept[mark].map(sample => sample.tick).filter(tick => tick !== null))].sort((x, y) => x - y);
      out[mark] = {...flickerOf(kept[mark], await pictures(ctx, wanted, {view})), reference};
    } catch (error) { out[mark].referenceError = String(error.message).slice(0, 200); }
  }
  await page.evaluate(() => { window.__bench.sampling = false; window.__bench.samples = []; });
  return out;
}

async function save(ctx) {
  const {app, page} = ctx;
  const target = path.join(os.tmpdir(), `styk-bench-save-${Date.now()}.styk`);
  await app.evaluate(({dialog}, f) => { dialog.showSaveDialog = async () => ({canceled: false, filePath: f}); dialog.showMessageBox = async () => ({response: 0, checkboxChecked: false}); }, target);
  // Saving replaces the target atomically: the file appears when the save is complete.
  const started = Date.now();
  await page.evaluate(() => { window.styk.actions['save-as'](); });
  let ok = false;
  for (let i = 0; i < 1200 && !ok; i++) { await sleep(100); ok = existsSync(target) && await page.evaluate(() => !window.styk.editor.dirty).catch(() => false); }
  const ms = Date.now() - started;
  const bytes = existsSync(target) ? (await import('node:fs')).statSync(target).size : 0;
  await rm(target, {force: true});
  return {ms: ok ? ms : null, bytes};
}

// ---------- steps added for the performance phase (each is a named step for --only=) ----------

/** The frame the new steps work on: the one the drags use, where the figures have most to draw. */
async function heavyFrame(ctx) {
  const ticks = await ctx.page.evaluate(() => window.styk.editor.totalTicks);
  await ctx.page.evaluate(async t => { window.styk.editor.seek(t); await window.__bench.until(() => window.styk.state.lastEditingPresentation?.tick === t, 5000); }, Math.floor(ticks * .4));
  await dismiss(ctx.page);
  return ticks;
}

/** Draws per animation frame: how many pictures the engine draws for each tick playback shows. The old app has no
 *  such counter (`counter: false`). */
async function drawsPerFrame(ctx, seconds = 5) {
  const {page, memory} = ctx;
  await page.evaluate(async () => { window.styk.editor.seek(0); await window.__bench.until(() => window.styk.state.lastEditingPresentation?.tick === 0, 5000); });
  const read = () => page.evaluate(() => ({engineFrames: window.styk.state.renderer?.engineStats?.frames ?? null,
    shown: window.styk.performance().presentation.totalFrames, tick: window.styk.editor.tick}));
  memory.phase = 'draws';
  await setMark(page, 'draws');
  const before = await read();
  await page.evaluate(() => window.styk.actions.play());
  await sleep(seconds * 1000);
  const after = await read();
  await page.evaluate(() => { if (window.styk.state.playing) window.styk.actions.play(); });
  await setMark(page, 'idle');
  const counter = before.engineFrames !== null && after.engineFrames !== null;
  // A play starts its presentation count over, so the ticks shown are the count at the end.
  const shown = after.shown;
  return {counter, engineFrames: counter ? after.engineFrames - before.engineFrames : null, ticksShown: shown,
    drawsPerFrame: counter && shown > 0 ? +((after.engineFrames - before.engineFrames) / shown).toFixed(3) : null, seconds};
}

/** Zoom with real wheel events (Ctrl+wheel; ten notches in, ten out, again and again, so the zoom stays in range) and pan with a
 *  real middle-button drag, on the heavy frame. Latency is
 *  input → the app's paint that answers it, as everywhere; the view is put back afterwards. */
async function zoomPan(ctx, count = 90) {
  const {page, cdp} = ctx;
  await heavyFrame(ctx);
  const view = await page.evaluate(() => ({...window.styk.state.view}));
  const box = await page.evaluate(() => { const r = document.querySelector('#viewport').getBoundingClientRect(); return {x: r.left + r.width / 2, y: r.top + r.height / 2}; });
  const summarize = async (mark, type) => {
    const lat = await inputLatency(page, mark, {type, change: 'any'}), st = await markStats(page, mark);
    return {latency: q(lat.lat), inputs: lat.inputs, unanswered: lat.unanswered, inputDelay: q(lat.delays), paintsPerSec: st.paintsPerSec,
      uiFrameGaps: summarizeGaps(st.frameGaps), longTasks: st.longTasks, longestTaskMs: Math.round(st.longestTaskMs), seconds: st.seconds};
  };
  await page.mouse.move(box.x, box.y);
  await setMark(page, 'zoom');
  let started = Date.now();
  for (let i = 1; i <= count; i++) {
    await cdp.send('Input.dispatchMouseEvent', {type: 'mouseWheel', x: box.x, y: box.y, deltaX: 0, deltaY: Math.floor((i - 1) / 10) % 2 === 0 ? -60 : 60, modifiers: 2});
    const wait = started + i * 8.33 - Date.now(); if (wait > 1) await sleep(wait);
  }
  await sleep(400); // the glide ends
  await setMark(page, 'idle');
  const zoom = await summarize('zoom', 'wheel');
  zoom.scaleBefore = view.scale; zoom.scaleAfter = await page.evaluate(() => window.styk.state.view.scale);
  await page.evaluate(v => { Object.assign(window.styk.state.view, v); window.styk.state.dirtyRender = true; }, view);
  await page.evaluate(() => window.__bench.paints());
  await page.mouse.move(box.x, box.y);
  await setMark(page, 'pan');
  await page.mouse.down({button: 'middle'});
  started = Date.now();
  let dragKind = null;
  for (let i = 1; i <= count; i++) {
    const a = i / count * Math.PI * 2;
    await page.mouse.move(box.x + Math.sin(a) * 160, box.y - (1 - Math.cos(a)) * 80);
    if (i === 10) dragKind = await page.evaluate(() => window.styk.state.drag?.kind ?? null);
    const wait = started + i * 8.33 - Date.now(); if (wait > 1) await sleep(wait);
  }
  await page.mouse.up({button: 'middle'});
  await page.evaluate(() => window.__bench.paints());
  await setMark(page, 'idle');
  const pan = await summarize('pan', 'pointermove');
  pan.dragKind = dragKind;
  await page.evaluate(v => { Object.assign(window.styk.state.view, v); window.styk.state.dirtyRender = true; }, view);
  await page.evaluate(() => window.__bench.paints());
  return {zoom, pan};
}

/** A click that selects a figure on the heavy frame: pointer press → the paint after the selection. */
async function selectClick(ctx, repeats = 10) {
  const {page} = ctx;
  await heavyFrame(ctx);
  const target = await dragTarget(page, 'move');
  if (target.error) return {error: target.error};
  const lat = [], failed = [];
  for (let r = 0; r < repeats; r++) {
    await page.evaluate(() => { window.styk.editor.select(null); });
    await page.evaluate(() => window.__bench.paints());
    await page.evaluate(uid => { const B = window.__bench, e = window.styk.editor; B.selAt = null; B.selUid = uid;
      e.addEventListener('change', B.selListener ??= () => { if (B.selAt === null && e.selectedUid === B.selUid) B.selAt = performance.now(); }); }, target.uid);
    const mark = `select-${r}`;
    await page.mouse.move(target.x, target.y);
    await setMark(page, mark);
    await page.mouse.down(); await page.mouse.up();
    const ms = await page.evaluate(async mark => {
      const B = window.__bench;
      const p = await B.until(() => B.selAt !== null && B.pres.find(x => x.mark === mark && x.at >= B.selAt) || null, 3000);
      const down = B.inputs.find(i => i.mark === mark && i.type === 'pointerdown');
      return p && down ? p.at - down.ts : null;
    }, mark);
    await setMark(page, 'idle');
    if (ms === null) failed.push(r); else lat.push(ms);
  }
  const selected = await page.evaluate(() => window.styk.editor.selectedUid);
  await page.evaluate(() => { window.styk.editor.select(null); });
  return {repeats, latency: q(lat), failed: failed.length, hits: selected === target.uid, uid: target.uid};
}

/** Onion skins on: through the app's own action and settings, then the scrub and playback of the existing steps. */
async function onionOn(ctx) {
  const {page} = ctx;
  const before = await page.evaluate(() => { const s = window.styk.state; return {on: s.onion, mode: s.settings.onionMode, before: s.settings.onionBefore, after: s.settings.onionAfter}; });
  await page.evaluate(() => {
    if (!window.styk.state.onion) window.styk.actions['toggle-onion']();
    window.styk.settingsUI.commit({onionMode: 'frames', onionBefore: 3, onionAfter: 3});
  });
  const ticks = await heavyFrame(ctx);
  await page.evaluate(() => window.__bench.paints());
  const shown = await page.evaluate(() => { try { const s = window.styk.onionSkins?.(); return s == null ? null : Array.isArray(s) ? s.length : (s.count ?? Object.keys(s).length); } catch { return null; } });
  const scrub = await seekSeries(ctx, 'onion-scrub', Array.from({length: Math.min(60, ticks)}, (_, i) => i));
  const step = await frameSteps(ctx);
  const play = await playback(ctx, 'onion-play', 5);
  await page.evaluate(b => {
    window.styk.settingsUI.commit({onionMode: b.mode, onionBefore: b.before, onionAfter: b.after});
    if (window.styk.state.onion !== b.on) window.styk.actions['toggle-onion']();
  }, before);
  return {enabled: true, settings: {onionMode: 'frames', onionBefore: 3, onionAfter: 3}, skinsReported: shown, scrub, step: {latency: step.latency, unanswered: step.unanswered}, play};
}

/** Timeline and inspector on show with a figure selected, playing for 10 s: how long after a tick is shown the
 *  playhead's and the inspector's DOM change (a MutationObserver on each), plus the usual playback figures. */
async function timelineInspector(ctx, seconds = 10) {
  const {page} = ctx;
  await heavyFrame(ctx);
  const target = await dragTarget(page, 'pose');
  if (target.error) return {error: target.error};
  const shown = await page.evaluate(uid => {
    window.styk.editor.select(uid);
    const visible = el => Boolean(el) && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0;
    const B = window.__bench; B.watch = {playhead: [], inspector: [], shown: [], observers: [], restore: []};
    const watch = (selector, list) => { const el = document.querySelector(selector); if (!el) return false;
      const o = new MutationObserver(() => list.push(performance.now())); o.observe(el, {subtree: true, childList: true, attributes: true, characterData: true}); B.watch.observers.push(o); return visible(el); };
    // Inputs take their values as properties, which no observer sees: a changed value of an input in the inspector counts as a change too.
    const proto = HTMLInputElement.prototype, value = Object.getOwnPropertyDescriptor(proto, 'value');
    Object.defineProperty(proto, 'value', {...value, set(v) { if (this.closest('#inspector') && value.get.call(this) !== String(v)) B.watch.inspector.push(performance.now()); return value.set.call(this, v); }});
    B.watch.restore.push(() => Object.defineProperty(proto, 'value', value));
    return {selected: window.styk.editor.selectedUid === uid, timeline: watch('.sheet-playhead-clip', B.watch.playhead), inspector: watch('#inspector', B.watch.inspector)};
  }, target.uid);
  // The moments playback shows a tick: the app's own record of each presentation.
  await page.evaluate(async () => {
    const {PlaybackMetrics} = await import('/src/playback-metrics.mjs'), B = window.__bench, present = PlaybackMetrics.prototype.present;
    PlaybackMetrics.prototype.present = function (now) { B.watch.shown.push(now); return present.call(this, now); };
    B.watch.restore.push(() => { PlaybackMetrics.prototype.present = present; });
  });
  await page.evaluate(() => window.__bench.paints());
  const play = await playback(ctx, 'tl-play', seconds);
  const data = await page.evaluate(() => { const B = window.__bench; B.watch.observers.forEach(o => o.disconnect()); B.watch.restore.forEach(f => f());
    return {shown: B.watch.shown, playhead: B.watch.playhead, inspector: B.watch.inspector}; });
  // Each tick shown at T answers to the first change between T - 8 ms (a change made just before the record) and the next tick's T - 8 ms.
  const shownAt = data.shown;
  const lag = changes => {
    const delays = []; let missed = 0, j = 0;
    for (let k = 0; k < shownAt.length - 1; k++) {
      while (j < changes.length && changes[j] < shownAt[k] - 8) j++;
      if (j < changes.length && changes[j] < shownAt[k + 1] - 8) delays.push(changes[j] - shownAt[k]); else missed++;
    }
    return {delay: q(delays), missed, changes: changes.length};
  };
  await page.evaluate(() => { window.styk.editor.select(null); });
  return {selected: shown.selected, visible: {timeline: shown.timeline, inspector: shown.inspector}, ticksShown: shownAt.length,
    playhead: lag(data.playhead), inspector: lag(data.inspector), play};
}

/** The export dialog, then a video of about two seconds of the document written to a temporary file (deleted). */
async function exportVideo(ctx, seconds = 2) {
  const {app, page, memory} = ctx;
  const target = path.join(os.tmpdir(), `styk-bench-export-${Date.now()}.webm`);
  await app.evaluate(({dialog}, f) => { dialog.showSaveDialog = async () => ({canceled: false, filePath: f}); }, target);
  await heavyFrame(ctx);
  const dialogMs = await page.evaluate(async () => {
    const t0 = performance.now();
    window.styk.actions.export();
    const ok = await window.__bench.until(() => { const b = document.querySelector('#export-submit'); return b && !b.disabled && b.getBoundingClientRect().width > 0; }, 20000);
    return ok ? performance.now() - t0 : null;
  });
  if (dialogMs === null) { await dismiss(page); return {error: 'the export dialog was not usable', dialogMs}; }
  const range = await page.evaluate(async seconds => {
    const e = window.styk.editor, fps = e.report.fps || 24, end = Math.max(1, Math.min(e.totalTicks, Math.round(seconds * fps)));
    document.querySelector('.export-type[data-format="webm"]')?.click();
    const set = (id, v) => { const i = document.getElementById(id); if (!i) return false; i.value = String(v); i.dispatchEvent(new Event('input', {bubbles: true})); i.dispatchEvent(new Event('change', {bubbles: true})); i.blur(); return true; };
    const ok = set('export-start', 1) && set('export-end', end);
    await window.__bench.paints();
    const b = document.querySelector('#export-submit');
    return {frames: end, fps, set: ok, canExport: Boolean(b) && !b.disabled, label: b?.textContent ?? null};
  }, seconds);
  if (!range.canExport) { await dismiss(page); return {error: 'the dialog would not export', dialogMs, ...range}; }
  memory.phase = 'export';
  const started = Date.now();
  await page.evaluate(() => document.querySelector('#export-submit').click());
  const deadline = Date.now() + 300000;
  let size = -1, stable = 0;
  while (Date.now() < deadline && stable < 3) { await sleep(100); const now = existsSync(target) ? statSync(target).size : -1; stable = now > 0 && now === size ? stable + 1 : 0; size = now; }
  const ms = Date.now() - started - 300; // the last three reads only confirm the file stopped growing
  const ok = stable >= 3 && size > 0;
  await rm(target, {force: true});
  await dismiss(page);
  return {dialogMs, exportMs: ok ? ms : null, ok, bytes: Math.max(0, size), ...range};
}

/** Two projects in tabs (the document under test and a small one, or a new one), switched to and fro. */
async function switchTabs(ctx, switches = 10) {
  const {app, page, memory} = ctx;
  const front = await page.evaluate(() => ({id: window.styk.projects.tabs.activeId, name: window.styk.editor.name}));
  const t0 = Date.now(), second = smallFile && smallFile !== file ? smallFile : null; // the same file would only bring its own tab forward
  if (second) {
    await app.evaluate(({dialog}, f) => { dialog.showOpenDialog = async () => ({canceled: false, filePaths: [f]}); }, second);
    await page.evaluate(() => { window.styk.actions.open(); });
  } else await page.evaluate(() => { window.styk.actions.new(); });
  await page.waitForFunction(id => window.styk.projects.tabs.size >= 2 && window.styk.projects.tabs.activeId !== id && !window.styk.state.importing && window.styk.editor.totalTicks > 0, front.id, {timeout: 120000, polling: 50});
  await page.evaluate(() => window.__bench.paints());
  const openSecondMs = Date.now() - t0;
  const other = await page.evaluate(() => ({id: window.styk.projects.tabs.activeId, name: window.styk.editor.name}));
  await dismiss(page);
  await sleep(1500);
  memory.phase = 'tabs-switch';
  await page.evaluate(() => { const B = window.__bench; B.docAt = []; window.styk.editor.addEventListener('change', B.docListener ??= event => { if (event.detail?.kind === 'document') B.docAt.push(performance.now()); }); });
  const toFront = [], toOther = [], failed = [];
  for (let i = 0; i < switches; i++) {
    const goFront = i % 2 === 0, id = goFront ? front.id : other.id;
    await setMark(page, 'tab-switch');
    const ms = await page.evaluate(async id => {
      const B = window.__bench, n = B.docAt.length, t0 = performance.now();
      window.styk.projects.activate(id);
      const at = await B.until(() => B.docAt.length > n && window.styk.projects.tabs.activeId === id ? B.docAt[n] : null, 15000);
      if (at === null) return null;
      const p = await B.until(() => B.pres.find(x => x.mark === 'tab-switch' && x.at >= at) ?? null, 5000);
      return p ? p.at - t0 : null;
    }, id);
    await setMark(page, 'idle');
    if (ms === null) failed.push(i); else (goFront ? toFront : toOther).push(ms);
    await sleep(600);
    await page.evaluate(() => { window.__bench.pres = []; });
  }
  const st = await markStats(page, 'tab-switch').catch(() => null);
  memory.phase = 'tabs-settle';
  await sleep(4000);
  const settled = memory.samples.filter(s => s[2] === 'tabs-settle').map(s => s[1]);
  return {tabs: 2, second: second ? 'file' : 'new project', openSecondMs, switches, failed: failed.length,
    toHeavy: q(toFront), toOther: q(toOther), all: q([...toFront, ...toOther]),
    switchPeakMiB: Math.round(memory.byPhase['tabs-switch'] ?? 0), settledMiB: settled.length ? settled.at(-1) : null, longTasks: st?.longTasks ?? null};
}

// ---------- steps without a document ----------

/** The app after startup with no document of the person's open: startup times and settled memory by process type. */
async function emptyApp() {
  const ctx = await launch();
  const result = {startup: ctx.startup};
  try {
    ctx.memory.phase = 'empty';
    await sleep(5000);
    const samples = ctx.memory.samples.filter(s => s[2] === 'empty').map(s => s[1]);
    const tail = samples.slice(-8).sort((a, b) => a - b);
    result.settledMiB = samples.at(-1) ?? null;
    result.medianMiB = tail.length ? tail[tail.length >> 1] : null;
    result.peakMiB = Math.round(ctx.memory.byPhase.empty ?? 0);
    result.detail = await memoryNow(ctx);
    result.byType = result.detail.byType;
  } finally {
    result.errors = ctx.errors.slice(0, 20);
    await ctx.close();
  }
  return result;
}

/** A gradient picture for each fabricated project, as Home's list expects (a PNG). */
async function projectPicture() {
  const {deflateSync} = await import('node:zlib');
  const w = 480, h = 270, raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = 40 + (x * 160 / w) | 0; raw[o + 1] = 60 + (y * 120 / h) | 0; raw[o + 2] = 120; }
  const crcTable = Array.from({length: 256}, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = buf => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const body = Buffer.concat([Buffer.from(type), data]), out = Buffer.alloc(body.length + 8); out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(crc(body), body.length + 4); return out; };
  const head = Buffer.alloc(13); head.writeUInt32BE(w, 0); head.writeUInt32BE(h, 4); head[8] = 8; head[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', head), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** Home with a library of `count` projects, fabricated in the run's own temporary profile (never the person's library):
 *  copies of the small project the startup document saves as, with a picture each. Time to a usable Home, then the
 *  gaps between frames while the list scrolls. */
async function homeWithProjects(count = 200) {
  const {randomUUID} = await import('node:crypto');
  const {copyFile} = await import('node:fs/promises');
  const work = await mkdtemp(path.join(os.tmpdir(), 'styk-bench-home-'));
  try {
    // A small project: the startup document, saved by the app itself.
    const seed = await launch();
    const small = path.join(work, 'seed.styk');
    try {
      await seed.app.evaluate(({dialog}, f) => { dialog.showSaveDialog = async () => ({canceled: false, filePath: f}); dialog.showMessageBox = async () => ({response: 0, checkboxChecked: false}); }, small);
      await seed.page.evaluate(() => { window.styk.actions['save-as'](); });
      for (let i = 0; i < 100 && !existsSync(small); i++) await sleep(100);
    } finally { await seed.close(); }
    if (!existsSync(small)) return {error: 'the small project was not saved'};
    const picture = await projectPicture(), projects = [];
    await mkdir(path.join(work, 'projects'), {recursive: true});
    for (let i = 0; i < count; i++) {
      const file = path.join(work, 'projects', `Project ${String(i + 1).padStart(3, '0')}.styk`);
      await copyFile(small, file);
      projects.push({id: randomUUID(), path: file, pinned: i < 3, folder: '', openedAt: Date.now() - i * 3600000, stats: {frames: 120, fps: 24, width: 960, height: 540}, preview: true});
    }
    const ctx = await launch({startupView: 'home', probe: page => page.waitForFunction(n => window.styk?.home?.shown && document.querySelectorAll('.home-project').length >= n, count, {timeout: 60000, polling: 20}),
      seed: async profile => {
        const library = path.join(profile, 'project-library');
        await mkdir(path.join(library, 'previews'), {recursive: true});
        await writeFile(path.join(library, 'projects.json'), JSON.stringify({version: 1, folders: [], projects}));
        await Promise.all(projects.map(p => writeFile(path.join(library, 'previews', `${p.id}.png`), picture)));
      }});
    const result = {projects: count, startup: ctx.startup, homeUsableMs: ctx.probeMs};
    try {
      ctx.memory.phase = 'home';
      await sleep(3000);
      result.listed = await ctx.page.evaluate(() => document.querySelectorAll('.home-project').length);
      const area = await ctx.page.evaluate(() => {
        let n = document.querySelector('.home-project')?.parentElement;
        while (n && !(n.scrollHeight > n.clientHeight + 10 && /auto|scroll/.test(getComputedStyle(n).overflowY))) n = n.parentElement;
        if (!n) return null;
        const r = n.getBoundingClientRect();
        return {x: r.left + r.width / 2, y: r.top + r.height / 2, scrollHeight: n.scrollHeight, clientHeight: n.clientHeight};
      });
      if (!area) result.scroll = {error: 'no scrolling list'};
      else {
        await ctx.page.mouse.move(area.x, area.y);
        await setMark(ctx.page, 'home-scroll');
        const notches = Math.ceil((area.scrollHeight - area.clientHeight) / 100);
        const started = Date.now();
        for (let i = 1; i <= notches * 2; i++) {
          await ctx.page.mouse.wheel(0, i <= notches ? 100 : -100);
          const wait = started + i * 16.7 - Date.now(); if (wait > 1) await sleep(wait);
        }
        await sleep(300);
        await setMark(ctx.page, 'idle');
        const st = await markStats(ctx.page, 'home-scroll');
        result.scroll = {notches: notches * 2, uiFrameGaps: summarizeGaps(st.frameGaps), longTasks: st.longTasks, longestTaskMs: Math.round(st.longestTaskMs), seconds: st.seconds};
      }
      result.settledMiB = (ctx.memory.samples.filter(s => s[2] === 'home').map(s => s[1])).at(-1) ?? null;
      result.byType = roundTypes(ctx.memory.lastTypes ?? {});
    } finally {
      result.errors = ctx.errors.slice(0, 20);
      await ctx.close();
    }
    return result;
  } finally { await rm(work, {recursive: true, force: true}).catch(() => {}); }
}

async function docRun(run) {
  const ctx = await launch();
  const result = {label, run, file: path.basename(file), startup: ctx.startup};
  // After these steps the memory is also broken down by process type, with the renderer's JS heap and the engine's
  // WebAssembly memory (taken between steps, so never inside a measurement).
  const SNAPSHOT = new Set(['open', 'playCold', 'playWarm', 'scrub', 'poseDrag', 'flicker']), snapshots = {};
  const step = async (name, fn) => {
    if (only && name !== 'open' && !only.includes(name)) return;
    try { result[name] = await fn(); } catch (error) { result[name] = {error: String(error?.message ?? error).slice(0, 300)}; }
    if (SNAPSHOT.has(name)) snapshots[name] = await memoryNow(ctx).catch(error => ({error: String(error?.message ?? error).slice(0, 200)}));
  };
  const memoryOf = () => ({peakMiB: Math.round(ctx.memory.peakMiB), byPhase: Object.fromEntries(Object.entries(ctx.memory.byPhase).map(([k, v]) => [k, Math.round(v)]))});
  try {
    await step('open', () => openDocument(ctx));
    const ticks = result.open?.ticks ?? 0;
    await step('idle', () => idle(ctx));
    await step('playCold', () => playback(ctx, 'play-cold'));
    await step('playWarm', () => playback(ctx, 'play-warm'));
    await step('scrub', () => seekSeries(ctx, 'scrub', Array.from({length: Math.min(120, ticks)}, (_, i) => i)));
    let seed = 7; const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
    await step('jump', () => seekSeries(ctx, 'jump', Array.from({length: 25}, () => Math.floor(rnd() * ticks))));
    await step('step', () => frameSteps(ctx));
    await ctx.page.evaluate(async t => { window.styk.editor.seek(t); await window.__bench.until(() => window.styk.state.lastEditingPresentation?.tick === t, 5000); }, Math.floor(ticks * .4));
    await step('poseDrag', () => drags(ctx, 'pose', 5));
    await step('moveDrag', () => drags(ctx, 'move', 3));
    await step('flicker', () => flickerPass(ctx));
    if (flags.has('--save')) await step('save', () => save(ctx));
    // `memory` is what the steps above used; the steps below change the session (a second tab, an export), so they get
    // their own figures and `memory` stays comparable with runs that never had them.
    result.memory = memoryOf();
    result.memoryDetail = {byType: structuredClone(ctx.memory.byType), snapshots};
    await step('draws', () => drawsPerFrame(ctx));
    await step('zoomPan', () => zoomPan(ctx));
    await step('select', () => selectClick(ctx));
    await step('timelineInspector', () => timelineInspector(ctx));
    await step('onion', () => onionOn(ctx));
    await step('export', () => exportVideo(ctx));
    await step('tabs', () => switchTabs(ctx));
    result.memoryAfterNewSteps = memoryOf();
  } finally {
    result.memory ??= memoryOf();
    result.errors = ctx.errors.slice(0, 20);
    await ctx.close();
  }
  return result;
}

// ---------- drawing run ----------
async function drawRun(run) {
  const ctx = await launch();
  const {page} = ctx;
  const result = {label, run, startup: ctx.startup};
  try {
    await dismiss(page);
    await page.evaluate(() => { window.styk.state.settings.autosaveSeconds = 0; });
    await page.locator('[data-workspace-mode="draw"]').click();
    await page.locator('[data-draw-action="new"]').first().click();
    await page.locator('[data-tool="drawing-brush"]').click();
    await page.locator('[data-draw-preset="ink"]').click();
    await page.evaluate(() => window.__bench.paints());
    const box = await page.locator('#viewport').boundingBox(), cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    const strokes = [];
    for (let k = 0; k < 6; k++) {
      const mark = `stroke-${k}`, pts = [];
      for (let i = 0; i <= 150; i++) { const a = i / 150 * Math.PI * 4, r = 40 + i * 1.6; pts.push({x: cx + Math.cos(a + k) * r, y: cy + Math.sin(a + k) * r * .6}); }
      await setMark(page, mark);
      if (k === 5) await page.evaluate(() => { window.__bench.samples = []; window.__bench.sampling = true; });
      await page.mouse.move(pts[0].x, pts[0].y); await page.mouse.down();
      const started = Date.now();
      for (let i = 1; i < pts.length; i++) { await page.mouse.move(pts[i].x, pts[i].y); const w = started + i * 8.33 - Date.now(); if (w > 1) await sleep(w); }
      const tUp = await page.evaluate(() => performance.now());
      await page.mouse.up();
      const commitMs = await page.evaluate(async tUp => { await window.__bench.until(() => !window.styk.drawing.gesture && !window.styk.drawing.loading && !window.styk.drawing.operation, 10000); return performance.now() - tUp; }, tUp);
      await page.evaluate(() => window.__bench.paints());
      await setMark(page, 'idle');
      const lat = await inputLatency(page, mark, {type: 'pointermove', change: 'any'});
      const st = await markStats(page, mark);
      // Does the ink lie under the path? (gaps or misplaced paint are the "strange stuff" in drawing)
      const coverage = await page.evaluate(pts => {
        const d = window.styk.drawing, t = window.styk.editor.drawingTarget(); if (!t?.figure) return null;
        const store = d.owner.entry(t.figure).store; let inked = 0;
        const sample = pts.filter((_, i) => i % 5 === 0);
        for (const p of sample) { const px = d.pixel({clientX: p.x, clientY: p.y}, t); let best = 0;
          for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) best = Math.max(best, store.pixel(Math.floor(px.x) + dx, Math.floor(px.y) + dy)[3]);
          if (best > 200) inked++; }
        return inked / sample.length;
      }, pts);
      let flicker = null;
      if (k === 5) { const samples = await page.evaluate(m => window.__bench.samples.filter(s => s.mark === m), mark); flicker = flickerOf(samples); await page.evaluate(() => { window.__bench.sampling = false; window.__bench.samples = []; }); }
      strokes.push({lat: lat.lat, delays: lat.delays, unanswered: lat.unanswered, paintsPerSec: st.paintsPerSec, gaps: st.frameGaps, longTasks: st.longTasks, longestTaskMs: st.longestTaskMs, commitMs, coverage, flicker});
    }
    const undo = await page.evaluate(async () => { const out = []; for (let i = 0; i < 4; i++) { const t0 = performance.now(); window.styk.actions.undo();
      await window.__bench.until(() => !window.styk.drawing.operation && !window.styk.drawing.loading && window.styk.state.lastEditingPresentation?.at > t0, 5000); out.push(performance.now() - t0); } return out; });
    const all = k => strokes.flatMap(s => s[k]);
    result.draw = {latency: q(all('lat')), unanswered: strokes.reduce((s, x) => s + x.unanswered, 0), inputDelay: q(all('delays')),
      paintsPerSec: q(strokes.map(s => s.paintsPerSec)), uiFrameGaps: summarizeGaps(all('gaps')), longTasks: strokes.reduce((s, x) => s + x.longTasks, 0),
      longestTaskMs: Math.round(Math.max(...strokes.map(s => s.longestTaskMs))), commitMs: q(strokes.map(s => s.commitMs)),
      coverage: strokes.map(s => s.coverage), flicker: strokes.at(-1).flicker, undoMs: q(undo)};
  } catch (error) {
    result.error = String(error?.message ?? error).slice(0, 300);
  } finally {
    result.memory = {peakMiB: Math.round(ctx.memory.peakMiB)};
    result.memoryDetail = {byType: structuredClone(ctx.memory.byType)};
    result.errors = ctx.errors.slice(0, 20);
    await ctx.close();
  }
  return result;
}

// ---------- steps without a document ----------
async function freeRun(run) {
  const result = {label, run, file: 'free'};
  for (const [name, fn] of [['empty', emptyApp], ['home', homeWithProjects]]) {
    if (only && !only.includes(name)) continue;
    try { result[name] = await fn(); } catch (error) { result[name] = {error: String(error?.message ?? error).slice(0, 300)}; }
  }
  return result;
}

for (let run = 0; run < runs; run++) {
  const result = scenario === 'doc' ? await docRun(run) : scenario === 'free' ? await freeRun(run) : await drawRun(run);
  const name = scenario === 'doc' ? `${label}--${path.basename(file).replace(/[^a-z0-9]+/gi, '_')}--${run}.json` : `${label}--${scenario === 'free' ? 'free' : 'draw'}--${run}.json`;
  await writeFile(path.join(out, name), JSON.stringify(result, null, 1));
  console.log(`${name}: done${result.error ? ' ERROR ' + result.error : ''}`);
}
