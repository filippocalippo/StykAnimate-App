#!/usr/bin/env node
// Black-box benchmark of the app as a person uses it, for comparing one engine build with another.
//
// The same script measures the current app and any later build (--root points at the checkout to launch), so it
// relies only on what survives an engine change: window.styk's public surface, the DOM, real input sent through the
// browser, requestAnimationFrame, long tasks, screenshots and the OS process tree. The few places that still read
// app internals are in appInternals() below, each with a fallback, and every result records which path was used.
//
//   node scripts/engine-benchmark.mjs --file "<path>" --label <name>
//        [--target electron|web-chromium|web-webkit] [--renderer gpu|canvas] [--throttle 1|4] [--touch]
//        [--workloads open,playback,scrub,zoom,pan,drag,draw,onion,export-png,export-gif,export-video,memory]
//        [--runs 1] [--width 1440 --height 900] [--root <checkout>] [--tick N] [--export-frames 120]
//        [--wait-idle 2.0] [--headed] [--web-dir <built site>] [--url <running site>] [--out <dir>]
//        [--open-timeout 600] [--export-timeout 900] [--keep-exports] [--no-canvas-hook]
//   node scripts/engine-benchmark.mjs --cold-start --target electron --runs 5 --label <name> [--startup-view editor|home]
//   node scripts/engine-benchmark.mjs --bundle-size --label <name> [--no-build]
//
// One JSON per run: artifacts/engine-rust/bench/<label>/<config>/<file-slug>/run-<n>.json (n continues after the
// runs already there), and one `RESULT {...}` line per run on stdout. Progress goes to stderr.
//
// Workloads always run in the order listed above, whatever order --workloads names them in; the file is opened once
// per run in a fresh profile and is never saved. Use STYK_PYTHON for the desktop codec (.venv is picked up by itself).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import zlib from 'node:zlib';

const DRIVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKLOADS = ['open', 'playback', 'scrub', 'zoom', 'pan', 'drag', 'draw', 'onion', 'export-png', 'export-gif', 'export-video', 'memory'];
/** The editor settings' storage key in a browser (src/settings.mjs EDITOR_SETTINGS_KEY) and file in a desktop profile. */
const SETTINGS_KEY = 'stykanimate.editor.settings.v1', SETTINGS_FILE = 'editor-settings.json';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (...parts) => process.stderr.write(`[bench] ${parts.join(' ')}\n`);

// ---------------------------------------------------------------------------------------------------------------
// INTERNALS: update when the engine changes.
//
// Everything the driver reads that is not part of the surface listed in the header: the document model behind
// styk.editor.report (keyframes, figure_types), editor.evaluatedFrame / editor.geometry / editor.selectedSlot,
// worldToScreen() from /src/renderer.mjs, getPivotHandles() from /src/canvas-interactions.mjs,
// styk.state.renderer.stats, styk.state.settings, styk.state.drag and styk.performance(). Each request returns {path, value}: `path` starts with "internal:" when the app answered and
// with "fallback:" when the driver had to do without, and is copied into the result's `internals`.
async function appInternals(page, request, args = {}) {
  return page.evaluate(async ({ request, args }) => {
    const { editor, state } = window.styk;
    const out = (path, value) => ({ path, value });
    const attempt = async (...paths) => { for (const [path, read] of paths) { try { const value = await read(); if (value !== undefined && value !== null) return out(path, value); } catch { /* next path */ } } return out('fallback:none', null); };
    /** JSON-safe copy of numbers, strings and booleans down to `depth`; drops functions, buffers and long arrays. */
    const plain = (value, depth = 3) => {
      if (value === null || ['number', 'string', 'boolean'].includes(typeof value)) return value;
      if (typeof value !== 'object' || depth <= 0 || ArrayBuffer.isView(value)) return undefined;
      if (Array.isArray(value)) return value.length > 64 ? undefined : value.map((item) => plain(item, depth - 1));
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plain(item, depth - 1)]).filter(([, item]) => item !== undefined));
    };
    const frames2 = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    switch (request) {
      case 'scene': return attempt(
        ['internal:editor.report', () => {
          const report = editor.report, segments = new Map(report.figure_types.map((figure) => [figure.figure_type_id, figure.segments.length]));
          let maxObjects = 0, maxSegments = 0;
          for (const frame of report.keyframes) {
            let count = 0;
            for (const object of frame.objects) count += segments.get(object.figure_type_id) ?? 0;
            maxObjects = Math.max(maxObjects, frame.objects.length); maxSegments = Math.max(maxSegments, count);
          }
          return { ticks: editor.totalTicks, fps: report.fps, frameDelayMs: report.frame_delay_ms ?? null, keyframes: report.keyframes.length,
            figureTypes: report.figure_types.length, totalSegments: [...segments.values()].reduce((sum, n) => sum + n, 0),
            maxObjectsInKeyframe: maxObjects, maxSegmentsInKeyframe: maxSegments, canvas: [report.canvas_width, report.canvas_height],
            layerSheet: Boolean(report._styk?.layerSheet) };
        }],
        ['fallback:public-editor', () => ({ ticks: editor.totalTicks, fps: editor.report?.fps ?? null, frameDelayMs: editor.report?.frame_delay_ms ?? null })]);
      case 'renderer': return attempt(
        ['internal:state.renderer.stats', () => state.renderer.stats.backend && { backend: state.renderer.stats.backend, adapter: state.renderer.stats.adapter ?? null, reason: state.renderer.stats.reason ?? null }],
        ['internal:styk.performance', () => { const stats = window.styk.performance().renderer; return stats.backend && { backend: stats.backend, adapter: stats.adapter ?? null }; }],
        ['fallback:dom-renderer-label', () => ({ backend: document.querySelector('#renderer-label')?.textContent?.trim() || null, adapter: null })]);
      case 'settings': return attempt(
        ['internal:state.settings', () => { const s = state.settings; return plain({ rendererMode: s.rendererMode, playbackQuality: s.playbackQuality, fitViewOnPlayback: s.fitViewOnPlayback, loopPlayback: s.loopPlayback,
          smoothZoom: s.smoothZoom, canvasZoomGesture: s.canvasZoomGesture, uiScale: s.uiScale, uiScaleMode: s.uiScaleMode, timelineMode: s.timelineMode, touchInterface: s.touchInterface,
          showHandles: s.showHandles, showUnselectedHandles: s.showUnselectedHandles, onionBefore: s.onionBefore, onionAfter: s.onionAfter, onionMode: s.onionMode, onionOpacity: s.onionOpacity, autosaveSeconds: s.autosaveSeconds }); }],
        ['fallback:localStorage', () => JSON.parse(localStorage.getItem(args.key) || 'null')]);
      case 'performance': return attempt(['internal:styk.performance', () => { const p = window.styk.performance(); return plain({ presentation: p.presentation, playback: p.playback, import: p.import, renderer: p.renderer }, 3); }]);
      // The tick with the most evaluated objects (first of equals). Seeks through the animation, then returns to the tick it found.
      case 'dense-tick': return attempt(
        ['internal:editor.evaluatedFrame', () => {
          let best = 0, most = -1;
          for (let tick = 0; tick < editor.totalTicks; tick++) { editor.seek(tick); const count = editor.evaluatedFrame.objects.length; if (count > most) { most = count; best = tick; } }
          editor.seek(best);
          return { tick: best, objects: most };
        }],
        ['fallback:middle-tick', () => ({ tick: Math.floor(editor.totalTicks / 2), objects: null })]);
      // The figures of the current frame, most segments first (the first eight).
      case 'target-figures': return attempt(
        ['internal:editor.evaluatedFrame', () => {
          const segments = new Map(editor.report.figure_types.map((figure) => [figure.figure_type_id, figure.segments.length]));
          const objects = editor.evaluatedFrame.objects;
          const ranked = objects.map((object) => ({ uid: object.unique_id, segments: segments.get(object.figure_type_id) ?? 0 })).sort((a, b) => b.segments - a.segments || a.uid - b.uid).slice(0, 8);
          return ranked.length ? ranked.map((figure) => ({ ...figure, objects: objects.length })) : null;
        }]);
      // Client coordinates of figure `uid`'s movable joint handles that leave `room` px ({left, right, top, bottom})
      // to the stage's edges, nearest the stage's centre first. Selects the figure, as a click on it would.
      case 'joint-handles': {
        const rect = document.querySelector('#overlay')?.getBoundingClientRect() ?? document.querySelector('#viewport').getBoundingClientRect();
        const centre = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        const screen = async () => {
          const { worldToScreen } = await import('/src/renderer-geometry.mjs');
          const options = { report: editor.report, frame: editor.evaluatedFrame ?? editor.frame, view: state.view, cameraEnabled: false };
          return (point) => { const s = worldToScreen(point, options); return { x: rect.left + s.x, y: rect.top + s.y }; };
        };
        const inside = (handles) => {
          const kept = handles.filter((h) => h.x > rect.left + args.room.left && h.x < rect.right - args.room.right && h.y > rect.top + args.room.top && h.y < rect.bottom - args.room.bottom)
            .sort((a, b) => Math.hypot(a.x - centre.x, a.y - centre.y) - Math.hypot(b.x - centre.x, b.y - centre.y) || a.joint - b.joint);
          return kept.length ? kept : null;
        };
        const select = async () => { editor.select(args.uid, -1); await frames2(); };
        return attempt(
          ['internal:getPivotHandles', async () => {
            const { getPivotHandles } = await import('/src/canvas-interactions.mjs');
            await select();
            const at = await screen();
            const handles = getPivotHandles(editor.geometry, { frame: editor.frame, selectedUid: editor.selectedUid, selectedUids: editor.selectedUids, showUnselected: state.settings.showUnselectedHandles, viewScale: state.view.scale, autoSize: true, maxDiameter: 10 });
            return inside(handles.filter((h) => h.uid === args.uid && h.joint >= 0 && !h.static).map((h) => ({ joint: h.joint, ...at(h.point) })));
          }],
          ['internal:geometry.joints', async () => {
            await select();
            const at = await screen();
            return inside([...editor.geometry.objects.get(editor.selectedSlot).joints.entries()].filter(([id]) => Number(id) !== 0).map(([id, point]) => ({ joint: Number(id), ...at(point) })));
          }],
          ['fallback:viewport-centre', () => (args.last ? [{ joint: null, x: centre.x, y: centre.y }] : null)]);
      }
      case 'drag-state': return attempt(
        ['internal:state.drag', () => ({ kind: state.drag?.kind ?? null, selectedUid: editor.selectedUid ?? null, selectedJoint: editor.selectedJoint ?? null, canUndo: Boolean(editor.canUndo) })],
        ['fallback:public-editor', () => ({ kind: null, selectedUid: null, selectedJoint: null, canUndo: Boolean(editor.canUndo) })]);
      default: throw new Error(`Unknown internals request: ${request}`);
    }
  }, { request, args });
}
// ---------------------------------------------------------------------------------------------------------------

