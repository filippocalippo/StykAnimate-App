import {tuned} from '../trace.mjs';

/**
 * Scrubbing a scene whose editing frame is dear (docs/TIMELINE.md, "Scrubbing a dense scene").
 *
 * An editing frame at a new tick is evaluated, built, encoded and uploaded on the interface thread. In a scene of a few figures that
 * is a millisecond or two and a playhead drag shows the exact editing frame (onion skins and joints) at every tick it reaches. In a
 * dense scene it is a hundred milliseconds and more, and a drag shows a few frames a second with the interface frozen between them.
 * There the drag shows the frames the engine's workers prepare, as playback does, and the editing frame is drawn once, on release.
 *
 * `createSeekCosts` is the rule that says which scene is dear: what the last editing paints that showed a new tick of the document
 * cost the interface thread. `createScrubPreview` is the drag itself: which ticks the workers prepare and which prepared frame
 * the stage shows. Neither reads the document or a frame: they ask the playback adapter (engine-playback.mjs) for tickets.
 * `createStepRun` makes a run of frame steps (a held key) such a scrub: from its second step to its end the steps steer the playhead
 * as a drag does, and the exact frame is drawn once at the end.
 */

/**
 * Interface time of an editing paint at a new tick above which a scene scrubs from prepared frames. A display frame at 60 Hz is
 * 16.7 ms; the timeline's own paint and the input need what is left of it. A paint of the stage over 12 ms cannot follow a pointer
 * at the display's rate, and the prepared frame of a dense scene costs a few milliseconds whatever the scene (it is uploaded,
 * not made, on the interface thread). Below it the exact editing frame keeps up and the scrub is unchanged.
 */
export const DEAR_SEEK_MS = 12;
/** The paints the rule looks at: a median of three ignores a single slow paint (a first upload, a busy machine) either way. */
const SEEK_SAMPLES = 3;

/** The lower median of `values`: of two, the smaller, so a scene is dear only when both say so. */
const median = values => [...values].sort((a, b) => a - b)[(values.length - 1) >> 1];

export function createSeekCosts({dearMs = DEAR_SEEK_MS, samples = SEEK_SAMPLES} = {}) {
  let owner = null, last, costs = [];
  return {
    /**
     * An editing paint of `report` at `tick` took `ms` of the interface thread. Only a paint at another tick than the one before it
     * counts: a redraw of the tick on show (a pan, a zoom, an edit) reuses what that tick built and says nothing of a seek.
     */
    record(report, tick, ms) {
      if (report !== owner) { owner = report; costs = []; last = undefined; }
      if (tick === last || !Number.isFinite(ms)) return;
      last = tick;
      costs.push(ms);
      if (costs.length > samples) costs.shift();
    },
    /** Whether a scrub of `report` shows prepared frames. Asked once, when a drag starts: the mode holds until the release. */
    dear(report) { return report === owner && costs.length > 0 && median(costs) > dearMs; },
    get samples() { return [...costs]; },
  };
}

/**
 * How many frames the drag keeps the engine's workers making at once. A frame of a dense scene costs a worker a few hundred
 * milliseconds, and every frame made beside it makes it slower (the workers share the processor with each other, the interface and
 * the graphics process): with eight at once each took about twice as long as with three, as many were shown, and they lagged
 * further behind the pointer. A frame is asked for when one of these finishes, so it is the pointer's tick at that moment.
 */
const IN_FLIGHT_SPEC = Object.freeze({min: 1, max: 16, description: 'Frames being prepared at once while a dense scene is scrubbed'});
const inFlightLimit = () => tuned('scrub.framesInFlight', 3, IN_FLIGHT_SPEC);
/**
 * A run of frame steps moves the playhead one tick at a time: of three frames asked for together, the two that finish just behind the
 * playhead are passed over for the third, and they still hold the workers when the run ends and its exact frame is made beside them.
 * Measured on 2,000 figures of 100 segments (a held key, 30 steps a second): two at once showed 14.7 distinct frames a second against
 * 12.6 with three, and the exact frame after the key up took 150 ms against 232. A drag, whose pointer jumps, shows fewer with two.
 */
const STEP_IN_FLIGHT_SPEC = Object.freeze({min: 1, max: 16, description: 'Frames being prepared at once while frame steps are held in a dense scene'});
const stepInFlightLimit = () => tuned('scrub.stepFramesInFlight', 2, STEP_IN_FLIGHT_SPEC);
/** How many ticks past the pointer, in the drag's direction, fill the places the pointer's own tick leaves free (a slow drag, a pause). */
const AHEAD_SPEC = Object.freeze({min: 0, max: 32, description: 'Ticks past the pointer prepared while a dense scene is scrubbed'});
const aheadCount = () => tuned('scrub.aheadFrames', 2, AHEAD_SPEC);
// Registered as the module loads, so the developer tools list them before a first drag.
inFlightLimit(); stepInFlightLimit(); aheadCount();
/** At most this many ticks of one jump are marked as passed (the ones nearest the pointer), and at most this many kept. */
const MARKED = 64, KEPT = 256;
/** Ready reads a paint makes at most, newest first: each is one nonblocking read of the engine's frame cache. */
const CHECKS = 24;
/** How long a wait for the workers lasts before readiness is looked at again (the engine's progress counter wakes it sooner). */
const WAIT_MS = 50;
/** A frame asked for and not seen ready after this long (made, then dropped from a full cache before a paint saw it) stops counting. */
const STALE_MS = 2000;

