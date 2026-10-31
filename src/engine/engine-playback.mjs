/**
 * Playback preparation for the app: the engine's alone (docs/engine/threading.md).
 *
 * `createStagePlayback` is the app's transport interface to the engine. The engine holds the document its
 * edit session publishes (nothing is copied into playback workers), ticks are requested from the engine's
 * worker threads, and a "packet" is only a ticket: the tick, the frame's camera and backgrounds for the
 * overlay, and a key the stage recognises. A packet is available (`get`) once the engine has the frame ready.
 */
import {holdsRevision} from './engine-open.mjs';

/** Keys of engine packets: the stage renderer draws these with the engine. */
const ENGINE_KEY = 'engine:';
/** Generation, settings/resource epoch and the exact sample share one native owner. */
export function engineTicket(key) {
  if (typeof key !== 'string' || key.length > 96 || !key.startsWith(ENGINE_KEY)) return null;
  const parts = key.split(':');
  if (parts.length !== 4) return null;
  const [generation, epoch, tick] = parts.slice(1).map(Number);
  if (!Number.isSafeInteger(generation) || generation <= 0 || !Number.isSafeInteger(epoch) || epoch < 0 || !Number.isFinite(tick) || tick < 0) return null;
  if (parts[1] !== String(generation) || parts[2] !== String(epoch) || parts[3] !== String(tick)) return null;
  return {generation, epoch, tick};
}
// These are metadata tickets, not prepared frames. Native residency remains
// governed by its existing byte budget; a discarded ticket can be recreated.
const MAX_ENGINE_TICKETS = 120;
const sample = tick => Number.isFinite(tick) && tick >= 0;

/**
 * @param {{stage(): object|null, maxTickets?: number}} options `stage()` returns the stage once it exists;
 *   `maxTickets` lowers the number of tickets kept (120 at most)
 */