// ---- Options
function parseArguments(argv) {
  const options = { target: 'electron', renderer: 'gpu', throttle: 1, touch: false, workloads: [...WORKLOADS], runs: 1, width: null, height: null, root: process.cwd(),
    tick: null, exportFrames: 120, waitIdle: 2.0, coldStart: false, bundleSize: false, build: true, headed: false, webDir: null, url: null, out: null,
    openTimeout: 600, exportTimeout: 900, keepExports: false, canvasHook: true, startupView: 'editor', label: null, file: null };
  const flags = { '--touch': ['touch', true], '--cold-start': ['coldStart', true], '--bundle-size': ['bundleSize', true], '--no-build': ['build', false], '--headed': ['headed', true],
    '--keep-exports': ['keepExports', true], '--no-canvas-hook': ['canvasHook', false] };
  const values = { '--file': 'file', '--label': 'label', '--target': 'target', '--renderer': 'renderer', '--throttle': 'throttle', '--workloads': 'workloads', '--runs': 'runs', '--width': 'width',
    '--height': 'height', '--root': 'root', '--tick': 'tick', '--export-frames': 'exportFrames', '--wait-idle': 'waitIdle', '--web-dir': 'webDir', '--url': 'url', '--out': 'out',
    '--open-timeout': 'openTimeout', '--export-timeout': 'exportTimeout', '--startup-view': 'startupView' };
  const numeric = new Set(['throttle', 'runs', 'width', 'height', 'tick', 'exportFrames', 'waitIdle', 'openTimeout', 'exportTimeout']);
  for (let i = 0; i < argv.length; i++) {
    const [name, inline] = argv[i].split(/=(.*)/s);
    if (name === '--help' || name === '-h') return { help: true };
    if (flags[name]) { options[flags[name][0]] = flags[name][1]; continue; }
    const key = values[name];
    if (!key) throw new Error(`Unknown option ${argv[i]}`);
    const value = inline ?? argv[++i];
    if (value === undefined) throw new Error(`${name} needs a value`);
    options[key] = numeric.has(key) ? Number(value) : value;
    if (numeric.has(key) && !Number.isFinite(options[key])) throw new Error(`${name} needs a number`);
  }
  if (typeof options.workloads === 'string') options.workloads = options.workloads.split(',').map((name) => name.trim()).filter(Boolean);
  for (const name of options.workloads) if (!WORKLOADS.includes(name)) throw new Error(`Unknown workload "${name}". Known: ${WORKLOADS.join(', ')}`);
  if (!['electron', 'web-chromium', 'web-webkit'].includes(options.target)) throw new Error('--target is electron, web-chromium or web-webkit');
  if (!['gpu', 'canvas'].includes(options.renderer)) throw new Error('--renderer is gpu or canvas');
  if (!['editor', 'home'].includes(options.startupView)) throw new Error('--startup-view is editor or home');
  if (options.touch && options.target === 'electron') throw new Error('--touch needs a web target (the desktop app has no phone-size emulation)');
  if (!options.label || !/^[\w.-]+$/.test(options.label)) throw new Error('--label <name> is required (letters, digits, dot, dash, underscore)');
  options.root = path.resolve(options.root);
  if (options.touch) { options.width ??= 780; options.height ??= 390; } else { options.width ??= 1440; options.height ??= 900; }
  if (!options.coldStart && !options.bundleSize) {
    if (!options.file) throw new Error('--file <path> is required');
    options.file = path.resolve(options.file.replace(/^~(?=\/)/, os.homedir()));
    if (!existsSync(options.file)) throw new Error(`No such file: ${options.file}`);
  }
  return options;
}

// ---- Numbers
const round = (value, digits = 2) => (Number.isFinite(value) ? Number(value.toFixed(digits)) : null);
function stats(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const at = (p) => (sorted.length ? round(sorted[Math.min(sorted.length - 1, Math.round((sorted.length - 1) * p))]) : null);
  return { n: sorted.length, mean: sorted.length ? round(sorted.reduce((sum, v) => sum + v, 0) / sorted.length) : null, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: at(1) };
}
const series = (values) => ({ ...stats(values), raw: values.map((value) => round(value)) });
const differences = (times) => times.slice(1).map((time, index) => time - times[index]);
const slug = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'file';

/** What a probe window recorded, summarised: frame gaps, frames the stage was drawn in, long tasks. */
function summarize(data, frameIntervalMs) {
  const long = []; for (let i = 0; i < data.long.length; i += 2) long.push(data.long[i + 1]);
  return {
    durationMs: round(data.endedAt - data.startedAt), frameIntervalMs: round(frameIntervalMs, 3),
    rafGaps: series(differences(data.raf)),
    stageFrames: { count: data.presents.length, gaps: series(differences(data.presents)), drawnThrough: data.sources, hook: data.hook },
    longTasks: { supported: data.longSupported, count: long.length, totalMs: round(long.reduce((sum, v) => sum + v, 0)), maxMs: round(Math.max(0, ...long)), raw: long.map((v) => round(v)) },
  };
}
/**
 * Input-to-frame latency: for each input event of `type` (0 pointermove, 1 wheel), ms from the event's timeStamp to
 * the end of the first animation frame, at or after the event's handler, in which the stage canvas was drawn. Without
 * the canvas hook's evidence it is the end of the next animation frame after the handler, and says so.
 */
function latency(data, type) {
  const inputs = []; for (let i = 0; i < data.inputs.length; i += 3) if (data.inputs[i] === type) inputs.push({ stamp: data.inputs[i + 1], handled: data.inputs[i + 2] });
  const drawn = data.presents.length > 0, values = []; let unresolved = 0, p = 0, f = 0;
  for (const input of inputs) {
    let from = input.handled;
    if (drawn) { while (p < data.presents.length && data.presents[p] < input.handled) p++; if (p >= data.presents.length) { unresolved++; continue; } from = data.presents[p]; }
    while (f < data.frameEnds.length && data.frameEnds[f] < from) f++;
    if (f >= data.frameEnds.length) { unresolved++; continue; }
    values.push(data.frameEnds[f] - input.stamp);
  }
  return { latencyMethod: drawn ? 'event.timeStamp → end of the first animation frame in which the stage canvas was drawn (canvas-draw hook on the main thread)'
    : 'next rAF after the event: event.timeStamp → end of the next animation frame (no stage draw was observed on the main thread)',
    events: inputs.length, unresolved, latencyMs: series(values) };
}

// ---- The machine
const run = (command, args, options = {}) => { const result = spawnSync(command, args, { encoding: 'utf8', ...options }); return result.status === 0 ? result.stdout.trim() : null; };
function gitState(root) {
  const commit = run('git', ['-C', root, 'rev-parse', 'HEAD']);
  const status = run('git', ['-C', root, 'status', '--porcelain']);
  return { commit, branch: run('git', ['-C', root, 'rev-parse', '--abbrev-ref', 'HEAD']), dirty: status === null ? null : status.length > 0 };
}
function topProcesses() {
  const text = run('ps', ['-eo', 'pcpu,comm', '--sort=-pcpu']);
  if (!text) return null;
  const rows = text.split('\n').slice(1, 12).map((line) => { const [, pcpu, comm] = /^\s*([\d.]+)\s+(.*)$/.exec(line) ?? []; return { pcpu: Number(pcpu), comm }; });
  return rows.filter((row) => row.comm !== 'ps').slice(0, 5); // ps always measures itself as busy
}
async function waitIdle(threshold) {
  const started = Date.now();
  while (os.loadavg()[0] >= threshold) {
    if (Date.now() - started >= 600000) return { busy: true, waitedMs: Date.now() - started, load: os.loadavg()[0] };
    log(`1-minute load ${os.loadavg()[0].toFixed(2)} ≥ ${threshold}; waiting`);
    await sleep(10000);
  }
  return { busy: false, waitedMs: Date.now() - started, load: os.loadavg()[0] };
}
function hostInfo() {
  return { cpu: os.cpus()[0]?.model, threads: os.cpus().length, memoryGiB: round(os.totalmem() / 2 ** 30, 1), platform: process.platform, release: os.release(),
    session: process.env.XDG_SESSION_TYPE ?? null, gpu: run('nvidia-smi', ['--query-gpu=name,driver_version', '--format=csv,noheader']) };
}

// ---- Memory of a process tree (Linux /proc)
async function processTable() {
  const names = (await readdir('/proc').catch(() => [])).filter((name) => /^\d+$/.test(name));
  const rows = await Promise.all(names.map(async (name) => {
    try { const text = await readFile(`/proc/${name}/stat`, 'utf8'); return { pid: Number(name), parent: Number(text.slice(text.lastIndexOf(')') + 2).split(' ')[1]) }; } catch { return null; }
  }));
  return rows.filter(Boolean);
}
function descendants(table, roots) {
  const tree = new Set(roots);
  for (let grew = true; grew;) { grew = false; for (const row of table) if (!tree.has(row.pid) && tree.has(row.parent)) { tree.add(row.pid); grew = true; } }
  return tree;
}
async function residentKiB(pid) { try { return Number(/VmRSS:\s+(\d+)/.exec(await readFile(`/proc/${pid}/status`, 'utf8'))?.[1] ?? 0); } catch { return 0; } }
function processKind(commandLine, isRoot) {
  const type = /--type=([\w-]+)/.exec(commandLine)?.[1];
  if (type) return type === 'gpu-process' ? 'gpu' : type;
  if (/python|styk-codec|backend/.test(commandLine)) return 'codec';
  if (/WebProcess/.test(commandLine)) return 'renderer';
  if (/NetworkProcess|GPUProcess/.test(commandLine)) return /GPU/.test(commandLine) ? 'gpu' : 'utility';
  return isRoot ? 'main' : 'other';
}
/** GPU memory the driver attributes to the tree's processes. Only NVIDIA reports it per process (nvidia-smi -q -x). */
function gpuMemory(tree) {
  const xml = run('nvidia-smi', ['-q', '-x']);
  if (!xml) return { MiB: null, reason: 'nvidia-smi is unavailable: no per-process GPU memory source on this machine' };
  let total = 0, found = 0;
  for (const [, block] of xml.matchAll(/<process_info>([\s\S]*?)<\/process_info>/g)) {
    const pid = Number(/<pid>(\d+)<\/pid>/.exec(block)?.[1]), used = Number(/<used_memory>(\d+) MiB<\/used_memory>/.exec(block)?.[1]);
    if (tree.has(pid) && Number.isFinite(used)) { total += used; found++; }
  }
  return found ? { MiB: total, processes: found, source: 'nvidia-smi -q -x (per-process used_memory)' } : { MiB: null, reason: 'nvidia-smi lists none of the app\'s processes' };
}
class MemoryWatch {
  constructor(roots) { this.roots = roots; this.tree = new Set(roots); this.peakKiB = 0; this.polls = 0; this.checkpoints = []; this.scanned = 0; }
  start() { this.timer = setInterval(() => { void this.poll(); }, 500); this.timer.unref(); }
  async poll() {
    if (this.busy) return; this.busy = true;
    try {
      if (Date.now() - this.scanned > 3000) { this.tree = descendants(await processTable(), this.roots); this.scanned = Date.now(); }
      const total = (await Promise.all([...this.tree].map(residentKiB))).reduce((sum, v) => sum + v, 0);
      this.peakKiB = Math.max(this.peakKiB, total); this.polls++;
    } finally { this.busy = false; }
  }
  async checkpoint(label) {
    this.tree = descendants(await processTable(), this.roots); this.scanned = Date.now();
    const byKind = {}; let rss = 0, pss = 0, pssKnown = true;
    for (const pid of this.tree) {
      const kib = await residentKiB(pid);
      if (!kib) continue;
      let commandLine = ''; try { commandLine = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).replaceAll('\0', ' '); } catch { /* gone */ }
      const kind = processKind(commandLine, this.roots.includes(pid));
      byKind[kind] = (byKind[kind] ?? 0) + kib; rss += kib;
      try { pss += Number(/^Pss:\s+(\d+)/m.exec(await readFile(`/proc/${pid}/smaps_rollup`, 'utf8'))?.[1] ?? NaN); } catch { pssKnown = false; }
    }
    this.peakKiB = Math.max(this.peakKiB, rss);
    const entry = { label, rssMiB: round(rss / 1024, 1), pssMiB: pssKnown && Number.isFinite(pss) ? round(pss / 1024, 1) : null, processes: this.tree.size,
      byKindMiB: Object.fromEntries(Object.entries(byKind).map(([kind, kib]) => [kind, round(kib / 1024, 1)])), gpu: gpuMemory(this.tree) };
    this.checkpoints.push(entry);
    return entry;
  }
  stop() { clearInterval(this.timer); }
  report() {
    const find = (label) => this.checkpoints.find((entry) => entry.label === label) ?? null;
    return { method: 'sum of VmRSS over the app\'s process tree (/proc); shared pages are counted once per process, pssMiB (smaps_rollup) counts them once',
      afterOpen: find('after-open'), afterPlayback: find('after-playback'), end: find('end'), peakRssMiB: round(this.peakKiB / 1024, 1), peakPollMs: 500, polls: this.polls,
      gpuMemoryMiB: find('end')?.gpu.MiB ?? null, gpuMemoryReason: find('end')?.gpu.reason ?? null };
  }
}