/**
 * @param {{playback: {get(tick: number): object|null}, prepare(ticks: number[], playhead: number): unknown, total(): number,
 *   engine(): {progressSeen?(): number, whenProgress?(seen: number, ms: number): Promise<unknown>}|null, now?(): number}} options
 *   `prepare(ticks, playhead)` asks the engine for `ticks`, the first one first (each request replaces the one before), its cache
 *   counting from `playhead` when it is full; `total` is the document's tick count; `engine` the engine whose progress counter
 *   says a frame is done
 */
export function createScrubPreview({playback, prepare, total, engine, now = () => performance.now()}) {
  let active = false, serial = 0, pointer = null, direction = 1, shown = null, seen, watching = false, lifetime = 0, steps = false;
  /** Each tick the pointer passed, with the serial of when it last passed it: a higher serial is a newer place of the pointer. */
  const passed = new Map();
  /** The ticks asked for and not seen ready yet, with when they were asked for. */
  const asked = new Map();
  const last = () => Math.max(0, (Number(total()) || 0) - 1);
  const newerThanShown = () => {
    const floor = shown?.serial ?? 0;
    for (const value of passed.values()) if (value > floor) return true;
    return false;
  };
  /** A tick whose frame could still be shown: one the pointer passed after the place `floor` (the frame on show), or one ahead of it. */
  const wanted = (tick, floor) => (passed.get(tick) ?? -1) > floor || (tick - pointer) * direction > 0;
  /**
   * Asks for the pointer's tick, then the ones after it in the drag's direction, as far as the frames being made leave room. `floor`:
   * the place of the pointer whose frame is shown (or about to be); the frames of the ticks passed before it are not wanted.
   */
  const pump = (floor = shown?.serial ?? 0) => {
    if (!active || pointer === null) return;
    const time = now();
    for (const [tick, at] of asked) if (!wanted(tick, floor) || time - at > STALE_MS || playback.get(tick)) asked.delete(tick);
    const fresh = [], end = last(), limit = steps ? stepInFlightLimit() : inFlightLimit();
    for (let k = 0, count = aheadCount(); k <= count && asked.size + fresh.length < limit; k++) {
      const tick = pointer + k * direction;
      if (tick < 0 || tick > end) break;
      if (!asked.has(tick) && !playback.get(tick)) fresh.push(tick);
    }
    if (!fresh.length) return;
    for (const tick of fresh) asked.set(tick, time);
    // The request replaces the one before: the frames still wanted from it are asked for again, after the new ones.
    const ticks = [...fresh, ...[...asked.keys()].filter(tick => !fresh.includes(tick))];
    // A full cache drops first the frames furthest forward from its playhead (playback's order), so it counts from the low end of what
    // the drag still wants: in a forward drag the frame on show and the ticks passed since. Counted from the pointer, a forward drag
    // would drop each frame finished just behind it before a paint could show it.
    const low = Math.min(...ticks, ...(direction > 0 && shown ? [shown.tick] : []));
    prepare(ticks, low);
  };
  const preview = {
    get active() { return active; },
    /** The packet on show: its frame holds the camera and backgrounds of the tick it shows. */
    get shown() { return shown?.packet ?? null; },
    /** Whether the pointer passed a tick newer than the one on show, whose frame is not shown yet. */
    get waiting() { return active && newerThanShown(); },
    /**
     * A drag starts at `tick` (`steps`: a run of frame steps): nothing is shown from it until a frame of a tick the pointer passes
     * is ready.
     */
    begin(tick, {steps: stepping = false} = {}) {
      active = true; serial = 0; shown = null; passed.clear(); asked.clear(); direction = 1; lifetime++; watching = false; steps = stepping;
      pointer = Number.isFinite(tick) ? Math.min(Math.max(0, Math.floor(tick)), last()) : null;
    },
    /** The release (or a cancel): the editing frame takes over. */
    end() { active = false; shown = null; passed.clear(); asked.clear(); pointer = null; lifetime++; watching = false; },
    /** The pointer reached `tick`: the ticks it crossed since the last move are newer than any before, the ones nearest it newest. */
    point(tick) {
      if (!active || !Number.isFinite(tick)) return;
      const at = Math.min(Math.max(0, Math.floor(tick)), last()), from = pointer ?? at;
      const step = at > from ? 1 : at < from ? -1 : 0;
      if (step) direction = step;
      // The tick the last move reached is already marked; a move that stays on it marks it again, as the newest place.
      for (let distance = Math.min(Math.abs(at - from), MARKED) - (step ? 1 : 0); distance >= 0; distance--) {
        const passedTick = at - distance * step;
        passed.delete(passedTick);
        passed.set(passedTick, ++serial);
      }
      // Map order is the order of marking: the oldest are dropped first.
      for (const key of passed.keys()) { if (passed.size <= KEPT) break; passed.delete(key); }
      pointer = at;
      pump();
    },
    /**
     * The frame to show now: the ready frame of the newest tick the pointer passed after the one on show, or null (the picture on show
     * stays). A frame of an older place of the pointer that gets ready late is never shown over a newer one. A frame that finished
     * leaves its place to the pointer's tick of this moment.
     */
    next() {
      if (!active) return null;
      seen = engine()?.progressSeen?.();
      const floor = shown?.serial ?? 0, candidates = [];
      for (const [tick, value] of passed) if (value > floor) candidates.push([value, tick]);
      candidates.sort((a, b) => b[0] - a[0]);
      let choice = null;
      for (const [value, tick] of candidates.slice(0, CHECKS)) {
        const packet = playback.get(tick);
        if (packet) { choice = {tick, serial: value, packet}; break; }
      }
      // The pointer back on the frame on show (or held past the document's end, on its last tick): that picture stays, drawn once.
      if (choice && choice.packet.key === shown?.packet.key) { preview.presented(choice); choice = null; }
      pump(choice?.serial ?? floor);
      return choice;
    },
    /** `choice` (from `next`) is on show: what the pointer passed before it is not wanted any more. */
    presented(choice) {
      if (!active || !choice) return;
      shown = choice;
      for (const [tick, value] of passed) if (value <= choice.serial) passed.delete(tick);
    },
    /** While a newer frame is wanted, `invalidate` runs once the engine's workers finish something (or after a short wait). Never blocks. */
    watch(invalidate) {
      const side = engine();
      if (watching || !preview.waiting || typeof side?.whenProgress !== 'function') return;
      watching = true;
      const current = lifetime;
      side.whenProgress(seen ?? side.progressSeen?.(), WAIT_MS).then(() => {
        if (current !== lifetime) return;
        watching = false;
        if (active) invalidate();
      });
    },
  };
  return preview;
}

