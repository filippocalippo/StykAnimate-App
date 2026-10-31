/**
 * Drawing cels held live in the engine (docs/engine/drawing.md, Live cels).
 *
 * The engine draws a drawing cel from its published tiles, which are encoded some time after
 * the pixels change. While the workspace paints, fills or moves a selection, the interface
 * thread's tile store (drawing-resources.mjs) holds the pixels first; this module hands the
 * engine the tiles that changed (`Stage::live_cel_tiles`), a slice of them at a time, so the
 * stage draws a stroke as soon as its tiles exist. A cel the engine holds live is drawn from
 * those tiles instead of the published ones; the two show the same pixels once published.
 *
 * Which cels: those with pixels not yet published, and the one the workspace watches (the cel
 * under the playhead of the active drawing layer, so its first stroke finds it ready). A cel
 * that is published and no longer watched stays held until room is needed, then goes first.
 *
 * Also here: the signal wet ink waits for (drawing-controller.mjs). `presentedStamp` of a tile
 * store's entry is the stamp of its pixels the last frame drawn by the stage carried.
 */
import {TILE_BYTES} from '../drawing-tiles.mjs';
import {entryUnpublished} from '../drawing-resources.mjs';

/** Consumer name of the tile stores' change logs (`TileStore.changes`). */
const CONSUMER = 'engine-live';
/** Bytes of one tile record in a packed list: two little-endian `i32` coordinates and the pixels. */
const RECORD = 8 + TILE_BYTES;
/** Tiles in one call at most (1.5 MiB of pixels). */
const CALL_TILES = 96;
/** How long one frame may spend handing tiles over. */
const SLICE_MS = 6;
/** Published cels kept live beyond the watched and unpublished ones. */
const KEEP_CLEAN = 4;
/** How long a cel the engine could not take is left alone. */
const RETRY_MS = 5000;

const IDENTITY = [1, 0, 0, 1, 0, 0];
const sameMatrix = (a, b) => a.every((value, index) => value === b[index]);

/** One set of tiles held by the engine: what was sent, and what waits to be. */
class Layer {
  constructor(float) {
    this.float = float;
    this.store = null;
    /** Tile key to the `{pixels, version}` the engine holds. */
    this.sent = new Map();
    /** Tile key to the tile to send (`null`: the tile is gone), in the order they changed. */
    this.queue = new Map();
  }

  /** Brings `queue` to the difference between `store` and what the engine holds. */
  collect(store) {
    const log = store.changes(CONSUMER);
    if (this.store !== store || log.overflow) {
      // Another store, or more changes than the log keeps: compare every tile.
      this.store = store;
      log.keys.clear();
      log.overflow = false;
      this.queue.clear();
      for (const [key, tile] of store.tiles) {
        const known = this.sent.get(key);
        if (!known || known.pixels !== tile.pixels || known.version !== tile.version) this.queue.set(key, tile);
      }
      for (const key of this.sent.keys()) if (!store.tiles.has(key)) this.queue.set(key, null);
      return;
    }
    for (const key of log.keys) this.queue.set(key, store.tiles.get(key) ?? null);
    log.keys.clear();
  }

  /** Sends tiles from the queue while `budget()` allows; true while some wait. */
  send(stage, id, budget) {
    while (this.queue.size && budget()) {
      const packed = new Uint8Array(Math.min(this.queue.size, CALL_TILES) * RECORD), view = new DataView(packed.buffer), removed = [], taken = [];
      let count = 0;
      for (const [key, tile] of this.queue) {
        if (taken.length >= CALL_TILES) break;
        taken.push(key);
        if (!tile) { const [tx, ty] = key.split(',').map(Number); removed.push(tx, ty); continue; }
        view.setInt32(count * RECORD, tile.tx, true);
        view.setInt32(count * RECORD + 4, tile.ty, true);
        packed.set(tile.pixels, count * RECORD + 8);
        count++;
      }
      stage.live_cel_tiles(id, this.float, packed.subarray(0, count * RECORD), new Int32Array(removed));
      for (const key of taken) {
        const tile = this.queue.get(key);
        this.queue.delete(key);
        if (tile) this.sent.set(key, {pixels: tile.pixels, version: tile.version}); else this.sent.delete(key);
      }
    }
    return this.queue.size > 0;
  }
}

class Cel {
  constructor(entry) {
    this.entry = entry;
    this.id = entry.id;
    this.base = new Layer(false);
    this.float = new Layer(true);
    /** The engine draws this cel from its tiles, and its floating selection over them. */
    this.shown = false;
    this.floatShown = false;
    this.matrix = IDENTITY;
    /** The engine holds the cel (a cel exists there once it was sent tiles, even none). */
    this.created = false;
    this.used = performance.now();
  }
}

export class LiveCels {
  /**
   * @param {object} stage the engine's stage (`Stage` of styk-wasm)
   * @param {{invalidate?: () => void}} [options] `invalidate` asks for another frame
   */
  constructor(stage, {invalidate = () => {}} = {}) {
    this.stage = stage;
    this.invalidate = invalidate;
    this.resources = null;
    this.cels = new Map();
    /** Cels the engine could not take, by id, and when to try them again. */
    this.refused = new Map();
    /** Entries whose pixels the last frame carried, with the stamp it carried. */
    this.carried = [];
    this.stats = {tiles: 0, dropped: 0, full: 0, errors: 0, lastMs: 0};
  }

  /** The ids of the cels held, for tests and reports. */
  get held() { return [...this.cels.keys()]; }