// ---- The probe that runs in the page
/**
 * Installs window.__engineBench once: a requestAnimationFrame clock, a long-task observer, input timestamps and,
 * unless `canvasHook` is false, a note of each animation frame in which the stage canvas (a canvas in #viewport
 * other than #overlay) was drawn to. The hook wraps the browser's own drawing entry points (WebGPU
 * getCurrentTexture, 2D drawing calls, WebGL draws, bitmap transfers), so it knows nothing about the app's renderer;
 * a renderer that draws from a worker is invisible to it, and latency then falls back to the next animation frame.
 */
function installProbe({ canvasHook }) {
  if (window.__engineBench) return;
  const b = window.__engineBench = { active: false, opts: {}, raf: [], long: [], presents: [], frameEnds: [], inputs: [], ticks: [], sources: {}, presented: false,
    longSupported: Boolean(globalThis.PerformanceObserver?.supportedEntryTypes?.includes('longtask')), hook: canvasHook ? 'installed' : 'disabled' };
  const known = new WeakMap();
  const isStage = (canvas) => {
    if (!canvas || !canvas.isConnected) return false;
    let stage = known.get(canvas);
    if (stage === undefined) { stage = canvas.id !== 'overlay' && Boolean(canvas.closest?.('#viewport')); known.set(canvas, stage); }
    return stage;
  };
  const drawn = (canvas, source) => {
    if (!isStage(canvas)) return;
    b.presented = true; b.presents.push(performance.now()); b.sources[source] = (b.sources[source] ?? 0) + 1;
  };
  const wrap = (prototype, names, source) => {
    if (!prototype) return;
    for (const name of names) {
      const original = prototype[name];
      if (typeof original !== 'function') continue;
      prototype[name] = function () { if (b.active && !b.presented) drawn(this.canvas, source); return original.apply(this, arguments); };
    }
  };
  if (canvasHook) {
    wrap(globalThis.GPUCanvasContext?.prototype, ['getCurrentTexture'], 'webgpu');
    wrap(globalThis.CanvasRenderingContext2D?.prototype, ['clearRect', 'fillRect', 'drawImage', 'putImageData', 'fill', 'stroke'], 'canvas2d');
    for (const context of [globalThis.WebGL2RenderingContext, globalThis.WebGLRenderingContext]) wrap(context?.prototype, ['clear', 'drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced'], 'webgl');
    wrap(globalThis.ImageBitmapRenderingContext?.prototype, ['transferFromImageBitmap'], 'bitmap');
  }
  // A task posted from the frame's rAF runs once the frame's own work (callbacks, style, layout, paint) is done.
  const channel = new MessageChannel();
  channel.port1.onmessage = () => { if (b.active) b.frameEnds.push(performance.now()); b.presented = false; };
  const step = (now) => {
    if (b.active) {
      b.raf.push(now);
      if (b.opts.ticks) { const tick = window.styk.editor.tick; if (tick !== b.lastTick) { b.lastTick = tick; b.ticks.push(tick, now); } }
      if (b.opts.scale) { const scale = window.styk.state.view.scale; if (scale < b.scaleMin) b.scaleMin = scale; if (scale > b.scaleMax) b.scaleMax = scale; }
      channel.port2.postMessage(0);
    }
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
  if (b.longSupported) {
    b.observer = new PerformanceObserver((list) => { if (b.active) for (const entry of list.getEntries()) if (entry.startTime >= b.startedAt) b.long.push(entry.startTime, entry.duration); });
    b.observer.observe({ entryTypes: ['longtask'] });
  }
  const input = (type) => (event) => { if (b.active && b.opts.inputs) b.inputs.push(type, event.timeStamp, performance.now()); };
  window.addEventListener('pointermove', input(0), { capture: true, passive: true });
  window.addEventListener('wheel', input(1), { capture: true, passive: true });
  b.start = (opts = {}) => {
    Object.assign(b, { opts, raf: [], long: [], presents: [], frameEnds: [], inputs: [], ticks: [], sources: {}, presented: false, lastTick: undefined, scaleMin: Infinity, scaleMax: -Infinity });
    b.startedAt = performance.now(); b.active = true;
  };
  b.stop = () => {
    b.active = false;
    for (const entry of b.observer?.takeRecords() ?? []) if (entry.startTime >= b.startedAt) b.long.push(entry.startTime, entry.duration);
    return { startedAt: b.startedAt, endedAt: performance.now(), raf: b.raf, long: b.long, presents: b.presents, frameEnds: b.frameEnds, inputs: b.inputs, ticks: b.ticks,
      sources: b.sources, hook: b.hook, longSupported: b.longSupported, scale: Number.isFinite(b.scaleMin) ? [b.scaleMin, b.scaleMax] : null };
  };
}

// ---- Real input. Events are sent on schedule and not awaited one by one: a slow app does not slow the hand.
function createInput(session) {
  const { page, cdp } = session, pending = [];
  const send = (promise) => { pending.push(Promise.resolve(promise).catch((error) => { session.errors.push(`input: ${error.message}`); })); };
  const mouse = (type, x, y, extra = {}) => cdp.send('Input.dispatchMouseEvent', { type, x, y, pointerType: 'mouse', ...extra });
  return {
    kind: cdp ? 'CDP Input.dispatch*Event' : 'Playwright mouse/keyboard (no CDP in this browser)',
    multiTouch: Boolean(cdp),
    move(x, y, pressed = false) { send(cdp ? mouse('mouseMoved', x, y, pressed ? { button: 'left', buttons: 1 } : { button: 'none', buttons: 0 }) : page.mouse.move(x, y)); },
    down(x, y) { send(cdp ? mouse('mousePressed', x, y, { button: 'left', buttons: 1, clickCount: 1 }) : page.mouse.move(x, y).then(() => page.mouse.down())); },
    up(x, y) { send(cdp ? mouse('mouseReleased', x, y, { button: 'left', buttons: 0, clickCount: 1 }) : page.mouse.up()); },
    /** Control is held around a run of zoom wheels where there is no CDP to carry the modifier with the event. */
    async control(held) { if (!cdp) await (held ? page.keyboard.down('Control') : page.keyboard.up('Control')); },
    /** `deltaX`/`deltaY` are what the page should see: the browser divides wheel deltas by the page zoom (the desktop app's UI scale). */
    wheel(x, y, deltaX, deltaY, control = false) {
      const zoom = session.pageZoom ?? 1;
      send(cdp ? mouse('mouseWheel', x, y, { deltaX: deltaX * zoom, deltaY: deltaY * zoom, modifiers: control ? 2 : 0 }) : page.mouse.move(x, y).then(() => page.mouse.wheel(deltaX * zoom, deltaY * zoom)));
    },
    touch(type, points) { if (!cdp) throw new Error('Touch input needs CDP (Chromium).'); send(cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y], id) => ({ x, y, id })) })); },
    /** Resolves when the browser has taken every event sent so far; returns how long that took. */
    async drain() { const started = performance.now(); await Promise.all(pending.splice(0)); return round(performance.now() - started); },
  };
}
/** Calls step(i) `count` times at `hertz`, on an absolute schedule. */
async function paced(count, step, hertz = 60) {
  const started = performance.now(); let late = 0;
  for (let i = 0; i < count; i++) {
    step(i);
    const wait = started + (i + 1) * 1000 / hertz - performance.now();
    if (wait > 0) await sleep(wait); else late++;
  }
  return { events: count, hertz, sendMs: round(performance.now() - started), lateSends: late };
}
/** Records the probe around `gesture`, until the browser has taken all of its input and one more moment has passed. */
async function measure(session, opts, gesture, settleMs = 150) {
  await session.page.evaluate((opts) => window.__engineBench.start(opts), opts);
  const sent = await gesture();
  const drainMs = await session.input.drain();
  await sleep(settleMs);
  const data = await session.page.evaluate(() => window.__engineBench.stop());
  return { data, input: { ...sent, drainMs, through: session.input.kind } };
}

// ---- Launching
const supportModule = () => import(pathToFileURL(path.join(DRIVER_ROOT, 'tests/support/playwright.mjs')).href);
function electronBinary(root) {
  for (const base of [root, DRIVER_ROOT]) { try { return createRequire(path.join(base, 'package.json'))('electron'); } catch { /* next */ } }
  throw new Error('Electron is not installed (npm ci).');
}
function pythonFor(root) {
  if (process.env.STYK_PYTHON) return process.env.STYK_PYTHON;
  for (const base of [root, DRIVER_ROOT]) { const candidate = path.join(base, '.venv/bin/python'); if (existsSync(candidate)) return candidate; }
  return undefined;
}
const rendererSetting = (requested) => (requested === 'canvas' ? 'canvas' : 'auto');
async function removeDirectory(directory) { await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }).catch(() => {}); }

async function launchElectron(options, { startupView = 'editor' } = {}) {
  const { _electron: electron } = await supportModule();
  const profile = await mkdtemp(path.join(os.tmpdir(), 'styk-bench-'));
  await writeFile(path.join(profile, SETTINGS_FILE), JSON.stringify({ rendererMode: rendererSetting(options.renderer) }));
  const python = pythonFor(options.root);
  const env = { ...process.env, STYK_STARTUP_VIEW: startupView, STYK_USER_DATA_DIR: profile, STYK_LIBRARY_DIR: path.join(profile, 'library'), ...(python ? { STYK_PYTHON: python } : {}) };
  const app = await electron.launch({ executablePath: electronBinary(options.root), args: [options.root], cwd: options.root, timeout: 60000, env });
  const child = app.process();
  let stderr = ''; child.stderr?.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000); });
  const close = async () => {
    const tree = descendants(await processTable(), [child.pid]);
    let timer;
    await Promise.race([app.evaluate(({ app }) => app.exit(0)).catch(() => {}), new Promise((resolve) => { timer = setTimeout(resolve, 10000); })]);
    clearTimeout(timer);
    if (child.exitCode === null) child.kill('SIGKILL');
    // Helper processes outlive the main one for a moment and still write to the profile: wait for them, then remove it.
    for (let i = 0; i < 50 && [...tree].some((pid) => existsSync(`/proc/${pid}`)); i++) await sleep(100);
    await removeDirectory(profile);
  };
  try {
    const page = await app.firstWindow({ timeout: 60000 });
    return { target: 'electron', app, page, profile, roots: [child.pid], python: python ?? null, close, stderr: () => stderr,
      versions: async () => app.evaluate(() => ({ electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node })) };
  } catch (error) { await close(); throw error; }
}

