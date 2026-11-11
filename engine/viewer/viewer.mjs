/**
 * The engine viewer: the Rust engine in a browser with nothing else around it.
 * It opens a file, plays it, zooms and pans, and measures itself. It exists to
 * check the engine on every browser backend (WebGPU, WebGL2) and to measure how
 * far a browser puts it from the native prototype; it is not the editor.
 *
 *   node scripts/engine-serve.mjs --files ~/Downloads
 *   http://127.0.0.1:47860/engine/viewer/?file=/files/name.styk&workers=4
 *
 * `window.viewer` is the automation surface used by scripts/engine-viewer-bench.mjs.
 */
import {loadEngine, defaultWorkerCount} from '/src/engine/engine.mjs';

const query = new URLSearchParams(location.search);
const $ = id => document.getElementById(id);
const canvas = $('stage'), info = $('info');
const workers = query.has('workers') ? Number(query.get('workers')) : defaultWorkerCount();
const engine = await loadEngine({workers});
const stage = await engine.createStage(canvas);

const state = {opened: null, tick: 0, playing: false, zoom: 1, pan: [0, 0], camera: true, dirty: true, playStarted: 0, playTick: 0,
  /** What the frame loop presented: `{tick, at}` per new tick, and every animation-frame time. */
  presented: [], frames: [], recording: false, late: 0};
const dpr = () => Math.max(1, Math.min(3, window.devicePixelRatio || 1));

function resize() {
  const width = Math.max(1, Math.round(canvas.clientWidth * dpr())), height = Math.max(1, Math.round(canvas.clientHeight * dpr()));
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; stage.resize(width, height); state.dirty = true; }
}
function fit() {
  if (!state.opened) return;
  const [w, h] = state.opened.canvas, margin = 48 * dpr();
  state.zoom = Math.min((canvas.width - margin) / w, (canvas.height - margin) / h);
  state.pan = [(canvas.width - w * state.zoom) / 2, (canvas.height - h * state.zoom) / 2];
  state.dirty = true;
}
/** Asks for the ticks playback or scrubbing needs next, nearest first. */
function request(lookahead = 48) {
  if (!state.opened) return;
  const total = state.opened.ticks, ticks = [];
  for (let i = 0; i <= lookahead; i++) ticks.push((state.tick + i) % total);
  engine.handle.request(state.tick, new Uint32Array(ticks));
  engine.pump();
}
async function open(bytes, name) {
  state.playing = false;
  const extension = name.split('.').pop().toLowerCase();
  const started = performance.now();
  state.opened = await engine.open(bytes, extension, name.replace(/\.[^.]+$/, ''));
  state.opened.wallMs = performance.now() - started;
  state.tick = 0;
  $('seek').max = String(state.opened.ticks - 1);
  resize(); fit(); request();
  return state.opened;
}
function loop(now) {
  requestAnimationFrame(loop);
  resize();
  if (state.recording) state.frames.push(now);
  if (!state.opened) return;
  if (state.playing) {
    // The playhead follows the clock: a tick that is not ready yet is waited for, never skipped.
    const interval = 1000 / state.opened.fps;
    const due = state.playTick + Math.floor((now - state.playStarted) / interval);
    if (due > state.tick) {
      const next = state.tick + 1;
      if (next >= state.opened.ticks) { state.playing = false; $('play').textContent = 'Play'; }
      else if (engine.handle.frame_ready(next)) { state.tick = next; state.dirty = true; request(); }
      else { state.late++; request(); }
    }
  }
  if (state.dirty) {
    const drawn = stage.render(state.tick, state.zoom, state.pan[0], state.pan[1], state.camera, state.playing, !state.playing);
    if (drawn) {
      state.dirty = false;
      if (state.recording && state.presented.at(-1)?.tick !== state.tick) state.presented.push({tick: state.tick, at: now});
      $('seek').value = String(state.tick);
    }
  }
}
function play(from = state.tick) {
  if (!state.opened) return;
  state.tick = Math.min(from, state.opened.ticks - 1);
  state.playTick = state.tick; state.playStarted = performance.now(); state.playing = true; state.dirty = true;
  $('play').textContent = 'Pause';
  request();
}
function zoomAt(x, y, factor) {
  const zoom = Math.min(1e4, Math.max(1e-3, state.zoom * factor));
  state.pan = [x - (x - state.pan[0]) * zoom / state.zoom, y - (y - state.pan[1]) * zoom / state.zoom];
  state.zoom = zoom; state.dirty = true;
}

$('file').addEventListener('change', async event => {
  const file = event.target.files[0];
  if (file) await open(new Uint8Array(await file.arrayBuffer()), file.name).catch(error => { info.textContent = String(error.message || error); });
});
$('play').addEventListener('click', () => { if (state.playing) { state.playing = false; $('play').textContent = 'Play'; state.dirty = true; } else play(state.tick >= (state.opened?.ticks ?? 1) - 1 ? 0 : state.tick); });
$('fit').addEventListener('click', fit);
$('camera').addEventListener('change', event => { state.camera = event.target.checked; state.dirty = true; });
$('seek').addEventListener('input', event => { state.playing = false; $('play').textContent = 'Play'; state.tick = Number(event.target.value); state.dirty = true; request(8); });
canvas.addEventListener('wheel', event => {
  event.preventDefault();
  const x = event.offsetX * dpr(), y = event.offsetY * dpr();
  if (event.ctrlKey || event.metaKey) zoomAt(x, y, Math.exp(-event.deltaY * 0.005));
  else { state.pan = [state.pan[0] - event.deltaX * dpr(), state.pan[1] - event.deltaY * dpr()]; state.dirty = true; }
}, {passive: false});
let drag = null;
canvas.addEventListener('pointerdown', event => { drag = [event.clientX, event.clientY]; canvas.setPointerCapture(event.pointerId); });
canvas.addEventListener('pointermove', event => {
  if (!drag) return;
  state.pan = [state.pan[0] + (event.clientX - drag[0]) * dpr(), state.pan[1] + (event.clientY - drag[1]) * dpr()];
  drag = [event.clientX, event.clientY]; state.dirty = true;
});
canvas.addEventListener('pointerup', () => { drag = null; });
new ResizeObserver(() => { resize(); state.dirty = true; }).observe(canvas);

