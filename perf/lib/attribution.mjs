/**
 * Where the time went (docs/PERFORMANCE.md "Reading an attribution"): turns the raw recordings of one profiled pass
 * of a scenario into tables a person or an agent can act on.
 *
 *   profileAttribution   a thread's processor profile (the inspector's sampling profiler) as time per layer
 *                        (layers.mjs), per engine module, and its heaviest functions with who called them;
 *   traceAttribution     the browser's own trace as busy time per thread of every process (the page, the workers,
 *                        the graphics process, the browser), what the page's main thread did besides script (style,
 *                        layout, paint, garbage collection), and what the graphics process spent its time on.
 *
 * Both are pure: recordings in, numbers out.
 */
import {round} from '../../src/devtools/stats.mjs';
import {displayName, layerOf, LAYERS, rustModule} from './layers.mjs';

/**
 * A processor profile ({nodes, samples, timeDeltas}, times in microseconds) of the thread `thread`.
 * Returns {thread, sampledMs, busyMs, layers: [{id, title, group, ms}], modules: [{name, ms}], functions: [{name, layer, where, selfMs, callers}]}.
 * Idle time is left out of the layers; `busyMs` is everything else.
 */
export function profileAttribution(profile, thread, {functions: keep = 25} = {}) {
  const nodes = new Map(profile.nodes.map(node => [node.id, node])), parent = new Map();
  for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id);
  const self = new Map();
  let sampled = 0;
  profile.samples.forEach((id, index) => {
    const ms = (profile.timeDeltas[index] ?? 0) / 1000;
    if (ms <= 0) return;
    self.set(id, (self.get(id) ?? 0) + ms); sampled += ms;
  });
  const layers = new Map(), modules = new Map(), byFunction = new Map();
  for (const [id, ms] of self) {
    const frame = nodes.get(id).callFrame, layer = layerOf(frame);
    layers.set(layer, (layers.get(layer) ?? 0) + ms);
    if (layer === 'idle') continue;
    const module = rustModule(frame.functionName);
    if (module) modules.set(module, (modules.get(module) ?? 0) + ms);
    const key = `${frame.functionName}|${frame.url}|${frame.lineNumber}`;
    let row = byFunction.get(key);
    if (!row) byFunction.set(key, row = {frame, layer, selfMs: 0, heaviest: id, heaviestMs: 0});
    row.selfMs += ms;
    if (ms > row.heaviestMs) { row.heaviestMs = ms; row.heaviest = id; }
  }
  const idle = layers.get('idle') ?? 0;
  const where = frame => (frame.url ? `${frame.url.replace(/^[a-z-]+:\/\/[^/]*/i, '').replace(/^.*\/(src\/)/, '$1')}${frame.lineNumber >= 0 && !/wasm/.test(frame.url) ? `:${frame.lineNumber + 1}` : ''}` : '');
  /** The functions that called the node, innermost first, without the browser's own frames. */
  const callers = id => {
    const chain = [];
    for (let at = parent.get(id); at !== undefined && chain.length < 6; at = parent.get(at)) {
      const frame = nodes.get(at).callFrame;
      if (frame.functionName && !/^\((root|program|idle)\)$/.test(frame.functionName)) chain.push(displayName(frame.functionName));
    }
    return chain;
  };
  return {
    thread, sampledMs: round(sampled, 1), busyMs: round(sampled - idle, 1),
    layers: [...layers].filter(([id]) => id !== 'idle').sort((a, b) => b[1] - a[1]).map(([id, ms]) => ({id, title: LAYERS[id]?.title ?? id, group: LAYERS[id]?.group ?? 'interface', ms: round(ms, 1)})),
    modules: [...modules].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([name, ms]) => ({name, ms: round(ms, 1)})),
    functions: [...byFunction.values()].sort((a, b) => b.selfMs - a.selfMs).slice(0, keep).map(row => ({name: displayName(row.frame.functionName), layer: row.layer, where: where(row.frame),
      selfMs: round(row.selfMs, 1), callers: callers(row.heaviest)})),
  };
}