  /** Lets go of every cel (another document is open). */
  reset() {
    if (this.cels.size) try { this.stage.live_cel_reset(); } catch { /* the stage is gone */ }
    this.cels.clear();
    this.refused.clear();
    this.carried = [];
  }

  drop(cel) {
    this.cels.delete(cel.id);
    try { this.stage.live_cel_drop(cel.id); } catch { /* the stage is gone */ }
    this.stats.dropped++;
  }

  /**
   * Brings the engine's live cels to the pixels of the document's drawing cels (`resources`,
   * drawing-resources.mjs). Call it before a frame is drawn and `presented()` after the stage
   * drew it. Hands over a few milliseconds of tiles at most, and asks for another frame while
   * more wait.
   */
  sync(resources) {
    this.carried = [];
    if (resources !== this.resources) { this.reset(); this.resources = resources; }
    if (!resources) return;
    const started = performance.now(), budget = () => performance.now() - started < SLICE_MS, now = started;
    let more = false;
    const seen = new Set();
    for (const entry of resources.entries.values()) {
      if (entry.transient || entry.external) continue;
      let cel = this.cels.get(entry.id);
      if (cel && cel.entry !== entry) { this.drop(cel); cel = undefined; }
      if (!entry.store) { if (cel) this.drop(cel); continue; }
      if (!cel && !(resources.watching === entry || entryUnpublished(entry))) continue;
      if ((this.refused.get(entry.id) ?? 0) > now) continue;
      if (!cel) { cel = new Cel(entry); this.cels.set(entry.id, cel); }
      cel.used = Math.max(cel.used, entry.used ?? 0);
      seen.add(entry.id);
      try { more = this.follow(cel, resources, budget) || more; }
      catch (error) { this.fail(cel, error, now); more = true; }
    }
    // Cels whose entry is gone (the document dropped it) go too.
    for (const cel of [...this.cels.values()]) if (!seen.has(cel.id)) this.drop(cel);
    this.trim(resources);
    this.stats.lastMs = performance.now() - started;
    if (more) this.invalidate();
  }

  /** Follows one entry. True while some of its tiles wait to be sent. */
  follow(cel, resources, budget) {
    const entry = cel.entry, source = resources.liveSource?.(entry) ?? null, floating = source?.float ?? null;
    let more = false;
    if (!cel.created) { this.stage.live_cel_tiles(cel.id, false, new Uint8Array(0), new Int32Array(0)); cel.created = true; }
    if (floating) {
      // The selection's pixels arrive before the cel loses them: its copy shows over the cel
      // (at first through the identity) and the cel's copy goes after, so none flickers.
      cel.float.collect(floating.store);
      more = cel.float.send(this.stage, cel.id, budget);
      if (!more) {
        if (!sameMatrix(cel.matrix, floating.matrix)) { this.stage.live_cel_matrix(cel.id, floating.matrix); cel.matrix = [...floating.matrix]; }
        if (cel.shown && !cel.floatShown) { this.stage.live_cel_show(cel.id, true, true); cel.floatShown = true; }
      }
    }
    if (!floating || cel.floatShown) {
      cel.base.collect(source?.base ?? entry.store);
      more = cel.base.send(this.stage, cel.id, budget) || more;
    }
    if (!floating && cel.float.store) {
      // The selection ended: the cel holds its pixels again, and the copy goes.
      if (!cel.base.queue.size) {
        this.stage.live_cel_clear_float(cel.id);
        cel.float = new Layer(true);
        cel.floatShown = false;
        cel.matrix = IDENTITY;
      } else more = true;
    }
    if (!cel.shown && !more) {
      this.stage.live_cel_show(cel.id, true, cel.floatShown);
      cel.shown = true;
      if (floating && !cel.floatShown) { this.stage.live_cel_show(cel.id, true, true); cel.floatShown = true; }
    }
    if (cel.shown && !more) this.carried.push({entry, stamp: entry.stamp});
    return more;
  }

  /** The engine could not take a cel: it is not held any more; room is made if its slots ran out. */
  fail(cel, error, now) {
    this.cels.delete(cel.id);
    try { this.stage.live_cel_drop(cel.id); } catch { /* the stage is gone */ }
    if (/full/.test(String(error?.message ?? error))) {
      this.stats.full++;
      // Published cels give their slots up first, the least recently used half of them.
      const clean = [...this.cels.values()].filter(other => this.resources.watching !== other.entry && !entryUnpublished(other.entry)).sort((a, b) => a.used - b.used);
      for (const other of clean.slice(0, Math.max(1, clean.length >> 1))) this.drop(other);
      if (!clean.length) this.refused.set(cel.id, now + RETRY_MS);
    } else {
      this.stats.errors++;
      console.warn('The engine could not hold a drawing cel live.', error);
      this.refused.set(cel.id, now + RETRY_MS);
    }
  }

  /** Keeps only a few published cels the workspace no longer watches. */
  trim(resources) {
    const clean = [...this.cels.values()].filter(cel => resources.watching !== cel.entry && !entryUnpublished(cel.entry));
    if (clean.length <= KEEP_CLEAN) return;
    clean.sort((a, b) => a.used - b.used);
    for (const cel of clean.slice(0, clean.length - KEEP_CLEAN)) this.drop(cel);
  }

  /** The stage drew the frame: the pixels it carried are on their way to the screen. */
  presented() {
    for (const {entry, stamp} of this.carried) entry.presentedStamp = Math.max(entry.presentedStamp ?? -1, stamp);
    this.carried = [];
  }
}