export function createStagePlayback({stage, maxTickets}) {
  const side = () => stage()?.engineSide ?? null;
  let report = null, revision = -1, hiddenKey = null;
  const packets = new Map();
  const configured = Number(maxTickets);
  const ticketLimit = Number.isFinite(configured) ? Math.max(1, Math.min(MAX_ENGINE_TICKETS, Math.floor(configured))) : MAX_ENGINE_TICKETS;
  let requested = [], packetGeneration = null;
  // Latest admission requests only. Busy never certifies the old native view.
  let pendingHidden = null, pendingEffects = null, pendingRequest = null;
  let controlOrder = 0, controlLifetime = 0, retryScheduled = false;
  const controlsPending = () => pendingHidden !== null || pendingEffects !== null || pendingRequest !== null;
  const retryControls = (engine, seen) => {
    if (retryScheduled || !controlsPending()) return;
    if (!engine) return;
    retryScheduled = true;
    const lifetime = controlLifetime;
    // The same bounded progress owner retries even when an idle lock released
    // without publishing progress. At most one waiter is outstanding.
    const waiting = engine.whenProgress?.(seen, 16) ?? Promise.resolve();
    waiting.then(() => setTimeout(() => {
      if (lifetime !== controlLifetime) return;
      retryScheduled = false;
      flushControls();
    }, 0));
  };
  const flushControls = () => {
    if (!controlsPending()) return true;
    const engine = side()?.engine, handle = engine?.handle;
    if (!handle) return false;
    // Read before testing admission, matching the existing progress contract.
    const seen = engine.progressSeen?.();
    for (const kind of ['hidden', 'effects']) {
      const pending = kind === 'hidden' ? pendingHidden : pendingEffects;
      if (!pending) continue;
      const admission = kind === 'hidden' ? handle.try_set_hidden(pending.uids) : handle.try_set_effects(pending.enabled);
      if (admission === 0) { retryControls(engine, seen); return false; }
      // An actually changed setting resets older demand; a no-op does not.
      if (admission === 2 && pendingRequest && pendingRequest.order < pending.order) pendingRequest = null;
      if (kind === 'hidden') { hiddenKey = pending.key; pendingHidden = null; } else pendingEffects = null;
    }
    if (pendingRequest) {
      const admission = handle.try_request_samples(pendingRequest.playhead, pendingRequest.samples);
      if (admission === 0) { retryControls(engine, seen); return false; }
      pendingRequest = null;
      side()?.engine.pump();
    }
    return true;
  };
  const stats = {};
  /** The last preparation statistics the engine answered with: it answers zeros while a worker holds its state. */
  let lastFrames = null;
  const dropPackets = () => { packets.clear(); requested = []; packetGeneration = null; };
  const prunePackets = handle => {
    const generation = handle.generation();
    if (packetGeneration !== generation) { packets.clear(); packetGeneration = generation; }
    for (const [tick, packet] of packets) {
      const ticket = engineTicket(packet.key);
      if (!ticket || !handle.frame_ticket_ready(ticket.generation, ticket.epoch, ticket.tick)) packets.delete(tick);
    }
  };
  const rank = tick => { const at = requested.indexOf(tick); return at < 0 ? ticketLimit : at; };
  const retainPacket = (tick, packet) => {
    if (packets.size >= ticketLimit) {
      let victim, farthest = -1;
      for (const candidate of packets.keys()) {
        // Preserve the current request's first presentation while checking ahead.
        if (candidate === requested[0]) continue;
        const priority = rank(candidate);
        if (priority > farthest) { victim = candidate; farthest = priority; }
      }
      if (victim === undefined || farthest < rank(tick)) return;
      packets.delete(victim);
    }
    packets.set(tick, packet);
  };

  const setHidden = options => {
    if (options?.hiddenKey === undefined || (!pendingHidden && options.hiddenKey === hiddenKey)) return;
    pendingHidden = {key: options.hiddenKey, uids: new Uint32Array(options.hiddenUids ?? []), order: ++controlOrder};
    dropPackets();
    flushControls();
  };
  /** The document changed: tickets and demand for the one before it are void. */
  const changed = () => {
    // Publication clears native demand; an unaccepted request for its previous
    // document must not be retried after that publication either.
    pendingRequest = null;
    dropPackets();
  };
  /** Whether the engine holds the editor's revision: its session publishes every change as it makes it. */
  const held = () => side() !== null && holdsRevision(side().engine, revision);
  const ready = () => !controlsPending() && held();
  const packetFor = tick => {
    flushControls();
    if (!side() || !sample(tick) || !ready()) return null;
    tick = tick === 0 ? 0 : tick;
    const handle = side().engine.handle;
    prunePackets(handle);
    let packet = packets.get(tick);
    if (!packet) {
      const meta = handle.frame_meta(tick);
      if (meta === undefined) return null;
      const frame = JSON.parse(meta), key = `${ENGINE_KEY}${frame.generation}:${frame.epoch}:${tick}`;
      const ticket = engineTicket(key);
      if (!ticket || frame.tick !== tick || !handle.frame_ticket_ready(ticket.generation, ticket.epoch, ticket.tick)) return null;
      packet = {tick, key, engine: true, cameraEnabled: true, frame: {...frame, engine: true},
        byteLength: 0, compileMs: 0, hiddenKey: hiddenKey ?? '', softwareFrames: true, previewQuality: {reduced: false}, compatibility: [], groups: []};
      retainPacket(tick, packet);
    } else {
      // Existing Map order supplies recency after the bounded request priority.
      packets.delete(tick); packets.set(tick, packet);
    }
    return packet;
  };

  const playback = {
    get report() { return report; },
    get documentRevision() { return revision; },
    set documentRevision(value) { revision = value; },
    get cache() { return packets; },
    get stats() {
      const engine = side();
      if (!engine) return Object.assign(stats, {preparedFrames: 0, compileMs: 0, lastCompileMs: 0, pendingFrames: 0, bytes: 0, readyFrames: 0, hits: 0, misses: 0});
      const read = JSON.parse(engine.engine.handle.stats());
      // A busy answer would read as a document that prepares instantly, and a shorter start-up buffer for it.
      if (!read.busy || !lastFrames) lastFrames = read;
      const frames = lastFrames;
      return Object.assign(stats, {preparedFrames: frames.prepared, compileMs: frames.totalMs, lastCompileMs: frames.prepared ? frames.totalMs / frames.prepared : 0,
        pendingFrames: 0, bytes: frames.cachedBytes, readyFrames: frames.cached, hits: 0, misses: 0, engine: frames});
    },
    /** Brings the engine to `next` at `options.revision`; the app loads the document again once the stage exists if it did not yet. */
    load(next, options = {}) {
      next = next?.document ?? next?.report ?? next;
      // The engine holds the document already; no worker gets a copy of it.
      report = next; revision = options.revision; lastFrames = null;
      setHidden(options);
      changed();
      return playback;
    },
    updateDocument(patch = {}) {
      revision = patch.revision ?? revision;
      setHidden(patch);
      changed();
      return playback;
    },
    updateView(options = {}) {
      // The engine's frames do not depend on the view or the camera mode; only on what is hidden.
      setHidden(options);
      return playback;
    },
    invalidate() {
      pendingRequest = {playhead: 0, samples: new Float64Array(0), order: ++controlOrder};
      flushControls();
      dropPackets();
      return playback;
    },
    async prepareRange(ticks) {
      // A busy earlier admission stays cold, but cannot suppress newer demand.
      if (!held() || !ticks.length || !sample(ticks[0])) return;
      const engine = side().engine;
      requested = [];
      for (let index = 0; index < Math.min(ticks.length, ticketLimit); index++) {
        const tick = ticks[index];
        if (sample(tick) && !requested.includes(tick)) requested.push(tick === 0 ? 0 : tick);
      }
      prunePackets(engine.handle);
      pendingRequest = {playhead: ticks[0], samples: new Float64Array(ticks), order: ++controlOrder};
      flushControls();
    },
    get(tick) { return packetFor(tick); },
    has(tick) { return packetFor(tick) !== null; },
    bufferedAhead(tick, count, end) {
      if (!side()) return false;
      const total = side().engine.handle.total_ticks(), last = Math.min(tick + count, end ?? total, total);
      if (total === 0) return false; // No document or a busy scalar header is cold.
      for (let next = tick; next < last; next++) if (packetFor(next) === null) return false;
      return packetFor(tick) !== null;
    },
    setVfxEnabled(enabled) {
      // The engine's prepared frames are kept with or without effects, as the editor's preview shows them.
      if (side()) {
        pendingEffects = {enabled: enabled !== false, order: ++controlOrder};
        dropPackets();
        flushControls();
      }
    },
    dispose() {
      pendingHidden = pendingEffects = pendingRequest = null;
      controlLifetime++; retryScheduled = false;
      dropPackets();
    },
  };
  return playback;
}