let builtSite = null;
/** The site to open: --url, else a server over --web-dir or over a fresh build of --root (built once per invocation). */
async function webSite(options) {
  if (options.url) return { origin: options.url.replace(/\/$/, ''), source: 'url', close: async () => {} };
  if (builtSite) return builtSite;
  const { startWebServer } = await import(pathToFileURL(path.join(DRIVER_ROOT, 'scripts/serve-web.mjs')).href);
  let directory = options.webDir && path.resolve(options.webDir), temporary = null;
  if (!directory) {
    temporary = await mkdtemp(path.join(os.tmpdir(), 'styk-bench-web-'));
    const { buildWeb } = await import(pathToFileURL(path.join(options.root, 'scripts/build-web.mjs')).href);
    log(`building the web app of ${options.root}`);
    directory = (await buildWeb({ root: options.root, output: path.join(temporary, 'site') })).output;
  }
  const server = await startWebServer({ root: directory });
  builtSite = { origin: server.origin, source: options.webDir ? 'web-dir' : 'fresh-build', directory, close: async () => { await server.close(); if (temporary) await removeDirectory(temporary); } };
  return builtSite;
}
/** Shared libraries the Playwright WebKit build needs and this system lacks (the loader itself names only the first). */
function missingWebKitLibraries(executable) {
  const home = path.dirname(executable), missing = new Set();
  for (const flavour of ['minibrowser-wpe', 'minibrowser-gtk']) {
    const base = path.join(home, flavour);
    if (!existsSync(base)) continue;
    const listed = run('sh', ['-c', `for f in "${base}"/bin/* "${base}"/lib/*.so*; do [ -f "$f" ] && ldd "$f" 2>/dev/null; done | grep "not found" | sort -u`],
      { env: { ...process.env, LD_LIBRARY_PATH: `${base}/lib:${base}/sys/lib` } });
    for (const line of (listed ?? '').split('\n')) { const name = /^\s*(\S+) => not found/.exec(line)?.[1]; if (name) missing.add(name); }
  }
  return [...missing].sort();
}
async function launchWeb(options) {
  const support = await supportModule();
  const site = await webSite(options);
  const before = new Set((await processTable()).filter((row) => row.parent === process.pid).map((row) => row.pid));
  let browser;
  try {
    browser = options.target === 'web-webkit'
      ? support.editorFirst(await support.webkit.launch({ headless: !options.headed }))
      : await support.chromium.launch({ channel: 'chrome', headless: !options.headed });
  } catch (error) {
    if (options.target === 'web-webkit') {
      const missing = missingWebKitLibraries(support.webkit.executablePath());
      if (missing.length) throw Object.assign(new Error(`WebKit could not start: this system lacks ${missing.join(', ')}. ${error.message}`), { missingLibraries: missing });
    }
    throw error;
  }
  const roots = (await processTable()).filter((row) => row.parent === process.pid && !before.has(row.pid)).map((row) => row.pid);
  try {
    const context = await browser.newContext({ viewport: { width: options.width, height: options.height }, acceptDownloads: true,
      ...(options.touch ? { deviceScaleFactor: 2, isMobile: true, hasTouch: true } : {}) });
    // Exports download instead of opening the native picker, and the Graphics mode is the one asked for.
    await context.addInitScript(({ key, mode }) => {
      delete window.showSaveFilePicker;
      try { if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ rendererMode: mode })); } catch { /* storage is unavailable before the first navigation */ }
    }, { key: SETTINGS_KEY, mode: rendererSetting(options.renderer) });
    const page = await context.newPage();
    return { target: options.target, browser, context, page, site, roots, close: async () => { await browser.close().catch(() => {}); },
      versions: async () => ({ browser: `${browser.browserType().name()} ${browser.version()}` }) };
  } catch (error) { await browser.close().catch(() => {}); throw error; }
}
const dismissDialogs = (page) => page.evaluate(() => { document.querySelector('.styk-privacy [data-decline]')?.click(); for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close(); });

/** A running app, ready in the editor, with the probe installed and the throttle applied. */
async function openSession(options, result) {
  const session = options.target === 'electron' ? await launchElectron(options) : await launchWeb(options);
  session.errors = [];
  try {
    const { page } = session;
    page.setDefaultTimeout(120000);
    page.on('pageerror', (error) => session.errors.push(`pageerror: ${error.message}`));
    page.on('console', (message) => { if (message.type() === 'error') session.errors.push(`console: ${message.text().slice(0, 500)}`); });
    if (session.app) await session.app.evaluate(({ BrowserWindow }, size) => { const w = BrowserWindow.getAllWindows()[0]; w.setContentSize(size.width, size.height); w.webContents.setBackgroundThrottling(false); w.show(); w.focus(); }, { width: options.width, height: options.height });
    else await page.goto(session.site.origin, { waitUntil: 'load' });
    await page.waitForFunction(() => window.styk?.ready === true, undefined, { timeout: 120000 });
    await dismissDialogs(page);
    await sleep(300);
    session.cdp = options.target === 'web-webkit' ? null : await page.context().newCDPSession(page);
    session.pageZoom = session.cdp ? ((await session.cdp.send('Page.getLayoutMetrics')).cssVisualViewport?.zoom ?? 1) : 1;
    session.input = createInput(session);
    session.touch = options.touch;
    result.throttle = { requested: options.throttle, applied: false, scope: 'the page\'s main thread (CDP Emulation.setCPUThrottlingRate); workers and other processes are not slowed' };
    if (options.throttle > 1) {
      if (session.cdp) { await session.cdp.send('Emulation.setCPUThrottlingRate', { rate: options.throttle }); result.throttle.applied = true; }
      else result.throttle.reason = 'CPU throttling needs CDP (Chromium-family only)';
    }
    await page.evaluate(installProbe, { canvasHook: options.canvasHook });
    result.versions = { driverNode: process.version, ...(await session.versions()) };
    result.window = { requested: [options.width, options.height], touch: options.touch, headless: session.app ? false : !options.headed, pageZoom: session.pageZoom,
      ...(await page.evaluate(() => ({ inner: [innerWidth, innerHeight], dpr: devicePixelRatio, input: document.documentElement.dataset.input ?? null, layout: document.documentElement.dataset.touchLayout ?? null }))) };
    result.environment = { STYK_PYTHON: session.python ?? null, STYK_BROWSER_GPU: process.env.STYK_BROWSER_GPU ?? null, site: session.site ? { source: session.site.source, origin: session.site.origin } : null };
    return session;
  } catch (error) { await session.close(); throw error; }
}

// ---- Shared steps
const viewportRect = (page) => page.evaluate(() => { const r = document.querySelector('#viewport').getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; });
/** A hash of the stage's pixels: a clipped screenshot at a quarter of the size, never decoded. */
async function stageHash(session, clip) {
  const bytes = session.cdp
    ? (await session.cdp.send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 0.25 }, optimizeForSpeed: true })).data
    : await session.page.screenshot({ clip, type: 'png' });
  return createHash('sha1').update(bytes).digest('hex').slice(0, 16);
}
const intervalOf = (scene) => (scene.frameDelayMs ? scene.frameDelayMs : 1000 / scene.fps);
/** Shows `tick`, fitted to the stage. A timeline still settling from a touch scrub can move the playhead again: seek until it stays. */
async function showTick(session, tick) {
  for (let attempt = 0; attempt < 4; attempt++) {
    await session.page.evaluate((tick) => { window.styk.editor.seek(tick); window.styk.fit(); }, tick);
    await sleep(1000);
    if (await session.page.evaluate((tick) => Math.floor(window.styk.editor.tick) === tick, tick)) return;
  }
  throw new Error(`The playhead would not stay on tick ${tick}.`);
}
/** The tick the interaction workloads use: --tick, else the one with the most objects (found once, after playback). */
async function denseTick(session, options, result) {
  if (session.tick !== undefined) return session.tick;
  if (Number.isInteger(options.tick)) { session.tick = Math.max(0, Math.min(options.tick, result.scene.ticks - 1)); result.scene.tick = { tick: session.tick, chosenBy: '--tick' }; }
  else { const found = await appInternals(session.page, 'dense-tick'); result.internals.denseTick = found.path; session.tick = found.value.tick; result.scene.tick = { ...found.value, chosenBy: 'most objects in the evaluated frame' }; }
  return session.tick;
}
const pressUndo = async (session, limit) => {
  let presses = 0;
  while (presses < limit && await session.page.evaluate(() => window.styk.editor.canUndo)) { await session.page.keyboard.press('Control+z'); presses++; await sleep(250); }
  return { presses, clean: !(await session.page.evaluate(() => window.styk.editor.canUndo)) };
};

// ---- Workloads
async function workloadOpen(session, options, result) {
  const { page } = session, stem = path.basename(options.file, path.extname(options.file)), clip = await viewportRect(page);
  let previous = await stageHash(session, clip), still = false;
  for (let i = 0; i < 8 && !still; i++) { await sleep(120); const next = await stageHash(session, clip); still = next === previous; previous = next; }
  await page.evaluate((name) => {
    const b = window.__engineBench; b.openAt = null;
    document.querySelector('#file-input').addEventListener('change', () => { b.openAt = performance.now(); }, { capture: true, once: true });
    b.opened = new Promise((resolve) => { const check = () => { if (b.openAt !== null && !window.styk.state.importing && window.styk.editor.name === name) resolve(performance.now() - b.openAt); else requestAnimationFrame(check); }; requestAnimationFrame(check); });
    b.start({});
  }, stem);
  const started = performance.now(), changes = [], polls = [];
  let openMs = null, handedMs = null, failure = null, finished = false, finishedAt = null;
  const opening = (async () => {
    await page.locator('#file-input').setInputFiles(options.file);
    handedMs = performance.now() - started;
    await page.waitForFunction((name) => !window.styk.state.importing && window.styk.editor.name === name, stem, { timeout: options.openTimeout * 1000, polling: 'raf' });
    openMs = performance.now() - started;
  })().catch((error) => { failure = error; }).finally(() => { finished = true; });
  for (;;) {
    const hash = await stageHash(session, clip).catch(() => null), at = performance.now() - started;
    polls.push(at);
    if (hash && hash !== previous) { changes.push({ ms: round(at), hash }); previous = hash; }
    if (finished) {
      finishedAt ??= at;
      // The first frame may land a little after the import reports done; stop once the stage has been still for 0.5 s.
      if (failure || at - finishedAt > 8000 || (at - finishedAt > 500 && at - (changes.at(-1)?.ms ?? 0) > 500)) break;
    }
    await sleep(15);
  }
  await opening;
  const data = await page.evaluate(() => window.__engineBench.stop());
  if (failure) throw failure;
  const inPage = await page.evaluate(async () => ({ ms: await window.__engineBench.opened, changeAt: window.__engineBench.openAt })), inPageMs = inPage.ms;
  const stageDraws = data.presents.map((at) => round(at - inPage.changeAt)).filter((ms) => ms >= 0);
  await dismissDialogs(page);
  const scene = await appInternals(page, 'scene'), renderer = await appInternals(page, 'renderer'), settings = await appInternals(page, 'settings');
  Object.assign(result.internals, { scene: scene.path, renderer: renderer.path, settings: settings.path });
  result.scene = { name: stem, ...scene.value, frameIntervalMs: round(intervalOf(scene.value), 4) };
  result.renderer.reported = { ...renderer.value, label: await page.evaluate(() => document.querySelector('#renderer-label')?.textContent?.trim() || null) };
  result.settings = settings.value;
  const final = previous, firstFinal = changes.find((change) => change.hash === final);
  return {
    ms: round(openMs), measured: 'driver clock: from handing the file to #file-input until !styk.state.importing && styk.editor.name === <file stem> (polled every animation frame)',
    inPageMs: round(inPageMs), handOverMs: round(handedMs),
    firstFrame: {
      ms: changes[0]?.ms ?? null, measured: 'first screenshot of the #viewport region that differs from the capture before opening',
      finalFrameMs: firstFinal?.ms ?? null, lastChangeMs: changes.at(-1)?.ms ?? null, changes: changes.length, changeTimesMs: changes.slice(0, 60).map((change) => change.ms),
      stillBeforeOpen: still, pollMs: stats(differences(polls)), polls: polls.length,
      // The stage canvas alone (the canvas hook), free of the import progress the screenshots also see.
      stageDrawsMs: stageDraws.slice(0, 60), firstStageDrawAfterImportMs: stageDraws.find((ms) => ms >= inPageMs) ?? null,
      method: session.cdp ? 'CDP Page.captureScreenshot, clipped to #viewport at 0.25 scale, compared by hash' : 'Playwright page.screenshot clipped to #viewport, compared by hash',
    },
    ...summarize(data, intervalOf(scene.value)),
  };
}

