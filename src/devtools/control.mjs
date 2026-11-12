/**
 * The control channel's operations, answered in the page (developer build only; docs/DEVTOOLS.md "Control channel").
 *
 * A request is `{id, op, args?, detail?: 'short'|'full'}`; the answer is `{id, ok: true, result}` or
 * `{id, ok: false, error: {what, where, input, cause, hint}}`. Answers are short by default; `detail: 'full'` returns more.
 * Transports (the desktop's named pipe, Playwright's page.evaluate) only carry these objects.
 *
 * The channel reads through the same narrow reads the panels use, changes the document only through the app's own actions
 * and commands (so every change is a session command with undo), and offers no way to run arbitrary code.
 */
import {analyze, perfettoTrace, ringEvents} from './capture.mjs';
import {round} from './stats.mjs';
import {commandLog, documentSummary, framePage, historyPage, treePage} from './inspector.mjs';

export const PROTOCOL_VERSION = 1;
/** Pages of trace text `trace.read` hands out. */
export const TRACE_PAGE = 256 * 1024;

class ControlError extends Error {
  constructor(what, {input = null, cause = '', hint = ''} = {}) { super(what); this.input = input; this.causeText = cause; this.hint = hint; }
}
const fail = (what, details) => { throw new ControlError(what, details); };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const frame = () => new Promise(resolve => requestAnimationFrame(() => resolve()));

/** Waits until `test()` is truthy, polling each animation frame, at most `timeoutMs`. */
export async function until(test, timeoutMs = 5000) {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const value = test();
    if (value) return value;
    if (performance.now() > deadline) return null;
    await frame();
  }
}

/** The element with focus, described for an agent. */
function focused() {
  const element = document.activeElement;
  if (!element || element === document.body) return null;
  return {tag: element.tagName.toLowerCase(), id: element.id || null, role: element.getAttribute('role'), label: element.getAttribute('aria-label') ?? element.getAttribute('title') ?? null,
    classes: String(element.className || '').slice(0, 80) || null};
}

