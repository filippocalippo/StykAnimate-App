import {messageError} from '../localized-error.mjs';
/**
 * Surface-scoped chrome updates (architecture.md §3.2). The editor chrome is a
 * list of surfaces (the title, the transport, the inspector, …), each with the
 * reasons that make it stale and the function that brings it up to date.
 * invalidate(reason) marks the surfaces that listen for the reason ('all'
 * marks every one) and schedules one pass; the pass updates the marked
 * surfaces in the order they were declared.
 *
 *   const ui = createInvalidator({isPlaying: () => state.playing});
 *   ui.surface('title', {on: ['document', 'save'], update: updateTitle});
 *   ui.surface('transport', {on: ['tick'], playbackInterval: 200, update: updateTransport});
 *   ui.surface('inspector', {on: ['selection', 'revision'], quiet: true, update: renderInspector});
 *   ui.invalidate('selection');
 *
 * Playback stays quiet:
 *   quiet             the surface is not updated while playing; it stays
 *                     marked and updates in the first pass after playback
 *                     stops (the caller invalidates when it stops).
 *   playbackInterval  while playing, at most one update per this many ms
 *                     (the transport's readout: 200 ms, 5 Hz); a marked
 *                     surface waits for its time, and one timer (not a pass
 *                     every frame) wakes the pass that updates it.
 *   visible           an optional () => boolean; a hidden surface stays
 *                     marked, and show(name) updates it when it shows.
 * afterPass runs after a pass that updated at least one surface (the app
 * repaints then); a pass that only finds surfaces waiting does not call it.
 *
 * Surfaces write through dom-write.mjs, so an update that finds nothing
 * changed writes nothing. DOM-free at import: schedule, delay and now are
 * injected (requestAnimationFrame, setTimeout and performance.now by default).
 */
export const UI_REASONS = Object.freeze(['tick', 'selection', 'revision', 'context', 'mode', 'range', 'view', 'settings',
  'document', 'save', 'objects', 'drag', 'playback']);

export function createInvalidator({
  schedule = callback => requestAnimationFrame(callback),
  delay = (callback, ms) => setTimeout(callback, ms),
  now = () => performance.now(),
  isPlaying = () => false,
  afterPass = null,
  onError = error => { throw error; },
} = {}) {
  const surfaces = [], byName = new Map();
  let scheduled = false, wakeAt = Infinity;

  const request = () => {
    if (scheduled) return;
    scheduled = true;
    schedule(pass);
  };
  /** Schedules a pass once `at` (a now() time) has come, unless an earlier wake-up is already set. */
  const wake = at => {
    if (at >= wakeAt) return;
    wakeAt = at;
    delay(() => { if (wakeAt === at) wakeAt = Infinity; request(); }, Math.max(0, at - now()));
  };
  /** Whether a surface may update now; `force` ignores quiet, visibility and the interval (a full update). */
  const ready = (surface, playing, time, force) => {
    if (force) return true;
    if (playing && surface.quiet) return false;
    if (surface.visible && !surface.visible()) return false;
    if (playing && surface.playbackInterval && time - surface.last < surface.playbackInterval) return 'later';
    return true;
  };
  const run = (surface, time) => {
    surface.dirty = false;
    surface.last = time;
    surface.updates++;
    try { surface.update(); } catch (error) { onError(error, surface.name); }
  };
  function pass({force = false} = {}) {
    scheduled = false;
    const playing = isPlaying(), time = now();
    let due = Infinity, updated = false;
    for (const surface of surfaces) {
      if (!surface.dirty && !force) continue;
      const state = ready(surface, playing, time, force);
      if (state === 'later') due = Math.min(due, surface.last + surface.playbackInterval);
      if (state === true) { run(surface, time); updated = true; }
    }
    if (due < Infinity) wake(due);
    if (updated) afterPass?.();
    return true;
  }

  return {
    /** Declares a surface; surfaces update in declaration order. */
    surface(name, {on = [], update, quiet = false, playbackInterval = 0, visible = null}) {
      if (byName.has(name)) throw messageError(new Error(''), "errors.uiInvalidation.surfaceIsAlreadyDeclared", {name: name});
      if (typeof update !== 'function') throw messageError(new TypeError(''), "errors.uiInvalidation.surfaceNeedsAnUpdateFunction", {name: name});
      for (const reason of on) if (!UI_REASONS.includes(reason)) throw messageError(new TypeError(''), "errors.uiInvalidation.unknownInvalidationReason", {reason: reason});
      const surface = {name, on: new Set(on), update, quiet, playbackInterval, visible, dirty: false, last: -Infinity, updates: 0};
      surfaces.push(surface);
      byName.set(name, surface);
      return this;
    },
    /** Marks the surfaces that listen for any of `reasons` ('all': every surface) and schedules a pass. */
    invalidate(...reasons) {
      let marked = false;
      for (const surface of surfaces) {
        if (reasons.includes('all') || reasons.some(reason => surface.on.has(reason))) { surface.dirty = true; marked = true; }
      }
      if (marked) request();
      return marked;
    },
    /**
     * Updates one surface now if it may (quiet, visibility, interval); otherwise it stays marked for a
     * later pass. A direct update is the caller's own timing (the render loop's readout).
     */
    update(name) {
      const surface = byName.get(name);
      if (!surface) throw messageError(new Error(''), "errors.uiInvalidation.unknownSurface", {name: name});
      surface.dirty = true;
      const state = ready(surface, isPlaying(), now(), false);
      if (state === true) { run(surface, now()); return true; }
      if (state === 'later') wake(surface.last + surface.playbackInterval);
      else request();
      return false;
    },
    /** Updates every surface now, marked or not, as one full refresh (startup, a restored document). */
    flushAll() { for (const surface of surfaces) surface.dirty = true; return pass({force: true}); },
    /** A surface that became visible updates now if it was marked while hidden. */
    show(name) {
      const surface = byName.get(name);
      if (surface?.dirty && ready(surface, isPlaying(), now(), false) === true) run(surface, now());
    },
    isDirty: name => Boolean(byName.get(name)?.dirty),
    /** How often each surface updated, for tests and diagnostics. */
    stats: () => Object.fromEntries(surfaces.map(surface => [surface.name, surface.updates])),
  };
}