async function workloadPlayback(session, options, result) {
  const interval = result.scene.frameIntervalMs, nominal = (result.scene.ticks - 1) * interval;
  const played = await session.page.evaluate(async ({ timeoutMs }) => {
    const b = window.__engineBench, { editor, state, actions } = window.styk;
    const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
    const looping = () => state.loop ?? document.querySelector('#loop-button')?.classList.contains('active') ?? false;
    let loop = 'already off';
    if (looping()) { actions['toggle-loop'](); loop = looping() ? 'still on: stopped at the wrap' : 'turned off through the toggle-loop action'; }
    // Effects preview is the stage header's toggle; it ships on.
    const effectsButton = document.querySelector('#vfx-preview');
    if (effectsButton?.getAttribute('aria-pressed') === 'false') effectsButton.click();
    const effects = effectsButton ? effectsButton.getAttribute('aria-pressed') === 'true' : null;
    let reduced = false; const reducedNote = document.querySelector('#preview-quality');
    editor.seek(0);
    await new Promise((resolve) => setTimeout(resolve, 500));
    b.start({ ticks: true });
    const playAt = performance.now();
    await actions.play();
    if (!state.playing) return { started: false, loop, data: b.stop() };
    let wrapped = false, timedOut = false, last = editor.tick;
    while (state.playing) {
      await frame();
      if (reducedNote && !reducedNote.hidden) reduced = true;
      if (editor.tick < last) { wrapped = true; break; }
      last = editor.tick;
      if (performance.now() - playAt > timeoutMs) { timedOut = true; break; }
    }
    const endAt = performance.now();
    if (state.playing) await actions.play();
    await frame(); await frame();
    return { started: true, loop, effects, reduced, wrapped, timedOut, playAt, endAt, data: b.stop() };
  }, { timeoutMs: nominal * 6 + 120000 });
  if (!played.started) throw new Error('Playback did not start (styk.state.playing stayed false after the play action).');
  const { data } = played, shown = [];
  for (let i = 0; i < data.ticks.length; i += 2) shown.push({ tick: data.ticks[i], at: data.ticks[i + 1] });
  const first = shown.findIndex((entry) => entry.tick === 0), sequence = (played.wrapped ? shown.slice(0, -1) : shown).slice(Math.max(0, first));
  const gaps = differences(sequence.map((entry) => entry.at));
  const sequential = sequence.length === result.scene.ticks && sequence.every((entry, index) => entry.tick === index);
  const skipped = []; for (let i = 1; i < sequence.length; i++) if (sequence[i].tick !== sequence[i - 1].tick + 1) skipped.push([sequence[i - 1].tick, sequence[i].tick]);
  const performanceReport = await appInternals(session.page, 'performance'); result.internals.performance = performanceReport.path;
  const wallMs = sequence.length > 1 ? sequence.at(-1).at - sequence[0].at : null;
  return {
    ticks: result.scene.ticks, presentedTicks: sequence.length, sequential, skipped: skipped.slice(0, 50), loop: played.loop, effectsPreview: played.effects, reducedPreviewShown: played.reduced,
    wrapped: played.wrapped, timedOut: played.timedOut,
    wallMs: round(wallMs), nominalMs: round(nominal), wallOverNominal: wallMs === null ? null : round(wallMs / nominal, 4),
    firstAdvanceMs: sequence.length > 1 ? round(sequence[1].at - played.playAt) : null,
    tickGaps: series(gaps), tickGapsOver2Intervals: gaps.filter((gap) => gap > 2 * interval).length,
    presented: sequence.map((entry) => [entry.tick, round(entry.at - played.playAt)]), presentedAs: '[tick, ms since the play action], sampled once per animation frame',
    quality: result.settings && { playbackQuality: result.settings.playbackQuality, fitViewOnPlayback: result.settings.fitViewOnPlayback },
    appReported: performanceReport.value?.presentation ?? null,
    ...summarize(data, interval),
  };
}

/** The Advanced timeline's grid: its box, the ruler's height and where the playhead stands. */
const timelineBox = (page) => page.evaluate(() => {
  const grid = document.querySelector('#animation-timeline .sheet-scroll'); if (!grid) return null;
  const r = grid.getBoundingClientRect(), playhead = document.querySelector('#animation-timeline .sheet-playhead')?.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height, ruler: parseFloat(getComputedStyle(grid).getPropertyValue('--sheet-ruler')) || 24, playhead: playhead ? playhead.left + playhead.width / 2 : null };
});
async function workloadScrub(session, options, result) {
  const { page, input } = session, total = result.scene.ticks, interval = result.scene.frameIntervalMs;
  const seek = async (tick) => { await page.evaluate((tick) => window.styk.editor.seek(tick), tick); await sleep(250); };
  const tickNow = () => page.evaluate(() => window.styk.editor.tick);
  await seek(0);
  let box = await timelineBox(page);
  if (!box) return { unavailable: 'No timeline grid (#animation-timeline .sheet-scroll) on screen.' };
  const shownTicks = (data) => { const ticks = []; for (let i = 0; i < data.ticks.length; i += 2) ticks.push(Math.floor(data.ticks[i])); return ticks; };
  let measured, detail;
  if (session.touch) {
    // The playhead stands in the middle and time slides under the finger: a swipe to the left goes forward.
    const y = box.top + Math.min(box.height - 12, box.ruler + 34), right = box.left + box.width * 0.82, left = box.left + box.width * 0.18;
    const swipe = async (from, to, steps) => { input.touch('touchStart', [[from, y]]); await paced(steps, (i) => input.touch('touchMove', [[from + (to - from) * (i + 1) / steps, y]])); await sleep(80); input.touch('touchEnd', []); await input.drain(); await sleep(350); };
    // Pinch the timeline to its smallest frames first: at its starting zoom the whole animation would take a
    // swipe every 150 ms to cross in 3 s.
    const middle = box.left + box.width / 2, reach = Math.min(110, box.width / 2 - 16);
    for (let pinch = 0; pinch < 2; pinch++) {
      input.touch('touchStart', [[middle - reach, y], [middle + reach, y]]);
      await paced(24, (i) => { const spread = reach * 0.22 ** ((i + 1) / 24); input.touch('touchMove', [[middle - spread, y], [middle + spread, y]]); });
      input.touch('touchEnd', []); await input.drain(); await sleep(350);
    }
    await seek(0);
    await swipe(right, right - 150, 30);
    const moved = await tickNow();
    if (!(moved > 0)) return { unavailable: 'A 150 px swipe on the timeline grid did not move the playhead.' };
    const pxPerTick = 150 / moved, distance = (total - 1) * pxPerTick, step = distance / 180;
    await seek(0);
    const leg = async (direction) => {
      let x = direction > 0 ? right : left, down = false, lifts = 0;
      const sent = await paced(180, () => {
        if (!down) { input.touch('touchStart', [[x, y]]); down = true; return; }
        x -= direction * step;
        if (x < left || x > right) { x = Math.max(left, Math.min(right, x)); input.touch('touchMove', [[x, y]]); input.touch('touchEnd', []); down = false; lifts++; x = direction > 0 ? right : left; return; }
        input.touch('touchMove', [[x, y]]);
      });
      if (down) input.touch('touchEnd', []);
      return { ...sent, lifts };
    };
    let forward, back, reached;
    measured = await measure(session, { ticks: true, inputs: true }, async () => { forward = await leg(1); await input.drain(); await sleep(200); reached = await tickNow(); back = await leg(-1); return { events: forward.events + back.events, hertz: 60, sendMs: round(forward.sendMs + back.sendMs), lateSends: forward.lateSends + back.lateSends }; }, 400);
    detail = { gesture: 'touch swipes on the timeline grid, forward then back, 3 s each way', pxPerTick: round(pxPerTick), swipes: [forward.lifts + 1, back.lifts + 1], tickAfterForward: reached };
  } else {
    // Fit the whole animation in the grid (Ctrl+wheel zooms the timeline), then drag along the ruler.
    const at = async (tick) => { await page.evaluate((tick) => window.styk.editor.seek(tick), tick); await sleep(120); return timelineBox(page); };
    const calibrate = async () => { const one = (await at(Math.min(1, total - 1))).playhead; box = await at(0); return total > 1 ? one - box.playhead : 14; };
    let pxPerTick = await calibrate(), zoomEvents = 0;
    const room = box.width - 24;
    // Small wheel steps, measured after each pair, so the animation ends up filling the grid instead of a corner of it.
    while ((total - 1) * pxPerTick > room && zoomEvents < 120) {
      await input.control(true);
      for (let i = 0; i < 2; i++) { input.wheel(box.left + 60, box.top + box.ruler + 20, 0, 30, true); await input.drain(); await sleep(30); zoomEvents++; }
      await input.control(false);
      const next = await calibrate();
      if (Math.abs(next - pxPerTick) < 1e-6) break;
      pxPerTick = next;
    }
    if (box.playhead === null || !(pxPerTick > 0)) return { unavailable: 'The timeline playhead could not be located.' };
    const y = box.top + box.ruler / 2, first = box.playhead, end = Math.min(first + (total - 1) * pxPerTick, box.left + box.width - 4), fits = first + (total - 1) * pxPerTick <= box.left + box.width - 4;
    // Zoomed out, the first frames lie under the divider of the layer names: press on the first pixel that is the
    // grid's own, then come back all the way to the first frame (the grid keeps the pointer once it is pressed).
    const press = await page.evaluate(({ x, y }) => { for (let dx = 0; dx <= 40; dx++) if (document.elementFromPoint(x + dx, y)?.classList.contains('sheet-scroll')) return x + dx; return null; }, { x: first, y });
    if (press === null) return { unavailable: 'The timeline ruler is covered at the first frame.' };
    input.move(press, y); await input.drain(); await sleep(100);
    measured = await measure(session, { ticks: true, inputs: true }, async () => {
      input.down(press, y);
      const sent = await paced(360, (i) => input.move(i < 180 ? press + (end - press) * (i + 1) / 180 : end - (end - first) * (i - 179) / 180, y, true));
      input.up(first, y);
      return sent;
    }, 400);
    detail = { gesture: 'mouse drag along the timeline ruler, first frame → last → first, 3 s each way', pxPerTick: round(pxPerTick), timelineZoomWheels: zoomEvents, wholeAnimationInView: fits, pressedOnTick: round((press - first) / pxPerTick, 1) };
  }
  const ticks = shownTicks(measured.data), distinct = new Set(ticks);
  return { ...detail, distinctTicks: distinct.size, ticks: total, reachedLastTick: distinct.has(total - 1), endedOnTick: await tickNow(), input: measured.input,
    ...latency(measured.data, 0), ...summarize(measured.data, interval) };
}