/**
 * Steps closer together than this are one run (docs/TIMELINE.md, "Stepping through a dense scene"), and a run of taps with no step
 * for this long has ended. An exact step in a dense scene costs the interface 105 to 180 ms: steps a quarter of a second apart leave
 * it a few display frames between them, closer ones leave it frozen; and a person who looks at each frame (to pose it, to check it)
 * steps more slowly than four a second. A key's auto-repeat is a run whatever its rate: the keyboard says so.
 */
export const STEP_RUN_MS = 250;

/**
 * Whether a frame step is one of a run, which in a scene whose editing frame is dear moves the playhead without evaluating and shows
 * prepared frames, as a playhead drag does, until the run ends. The first step of a run is always exact: a run starts at its second
 * step (a key's auto-repeat, or a step within `gapMs` of the one before), when `begin()` says the scene scrubs from prepared frames.
 * A held key's run ends when the key is released; a run of taps ends `gapMs` after its last step. `end()` then draws the exact
 * editing frame of the tick the run reached.
 * @param {{begin(): boolean, end(): void, gapMs?: number, now?(): number, setTimer?: typeof setTimeout, clearTimer?: typeof clearTimeout}} options
 */
export function createStepRun({begin, end, gapMs = STEP_RUN_MS, now = () => performance.now(), setTimer = setTimeout, clearTimer = clearTimeout}) {
  let active = false, last = -Infinity, held = null, repeated = false, timer = null;
  const disarm = () => { if (timer !== null) clearTimer(timer); timer = null; };
  const settle = () => { disarm(); timer = setTimer(() => { timer = null; run.finish(); }, gapMs); };
  const run = {
    get active() { return active; },
    /**
     * A step is about to move the playhead; `event` is the key's keydown (`{code, repeat}`), or nothing for another source.
     * True when it is a step of a run: the step then seeks without evaluating and the run's preview shows the new tick.
     */
    step(event = {}) {
      const time = now(), close = time - last < gapMs;
      last = time;
      if (event.code) held = event.code;
      if (!active) {
        if (!event.repeat && !close) return false;
        if (!begin()) return false;
        active = true; repeated = false;
      }
      if (event.repeat) repeated = true;
      // While its key is down a run waits for the key; a run of taps (or of steps from elsewhere) settles on its own.
      if (held) disarm(); else settle();
      return true;
    },
    /** A key went up: the held key of a run ends it at once; a tap's leaves the run to settle, for the next tap to join. */
    keyup(event) {
      if (!event?.code || event.code !== held) return;
      held = null;
      if (!active) return;
      if (repeated) run.finish(); else settle();
    },
    /** The run ends now (its key up, the window losing focus): `end()` draws the exact frame. */
    finish() {
      disarm(); held = null;
      if (!active) return;
      active = false; repeated = false;
      end();
    },
    /** A playhead drag takes the scrub over: the run ends without its `end()`, which the drag's release does. */
    cancel() { disarm(); active = false; repeated = false; },
  };
  return run;
}