export function createControl(runtime) {
  const {app, early, sampler, capture} = runtime;
  let lastTrace = null, markCount = 0, preparedBefore = null;
  const marks = new Map();
  const editor = () => app.editor ?? fail('The editor is not ready.', {hint: 'Wait for window.styk.ready.'});

  /** Paints until the frame on show is the document's current revision and tick. */
  const presented = (timeoutMs = 5000) => {
    const e = editor(), tick = e.tick, revision = e.revision, since = performance.now();
    app.requestRender();
    return until(() => { const p = app.state.lastEditingPresentation; return p && p.tick === tick && p.revision === revision && p.at >= since - 1 ? p : null; }, timeoutMs);
  };

  const ops = {
    hello: () => ({version: PROTOCOL_VERSION, build: 'developer', ready: Boolean(app.ready), ops: Object.keys(ops).sort()}),

    /** The document, selection, playback, view, focus and open dialogs. */
    state: (args, full) => {
      const s = app.state ?? {};
      return {
        ready: Boolean(app.ready),
        document: app.editor ? documentSummary(app.editor) : null,
        playback: {playing: Boolean(s.playing), buffering: Boolean(s.buffering), loop: Boolean(s.loop), scrubbing: Boolean(s.scrubbing)},
        view: s.view ? {x: s.view.x, y: s.view.y, scale: s.view.scale} : null,
        renderer: s.renderer?.stats ? {backend: s.renderer.stats.backend, adapter: full ? s.renderer.stats.adapter : undefined} : null,
        stage: stageRect(),
        focus: focused(),
        dialogs: [...document.querySelectorAll('dialog[open]')].map(dialog => dialog.id || dialog.className || 'dialog'),
        window: {width: innerWidth, height: innerHeight, devicePixelRatio, crossOriginIsolated: globalThis.crossOriginIsolated === true, webgpu: Boolean(navigator.gpu)},
        workspace: full ? (() => { try { return app.workspace?.state?.() ?? app.workspace?.layout ?? null; } catch { return null; } })() : undefined,
      };
    },

    metrics: (args) => sampler.snapshot(args),
    threads: (args) => ({rows: sampler.threads(args)}),
    memory: () => sampler.memory(),
    /** The calls the interface made into the engine since the last capture began (or `reset: true`), heaviest first. */
    boundary: ({limit = 40, reset = false} = {}) => {
      const rows = runtime.boundary.rows().slice(0, Math.max(1, Math.min(500, limit))).map(row => ({name: row.name, calls: row.calls, totalMs: round(row.totalMs), worstMs: round(row.worstMs)}));
      if (reset) runtime.boundary.reset();
      return {rows};
    },
    /** The machine this page runs as: what a profiling run asked it to pretend, and what the page, the engine and the stage report. */
    environment: () => ({
      asked: early.environment,
      navigator: {hardwareConcurrency: navigator.hardwareConcurrency ?? null, deviceMemoryGiB: navigator.deviceMemory ?? null, userAgent: navigator.userAgent},
      engine: runtime.engine ? {threads: runtime.engine.workers, threaded: runtime.engine.threaded, memoryMaximumBytes: runtime.engine.memoryMaximumBytes} : null,
      renderer: app.state?.renderer?.stats ? {backend: app.state.renderer.stats.backend, adapter: app.state.renderer.stats.adapter ?? null} : null,
      display: sampler.displayPeriod(),
      window: {width: innerWidth, height: innerHeight, devicePixelRatio, crossOriginIsolated: globalThis.crossOriginIsolated === true, webgpu: Boolean(navigator.gpu)},
    }),
    /**
     * The launch's milestones in milliseconds from the page's start: the document parsed, the first pixels, the engine
     * loaded, the app ready, and the steps of the app's start one after another (`phases`). `timeOrigin` is the page's
     * start as a clock time, so a launcher can add the time before it.
     */
    startup: () => {
      const navigation = performance.getEntriesByType('navigation')[0];
      const paints = Object.fromEntries(performance.getEntriesByType('paint').map(entry => [entry.name, entry.startTime]));
      const events = ringEvents(early.ring).events.filter(event => event.start <= runtime.readyAt);
      const engineLoad = events.find(event => event.name === 'engine load');
      // The app's own steps (src/trace.mjs `tracePhase`), and before the first of them the page and its scripts loading.
      const steps = events.filter(event => event.thread === 'phases').map(event => ({name: event.name.replace(/^start: /, ''), startMs: round(event.start, 1), ms: round(event.duration, 1)}));
      const longTasks = events.filter(event => event.name === 'long task');
      return {timeOrigin: performance.timeOrigin, responseEndMs: round(navigation?.responseEnd, 1), domContentLoadedMs: round(navigation?.domContentLoadedEventEnd, 1),
        firstPaintMs: round(paints['first-paint'], 1), firstContentfulPaintMs: round(paints['first-contentful-paint'], 1),
        engineLoadedMs: engineLoad ? round(engineLoad.start + engineLoad.duration, 1) : null, engineLoadMs: engineLoad ? round(engineLoad.duration, 1) : null,
        readyMs: round(runtime.readyAt, 1), phases: steps.length ? [{name: 'page and scripts', startMs: 0, ms: steps[0].startMs}, ...steps] : [],
        longTasks: {count: longTasks.length, ms: round(longTasks.reduce((total, event) => total + event.duration, 0), 1)}};
    },
    /** Measures the display's period over `frames` frames (call it while the app is idle): the budget every frame is judged against. */
    'display.period': async ({frames: count = 45} = {}) => {
      runtime.watch(true);
      try { for (let index = 0; index < Math.max(30, Math.min(600, count)); index++) await frame(); }
      finally { runtime.watch(false); }
      return sampler.displayPeriod();
    },

    /** Log lines, newest last: filtered by least level, module (substring), text (substring) and sequence. */
    logs: ({level = 'debug', module = '', text = '', since = 0, limit = 100} = {}) => {
      const least = early.LEVELS.indexOf(level);
      if (least < 0) fail(`Unknown log level ${JSON.stringify(level)}.`, {input: level, hint: `One of ${early.LEVELS.join(', ')}.`});
      const rows = filterLogs(early.logs.rows, {least, levels: early.LEVELS, module, text, since});
      return {rows: rows.slice(-Math.max(1, Math.min(1000, limit))), matched: rows.length, last: early.logs.sequence, dropped: early.logs.dropped};
    },

    'trace.start': ({label = ''} = {}) => {
      const started = capture.start(label);
      runtime.watch(true);
      preparedBefore = sampler.preparation();
      return started;
    },
    /** Ends the capture. `series: true` adds the frames as chart series; `detail: "full"` returns every span group. */
    'trace.stop': ({series = false} = {}, full) => {
      const taken = capture.stop();
      runtime.watch(false);
      const text = JSON.stringify(perfettoTrace(taken.events, {origin: taken.startedAt, metadata: {label: taken.label, startedTime: taken.startedTime}}));
      const period = sampler.displayPeriod();
      const summary = {...analyze(taken, {periodMs: period.measured ? period.periodMs : null, series}), preparation: preparationSince(preparedBefore, sampler.preparation())};
      lastTrace = {text, summary};
      return {label: taken.label, events: taken.events.length, dropped: taken.dropped, ms: Math.round(taken.stoppedAt - taken.startedAt), traceBytes: text.length,
        pages: Math.ceil(text.length / TRACE_PAGE), summary: full ? summary : shortSummary(summary)};
    },
    /** A page of the last capture's Perfetto JSON text: concatenate the pages in order. */
    'trace.read': ({page = 0} = {}) => {
      if (!lastTrace) fail('No capture has been taken.', {hint: 'Run trace.start, then trace.stop.'});
      const text = lastTrace.text.slice(page * TRACE_PAGE, (page + 1) * TRACE_PAGE);
      return {page, pages: Math.ceil(lastTrace.text.length / TRACE_PAGE), text};
    },
    /** The ring's recent events, summarized: what happened in the last `ms` (a hitch, after the fact). */
    'trace.recent': ({ms = 5000} = {}, full) => {
      const period = sampler.displayPeriod();
      const summary = analyze(runtime.recent(ms), {periodMs: period.measured ? period.periodMs : null});
      return full ? summary : shortSummary(summary);
    },

    'params.list': () => ({rows: [...early.parameters.registry.values()].map(entry => ({...entry}))}),
    'params.set': ({name, value} = {}) => {
      const entry = early.parameters.registry.get(name) ?? fail(`No live parameter is named ${JSON.stringify(name)}.`, {input: name, hint: 'params.list names them; a parameter registers when its code first runs.'});
      entry.value = early.parameters.clamp(entry, value);
      runtime.parametersChanged();
      return {name, value: entry.value};
    },
    'params.reset': ({name} = {}) => {
      for (const entry of early.parameters.registry.values()) if (!name || entry.name === name) entry.value = entry.default;
      runtime.parametersChanged();
      return {reset: name ?? 'all'};
    },
    'params.save': ({profile} = {}) => ({saved: runtime.saveProfile(profile ?? fail('Name the profile to save.', {hint: '{"profile": "fast-cache"}'}))}),
    'params.load': ({profile} = {}) => ({loaded: runtime.loadProfile(profile ?? fail('Name the profile to load.'))}),

    'doc.tree': ({path = [], cursor = 0, fetch = false} = {}) => {
      if (!Array.isArray(path) || path.length > 32) fail('The path is a list of at most 32 keys.', {input: path});
      try { return treePage(editor().report, {path, cursor, fetch}); }
      catch (error) { return fail(error.message, {input: path}); }
    },
    'doc.frame': ({cursor = 0} = {}) => framePage(editor(), {cursor}),
    'doc.history': ({cursor = 0} = {}) => historyPage(editor(), {cursor}),
    'doc.commands': ({limit = 50} = {}) => ({rows: commandLog(early.ring, {limit})}),

    /** The app's commands (the command palette's registry): id, label, enabled. */
    'command.list': ({query = '', limit = 50} = {}) => ({rows: (app.ui?.commands?.list({query, limit}) ?? []).map(row => ({id: row.id, label: row.label, enabled: row.enabled, reason: row.reason || undefined}))}),
    'command.run': ({command} = {}) => {
      const registry = app.ui?.commands ?? fail('The command registry is not ready.');
      const outcome = registry.run(command, {source: 'devtools'});
      if (!outcome.ran) fail(`The command ${JSON.stringify(command)} cannot run now.`, {input: command, cause: outcome.reason || 'disabled', hint: 'command.list shows which commands are enabled.'});
      if (outcome.error) fail(`The command ${JSON.stringify(command)} failed.`, {input: command, cause: String(outcome.error?.message ?? outcome.error)});
      return {ran: true};
    },

    /** Automation steps: the editing actions an agent needs, through the app's own objects. */
    seek: async ({tick} = {}) => {
      const e = editor();
      if (!Number.isInteger(tick) || tick < 0 || tick >= Math.max(1, e.totalTicks)) fail('Seek to a tick of the document.', {input: tick, hint: `0 to ${e.totalTicks - 1}.`});
      const started = performance.now();
      e.seek(tick);
      const shown = await presented();
      return {tick: e.tick, presentedMs: shown ? Math.round((shown.at - started) * 100) / 100 : null};
    },
    play: async ({seconds = 0} = {}) => {
      if (!app.state.playing) app.actions.play();
      if (seconds > 0) { await wait(Math.min(120, seconds) * 1000); if (app.state.playing) app.actions.play(); }
      return {playing: Boolean(app.state.playing), tick: editor().tick};
    },
    pause: () => { if (app.state.playing) app.actions.play(); return {playing: Boolean(app.state.playing), tick: editor().tick}; },
    undo: async () => { app.actions.undo(); await presented(); return {revision: editor().revision}; },
    redo: async () => { app.actions.redo(); await presented(); return {revision: editor().revision}; },
    select: async ({uid = null} = {}) => { editor().select(uid); await presented(); return {selection: [...(editor().selectedUids ?? [])]}; },
    /** Sets the view (pan and zoom) directly: `{x, y, scale}`, any of them. */
    view: async ({x, y, scale} = {}) => {
      const view = app.state.view;
      if (Number.isFinite(x)) view.x = x;
      if (Number.isFinite(y)) view.y = y;
      if (Number.isFinite(scale) && scale > 0) view.scale = scale;
      await presented();
      return {x: view.x, y: view.y, scale: view.scale};
    },
    /** Waits until the frame on show is the document's current state. */
    settle: async ({timeoutMs = 5000} = {}) => ({presented: Boolean(await presented(timeoutMs))}),
    /** Where to press to drag a joint (`kind: 'pose'`) or move a figure (`kind: 'move'`): the view is centred on it first. */
    'target.handle': ({kind = 'pose'} = {}) => handleTarget(app, kind, presented),
    /** Opens a document from a URL the page can fetch (the browser driver serves the file there). */
    open: async ({url, name} = {}) => {
      if (typeof url !== 'string' || !name) fail('Give the url to fetch and the file name.', {input: {url, name}});
      const response = await fetch(url);
      if (!response.ok) fail(`The file could not be fetched (${response.status}).`, {input: url});
      const before = app.editor?.report;
      const file = new File([await response.arrayBuffer()], name);
      const started = performance.now();
      await app.importFiles([file]);
      const opened = await until(() => app.editor.report !== before && !app.state.importing && app.editor.totalTicks > 0, 120000);
      if (!opened) fail('The document did not open within two minutes.', {input: name});
      await presented(30000);
      return {opened: true, ms: Math.round(performance.now() - started), document: documentSummary(app.editor)};
    },
    /**
     * The desktop's `open {path}` (the shell opens the file as it opens one from outside): `document.mark` notes the
     * document on show, `document.wait` waits until another one has opened and is drawn.
     */
    'document.mark': () => {
      const token = ++markCount;
      marks.set(token, {report: app.editor?.report, at: performance.now()});
      if (marks.size > 16) marks.delete(marks.keys().next().value);
      return {token};
    },
    'document.wait': async ({token, timeoutMs = 120000} = {}) => {
      const mark = marks.get(token) ?? fail('No such document mark.', {input: token, hint: 'document.mark returns one.'});
      const opened = await until(() => app.editor.report !== mark.report && !app.state.importing && app.editor.totalTicks > 0, Math.min(300000, timeoutMs));
      marks.delete(token);
      if (!opened) fail('No document opened in time.', {input: token, hint: 'Check logs for an open error.'});
      await presented(30000);
      return {opened: true, ms: Math.round(performance.now() - mark.at), document: documentSummary(app.editor)};
    },
    /** The stage's picture as a PNG data URL (the scene canvas and the overlay drawn on it). */
    screenshot: async () => {
      await presented();
      return await new Promise(resolve => requestAnimationFrame(() => {
        const scene = app.state.renderer?.canvas, overlay = document.getElementById('overlay');
        const canvas = document.createElement('canvas');
        canvas.width = scene?.width ?? 1; canvas.height = scene?.height ?? 1;
        const context = canvas.getContext('2d');
        if (scene) context.drawImage(scene, 0, 0);
        if (overlay) context.drawImage(overlay, 0, 0, canvas.width, canvas.height);
        resolve({width: canvas.width, height: canvas.height, png: canvas.toDataURL('image/png')});
      }));
    },
    /** The tools' own switches: the overlay and the panel. */
    'tools.overlay': ({visible} = {}) => ({visible: runtime.panels.overlay(visible)}),
    'tools.panel': ({visible, tab} = {}) => ({visible: runtime.panels.toggle(visible, tab)}),
  };

  /** Answers one request; never throws. */
  async function handle(request) {
    let id = null;
    try {
      if (typeof request === 'string') request = JSON.parse(request);
      id = Number.isInteger(request?.id) ? request.id : null;
      const op = ops[request?.op];
      if (!op) fail(`Unknown operation ${JSON.stringify(request?.op)}.`, {input: request?.op ?? null, hint: 'hello lists the operations.'});
      const args = request.args ?? {};
      if (args === null || typeof args !== 'object' || Array.isArray(args)) fail('args is an object.', {input: args});
      return {id, ok: true, result: await op(args, request.detail === 'full')};
    } catch (error) {
      return {id, ok: false, error: {what: String(error?.message ?? error), where: `devtools control ${request?.op ?? '(unparsed)'}`, input: error?.input ?? null,
        cause: error?.causeText || (error instanceof ControlError ? '' : String(error?.stack ?? '').split('\n').slice(0, 3).join(' | ')), hint: error?.hint ?? ''}};
    }
  }
  return {handle, ops};
}

