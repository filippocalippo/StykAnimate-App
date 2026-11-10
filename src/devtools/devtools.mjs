/**
 * The developer tools (developer build only; docs/DEVTOOLS.md). src/devtools-gate.mjs loads this module by URL once
 * the app is ready, and only when the developer build's early script (early.js) marked the page; the shipping build has
 * neither file.
 *
 * `start(app, owners)` builds the tools over the early script's rings: the panels and overlay (panels.mjs), the control
 * channel's operations (control.mjs) and its transport to the desktop's named pipe. `app` is `window.styk`; `owners` the
 * reads the app hands over (the engine's loader, the lazy tables' reader), since a module of the app imported from here
 * would be a second copy.
 */
import {Capture, DEVELOPER, ringEvents} from './capture.mjs';
import {createControl} from './control.mjs';
import {createPanels} from './panels.mjs';
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
  const sampler = new Sampler({app, early, engine});
  const capture = new Capture(early.ring);

  let watchers = 0, counterTimer = 0;
  const runtime = {
    app, early, sampler, capture, engine,
    /** Frames and counters are sampled only while something watches (the overlay, a capture). */
    watch(on) {
      early.watchFrames(on);
      watchers = Math.max(0, watchers + (on ? 1 : -1));
      if (watchers && !counterTimer) counterTimer = setInterval(() => { try { sampler.sampleCounters(trace); } catch { /* a read that fails skips a sample */ } }, 250);
      if (!watchers && counterTimer) { clearInterval(counterTimer); counterTimer = 0; }
    },
    recent(ms) {
      const since = performance.now() - ms, {events} = ringEvents(early.ring, Math.max(0, early.ring.total - early.ring.capacity));
      return events.filter(event => event.start >= since);
    },
    startCapture(label) { runtime.watch(true); return capture.start(label); },
    stopCapture() { const taken = capture.stop(); runtime.watch(false); return taken; },
    lateMs: () => trace.parameter('devtools.lateFrameMs', 25, {min: 8, max: 200, description: 'A display frame longer than this is late (overlay and summaries)'}),
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
  runtime.lateMs();
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