/** What the page's main thread does besides running script, by the browser's own event names. First match wins. */
const MAIN_CATEGORIES = [
  ['gc', /^(MinorGC|MajorGC|V8\.GC|BlinkGC|GCEvent)/],
  ['style', /^(UpdateLayoutTree|ScheduleStyleRecalculation|RecalculateStyles|Document::updateStyle|LocalFrameView::RunStyleAndLayoutLifecyclePhases|ParseAuthorStyleSheet|InvalidateLayout)/],
  ['layout', /^(Layout|LocalFrameView::(layout|performLayout|performPostLayoutTasks|NotifyResizeObservers)|IntersectionObserver|ResizeObserver)/],
  ['paint', /^(Paint|PrePaint|Layerize|UpdateLayer|CullRectUpdate|LocalFrameView::Run(Paint|PrePaint|CompositingInputs|Accessibility)|LayerTreeHost|Commit|CompositeLayers|ProxyMain|cc::|PaintArtifactCompositor|RasterImplementation|CommandBuffer|ImageDecode|Decode Image)/],
  ['script', /^(FunctionCall|EvaluateScript|v8\.|V8\.|FireAnimationFrame|RequestAnimationFrame|TimerFire|EventDispatch|RunMicrotasks|BlinkScheduler_PerformMicrotaskCheckpoint|XHR|WebSocket|FireIdleCallback|HandlePostMessage|AnimationFrame|WorkerThread|compile|v8\.wasm)/],
  ['messages', /^(Receive mojo message|SimpleWatcher|IPC|Mojo|MessagePort)/],
];
export const MAIN_TITLES = Object.freeze({script: 'Script (JavaScript and the engine)', style: 'Style', layout: 'Layout', paint: 'Paint and compositing', gc: 'Garbage collection', messages: 'Messages between threads', other: 'Other browser work'});

/** What the graphics process's main thread spends its time on. First match wins. */
const GPU_CATEGORIES = [
  ['interface', /^(RendererRasterWorker|RasterDecoder|RasterImplementation|GpuRasterization|ServiceTransferCache|DisplayItemList|SkiaRenderer::(Draw|Flush)|GrDirectContext|TileManager)/],
  ['stage', /^(WebGPU|Dawn|WebGPUDecoder|GLES2Decoder|GLES2Implementation|WebGL|RendererMainThread|ValidatingAbstractTextureImpl|BufferManager|TextureManager|CommandBufferStub::OnAsyncFlush$)/],
  ['present', /^(SkiaOutputSurface|SkiaOutputDevice|DXGISwapChain|DCompPresenter|DCLayerTree|Swap|Present|NativeViewGLSurface|GLSurface|DirectComposition|OverlayProcessor|Display::DrawAndSwap|BufferQueue)/],
];
export const GPU_TITLES = Object.freeze({interface: 'Rasterizing the interface (DOM)', stage: 'The stage\'s graphics commands', present: 'Presenting frames', other: 'Other'});

const categoryOf = (table, name) => { for (const [id, pattern] of table) if (pattern.test(name)) return id; return 'other'; };

/** The role of a thread, from its process's and its own name. */
function roleOf(processName, threadName) {
  if (/^Renderer/.test(processName)) {
    if (threadName === 'CrRendererMain') return 'interface thread';
    if (/DedicatedWorker/.test(threadName)) return 'worker';
    if (threadName === 'Compositor') return 'page compositor';
    return 'page helper';
  }
  if (/^GPU/.test(processName)) return threadName === 'CrGpuMain' ? 'graphics main' : threadName === 'VizCompositorThread' ? 'display compositor' : 'graphics helper';
  if (/^Browser/.test(processName)) return threadName === 'CrBrowserMain' ? 'browser main' : 'browser helper';
  return 'service';
}

/**
 * The browser's trace events of one pass (the Chrome trace format's `traceEvents`).
 * Returns {windowMs, threads: [{process, thread, role, busyMs, cpuMs}], interface: [{id, title, ms}], graphics: [{id, title, ms}], counts}.
 *
 * A thread's `busyMs` is the wall time it was running tasks (overlapping events counted once) and `cpuMs` the processor
 * time of those tasks, which leaves out time it was blocked inside one. Threads that only wait (the trace's own, the
 * vertical-sync and input-output threads) are left out.
 */