/** The short summary: frames and inputs, the ten heaviest span groups, the five slowest spans and the eight heaviest calls into the engine. */
export function shortSummary(summary) {
  return {ms: summary.ms, frames: summary.frames, inputs: summary.inputs, spans: summary.spans.slice(0, 10), slowest: summary.slowest.slice(0, 5),
    boundary: summary.boundary?.slice(0, 8) ?? null, counters: summary.counters, ...(summary.preparation ? {preparation: summary.preparation} : {})};
}

/** What the engine's threads prepared between two reads of its counters: frames, and the mean time of one (ms). */
export function preparationSince(before, after) {
  if (!before || !after) return null;
  // The engine starts its counters afresh for a new document: what it counts then is all since.
  const since = after.prepared >= before.prepared ? before : {prepared: 0, totalMs: 0, inline: 0};
  const frames = after.prepared - since.prepared;
  return {frames, msPerFrame: frames > 0 ? round((after.totalMs - since.totalMs) / frames) : null, inline: Math.max(0, after.inline - since.inline)};
}

/** The stage's place in the window (CSS pixels): where input is aimed. */
function stageRect() {
  const rect = document.getElementById('viewport')?.getBoundingClientRect();
  return rect ? {x: rect.left, y: rect.top, width: rect.width, height: rect.height} : null;
}

