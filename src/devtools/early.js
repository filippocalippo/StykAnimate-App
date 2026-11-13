/*
 * StykAnimate developer tools: the part that runs before the page's own scripts (docs/DEVTOOLS.md).
 *
 * Only a developer launch runs this file: the desktop's preload script runs it in the page before any page script, and
 * the profiling runner and the browser tests add it as an initialization script. The shipping build neither ships nor
 * injects it (scripts/check-devtools-shipping.mjs proves that). It must stay a classic script with no imports.
 *
 * What it keeps from the first instant, so a hitch can be inspected after it happened:
 *   - a ring of the most recent spans, instants and counters (`globalThis.__stykTrace`, the sink src/trace.mjs writes to);
 *   - a ring of structured log lines (the console, uncaught errors and rejections);
 *   - the page's workers, with their messages in and out;
 *   - long tasks and slow input events (the browser's own measurements);
 *   - the live parameters registered so far.
 * While something watches (the overlay, the performance panel, a capture) it also records every display frame: its
 * interval, what the interface thread spent in it by phase, and how long each input waited for its frame.
 * Everything else (the panels, the overlay, the control channel) loads on demand from src/devtools/devtools.mjs.
 */
(() => {
  'use strict';
  if (typeof window === 'undefined' || window.top !== window || globalThis.__stykDevtoolsEarly) return;
  /** The developer build's mark: src/devtools-gate.mjs and src/trace.mjs check it. */
  globalThis.__STYK_DEVTOOLS__ = true;
  const now = () => performance.now();

  // --- the environment a profiling run asks for --------------------------------------------------------------------
  /**
   * A profiling run can ask this launch to behave as a smaller machine (perf/environments.mjs): live parameters'
   * starting values, and the memory and processor count the page reports. The launcher defines it before this script;
   * nothing else does, so an ordinary developer launch runs as the machine it is.
   */
  const environment = globalThis.__stykDevtoolsEnvironment ?? {};
  for (const [property, value] of [['deviceMemory', environment.deviceMemoryGiB], ['hardwareConcurrency', environment.hardwareConcurrency]]) {
    if (!Number.isFinite(value) || value <= 0) continue;
    try { Object.defineProperty(Navigator.prototype, property, {get: () => value, configurable: true}); } catch { /* the page reports the real value */ }
  }

  // --- spans -------------------------------------------------------------------------------------------------------
  /** Recent spans: start (ms, performance.now), duration (ms; -1 for an instant, -2 for a counter), name, thread, depth, value. */
  const CAPACITY = 1 << 16;
  const ring = {
    capacity: CAPACITY, head: 0, total: 0,
    start: new Float64Array(CAPACITY), duration: new Float64Array(CAPACITY), value: new Float64Array(CAPACITY),
    name: new Uint16Array(CAPACITY), thread: new Uint8Array(CAPACITY), depth: new Uint8Array(CAPACITY),
    args: new Array(CAPACITY).fill(null),
    names: [], ids: new Map(), threads: ['interface'],
  };
  const nameId = (name) => {
    let id = ring.ids.get(name);
    if (id === undefined) {
      if (ring.names.length >= 0xffff) return 0;
      id = ring.names.length; ring.names.push(String(name)); ring.ids.set(name, id);
    }
    return id;
  };
  nameId('(names exhausted)');
  const push = (name, thread, start, duration, depth, value, args) => {
    const at = ring.head;
    ring.start[at] = start; ring.duration[at] = duration; ring.value[at] = value;
    ring.name[at] = nameId(name); ring.thread[at] = thread; ring.depth[at] = depth > 255 ? 255 : depth;
    ring.args[at] = args ?? null;
    ring.head = (at + 1) % CAPACITY; ring.total++;
  };
  /** Open spans of the interface thread, innermost last. A token is the depth the span opened at, plus one. */
  const openNames = [], openStarts = [], openArgs = [];
  const listeners = new Set();
  /** The phase running now ({name, at}), or null. */
  let phase = null;
  const trace = {
    begin(name, args) {
      openNames.push(name); openStarts.push(now()); openArgs.push(args ?? null);
      return openNames.length;
    },
    /** Ends the span `token` began, and any left open inside it (an exception skipped their end). */
    end(token, args) {
      if (!(token > 0) || token > openNames.length) return;
      const ended = now();
      while (openNames.length >= token) {
        const depth = openNames.length - 1, name = openNames.pop(), started = openStarts.pop(), opened = openArgs.pop();
        push(name, 0, started, ended - started, depth, 0, openNames.length + 1 === token && args ? {...opened, ...args} : opened);
      }
      for (const listener of listeners) listener('span');
    },
    /** A span measured elsewhere (another thread, or an engine timing): `thread` is a name, `start` in performance.now ms. */
    complete(name, start, duration, args, thread = 'interface') { push(name, threadId(thread), start, duration, 0, 0, args); },
    /** A span of the interface thread measured by its caller, placed inside the spans open now (the engine boundary meter's). */
    nested(name, start, duration, args) { push(name, 0, start, duration, openNames.length, 0, args); },
    /** Ends the phase before and begins `name` (src/trace.mjs `tracePhase`): spans of the `phases` lane, one after another. */
    phase(name) {
      const at = now();
      if (phase) push(phase.name, threadId('phases'), phase.at, at - phase.at, 0, 0, null);
      phase = name ? {name, at} : null;
    },
    instant(name, args) { push(name, 0, now(), -1, openNames.length, 0, args); },
    counter(name, value) { if (Number.isFinite(value)) push(name, 0, now(), -2, 0, value, null); },
    /** The live parameter `name` (src/trace.mjs `tuned`): its current value, registering it with its default the first time. */
    parameter(name, fallback, spec) { return parameters.read(name, fallback, spec); },
  };
  const threadId = (name) => {
    let id = ring.threads.indexOf(name);
    if (id < 0) { if (ring.threads.length >= 255) return 0; id = ring.threads.push(name) - 1; }
    return id;
  };

  // --- frames ------------------------------------------------------------------------------------------------------
  /**
   * Every display frame while something watches, whatever drew in it. Per frame: when it began (`at`), the time since
   * the frame before (`intervals`), and what the interface thread spent on it: input handlers that ran since the frame
   * before (`handlers`), animation-frame callbacks (`script`: the app's paint and its interface updates), and the
   * browser's own style, layout and paint after them (`render`, measured to the first task after the frame and so an
   * upper estimate). `inputs` is how long each input event waited until the frame that followed its handler was done.
   */
  const FRAMES = 2048, INPUTS = 2048;
  const frames = {
    intervals: new Float32Array(FRAMES), at: new Float64Array(FRAMES), handlers: new Float32Array(FRAMES), script: new Float32Array(FRAMES),
    render: new Float32Array(FRAMES), head: 0, total: 0, last: 0, watching: 0,
    inputs: {latency: new Float32Array(INPUTS), at: new Float64Array(INPUTS), head: 0, total: 0},
  };
  /**
   * What accumulates between frames: handler and callback time, and the inputs still waiting for their frame (pairs of
   * the event's own time and the time its handlers began).
   */
  const pending = {handlers: 0, script: 0, depth: 0, inputs: []};
  const nativeFrame = window.requestAnimationFrame.bind(window);
  const afterFrame = new MessageChannel();
  /** The frame whose callbacks are running or whose rendering is not over yet: {slot, sequence, began}. */
  let open = null;
  const finishFrame = (ended) => {
    const frame = open;
    open = null;
    frames.script[frame.slot] = pending.script;
    // Handlers that ran between the callbacks and the frame's end belong to the next frame, not to this one's rendering.
    frames.render[frame.slot] = Math.max(0, ended - frame.began - pending.script - pending.handlers);
    pending.script = 0;
    const inputs = frames.inputs, waiting = pending.inputs;
    let kept = 0;
    for (let index = 0; index < waiting.length; index += 2) {
      // An input handled after this frame's callbacks began is shown by the next frame.
      if (waiting[index + 1] > frame.began) { waiting[kept++] = waiting[index]; waiting[kept++] = waiting[index + 1]; continue; }
      inputs.latency[inputs.head] = ended - waiting[index]; inputs.at[inputs.head] = waiting[index];
      inputs.head = (inputs.head + 1) % INPUTS; inputs.total++;
    }
    waiting.length = kept;
  };
  // The first task after a frame's callbacks and the browser's rendering: the frame's work on this thread is over.
  afterFrame.port1.onmessage = (event) => { if (open?.sequence === event.data) finishFrame(now()); };
  /**
   * Counts its callers: each calls `watchFrames(false)` when it stops needing frames. With the tools closed nothing ticks.
   * Each start of the loop is a new generation: when the last watcher stops and another starts before the next display
   * frame (the overlay closed and the panel opened), the loop already scheduled ends instead of recording every frame twice.
   */
  let generation = 0;
  const watchFrames = (on = true) => {
    frames.watching = Math.max(0, frames.watching + (on ? 1 : -1));
    if (!on || frames.watching !== 1) return;
    frames.last = 0; open = null; pending.handlers = 0; pending.script = 0; pending.inputs.length = 0;
    const loop = ++generation;
    const tick = (time) => {
      if (!frames.watching || loop !== generation) return;
      const began = now();
      // A thread too busy to run the task between two frames: the frame before ends where this one begins.
      if (open) finishFrame(began);
      if (frames.last) {
        const interval = time - frames.last, slot = frames.head;
        push('display frame', threadId('display'), frames.last, interval, 0, 0, null);
        frames.intervals[slot] = interval; frames.at[slot] = time;
        frames.handlers[slot] = pending.handlers; frames.script[slot] = 0; frames.render[slot] = 0;
        frames.head = (slot + 1) % FRAMES; frames.total++;
        pending.handlers = 0; pending.script = 0;
        open = {slot, sequence: frames.total, began};
        afterFrame.port2.postMessage(frames.total);
      }
      frames.last = time;
      nativeFrame(tick);
    };
    nativeFrame(tick);
  };
  /** Runs `work` as a span named `name`, adding its time to `bucket` of the frame being measured (outermost calls only). */
  const timed = (name, bucket, work, self, argument) => {
    if (!frames.watching) return work.call(self, argument);
    const token = trace.begin(name), started = now();
    pending.depth++;
    try { return work.call(self, argument); }
    finally {
      if (--pending.depth === 0) pending[bucket] += now() - started;
      trace.end(token);
    }
  };
  // The app's animation-frame callbacks: its paint (src/app.mjs `loop`) and one pass of interface updates.
  window.requestAnimationFrame = (callback) => nativeFrame(time => timed('animation frame', 'script', callback, undefined, time));
  /**
   * Input handlers, timed where the browser calls them, so every listener of the app is covered without a line in it:
   * a span `on <type> (<target>)` per call, named by the kind of object the listener is on (the window, a canvas, the
   * editor, whose `change` event every edit sends), and the event's time kept until its frame is done (the input latency).
   */
  const INPUT_TYPES = new Set(['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'wheel', 'keydown', 'keyup', 'mousedown', 'mousemove', 'mouseup',
    'click', 'dblclick', 'contextmenu', 'input', 'change', 'scroll', 'dragstart', 'dragover', 'drop', 'touchstart', 'touchmove', 'touchend']);
  const LATENCY_TYPES = new Set(['pointerdown', 'pointermove', 'pointerup', 'wheel', 'keydown', 'click', 'input', 'touchmove']);
  const wrappers = new WeakMap(), spanNames = new Map();
  const captures = (options) => (typeof options === 'boolean' ? options : Boolean(options?.capture));
  /** `on <type> (<target kind>)`, made once per pair. */
  const spanName = (type, target) => {
    const kind = target?.constructor?.name || 'object';
    let byKind = spanNames.get(type);
    if (!byKind) spanNames.set(type, byKind = new Map());
    let name = byKind.get(kind);
    if (!name) byKind.set(kind, name = `on ${type} (${kind.replace(/^HTML(.+)Element$/, '$1').toLowerCase()})`);
    return name;
  };
  const nativeAdd = EventTarget.prototype.addEventListener, nativeRemove = EventTarget.prototype.removeEventListener;
  EventTarget.prototype.addEventListener = function (type, listener, options) {
    if (!INPUT_TYPES.has(type) || !listener || (typeof listener !== 'function' && typeof listener.handleEvent !== 'function')) return nativeAdd.call(this, type, listener, options);
    let byKey = wrappers.get(listener);
    if (!byKey) wrappers.set(listener, byKey = new Map());
    const key = `${type}:${captures(options)}`;
    let wrapped = byKey.get(key);
    if (!wrapped) {
      const call = typeof listener === 'function' ? listener : function (event) { return listener.handleEvent(event); };
      wrapped = function (event) { return frames.watching ? timed(spanName(type, this), 'handlers', call, this, event) : call.call(this, event); };
      byKey.set(key, wrapped);
    }
    return nativeAdd.call(this, type, wrapped, options);
  };
  EventTarget.prototype.removeEventListener = function (type, listener, options) {
    const wrapped = listener ? wrappers.get(listener)?.get(`${type}:${captures(options)}`) : null;
    return nativeRemove.call(this, type, wrapped ?? listener, options);
  };
  for (const type of LATENCY_TYPES) {
    nativeAdd.call(window, type, (event) => {
      if (frames.watching && event.isTrusted && pending.inputs.length < 1024) pending.inputs.push(event.timeStamp, now());
    }, {capture: true, passive: true});
  }

  // --- logs --------------------------------------------------------------------------------------------------------
  const LOGS = 4096;
  const logs = {rows: [], dropped: 0, sequence: 0};
  const LEVELS = ['debug', 'info', 'warn', 'error'];
  const text = (value) => {
    if (typeof value === 'string') return value;
    if (value instanceof Error) return `${value.name}: ${value.message}${value.stack ? `\n${value.stack}` : ''}`;
    try { return JSON.stringify(value); } catch { return String(value); }
  };
  /** One structured log line: `module` is the part of the app that wrote it (a "[module]" prefix names it, else "console"). */
  const log = (level, module, message, fields) => {
    const row = {seq: ++logs.sequence, at: now(), time: Date.now(), level, module, message: message.length > 4096 ? `${message.slice(0, 4093)}…` : message};
    if (fields) row.fields = fields;
    logs.rows.push(row);
    if (logs.rows.length > LOGS) { logs.rows.splice(0, logs.rows.length - LOGS); logs.dropped++; }
    for (const listener of listeners) listener('log');
  };
  const consoleLevel = {debug: 'debug', log: 'info', info: 'info', warn: 'warn', error: 'error'};
  for (const [method, level] of Object.entries(consoleLevel)) {
    const original = console[method];
    if (typeof original !== 'function') continue;
    console[method] = function (...values) {
      try {
        let module = 'console', parts = values;
        const first = typeof values[0] === 'string' ? /^\[([\w.:/-]{1,40})\]\s*/.exec(values[0]) : null;
        if (first) { module = first[1]; parts = [values[0].slice(first[0].length), ...values.slice(1)]; }
        log(level, module, parts.map(text).join(' '));
      } catch { /* a log that cannot be kept is still printed */ }
      return original.apply(this, values);
    };
  }
  window.addEventListener('error', (event) => log('error', 'uncaught', text(event.error ?? event.message), {source: event.filename, line: event.lineno}));
  window.addEventListener('unhandledrejection', (event) => log('error', 'unhandled-rejection', text(event.reason)));

  // --- workers -----------------------------------------------------------------------------------------------------
  /** The page's workers: the engine's threads, the export, codec, drawing and audio workers. */
  const workers = {rows: [], sequence: 0};
  const NativeWorker = globalThis.Worker;
  if (typeof NativeWorker === 'function') {
    const Tracked = function Worker(url, options) {
      const worker = new NativeWorker(url, options);
      const row = {id: ++workers.sequence, name: options?.name ?? '', url: String(url).replace(location.origin, ''), created: now(), terminated: null,
        sent: 0, received: 0, errors: 0, lastMessage: null};
      workers.rows.push(row);
      if (workers.rows.length > 512) {
        const ended = workers.rows.findIndex((r) => r.terminated !== null);
        workers.rows.splice(ended < 0 ? 0 : ended, 1);
      }
      const post = worker.postMessage;
      worker.postMessage = function (...args) { row.sent++; return post.apply(this, args); };
      const terminate = worker.terminate;
      worker.terminate = function () { row.terminated ??= now(); return terminate.call(this); };
      worker.addEventListener('message', () => { row.received++; row.lastMessage = now(); });
      worker.addEventListener('error', (event) => { row.errors++; log('error', `worker:${row.name || row.id}`, event.message ?? 'worker error'); });
      return worker;
    };
    Tracked.prototype = NativeWorker.prototype;
    globalThis.Worker = Tracked;
  }

  // --- the browser's own measurements ------------------------------------------------------------------------------
  const browser = {longTasks: 0, longTaskMs: 0, slowInputs: 0, worstInputMs: 0, inputs: []};
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        browser.longTasks++; browser.longTaskMs += entry.duration;
        push('long task', threadId('long tasks'), entry.startTime, entry.duration, 0, 0, null);
      }
    }).observe({type: 'longtask', buffered: true});
  } catch { /* not every engine reports long tasks */ }
  try {
    // Input to the next paint, per event: the latency a person feels.
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        browser.slowInputs++; browser.worstInputMs = Math.max(browser.worstInputMs, entry.duration);
        browser.inputs.push({type: entry.name, at: entry.startTime, ms: entry.duration, processingMs: entry.processingEnd - entry.processingStart});
        if (browser.inputs.length > 256) browser.inputs.shift();
        push(`input ${entry.name}`, threadId('input'), entry.startTime, entry.duration, 0, 0, null);
      }
    }).observe({type: 'event', durationThreshold: 16, buffered: true});
  } catch { /* event timing is Chromium's */ }

  // --- live parameters ---------------------------------------------------------------------------------------------
  /** Values worth tuning, registered where they are used (src/trace.mjs `tuned`). The shipping build reads their defaults. */
  const PROFILE_KEY = 'styk-devtools-parameters';
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(PROFILE_KEY) ?? '{}')?.current ?? {}; } catch { saved = {}; }
  // A profiling run's values come first: its launch measures them, whatever this developer profile had kept.
  if (environment.parameters && typeof environment.parameters === 'object') saved = {...saved, ...environment.parameters};
  const parameters = {
    registry: new Map(),
    read(name, fallback, spec = {}) {
      let entry = this.registry.get(name);
      if (!entry) {
        entry = {name, default: fallback, value: fallback, min: spec.min ?? null, max: spec.max ?? null, step: spec.step ?? null,
          options: spec.options ?? null, description: spec.description ?? '', reads: 0};
        if (Object.hasOwn(saved, name)) entry.value = this.clamp(entry, saved[name]);
        this.registry.set(name, entry);
        for (const listener of listeners) listener('parameter');
      }
      entry.reads++;
      return entry.value;
    },
    clamp(entry, value) {
      if (typeof entry.default === 'number') {
        let number = Number(value);
        if (!Number.isFinite(number)) return entry.value;
        if (entry.min !== null) number = Math.max(entry.min, number);
        if (entry.max !== null) number = Math.min(entry.max, number);
        if (Number.isInteger(entry.default) && entry.step === null) number = Math.round(number);
        return number;
      }
      if (typeof entry.default === 'boolean') return value === true || value === 'true' || value === 1;
      if (entry.options && !entry.options.includes(value)) return entry.value;
      return String(value);
    },
  };

  // --- the control channel before the tools load ------------------------------------------------------------------
  /**
   * Until src/devtools/devtools.mjs loads (at the end of the app's start), the desktop's control requests reach this:
   * `hello` and `logs` answer from the rings above, so an app that fails to start can still say why. The tools replace
   * this receiver when they load. Outside the desktop (no bridge from the preload script), nothing here runs.
   */
  const reply = (ticket, answer) => globalThis.__stykDevtoolsBridge?.reply(ticket, JSON.stringify(answer));
  globalThis.__stykDevtoolsReceive = (ticket, request) => {
    const id = Number.isInteger(request?.id) ? request.id : null, args = request?.args ?? {};
    if (request?.op === 'hello') reply(ticket, {id, ok: true, result: {version: 1, build: 'developer', ready: false, toolsLoaded: false, ops: ['hello', 'logs']}});
    else if (request?.op === 'logs') {
      const least = Math.max(0, LEVELS.indexOf(args.level ?? 'debug')), limit = Math.max(1, Math.min(1000, args.limit ?? 100));
      const rows = logs.rows.filter(row => row.seq > (args.since ?? 0) && LEVELS.indexOf(row.level) >= least);
      reply(ticket, {id, ok: true, result: {rows: rows.slice(-limit), matched: rows.length, last: logs.sequence, dropped: logs.dropped, early: true}});
    } else reply(ticket, {id, ok: false, error: {what: 'The app has not finished starting: only hello and logs answer yet.', where: 'devtools early script',
      input: request?.op ?? null, cause: '', hint: 'Read logs for why it has not started, or retry once it has.'}});
  };
  const announce = () => globalThis.__stykDevtoolsBridge?.ready();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', announce, {once: true});
  else announce();

  globalThis.__stykTrace = trace;
  globalThis.__stykDevtoolsEarly = {ring, frames, watchFrames, logs, log, LEVELS, workers, browser, parameters, listeners, PROFILE_KEY, environment, startedAt: now()};
  log('info', 'devtools', 'Developer build: tools ready (Ctrl+Shift+D opens them, Ctrl+Shift+O the performance overlay).');
})();