async function workloadZoom(session, options, result) {
  const { page, input } = session, interval = result.scene.frameIntervalMs;
  await showTick(session, await denseTick(session, options, result));
  const box = await viewportRect(page), cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  const fit = await page.evaluate(() => window.styk.state.view.scale);
  let measured, gesture;
  if (session.touch) {
    // Two fingers spread 11× apart and back: the scale follows the distance between them.
    const near = 16, far = Math.min(near * 11, box.width / 2 - 12, 400);
    const fingers = (spread) => [[cx - spread, cy], [cx + spread, cy]];
    measured = await measure(session, { scale: true, inputs: true }, async () => {
      input.touch('touchStart', fingers(near));
      const sent = await paced(240, (i) => { const u = i < 120 ? (i + 1) / 120 : (240 - i - 1) / 120; input.touch('touchMove', fingers(near * (far / near) ** u)); });
      input.touch('touchEnd', []);
      return sent;
    }, 800);
    gesture = `two-finger pinch, ${near * 2} px → ${round(far * 2)} px → ${near * 2} px apart over 4 s`;
  } else {
    input.move(cx, cy); await input.drain();
    await input.control(true);
    // 240 wheel events of 4 px: about fit → 11× → fit with the app's wheel zoom (0.005 log-zoom per pixel when gliding).
    measured = await measure(session, { scale: true, inputs: true }, () => paced(240, (i) => input.wheel(cx, cy, 0, i < 120 ? -4 : 4, true)), 800);
    await input.control(false);
    gesture = 'Ctrl+wheel at the stage centre, 120 events of -4 px then 120 of +4 px over 4 s';
  }
  const range = measured.data.scale ?? [fit, fit];
  return { gesture, tick: session.tick, fitScale: round(fit, 5), scaleRange: range.map((value) => round(value, 5)), zoomReached: round(range[1] / fit, 3), input: measured.input,
    ...latency(measured.data, session.touch ? 0 : 1), ...summarize(measured.data, interval) };
}

async function workloadPan(session, options, result) {
  const { page, input } = session, interval = result.scene.frameIntervalMs;
  await showTick(session, await denseTick(session, options, result));
  const box = await viewportRect(page), cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  const scale = () => page.evaluate(() => window.styk.state.view.scale), fit = await scale();
  let measured, gesture;
  if (session.touch) {
    const fingers = (spread, dx = 0) => [[cx - spread + dx, cy], [cx + spread + dx, cy]];
    input.touch('touchStart', fingers(16));
    await paced(60, (i) => input.touch('touchMove', fingers(16 * 8 ** ((i + 1) / 60))));
    input.touch('touchEnd', []); await input.drain();
    await sleep(1500);
    const reach = Math.min(100, box.width / 2 - 60);
    measured = await measure(session, { inputs: true }, async () => {
      input.touch('touchStart', fingers(30));
      const sent = await paced(180, (i) => input.touch('touchMove', fingers(30, reach * Math.sin((i + 1) / 180 * 4 * Math.PI))));
      input.touch('touchEnd', []);
      return sent;
    }, 500);
    gesture = `two-finger drag, ±${round(reach)} px side to side twice over 3 s`;
  } else {
    input.move(cx, cy); await input.drain();
    await input.control(true);
    for (let sent = 0; sent < 400 && await scale() < fit * 8; sent += 8) { await paced(8, () => input.wheel(cx, cy, 0, -4, true)); await input.drain(); }
    await input.control(false);
    await sleep(1500);
    measured = await measure(session, { inputs: true }, () => paced(180, (i) => input.wheel(cx, cy, Math.sin(i / 180 * 4 * Math.PI) > 0 ? 30 : -30, 0, false)), 500);
    gesture = 'wheel pan at the stage centre, 30 px per event, two sweeps each way over 3 s';
  }
  const zoomed = await scale();
  return { gesture, tick: session.tick, fitScale: round(fit, 5), panScale: round(zoomed, 5), zoomReached: round(zoomed / fit, 3), input: measured.input,
    ...latency(measured.data, session.touch ? 0 : 1), ...summarize(measured.data, interval) };
}

async function workloadDrag(session, options, result) {
  const { page, input } = session, interval = result.scene.frameIntervalMs;
  await showTick(session, await denseTick(session, options, result));
  // The handle is dragged round a circle to its left: 40 px in radius, less on a stage too small for that.
  const clip = await viewportRect(page), radius = Math.round(Math.max(12, Math.min(40, clip.height * 0.14, clip.width * 0.1)));
  const room = { left: radius * 2 + 12, right: 36, top: radius + 12, bottom: radius + 36 };
  const before = await appInternals(page, 'drag-state'), figures = await appInternals(page, 'target-figures');
  Object.assign(result.internals, { dragState: before.path, targetFigure: figures.path });
  const press = (x, y) => (session.touch ? input.touch('touchStart', [[x, y]]) : input.down(x, y));
  const moveTo = (x, y) => (session.touch ? input.touch('touchMove', [[x, y]]) : input.move(x, y, true));
  const release = (x, y) => (session.touch ? input.touch('touchEnd', []) : input.up(x, y));
  const cancel = async (x, y) => { await page.keyboard.press('Escape'); release(x, y); await input.drain(); await sleep(200); };
  // The figure with the most segments that has a movable joint handle on screen which a press really grabs.
  const candidates = figures.value ?? [{ uid: null, segments: null }];
  let handle = null, figure = null, picked = null, tried = 0;
  for (const [index, entry] of candidates.entries()) {
    const handles = await appInternals(page, 'joint-handles', { uid: entry.uid, room, last: index === candidates.length - 1 });
    result.internals.jointHandle = handles.path;
    for (const candidate of (handles.value ?? []).slice(0, 6)) {
      tried++;
      if (!session.touch) { input.move(candidate.x, candidate.y); await input.drain(); await sleep(80); }
      press(candidate.x, candidate.y); await input.drain(); await sleep(80);
      picked = (await appInternals(page, 'drag-state')).value;
      // Where the app says what a press grabbed, insist on a pose drag of this figure; otherwise take the press as it is.
      if (before.path.startsWith('fallback') || candidate.joint === null || (picked.kind === 'pose' && picked.selectedUid === entry.uid)) { handle = candidate; figure = { ...entry, rank: index + 1 }; break; }
      await cancel(candidate.x, candidate.y);
      if (!before.value.canUndo) await pressUndo(session, 2);
    }
    if (handle) break;
  }
  if (!handle) return { unavailable: `No joint handle of the ${candidates.length} largest figures could be grabbed at tick ${session.tick} (${tried} tried).`, tick: session.tick };
  const pressedHash = await stageHash(session, clip);
  const centre = { x: handle.x - radius, y: handle.y };
  const measured = await measure(session, { inputs: true }, () => paced(180, (i) => { const angle = (i + 1) / 180 * 4 * Math.PI; moveTo(centre.x + radius * Math.cos(angle), centre.y + radius * Math.sin(angle)); }), 200);
  moveTo(handle.x + 24, handle.y + 24); await input.drain(); await sleep(250);
  const during = (await appInternals(page, 'drag-state')).value, draggedHash = await stageHash(session, clip);
  await cancel(handle.x + 24, handle.y + 24);
  const undo = before.value.canUndo ? { presses: 0, clean: null } : await pressUndo(session, 3);
  await page.evaluate(() => window.styk.editor.select(null)).catch(() => {});
  return { gesture: `${session.touch ? 'one finger' : 'mouse'} drags a joint handle round a ${radius} px circle twice over 3 s, then Escape`, tick: session.tick, figure,
    handle: { joint: handle.joint, x: round(handle.x), y: round(handle.y), candidatesTried: tried }, dragKind: during.kind ?? picked?.kind ?? null, stageChanged: draggedHash !== pressedHash,
    ...(draggedHash === pressedHash || handle.joint === null ? { warning: handle.joint === null ? 'No joint handle was found: the press was at the stage centre, so this is not a pose drag.' : 'The stage looked the same after the drag: the pose may not have moved.' } : {}),
    restored: { escape: true, undoPresses: undo.presses, nothingToUndo: undo.clean }, input: measured.input, ...latency(measured.data, 0), ...summarize(measured.data, interval) };
}

async function workloadDraw(session, options, result) {
  const { page, input } = session, interval = result.scene.frameIntervalMs;
  const workspace = (mode) => page.evaluate((mode) => { const buttons = [...document.querySelectorAll(`[data-workspace-mode="${mode}"]`)]; (buttons.find((b) => b.getClientRects().length) ?? buttons[0])?.click(); return buttons.length; }, mode);
  if (!await workspace('draw')) return { unavailable: 'No Draw workspace switch ([data-workspace-mode="draw"]).' };
  await sleep(1200);
  // In Draw, the timeline's New layer button adds a drawing layer: strokes then land on an empty layer of their own.
  const layer = await page.evaluate(() => { const button = document.querySelector('#animation-timeline .sheet-new-layer button') ?? document.querySelector('[data-draw-action="new"]'); button?.click(); return button ? (button.getAttribute('aria-label') ?? 'new layer') : null; });
  await sleep(800);
  // The new layer opens its name for typing and holds no drawing at the playhead yet: leave the name, then F7
  // (Insert blank key at playhead), as a person would before painting on a later frame.
  await page.keyboard.press('Escape'); await sleep(150);
  await page.keyboard.press('F7'); await sleep(400);
  await page.evaluate(() => { const brush = document.querySelector('[data-tool="drawing-brush"]'); if (brush?.getClientRects().length) brush.click(); });
  await sleep(200);
  const box = await viewportRect(page), strokes = 5;
  const point = (stroke, u) => [box.x + box.width * (0.18 + 0.64 * (stroke % 2 ? 1 - u : u)), box.y + box.height * (0.26 + 0.12 * stroke) + Math.sin(u * 6 * Math.PI) * Math.min(28, box.height * 0.06)];
  const measured = await measure(session, { inputs: true }, async () => {
    let events = 0, sendMs = 0, lateSends = 0;
    for (let stroke = 0; stroke < strokes; stroke++) {
      const [x, y] = point(stroke, 0);
      if (session.touch) input.touch('touchStart', [[x, y]]); else { input.move(x, y); input.down(x, y); }
      const sent = await paced(60, (i) => { const [px, py] = point(stroke, (i + 1) / 60); if (session.touch) input.touch('touchMove', [[px, py]]); else input.move(px, py, true); });
      const [ex, ey] = point(stroke, 1);
      if (session.touch) input.touch('touchEnd', []); else input.up(ex, ey);
      events += sent.events; sendMs += sent.sendMs; lateSends += sent.lateSends;
      await input.drain(); await sleep(250);
    }
    return { events, hertz: 60, sendMs: round(sendMs), lateSends };
  }, 400);
  await sleep(600);
  const undo = await pressUndo(session, strokes + 4);
  await workspace('animate');
  await sleep(1000);
  return { gesture: `${strokes} brush strokes of 1 s each (${session.touch ? 'one finger' : 'mouse'}, 60 events/s) on a new drawing layer, 250 ms apart`, newLayerButton: layer, tick: await page.evaluate(() => window.styk.editor.tick),
    painted: undo.presses >= strokes, paintedHow: 'the undo history took at least one step per stroke', restored: { undoPresses: undo.presses, nothingToUndo: undo.clean }, input: measured.input, ...latency(measured.data, 0), ...summarize(measured.data, interval) };
}

