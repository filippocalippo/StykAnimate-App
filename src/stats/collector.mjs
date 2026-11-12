/**
 * The statistics collector of the editor (docs/STATISTICS.md, "How it flows"): it holds the session in memory and hands the
 * desktop process a fresh summary at most once a minute, and each problem and failed file operation as it happens. The
 * desktop process checks, queues and uploads them (desktop/stats.cjs).
 *
 * The browser build has no desktop bridge and collects nothing. A developer launch's page (the developer tools are present)
 * collects without sending, so the profiling command reads the same numbers.
 *
 * Off means off: while statistics are off there is no counting, no listener, no timer, and `on` is false, which the frame
 * loop checks before it calls the frame counter.
 */
import {BACKENDS, fileSizeOf, refreshOf} from './schema.mjs';
import {FrameCounter, SPAN_STAGES} from './frames.mjs';
import {SessionSummary} from './session.mjs';
import {Problems, describeError, describePanic, isProblem} from './problems.mjs';
import {formatOf, reasonOf, stageOf} from './files.mjs';
import {loadFrameTables} from './stack.mjs';
import {listenSpans, stopListening} from '../trace.mjs';
import {onEnginePanic} from '../engine/engine-panic.mjs';

const SUMMARY_EVERY_MS = 60000, TIME_EVERY_MS = 15000, INPUT_WINDOW_MS = 60000;
const MADE_WITH = /^[a-z][a-z-]{0,23}\/[0-9a-z][0-9a-z.]{0,11}$/;
/** The program that wrote a file of the kind the engine's reader names. */
const PROGRAMS = {styk: 'stykanimate', json: 'stykanimate', stkz: 'stykanimate', stykmov: 'stykanimate', piv: 'pivot', stk: 'pivot',
  nodes: 'sticknodes', nodemc: 'sticknodes', stknds: 'sticknodes'};
/** The program and format version that wrote an opened file, as `made` holds it: "pivot/5", "stykanimate/12". */
export function madeOf(kind, version) {
  const program = PROGRAMS[String(kind ?? '').toLowerCase()], made = program && Number.isFinite(Number(version)) ? `${program}/${Number(version)}` : '';
  return MADE_WITH.test(made) ? made : undefined;
}

/**
 * `app`: what the collector reads of the editor, all functions: `language()`, `mode()`, `playing()`, `activity()` (a word of
 * ACTIVITIES), `featuresOn()`, `project()` ({segments, figures, frames, fps}), `segments()`, `unsaved()`, `backend()`
 * ('WebGPU'…), `commandIds` (a Set). `bridge`: the desktop bridge, or null.
 */