setInterval(() => {
  if (!state.opened) { info.textContent = `${stage.backend()}\n${engine.threaded ? `${engine.workers} worker threads` : 'no worker threads (page not cross-origin isolated)'}`; return; }
  const frames = JSON.parse(engine.handle.stats()), draw = JSON.parse(stage.stats());
  info.textContent = `${state.opened.name}  ${state.opened.canvas.join('×')}  ${state.opened.fps} fps  tick ${state.tick + 1}/${state.opened.ticks}\n` +
    `${stage.backend()}  ${engine.threaded ? `${engine.workers} threads` : 'single thread'}  opened in ${state.opened.wallMs.toFixed(0)} ms\n` +
    `${draw.prims} primitives, ${draw.passes} passes  prepared ${frames.prepared} (avg ${(frames.totalMs / Math.max(1, frames.prepared)).toFixed(2)} ms, worst ${frames.worstMs.toFixed(1)} ms, ${frames.inline} here)  cache ${frames.cached} frames, ${(frames.cachedBytes / 1048576).toFixed(1)} MiB` +
    (state.opened.unsupported.length ? `\nnot drawn yet: ${state.opened.unsupported.join(', ')}` : '');
}, 250);

const quantiles = values => {
  const sorted = [...values].sort((a, b) => a - b), at = p => sorted[Math.min(sorted.length - 1, Math.round((sorted.length - 1) * p))] ?? 0;
  return {n: sorted.length, p50: +at(.5).toFixed(2), p95: +at(.95).toFixed(2), p99: +at(.99).toFixed(2), max: +(sorted.at(-1) ?? 0).toFixed(2)};
};
const gaps = times => times.slice(1).map((time, i) => time - times[i]);
const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
async function record(run) {
  state.frames = []; state.presented = []; state.recording = true;
  const long = [], observer = new PerformanceObserver(list => { for (const entry of list.getEntries()) long.push(entry.duration); });
  try { observer.observe({entryTypes: ['longtask']}); } catch { /* not every browser reports long tasks */ }
  await run();
  state.recording = false; observer.disconnect();
  return {frameGaps: quantiles(gaps(state.frames)), longTasks: quantiles(long), presented: state.presented};
}

window.viewer = {
  engine, stage, state, open, play, fit,
  async openURL(url) { return open(new Uint8Array(await (await fetch(url)).arrayBuffer()), decodeURIComponent(url.split('/').pop())); },
  /** One playback pass from the first tick: gaps between presented ticks against the frame interval. */
  async benchPlayback() {
    state.tick = 0; state.late = 0; fit(); request(); await frame();
    const result = await record(async () => { play(0); while (state.playing) await frame(); });
    const ticks = result.presented, interval = 1000 / state.opened.fps;
    const tickGaps = gaps(ticks.map(entry => entry.at));
    return {fps: state.opened.fps, intervalMs: +interval.toFixed(2), ticks: state.opened.ticks, presented: ticks.length + 1,
      sequential: ticks.every((entry, i) => i === 0 || entry.tick === ticks[i - 1].tick + 1),
      wallMs: Math.round((ticks.at(-1)?.at ?? 0) - (ticks[0]?.at ?? 0)), nominalMs: Math.round((ticks.length - 1) * interval),
      tickGaps: quantiles(tickGaps), gapsOverTwoIntervals: tickGaps.filter(gap => gap > 2 * interval).length,
      frameGaps: result.frameGaps, longTasks: result.longTasks, prepare: JSON.parse(engine.handle.stats())};
  },
  /** Zoom fit → 11× → fit over `seconds`, around the centre, one step per animation frame. */
  async benchZoom(seconds = 4) {
    fit(); await frame();
    const start = state.zoom, x = canvas.width / 2, y = canvas.height / 2;
    const result = await record(async () => {
      const began = performance.now();
      for (let now = began; now - began < seconds * 1000; now = await frame()) {
        const phase = (now - began) / (seconds * 1000), up = phase < .5 ? phase * 2 : 2 - phase * 2;
        zoomAt(x, y, start * Math.pow(11, up) / state.zoom);
      }
    });
    fit();
    return {frameGaps: result.frameGaps, longTasks: result.longTasks};
  },
  /** Pan back and forth at 8× for `seconds`. */
  async benchPan(seconds = 3) {
    fit(); zoomAt(canvas.width / 2, canvas.height / 2, 8); await frame();
    const origin = [...state.pan];
    const result = await record(async () => {
      const began = performance.now();
      for (let now = began; now - began < seconds * 1000; now = await frame()) {
        state.pan = [origin[0] + Math.sin((now - began) / 250) * 400 * dpr(), origin[1]]; state.dirty = true;
      }
    });
    fit();
    return {frameGaps: result.frameGaps, longTasks: result.longTasks};
  },
};

requestAnimationFrame(loop);
if (query.has('file')) await window.viewer.openURL(query.get('file')).catch(error => { info.textContent = String(error.message || error); });
window.viewer.ready = true;
