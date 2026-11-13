/**
 * The developer tools (developer build only; docs/DEVTOOLS.md). src/devtools-gate.mjs loads this module by URL once
 * the app is ready, and only when the developer build's early script (early.js) marked the page; the shipping build has
 * neither file.
 *
 * `start(app, owners)` builds the tools over the early script's rings: the panels and overlay (panels/panels.mjs), the control
 * channel's operations (control.mjs) and its transport to the desktop's named pipe. `app` is `window.styk`; `owners` the
 * reads the app hands over (the engine's loader, the lazy tables' reader), since a module of the app imported from here
 * would be a second copy.
 */
import {meterBoundary} from './boundary.mjs';
import {analyze, Capture, DEVELOPER, recentEvents} from './capture.mjs';
import {createControl} from './control.mjs';
import {frameCountAt, frameWindow, inputCountAt, inputWindow} from './frames.mjs';
import {createPanels} from './panels/panels.mjs';
import {Sampler} from './sampler.mjs';
import {useTableReader} from './inspector.mjs';

export {DEVELOPER};
let started = null;

export async function start(app, owners = {}) {
  if (started) return started;
  const early = globalThis.__stykDevtoolsEarly;
  if (!early) throw new Error('The developer tools need their early script (src/devtools/early.js).');
  useTableReader(owners.tableOf);
  const engine = owners.loadEngine ? await owners.loadEngine().catch(() => null) : null;
  const trace = globalThis.__stykTrace;
  // Every call the interface makes into the engine, counted where the generated classes define them (boundary.mjs).
  const boundary = meterBoundary(engine?.boundary, early, trace);
  const sampler = new Sampler({app, early, engine, boundary});
  const capture = new Capture(early.ring, {frames: early.frames, boundary, preparation: () => sampler.preparation()});

  let watchers = 0, counterTimer = 0;
  const runtime = {
    app, early, sampler, capture, engine, boundary,
    /** When the app finished starting (performance.now ms): it starts the tools as its last step (src/devtools-gate.mjs). */
    readyAt: owners.readyAt ?? performance.now(),
    /**
     * Frames, the engine boundary and the sampler's counters are recorded only while something watches (the panel on
     * screen, the overlay, a capture): each watcher calls `watch(true)` once and `watch(false)` once. With none, nothing ticks.
     */
    watch(on) {
      early.watchFrames(on);
      watchers = Math.max(0, watchers + (on ? 1 : -1));
      const sample = () => { try { sampler.sample(trace); } catch { /* a read that fails skips a sample */ } };
      if (watchers && !counterTimer) { counterTimer = setInterval(sample, 250); sample(); }
      if (!watchers && counterTimer) { clearInterval(counterTimer); counterTimer = 0; }
    },
    /**
     * The last `ms` of the rings, shaped as a capture (capture.mjs `analyze` reads either). Frames exist only for the
     * time something watched; the calls into the engine are the boundary meter's live window (to the half second).
     */
    recent(ms) {
      const stoppedAt = performance.now(), startedAt = stoppedAt - ms;
      return {label: 'recent', startedAt, stoppedAt, startedTime: Date.now() - ms, events: recentEvents(early.ring, startedAt), dropped: 0,
        frames: frameWindow(early.frames, frameCountAt(early.frames, startedAt)), inputs: inputWindow(early.frames, inputCountAt(early.frames, startedAt)),
        boundary: boundary.recent(ms, stoppedAt), preparation: null};
    },
    startCapture(label) { const started = capture.start(label); runtime.watch(true); return started; },
    stopCapture() { const taken = capture.stop(); runtime.watch(false); return taken; },
    /**
     * A capture's summary (capture.mjs `analyze`), judged against the display's period once it has been measured (until
     * then a capture's own median frame stands for it). The control channel, the profiling runner and the panels all
     * summarize through here, so they print the same numbers.
     */
    summarize(taken, options = {}) {
      const period = sampler.displayPeriod();
      return analyze(taken, {periodMs: period.measured ? period.periodMs : null, ...options});
    },
    setParameter(name, value) {
      const entry = early.parameters.registry.get(name);
      if (!entry) return;
      entry.value = early.parameters.clamp(entry, value);
      runtime.parametersChanged();
    },
    /** Keeps the current values for the next launch and redraws (a parameter read per frame takes effect at once). */
    parametersChanged() {
      const store = readProfiles(early);
      store.current = Object.fromEntries([...early.parameters.registry.values()].filter(entry => entry.value !== entry.default).map(entry => [entry.name, entry.value]));
      writeProfiles(early, store);
      app.requestRender?.();
    },
    profiles: () => Object.keys(readProfiles(early).profiles ?? {}).sort(),
    saveProfile(name) {
      const store = readProfiles(early);
      store.profiles = {...store.profiles, [name]: Object.fromEntries([...early.parameters.registry.values()].map(entry => [entry.name, entry.value]))};
      writeProfiles(early, store);
      return name;
    },
    loadProfile(name) {
      const values = readProfiles(early).profiles?.[name];
      if (!values) throw new Error(`No parameter profile is named ${JSON.stringify(name)}.`);
      for (const [key, value] of Object.entries(values)) { const entry = early.parameters.registry.get(key); if (entry) entry.value = early.parameters.clamp(entry, value); }
      runtime.parametersChanged();
      return name;
    },
  };
  runtime.panels = createPanels(runtime);
  runtime.control = createControl(runtime);
  connectDesktop(runtime.control);
  // For Playwright and the console: the same operations the named pipe reaches.
  globalThis.stykDevtools = {request: request => runtime.control.handle(request), toggle: (on, tab) => runtime.panels.toggle(on, tab), overlay: on => runtime.panels.overlay(on), version: 1};
  early.log('info', 'devtools', `Tools loaded${engine ? '' : ' (the engine is not loaded: engine reads answer null)'}.`);
  started = runtime;
  return runtime;
}

function readProfiles(early) {
  try { return JSON.parse(localStorage.getItem(early.PROFILE_KEY) ?? '{}') ?? {}; } catch { return {}; }
}
function writeProfiles(early, store) {
  try { localStorage.setItem(early.PROFILE_KEY, JSON.stringify(store)); } catch { /* a profile that cannot be kept is still applied */ }
}

/**
 * The desktop's half of the control channel (desktop/devtools.cjs): the developer launch hands each request from its
 * named pipe to `__stykDevtoolsReceive` and takes the answer back through the bridge its preload script exposes.
 * Neither exists in a packaged app.
 */
function connectDesktop(control) {
  const bridge = globalThis.__stykDevtoolsBridge;
  if (!bridge?.reply) return;
  globalThis.__stykDevtoolsReceive = (ticket, request) => {
    void control.handle(request).then(answer => bridge.reply(ticket, JSON.stringify(answer)))
      .catch(error => console.error('[devtools] A control answer could not be returned:', error));
  };
  bridge.ready();
}