export function createStats({bridge = null, app, developer = Boolean(globalThis.__STYK_DEVTOOLS__)} = {}) {
  const sends = Boolean(bridge?.getStatsState);
  const stats = {
    on: false, frames: null,
    /** The last summary built (a developer launch's tools and the tests read it). */
    lastSummary: null,
  };
  let session, problems, timers = [], unsubscribe = [], lastInput = 0, lastTime = 0, sent = 0;
  const reported = new WeakSet();
  const foreground = () => !globalThis.document?.hidden && (!globalThis.document?.hasFocus || globalThis.document.hasFocus());
  const onInput = event => { lastInput = performance.now(); stats.frames?.input(event.timeStamp); };
  const onError = event => stats.problem(event.error ?? event.message);
  const onRejection = event => stats.problem(event.reason);
  const onHidden = () => { if (globalThis.document?.hidden) flush(); };

  const send = (method, ...args) => { if (sends) void Promise.resolve(bridge[method]?.(...args)).catch(() => {}); };
  const facts = () => {
    const name = String(app.backend?.() ?? '').toLowerCase(), refresh = stats.frames?.cadence.interval;
    const backend = BACKENDS.find(word => word !== 'none' && word !== 'unknown' && name.startsWith(word)) ?? (name ? 'none' : 'unknown');
    return {backend, refresh: refresh ? refreshOf(1000 / refresh) : 'unknown'};
  };
  const passTime = () => {
    const now = performance.now(), seconds = (now - lastTime) / 1000;
    lastTime = now;
    if (!(seconds > 0) || seconds > 3600) return;
    session.time(seconds, foreground() && (now - lastInput < INPUT_WINDOW_MS || Boolean(app.playing?.())), app.mode?.());
  };
  /** Builds the summary and sends it, and the problems that changed since. */
  function flush() {
    if (!stats.on) return null;
    passTime();
    session.sawProject(app.project?.() ?? {});
    const summary = session.build({language: app.language?.() ?? 'en', unsaved: app.unsaved?.(), frames: stats.frames.summary()});
    stats.lastSummary = summary; sent = performance.now();
    send('sendStatsSession', summary, facts());
    for (const report of problems.drainChanged()) send('sendStatsReport', {...report});
    return summary;
  }

  function start() {
    if (stats.on) return;
    session = new SessionSummary({commandIds: app.commandIds}); problems = new Problems();
    stats.frames = new FrameCounter({segments: () => app.segments?.(), foreground});
    lastTime = performance.now(); lastInput = lastTime; sent = lastTime;
    listenSpans(new Set(SPAN_STAGES.keys()), stats.frames.onSpan);
    for (const name of ['pointerdown', 'pointermove', 'wheel', 'keydown']) globalThis.addEventListener?.(name, onInput, {capture: true, passive: true});
    globalThis.addEventListener?.('error', onError); globalThis.addEventListener?.('unhandledrejection', onRejection);
    globalThis.document?.addEventListener('visibilitychange', onHidden);
    globalThis.addEventListener?.('pagehide', flush);
    unsubscribe.push(onEnginePanic(panic => stats.problem(null, {panic})));
    timers.push(setInterval(passTime, TIME_EVERY_MS), setInterval(() => { if (performance.now() - sent >= SUMMARY_EVERY_MS - 1000) flush(); }, SUMMARY_EVERY_MS));
    stats.on = true;
  }
  function stop() {
    if (!stats.on) return;
    stats.on = false;
    stopListening();
    for (const name of ['pointerdown', 'pointermove', 'wheel', 'keydown']) globalThis.removeEventListener?.(name, onInput, {capture: true});
    globalThis.removeEventListener?.('error', onError); globalThis.removeEventListener?.('unhandledrejection', onRejection);
    globalThis.document?.removeEventListener('visibilitychange', onHidden);
    globalThis.removeEventListener?.('pagehide', flush);
    for (const stopped of unsubscribe) stopped();
    for (const timer of timers) clearInterval(timer);
    timers = []; unsubscribe = []; stats.frames = null; session = null; problems = null; stats.lastSummary = null;
  }
  const apply = state => { if (state?.enabled) start(); else stop(); };

  /** Starts with the desktop process's state (or, in a developer launch without one, collects locally). */
  stats.init = async () => {
    if (sends) {
      try { apply(await bridge.getStatsState()); } catch { /* statistics never keep the editor from starting */ }
      if (bridge.onStatsState) unsubscribe.push(bridge.onStatsState(apply));
    } else if (developer) start();
    return stats;
  };
  stats.flush = flush;
  stats.dispose = () => { flush(); stop(); };

  stats.command = id => { if (stats.on) session.command(id); };
  stats.feature = name => { if (stats.on) session.feature(name); };
  stats.count = (name, n = 1) => { if (stats.on) session.count(name, n); };
  stats.reach = name => { if (stats.on) session.reach(name); };
  stats.recovery = event => { if (stats.on) session.recover(event); };

  /**
   * A problem: an error (`type` error, graphics-lost, worker-stopped) or an engine panic (`{panic}`). Sent at once when it is
   * new; repeats are counted and sent with the next summary.
   */
  stats.problem = (error, {type = 'error', panic, recovered} = {}) => {
    if (!stats.on || !panic && !isProblem(error)) return;
    // One error reaches here once, however many layers report it (a failed save is also a failure the app shows).
    if (error && typeof error === 'object') { if (reported.has(error)) return; reported.add(error); }
    // What the app was doing is read now; the stack is read once the bundle's line tables are in (the first problem fetches them).
    const context = {doing: app.activity?.(), trail: [...session.trail], scene: stats.frames.scene ?? undefined, features: app.featuresOn?.(), recovered};
    session.count('problems');
    const list = problems;
    void loadFrameTables().then(() => {
      if (!stats.on || problems !== list) return;
      const report = problems.add(panic ? describePanic(panic) : describeError(error, type), context);
      if (report) send('sendStatsReport', {...report});
    }).catch(() => { /* a problem with a problem is not one more */ });
  };
  /** A lost graphics device came back. */
  stats.recovered = type => { if (stats.on) { problems.recovered(type); if (type === 'graphics-lost') session.count('graphicsBack'); } };

  /**
   * One file operation (`op`: open, save, autosave, export, recover) of `format` (a name, extension or export format), and
   * how it ended: `{ms}` succeeded, `{cancelled: true}`, or `{error, stage, bytes, kept}` failed. A failure is also a `file`
   * report and, unless a person caused it, a problem.
   */
  stats.file = (op, format, {ms = 0, error, cancelled = false, stage = 'unknown', bytes, kept, kind, version} = {}) => {
    if (!stats.on) return;
    const word = formatOf(format), made = madeOf(kind, version);
    const outcome = cancelled || error?.name === 'AbortError' ? 'cancelled' : error ? 'failed' : 'ok';
    session.file(op, word, outcome, ms, made);
    if (outcome !== 'failed') return;
    const reason = reasonOf(error);
    send('sendStatsReport', {kind: 'file', op, format: word, ...(made ? {made} : {}), size: fileSizeOf(bytes),
      ...(stats.frames.scene ? {scene: stats.frames.scene} : {}), stage: stageOf(error, stage), reason,
      ...(typeof error?.messageKey === 'string' && /^[A-Za-z][\w.]{0,119}$/.test(error.messageKey) ? {key: error.messageKey} : {}),
      ...(op === 'save' && kept ? {kept} : {}), ms: Math.min(8.64e7, Math.round(Math.max(0, ms) * 10) / 10)});
    stats.problem(error, {type: reason === 'worker-stopped' ? 'worker-stopped' : reason === 'graphics-lost' ? 'graphics-lost' : 'error'});
  };

  return stats;
}
