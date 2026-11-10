/*
 * StykAnimate developer tools: the part that runs before the page's own scripts (docs/DEVTOOLS.md).
 *
 * Only the developer build runs this file: its binary injects it as the webview's initialization script, and the
 * browser tests add it with Playwright's `addInitScript`. The shipping build neither ships nor injects it
 * (scripts/check-devtools-shipping.mjs proves that). It must stay a classic script with no imports.
 *
 * What it keeps from the first instant, so a hitch can be inspected after it happened:
 *   - a ring of the most recent spans, instants and counters (`globalThis.__stykTrace`, the sink src/trace.mjs writes to);
 *   - a ring of structured log lines (the console, uncaught errors and rejections);
 *   - the page's workers, with their messages in and out;
 *   - long tasks and slow input events (the browser's own measurements);
 *   - the live parameters registered so far.
 * Everything else (the panels, the overlay, the control channel) loads on demand from src/devtools/devtools.mjs.
 */
(() => {
  'use strict';
  if (typeof window === 'undefined' || window.top !== window || globalThis.__stykDevtoolsEarly) return;
  /** The developer build's mark: src/devtools-gate.mjs and src/trace.mjs check it. */
  globalThis.__STYK_DEVTOOLS__ = true;
  const now = () => performance.now();

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
  /** Every animation frame's interval, whatever drew in it: the overlay's frame time and late frames. */
  const FRAMES = 1024;
  const frames = {intervals: new Float32Array(FRAMES), at: new Float64Array(FRAMES), head: 0, total: 0, last: 0, watching: 0};
  /** Counts its callers: each calls `watchFrames(false)` when it stops needing frames. With the tools closed nothing ticks. */
  const watchFrames = (on = true) => {
    frames.watching = Math.max(0, frames.watching + (on ? 1 : -1));
    if (!on || frames.watching !== 1) return;
    frames.last = 0;
    const tick = (time) => {
      if (!frames.watching) return;
      if (frames.last) {
        const interval = time - frames.last;
        push('display frame', threadId('display'), frames.last, interval, 0, 0, null);
        frames.intervals[frames.head] = interval; frames.at[frames.head] = time;
        frames.head = (frames.head + 1) % FRAMES; frames.total++;
      }
      frames.last = time;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };

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
        push('long task', 0, entry.startTime, entry.duration, 0, 0, null);
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
  globalThis.__stykDevtoolsEarly = {ring, frames, watchFrames, logs, log, LEVELS, workers, browser, parameters, listeners, PROFILE_KEY, startedAt: now()};
  log('info', 'devtools', 'Developer build: tools ready (Ctrl+Shift+D opens them, Ctrl+Shift+O the performance overlay).');
})();