export function traceAttribution(events) {
  const processes = new Map(), threadNames = new Map(), byThread = new Map();
  let first = Infinity, last = -Infinity;
  for (const event of events) {
    if (event.ph === 'M') {
      if (event.name === 'process_name') processes.set(event.pid, event.args?.name ?? '');
      else if (event.name === 'thread_name') threadNames.set(`${event.pid}:${event.tid}`, event.args?.name ?? '');
      continue;
    }
    if (event.ph !== 'X' || !(event.dur >= 0)) continue;
    const key = `${event.pid}:${event.tid}`;
    if (!byThread.has(key)) byThread.set(key, []);
    byThread.get(key).push(event);
    if (event.ts < first) first = event.ts;
    if (event.ts + event.dur > last) last = event.ts + event.dur;
  }
  const threads = [];
  let mainKey = null, mainBusy = -1, gpuKey = null;
  const selfTimes = new Map();
  for (const [key, list] of byThread) {
    const pid = Number(key.split(':')[0]), processName = processes.get(pid) ?? '', threadName = threadNames.get(key) ?? '';
    if (/PerfettoTrace|VSync|IOThread|ChildIOThread|DevToolsHandler|tracing/i.test(threadName) || /tracing/i.test(processName)) continue;
    // Events nest: sorted by start (the longer first), a stack gives each its own time, and the outermost ones the busy time.
    list.sort((a, b) => a.ts - b.ts || b.dur - a.dur);
    const stack = [], self = new Map();
    let busy = 0, cpu = 0;
    for (const event of list) {
      while (stack.length && stack.at(-1).end <= event.ts) stack.pop();
      const end = event.ts + event.dur;
      if (!stack.length) { busy += event.dur; cpu += event.tdur ?? event.dur; }
      else { const outer = stack.at(-1); outer.self -= Math.min(event.dur, Math.max(0, outer.end - event.ts)); }
      const entry = {name: event.name, end, self: event.dur};
      stack.push(entry);
      (self.get(event.name) ?? self.set(event.name, []).get(event.name)).push(entry);
    }
    const role = roleOf(processName, threadName);
    threads.push({process: processName, thread: threadName, role, busyMs: round(busy / 1000, 1), cpuMs: round(cpu / 1000, 1)});
    selfTimes.set(key, self);
    if (role === 'interface thread' && busy > mainBusy) { mainBusy = busy; mainKey = key; }
    if (role === 'graphics main') gpuKey = key;
  }
  const categories = (key, table, titles) => {
    const totals = new Map(), self = selfTimes.get(key);
    if (!self) return [];
    for (const [name, entries] of self) {
      const category = categoryOf(table, name);
      let ms = 0;
      for (const entry of entries) ms += Math.max(0, entry.self) / 1000;
      totals.set(category, (totals.get(category) ?? 0) + ms);
    }
    return [...totals].sort((a, b) => b[1] - a[1]).map(([id, ms]) => ({id, title: titles[id] ?? id, ms: round(ms, 1)})).filter(row => row.ms > 0);
  };
  const count = name => events.reduce((total, event) => total + (event.name === name && (event.ph === 'X' || event.ph === 'I' || event.ph === 'i' || event.ph === 'b') ? 1 : 0), 0);
  return {
    windowMs: Number.isFinite(first) ? round((last - first) / 1000, 1) : 0,
    threads: threads.filter(row => row.busyMs >= .5).sort((a, b) => b.busyMs - a.busyMs),
    interface: mainKey ? categories(mainKey, MAIN_CATEGORIES, MAIN_TITLES) : [],
    graphics: gpuKey ? categories(gpuKey, GPU_CATEGORIES, GPU_TITLES) : [],
    // How often the browser did the work an interface change causes: each is a place a quiet interface saves time.
    counts: {styleRecalculations: count('UpdateLayoutTree'), layouts: count('Layout'), paints: count('Paint'), interfaceRasters: count('RasterDecoderImpl::DoRasterCHROMIUM'), garbageCollections: count('MinorGC') + count('MajorGC')},
  };
}

/** What each of the app's processes used between two reads (`App.processes()`): CPU seconds, and the memory at the end. */
export function processAttribution(before, after) {
  const earlier = new Map(before.map(row => [row.pid, row]));
  const byType = new Map();
  for (const row of after) {
    const type = {Browser: 'browser', browser: 'browser', Tab: 'page', renderer: 'page', GPU: 'graphics', Utility: 'service'}[row.type] ?? String(row.type).toLowerCase();
    const entry = byType.get(type) ?? {type, cpuMs: 0, privateBytes: null, workingSetBytes: null};
    if (Number.isFinite(row.cpuSeconds)) entry.cpuMs += (row.cpuSeconds - (earlier.get(row.pid)?.cpuSeconds ?? 0)) * 1000;
    if (Number.isFinite(row.privateBytes)) entry.privateBytes = (entry.privateBytes ?? 0) + row.privateBytes;
    if (Number.isFinite(row.workingSetBytes)) entry.workingSetBytes = (entry.workingSetBytes ?? 0) + row.workingSetBytes;
    byType.set(type, entry);
  }
  return [...byType.values()].map(row => ({...row, cpuMs: round(row.cpuMs, 1)})).sort((a, b) => b.cpuMs - a.cpuMs);
}