async function workloadOnion(session, options, result) {
  const { page } = session, interval = result.scene.frameIntervalMs, clip = await viewportRect(page), total = result.scene.ticks;
  if (!await page.evaluate(() => typeof window.styk.actions['toggle-onion'] === 'function')) return { unavailable: 'No toggle-onion action.' };
  // Onion skins do not show on every frame. Start from the dense tick and take the first nearby tick where
  // toggling them changes the picture, so the measurement includes drawing them.
  const dense = await denseTick(session, options, result), toggle = () => page.evaluate(() => window.styk.actions['toggle-onion']());
  const candidates = Number.isInteger(options.tick) ? [dense] : [...new Set([dense, dense + 1, dense - 1, dense + 2, Math.floor(total / 2), Math.floor(total / 4), Math.floor(total * 3 / 4), 3, 1].filter((tick) => tick >= 0 && tick < total))];
  let tick = dense, visible = false, searched = 0;
  for (const candidate of candidates) {
    searched++;
    await showTick(session, candidate);
    const first = await stageHash(session, clip); await toggle(); await sleep(700);
    const second = await stageHash(session, clip); await toggle(); await sleep(300);
    if (first !== second) { tick = candidate; visible = true; break; }
  }
  if (!visible) await showTick(session, tick);
  const toggled = await page.evaluate(async ({ count }) => {
    const b = window.__engineBench, samples = [];
    const frame = () => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
    const shown = () => Boolean(window.styk.state.onion ?? document.querySelector('#onion-button')?.classList.contains('active'));
    b.start({});
    for (let i = 0; i < count; i++) {
      const drawnBefore = b.presents.length, endsBefore = b.frameEnds.length, at = performance.now();
      window.styk.actions['toggle-onion']();
      let first = null, nextFrame = null;
      while (performance.now() - at < 5000 && first === null) {
        await frame();
        nextFrame ??= b.frameEnds.length > endsBefore ? b.frameEnds[endsBefore] - at : null;
        if (b.presents.length > drawnBefore) { const drawn = b.presents[drawnBefore]; const end = b.frameEnds.find((time, index) => index >= endsBefore && time >= drawn); if (end !== undefined) first = end - at; }
        else if (b.hook !== 'installed' && nextFrame !== null) break;
      }
      // Onion skins may arrive after the first frame: note when the stage was last drawn before 300 ms of quiet.
      while (performance.now() - Math.max(at, b.presents.at(-1) ?? at) < 300 && performance.now() - at < 5000) await frame();
      const lastDrawn = b.presents.length > drawnBefore ? b.presents.at(-1) : null, lastEnd = lastDrawn === null ? undefined : b.frameEnds.find((time, index) => index >= endsBefore && time >= lastDrawn);
      samples.push({ on: shown(), firstFrameMs: first, nextFrameMs: nextFrame, settledMs: lastEnd === undefined ? null : lastEnd - at, stageFrames: b.presents.length - drawnBefore });
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return { samples, data: b.stop() };
  }, { count: 10 });
  const drawn = toggled.samples.some((sample) => sample.firstFrameMs !== null), value = (sample) => (drawn ? sample.firstFrameMs : sample.nextFrameMs);
  const of = (on) => toggled.samples.filter((sample) => sample.on === on).map(value);
  return { tick, denseTick: dense, onionChangesThePicture: visible, ticksSearched: searched, toggles: toggled.samples.length, method: drawn ? 'action → end of the first animation frame in which the stage canvas was drawn' : 'action → end of the next animation frame (no stage draw observed)',
    actionToFrameMs: series(toggled.samples.map(value)), on: stats(of(true)), off: stats(of(false)), settledMs: series(toggled.samples.map((sample) => sample.settledMs)),
    samples: toggled.samples.map((sample) => ({ ...sample, firstFrameMs: round(sample.firstFrameMs), nextFrameMs: round(sample.nextFrameMs), settledMs: round(sample.settledMs) })),
    ...summarize(toggled.data, interval) };
}

/** Category of each export command in the export dialog (#export-dialog [data-category]). */
const EXPORT_CATEGORY = { 'export-png': 'frames', 'export-png-sequence': 'frames', 'export-gif': 'animated', 'export-mp4': 'video', 'export-video': 'video' };
const EXPORT_EXTENSION = { 'export-png': 'png', 'export-png-sequence': 'zip', 'export-gif': 'gif', 'export-mp4': 'mp4', 'export-video': 'webm' };
/** One export through the export dialog, as a person does it: the type, the frame range, Export. */
async function exportThroughDialog(session, options, result, action, frames) {
  const { page } = session, target = path.join(session.exports, `${action}-${Date.now()}.${EXPORT_EXTENSION[action]}`);
  const closeDialog = () => page.evaluate(() => { for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close(); });
  await page.evaluate(() => window.styk.actions.export());
  await page.waitForSelector('#export-dialog', { state: 'attached', timeout: 15000 });
  await page.evaluate((category) => document.querySelector(`#export-dialog [data-category="${category}"]`)?.click(), EXPORT_CATEGORY[action]);
  const offered = await page.waitForFunction((action) => { const option = document.querySelector(`#output-format option[value="${action}"]`); return option && !option.disabled; }, action, { timeout: 30000 }).then(() => true, () => false);
  if (!offered) {
    const reason = await page.evaluate((action) => { const option = document.querySelector(`#output-format option[value="${action}"]`); return option ? (option.title || option.textContent.trim()) : 'the export dialog does not list this type'; }, action);
    await closeDialog();
    return { action, unavailable: reason };
  }
  const chosen = await page.evaluate(({ action, frames }) => {
    const edit = (element, value) => { element.value = value; element.dispatchEvent(new Event('input', { bubbles: true })); };
    edit(document.querySelector('#output-format'), action);
    // The range fields are part of the dialog in every layout; a phone's layout folds them away, and they are set all the same.
    const from = document.querySelector('#export-start'), to = document.querySelector('#export-end'), ranged = Boolean(frames && from && to && !from.closest('[hidden]'));
    if (ranged) { edit(from, '1'); edit(to, String(frames)); }
    const submit = document.querySelector('#export-submit');
    return { ranged, from: ranged ? Number(from.value) : null, to: ranged ? Number(to.value) : null, rangeFieldsShown: Boolean(from?.getClientRects().length), canExport: Boolean(submit && !submit.disabled),
      validation: document.querySelector('#export-validation')?.textContent.trim() || null, size: document.querySelector('#export-summary-size')?.textContent.trim() || null };
  }, { action, frames });
  if (!chosen.canExport) { await closeDialog(); return { action, unavailable: chosen.validation || 'the export dialog would not export this type' }; }
  const timeout = options.exportTimeout * 1000, errorMark = session.errors.length;
  if (session.app) await session.app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, target);
  const download = session.app ? null : page.waitForEvent('download', { timeout }).catch((error) => error);
  const started = performance.now();
  await page.evaluate(() => document.querySelector('#export-submit').click());
  // The dialog closes when the export ends, written or not. One that goes back to its settings instead (Export
  // enabled again, no progress showing) was refused before it started.
  const ended = page.evaluate(async (timeout) => {
    for (const from = performance.now(); ;) {
      const dialog = document.querySelector('#export-dialog'), elapsed = performance.now() - from;
      if (!dialog) return 'closed';
      if (elapsed > 2500 && !('exporting' in dialog.dataset) && dialog.querySelector('#export-submit')?.disabled === false) return 'refused';
      if (elapsed > timeout) return 'timed out';
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }, timeout);
  let encodeMs = null;
  const failed = async (why) => { await closeDialog(); return { action, error: why, errors: session.errors.slice(errorMark) }; };
  if (session.app) {
    const outcome = await ended;
    if (outcome !== 'closed') return failed(`The export ${outcome}.`);
  } else {
    // In a browser the finished file arrives as a download; the dialog ending without one is a failed export.
    const item = await Promise.race([download, ended.then((outcome) => (outcome === 'closed' ? sleep(3000).then(() => new Error('the export dialog closed')) : new Error(`the export ${outcome}`)))]);
    if (item instanceof Error) return failed(`No file was downloaded: ${item.message.split('\n')[0]}`);
    encodeMs = performance.now() - started;
    await item.saveAs(target);
  }
  const wallMs = performance.now() - started;
  const bytes = await stat(target).then((info) => info.size, () => null);
  if (!session.app) await page.waitForFunction(() => !document.querySelector('#export-dialog'), undefined, { timeout: 15000 }).catch(() => closeDialog());
  if (bytes === null) return { action, error: 'The export finished without writing a file.', errors: session.errors.slice(errorMark) };
  const count = chosen.ranged ? chosen.to - chosen.from + 1 : (/-sequence$|gif|mp4|video/.test(action) ? result.scene.ticks : 1);
  if (!options.keepExports) await rm(target, { force: true });
  return { action, extension: EXPORT_EXTENSION[action], frames: count, range: chosen.ranged ? [chosen.from, chosen.to] : (count === 1 ? 'current frame' : 'whole animation'), rangeFieldsShown: chosen.rangeFieldsShown, wallMs: round(wallMs), encodeMs: round(encodeMs),
    framesPerSecond: round(count / (wallMs / 1000)), bytes, dialogSize: chosen.size, file: options.keepExports ? target : null,
    measured: session.app ? 'Export click → the export dialog closes (the file is committed first)' : 'Export click → the download is saved; encodeMs is click → download offered' };
}
async function workloadExport(session, options, result, kind) {
  const frames = options.exportFrames > 0 ? Math.min(options.exportFrames, result.scene.ticks) : null;
  await session.page.evaluate(() => { window.styk.editor.seek(0); });
  await sleep(300);
  if (kind === 'export-png') {
    const sequence = await exportThroughDialog(session, options, result, 'export-png-sequence', frames);
    return { ...sequence, singleFrame: await exportThroughDialog(session, options, result, 'export-png', null) };
  }
  if (kind === 'export-gif') return exportThroughDialog(session, options, result, 'export-gif', frames);
  return exportThroughDialog(session, options, result, session.app ? 'export-mp4' : 'export-video', frames);
}

// ---- A run
function baseResult(options, kind) {
  return { schema: 1, tool: 'scripts/engine-benchmark.mjs', kind, label: options.label, startedAt: new Date().toISOString(), target: options.target,
    root: options.root, git: gitState(options.root), driverGit: options.root === DRIVER_ROOT ? undefined : gitState(DRIVER_ROOT),
    host: { ...hostInfo(), loadStart: os.loadavg().map((v) => round(v)), topCpuStart: topProcesses() },
    renderer: { requested: options.renderer, setting: rendererSetting(options.renderer), reported: null }, errors: [] };
}
function configName(options) {
  const size = options.touch ? (options.width === 780 && options.height === 390 ? '' : `-${options.width}x${options.height}`) : (options.width === 1440 && options.height === 900 ? '' : `-${options.width}x${options.height}`);
  return `${options.target}-${options.renderer}-t${options.throttle}${options.touch ? '-touch' : ''}${size}`;
}
async function nextRunPath(directory) {
  await mkdir(directory, { recursive: true });
  const taken = (await readdir(directory)).map((name) => Number(/^run-(\d+)\.json$/.exec(name)?.[1])).filter(Number.isInteger);
  const index = Math.max(0, ...taken) + 1;
  return { index, file: path.join(directory, `run-${index}.json`) };
}
const outputRoot = (options) => path.resolve(options.out ?? path.join(DRIVER_ROOT, 'artifacts/engine-rust/bench'));
async function finish(result, destination, summary) {
  result.finishedAt = new Date().toISOString(); result.host.loadEnd = os.loadavg().map((v) => round(v));
  await writeFile(destination.file, `${JSON.stringify(result, null, 1)}\n`);
  console.log(`RESULT ${JSON.stringify({ ...summary, run: destination.index, json: path.relative(process.cwd(), destination.file) })}`);
}

async function runFile(options, fileInfo) {
  const idle = await waitIdle(options.waitIdle);
  const destination = await nextRunPath(path.join(outputRoot(options), options.label, configName(options), slug(path.basename(options.file))));
  const result = baseResult(options, 'workloads');
  Object.assign(result, { config: configName(options), run: destination.index, file: fileInfo, workloadsRequested: options.workloads, internals: {}, workloads: {} });
  Object.assign(result.host, { busy: idle.busy, waitedForIdleMs: idle.waitedMs, idleThreshold: options.waitIdle });
  const wants = (name) => options.workloads.includes(name);
  let session, memory;
  try {
    session = await openSession(options, result);
    session.exports = await mkdtemp(path.join(os.tmpdir(), 'styk-bench-out-'));
    result.inputThrough = session.input.kind;
    if (wants('memory')) { memory = new MemoryWatch(session.roots); memory.start(); }
    const step = async (name, work) => {
      const mark = session.errors.length, started = performance.now();
      log(`${configName(options)} ${path.basename(options.file)}: ${name}`);
      try { result.workloads[name] = { ...(await work()), errors: session.errors.slice(mark) }; }
      catch (error) { result.workloads[name] = { error: error.message.split('\n')[0], errors: session.errors.slice(mark) }; result.errors.push(`${name}: ${error.message.split('\n')[0]}`); await session.input.drain().catch(() => {}); }
      result.workloads[name].workloadMs = round(performance.now() - started);
    };
    await step('open', () => workloadOpen(session, options, result));
    if (result.workloads.open.error) throw new Error(`The file did not open: ${result.workloads.open.error}`);
    await memory?.checkpoint('after-open');
    if (wants('playback')) { await step('playback', () => workloadPlayback(session, options, result)); await memory?.checkpoint('after-playback'); }
    // Touch gestures are sent through CDP; a browser without it (WebKit) can only be driven with a mouse.
    const byHand = (work) => (session.touch && !session.input.multiTouch ? async () => ({ unavailable: 'Touch gestures need CDP input, which only Chromium has.' }) : work);
    if (wants('scrub')) await step('scrub', byHand(() => workloadScrub(session, options, result)));
    if (wants('zoom')) await step('zoom', byHand(() => workloadZoom(session, options, result)));
    if (wants('pan')) await step('pan', byHand(() => workloadPan(session, options, result)));
    if (wants('drag')) await step('drag', byHand(() => workloadDrag(session, options, result)));
    if (wants('draw')) await step('draw', byHand(() => workloadDraw(session, options, result)));
    if (wants('onion')) await step('onion', () => workloadOnion(session, options, result));
    for (const kind of ['export-png', 'export-gif', 'export-video']) if (wants(kind)) await step(kind, () => workloadExport(session, options, result, kind));
    if (memory) { await memory.checkpoint('end'); result.workloads.memory = memory.report(); }
    const renderer = await appInternals(session.page, 'renderer');
    result.renderer.reportedAtEnd = renderer.value;
  } catch (error) {
    result.errors.push(error.message.split('\n')[0]);
    if (!session) { result.launchError = error.message.slice(0, 4000); if (error.missingLibraries) result.missingLibraries = error.missingLibraries; }
    if (session?.stderr) result.launchLog = session.stderr();
  } finally {
    memory?.stop();
    if (session) { result.errors.push(...session.errors.filter((message) => !Object.values(result.workloads).some((workload) => workload.errors?.includes(message)))); if (session.exports && !options.keepExports) await removeDirectory(session.exports); await session.close(); }
  }
  const w = result.workloads, pick = (name, read) => (w[name] && !w[name].error && !w[name].unavailable ? read(w[name]) : w[name] ? (w[name].error ? { error: w[name].error } : { unavailable: w[name].unavailable }) : undefined);
  const gesture = (name) => pick(name, (x) => ({ rafP95: x.rafGaps.p95, rafMax: x.rafGaps.max, longTasks: x.longTasks.count, longMaxMs: x.longTasks.maxMs, latencyP95: x.latencyMs?.p95 }));
  const exported = (name) => pick(name, (x) => ({ action: x.action, frames: x.frames, wallMs: x.wallMs, fps: x.framesPerSecond, bytes: x.bytes }));
  await finish(result, destination, { label: options.label, config: result.config, file: path.basename(options.file), renderer: result.renderer.reported?.backend ?? null, busy: idle.busy,
    open: pick('open', (x) => ({ ms: x.ms, firstFrameMs: x.firstFrame.ms, finalFrameMs: x.firstFrame.finalFrameMs })),
    playback: pick('playback', (x) => ({ sequential: x.sequential, wallMs: x.wallMs, nominalMs: x.nominalMs, gapP95: x.tickGaps.p95, gapMax: x.tickGaps.max, over2: x.tickGapsOver2Intervals, longTasks: x.longTasks.count })),
    scrub: pick('scrub', (x) => ({ distinctTicks: x.distinctTicks, rafP95: x.rafGaps.p95, rafMax: x.rafGaps.max, longTasks: x.longTasks.count })),
    zoom: gesture('zoom'), pan: gesture('pan'), drag: gesture('drag'), draw: gesture('draw'),
    onion: pick('onion', (x) => ({ p50: x.actionToFrameMs.p50, max: x.actionToFrameMs.max, longTasks: x.longTasks.count })),
    exportPng: exported('export-png'), exportGif: exported('export-gif'), exportVideo: exported('export-video'),
    memory: w.memory && { afterOpenMiB: w.memory.afterOpen?.rssMiB, afterPlaybackMiB: w.memory.afterPlayback?.rssMiB, endMiB: w.memory.end?.rssMiB, peakMiB: w.memory.peakRssMiB, gpuMiB: w.memory.gpuMemoryMiB },
    errors: result.errors.length, ...(result.errors.length ? { firstError: result.errors[0].slice(0, 300) } : {}) });
}

// ---- Cold start
async function runColdStart(options) {
  const idle = await waitIdle(options.waitIdle);
  const destination = await nextRunPath(path.join(outputRoot(options), options.label, configName(options), 'cold-start'));
  const result = baseResult(options, 'cold-start');
  Object.assign(result, { config: configName(options), run: destination.index, startupView: options.startupView });
  Object.assign(result.host, { busy: idle.busy, waitedForIdleMs: idle.waitedMs, idleThreshold: options.waitIdle });
  let session;
  try {
    const started = Date.now();
    session = options.target === 'electron' ? await launchElectron(options, { startupView: options.startupView }) : await launchWeb(options);
    const windowMs = Date.now() - started;
    let navigationStarted = started;
    if (!session.app) { navigationStarted = Date.now(); await session.page.goto(session.site.origin, { waitUntil: 'commit' }); }
    await session.page.waitForFunction(() => window.styk?.ready === true, undefined, { timeout: 120000, polling: 'raf' });
    const readyAt = Date.now();
    const paints = await session.page.evaluate(() => ({ origin: performance.timeOrigin, paint: Object.fromEntries(performance.getEntriesByType('paint').map((entry) => [entry.name, entry.startTime])) }));
    const since = session.app ? started : navigationStarted, paintAt = (name) => (paints.paint[name] === undefined ? null : round(paints.origin + paints.paint[name] - since));
    result.versions = { driverNode: process.version, ...(await session.versions()) };
    result.coldStart = {
      from: session.app ? 'spawning Electron (through Playwright, which attaches a debugger before the app starts)' : 'page.goto in a browser launched for this run, with a new profile and an empty cache',
      readyMs: readyAt - since, firstPaintMs: paintAt('first-paint'), firstContentfulPaintMs: paintAt('first-contentful-paint'),
      navigationStartMs: round(paints.origin - since), windowMs: session.app ? windowMs : null, browserLaunchMs: session.app ? null : windowMs,
      resolution: 'ready is polled once per animation frame; paint times are the browser\'s own paint timing entries', profile: 'fresh', diskCache: 'warm after the first run (the OS file cache is not dropped)',
    };
    const renderer = await appInternals(session.page, 'renderer').catch(() => null);
    result.renderer.reported = renderer?.value ?? null;
  } catch (error) { result.errors.push(error.message.split('\n')[0]); result.launchError = error.message.slice(0, 4000); if (error.missingLibraries) result.missingLibraries = error.missingLibraries; }
  finally { await session?.close(); }
  await finish(result, destination, { label: options.label, config: result.config, coldStart: result.coldStart ? { readyMs: result.coldStart.readyMs, firstPaintMs: result.coldStart.firstPaintMs, firstContentfulPaintMs: result.coldStart.firstContentfulPaintMs } : null, busy: idle.busy, errors: result.errors.length, ...(result.errors.length ? { firstError: result.errors[0].slice(0, 300) } : {}) });
}

// ---- Bundle size
async function runBundleSize(options) {
  const destination = await nextRunPath(path.join(outputRoot(options), options.label, 'bundle-size'));
  const result = baseResult(options, 'bundle-size');
  result.run = destination.index;
  const directory = options.webDir ? path.resolve(options.webDir) : path.join(options.root, 'build/web');
  try {
    if (options.build && !options.webDir) {
      log(`npm run web:build in ${options.root}`);
      const built = spawnSync('npm', ['run', 'web:build'], { cwd: options.root, encoding: 'utf8' });
      if (built.status !== 0) throw new Error(`npm run web:build failed: ${(built.stderr || built.stdout || '').trim().split('\n').slice(-3).join(' | ')}`);
      result.buildOutput = built.stdout.trim().split('\n').at(-1);
    }
    const groups = Object.fromEntries(['js', 'wasm', 'pythonRuntime', 'other'].map((name) => [name, { files: 0, bytes: 0, brotli5: 0 }])), files = [];
    const group = (name) => (name.startsWith('vendor/pyodide/') || name.startsWith('python/') ? 'pythonRuntime' : name.endsWith('.wasm') ? 'wasm' : /\.(mjs|js)$/.test(name) ? 'js' : 'other');
    for (const name of (await readdir(directory, { recursive: true })).sort()) {
      const file = path.join(directory, name);
      if (!(await stat(file)).isFile()) continue;
      const bytes = await readFile(file), compressed = zlib.brotliCompressSync(bytes, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: bytes.length } }).length;
      const entry = groups[group(name.split(path.sep).join('/'))];
      entry.files++; entry.bytes += bytes.length; entry.brotli5 += compressed;
      files.push({ name: name.split(path.sep).join('/'), bytes: bytes.length, brotli5: compressed });
    }
    const total = Object.values(groups).reduce((sum, entry) => ({ files: sum.files + entry.files, bytes: sum.bytes + entry.bytes, brotli5: sum.brotli5 + entry.brotli5 }), { files: 0, bytes: 0, brotli5: 0 });
    result.bundle = { directory, built: options.build && !options.webDir, groups: { ...groups, total },
      grouping: 'pythonRuntime is vendor/pyodide/ and python/ (the Pivot codec, loaded on first use); wasm is every other .wasm; js is every other .mjs/.js; brotli5 compresses each file alone at quality 5',
      largest: files.sort((a, b) => b.bytes - a.bytes).slice(0, 15) };
  } catch (error) { result.errors.push(error.message); }
  await finish(result, destination, { label: options.label, bundle: result.bundle?.groups ?? null, errors: result.errors.length });
}

// ---- Main
async function main() {
  let options;
  try { options = parseArguments(process.argv.slice(2)); } catch (error) { console.error(`${error.message}\nSee the header of scripts/engine-benchmark.mjs for usage.`); process.exit(2); }
  if (options.help) { console.log((await readFile(fileURLToPath(import.meta.url), 'utf8')).split('\n').slice(1, 22).map((line) => line.replace(/^\/\/ ?/, '')).join('\n')); return; }
  if (options.bundleSize) { await runBundleSize(options); return; }
  try {
    if (options.coldStart) { for (let i = 0; i < options.runs; i++) await runColdStart(options); return; }
    const bytes = await readFile(options.file);
    const fileInfo = { path: options.file, name: path.basename(options.file), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    for (let i = 0; i < options.runs; i++) await runFile(options, fileInfo);
  } finally { await builtSite?.close(); }
}
await main();