export function filterLogs(rows, {least = 0, levels = ['debug', 'info', 'warn', 'error'], module = '', text = '', since = 0} = {}) {
  const moduleText = String(module).toLowerCase(), needle = String(text).toLowerCase();
  return rows.filter(row => row.seq > since && levels.indexOf(row.level) >= least
    && (!moduleText || row.module.toLowerCase().includes(moduleText)) && (!needle || row.message.toLowerCase().includes(needle)));
}

/**
 * A handle to press: the joint (or figure) with the most pose handles, centred in the view, as client coordinates. The
 * handle geometry is the app's own (the bundle keeps these modules as page entries, so this import meets the app's copy).
 */
async function handleTarget(app, kind, presented) {
  const {getPivotHandles} = await import('/src/canvas-interactions.mjs');
  const {worldToScreen} = await import('/src/renderer-geometry.mjs');
  const e = app.editor, s = app.state;
  const options = () => ({frame: e.evaluatedFrame, selectedUid: null, selectedUids: new Set(), showUnselected: true, viewScale: s.view.scale});
  const handles = getPivotHandles(e.geometry, options());
  const free = new Set(handles.filter(h => h.action === 'move' && !h.g?.obj?.join).map(h => h.uid)), counts = new Map();
  for (const h of handles) if (h.action === 'pose' && !h.static && (kind !== 'move' || free.has(h.uid))) counts.set(h.uid, (counts.get(h.uid) ?? 0) + 1);
  const uid = [...counts].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))[0]?.[0];
  const candidates = handles.filter(h => h.uid === uid && (kind === 'move' ? h.action === 'move' : h.action === 'pose' && !h.static && !h.ik && !h.connector && h.kind !== 'origin'));
  const handle = candidates[Math.floor(candidates.length / 2)];
  if (!handle) throw new ControlError('No figure on this frame has a handle to drag.', {input: kind});
  const rect = document.getElementById('viewport').getBoundingClientRect();
  const origin = worldToScreen(handle.point, {report: e.report, frame: e.evaluatedFrame, view: {...s.view, x: 0, y: 0}, cameraEnabled: false});
  s.view.x = rect.width / 2 - origin.x; s.view.y = rect.height / 2 - origin.y;
  await presented();
  const again = getPivotHandles(e.geometry, options()).find(h => h.uid === handle.uid && h.id === handle.id) ?? handle;
  const point = worldToScreen(again.point, {report: e.report, frame: e.evaluatedFrame, view: s.view, cameraEnabled: false});
  const x = rect.left + point.x, y = rect.top + point.y;
  // Whether a press there reaches the stage (a dialog or a prompt may cover it).
  const onStage = document.elementFromPoint(x, y)?.id === 'overlay';
  return {x, y, uid, joint: again.joint ?? null, kind, onStage, room: Math.min(rect.width, rect.height) / 2};
}
