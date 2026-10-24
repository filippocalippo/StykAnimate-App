import {messageError} from './localized-error.mjs';
import {evaluatedFrame, buildGeometry, timeline, evaluationGeneration, evaluationGeometryGeneration} from './pivot/geometry.mjs';
import {layerIdForUid} from './layers.mjs';

/**
 * Camera follow: a camera motion clip that keeps figures in frame.
 *
 * Target samples (weighted centre, union bounds and the authored camera per tick) come from a projection holding
 * only the followed figures, their join parents and the camera. A deterministic forward pass shapes them (dead zone,
 * look-ahead, smoothing, framing zoom), so seeking, reverse seeking, playback, export and baking agree without any
 * playback state. Work is proportional to what is viewed and what changed: samples and shaped paths extend lazily
 * up to the requested frame, and after an edit only frames from the key before the change are sampled again; the
 * shaping state resumes from checkpoints.
 */
export const FOLLOW_TARGET_LIMIT = 16;
export const FOLLOW_FRAME_LIMIT = 100000;
export const FOLLOW_DEFAULTS = Object.freeze({strength: 1, followX: 1, followY: 1, offsetX: 0, offsetY: 0, lag: 8, deadZone: 0,
  lookAhead: 0, zoomFit: 0, padding: .2, maxZoom: 3, fadeIn: 6, fadeOut: 6});
/** Counts sampled frames; tests use it to prove edits resample only what changed. */
export const followStats = {samples: 0};
const RAW = 9, STRIDE = 3, CHECKPOINT = 32;
const reports = new WeakMap();

export function validateFollowTargets(targets) {
  if (!Array.isArray(targets) || !targets.length || targets.length > FOLLOW_TARGET_LIMIT) throw messageError(new Error(''), "errors.cameraFollow.follow1Figures", {FOLLOW_TARGET_LIMIT: FOLLOW_TARGET_LIMIT});
  const uids = new Set();
  for (const target of targets) {
    if (!target || !Number.isInteger(target.uid) || target.uid < 0 || uids.has(target.uid) || typeof target.weight !== 'number' || !(target.weight >= 0 && target.weight <= 1))
      throw messageError(new Error(''), "errors.cameraFollow.eachFollowedFigureNeedsAUniqueFigureAnd", {});
    uids.add(target.uid);
  }
}

/** Only the followed figures and the joins they hang from; other figures are dropped without being copied. */
function projectFrame(frame, keep) {
  const objects = frame.objects ?? [];
  if (!objects.length) return frame;
  const slots = new Set();
  for (let i = 0; i < objects.length; i++) {
    if (!keep.has(objects[i].unique_id)) continue;
    for (let slot = i, guard = 0; slot !== undefined && objects[slot] && !slots.has(slot) && guard <= objects.length; guard++) {
      slots.add(slot);
      const join = objects[slot].join;
      slot = join ? Number(join.target_object_slot) : undefined;
    }
  }
  const kept = [...slots].sort((a, b) => a - b), index = new Map(kept.map((slot, i) => [slot, i]));
  const result = {...frame, objects: kept.map((slot, i) => {
    const object = objects[slot], join = object.join;
    return {...object, object_slot: i, ...(join ? {join: {...join, target_object_slot: index.get(Number(join.target_object_slot))}} : {})};
  })};
  const uids = new Set(result.objects.map(object => object.unique_id));
  if (Array.isArray(frame.object_draw_order_unique_ids)) {
    result.object_draw_order_unique_ids = frame.object_draw_order_unique_ids.filter(uid => uids.has(uid));
    result.object_draw_order = result.object_draw_order_unique_ids.map(uid => result.objects.findIndex(object => object.unique_id === uid));
  } else if (Array.isArray(frame.object_draw_order)) result.object_draw_order = kept.map((_, i) => i);
  if ('object_count' in frame) result.object_count = result.objects.length;
  return result;
}

/** The document restricted to what the followed figures' poses depend on. Effects and camera motion are omitted. */
export function followSamplingReport(report, uids) {
  const keep = new Set(uids), sources = report._styk?.frameSources, frameSources = {};
  for (const [id, frame] of Object.entries(sources ?? {})) frameSources[id] = projectFrame(frame, keep);
  const animation = report._styk?.animation;
  const {cameraMotion, vfxClips, ...metadata} = report._styk ?? {};
  return {...report, keyframes: report.keyframes.map(frame => projectFrame(frame, keep)),
    _styk: {...metadata, ...(sources ? {frameSources} : {}),
      ...(animation ? {animation: {...animation, channels: animation.channels.filter(c => c.target.kind === 'camera' || c.target.kind === 'layer' || keep.has(c.target.uid))}} : {})}};
}

/**
 * What the samples of these figures depend on. Layer-sheet tracks are compared key by key, so an edit invalidates
 * samples only from the key before it. Anything else that can move the figures invalidates everything.
 */
function dependencies(report, uids) {
  const s = report._styk ?? {}, sheet = s.layerSheet, types = new Set(), wanted = new Set(uids);
  const layers = sheet ? [...new Set(['camera', ...uids.map(uid => layerIdForUid(report, uid))])] : [];
  for (const frame of report.keyframes) for (const object of frame.objects ?? []) if (wanted.has(object.unique_id)) types.add(object.figure_type_id);
  for (const frame of Object.values(s.frameSources ?? {})) for (const object of frame.objects ?? []) if (wanted.has(object.unique_id)) types.add(object.figure_type_id);
  // Definitions are edited in place, so their pose-relevant parts are compared by value.
  const definitions = JSON.stringify(report.figure_types.filter(figure => types.has(figure.figure_type_id)).map(figure => [figure.figure_type_id, figure.segments]));
  return {sheet: Boolean(sheet), layers, tracks: layers.map(id => sheet?.tracks[id]), sources: s.frameSources, definitions,
    fixed: [sheet ? null : report.keyframes, sheet ? null : evaluationGeometryGeneration(report), sheet?.legacyAnimation, s.animation, report.fps, report.canvas_width, report.canvas_height, sheet?.duration]};
}
const keySource = (sources, key) => key.value?.frameId ? sources?.[key.value.frameId] : key.value;
/** The earliest frame whose samples may differ: Infinity when nothing relevant changed, 0 for everything. */
function earliestChange(before, after) {
  if (before.sheet !== after.sheet || before.definitions !== after.definitions || before.layers.join() !== after.layers.join() ||
    before.fixed.some((value, i) => value !== after.fixed[i])) return 0;
  let earliest = Infinity;
  for (let t = 0; t < before.tracks.length; t++) {
    const a = before.tracks[t], b = after.tracks[t];
    if (a === b && before.sources === after.sources) continue;
    if (!a || !b) return 0;
    if (a.end !== b.end) earliest = Math.min(earliest, a.end, b.end);
    const keys = Math.max(a.keys.length, b.keys.length);
    for (let i = 0; i < keys; i++) {
      const x = a.keys[i], y = b.keys[i];
      if (x && y && x.tick === y.tick && x.interpolation === y.interpolation && x.sourceTick === y.sourceTick &&
        JSON.stringify(x.bezier) === JSON.stringify(y.bezier) && keySource(before.sources, x) === keySource(after.sources, y)) continue;
      // Interpolation from the previous key reaches the changed one.
      earliest = Math.min(earliest, x?.tick ?? Infinity, y?.tick ?? Infinity, a.keys[i - 1]?.tick ?? 0, b.keys[i - 1]?.tick ?? 0);
      break;
    }
  }
  return earliest;
}

/** Visible artwork extent without allocating per segment: endpoints, curve points and circle radii plus stroke. */
function figureBounds(entry, box) {
  let found = false;
  const add = (x, y, pad) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    found = true;
    if (x - pad < box.minX) box.minX = x - pad; if (y - pad < box.minY) box.minY = y - pad;
    if (x + pad > box.maxX) box.maxX = x + pad; if (y + pad > box.maxY) box.maxY = y + pad;
  };
  for (const s of entry.segments) {
    if (s.seg.visible === false) continue;
    const pad = Math.max(0, s.thickness ?? 0) / 2;
    if (s.type === 'circle') add((s.start.x + s.end.x) / 2, (s.start.y + s.end.y) / 2, Math.abs(s.length) / 2 + pad);
    else if (s.points?.length) for (const p of s.points) add(p.x, p.y, pad);
    else { add(s.start.x, s.start.y, pad); add(s.end.x, s.end.y, pad); }
  }
  for (const poly of entry.polys ?? []) for (const p of poly.points ?? []) add(p.x, p.y, 0);
  return found;
}

/** Lazily extended samples of one set of figures, indexed from `base`. */
class TargetSamples {
  constructor(targets) {
    this.uids = targets.map(t => t.uid); this.weights = new Map(targets.map(t => [t.uid, t.weight]));
    this.base = 0; this.count = 0; this.data = new Float64Array(0); this.paths = new Map();
  }
  reset(base) { this.base = base; this.count = 0; for (const path of this.paths.values()) path.truncate(0); }
  invalidate(tick) {
    const keep = Math.max(0, Math.min(this.count, tick - this.base));
    if (keep >= this.count) return;
    this.count = keep;
    for (const path of this.paths.values()) path.truncate(keep + this.base - path.clip.start - Math.round(path.clip.params.lookAhead));
  }
  ensure(report, last) {
    if (last < this.base + this.count) return;
    const needed = (last - this.base + 1) * RAW;
    if (this.data.length < needed) { const grown = new Float64Array(Math.max(needed, this.data.length * 2)); grown.set(this.data.subarray(0, this.count * RAW)); this.data = grown; }
    this.projection ??= followSamplingReport(report, this.uids);
    this.rows ??= timeline(this.projection);
    const rows = this.rows, width = report.canvas_width, height = report.canvas_height, box = {}, own = {};
    for (let tick = this.base + this.count; tick <= last; tick++) {
      let low = 0, high = rows.length - 1;
      while (low < high) { const mid = (low + high + 1) >>> 1; if (rows[mid].start <= tick) low = mid; else high = mid - 1; }
      const row = rows[low], frame = evaluatedFrame(this.projection, low, row?.count ? (tick - row.start) / row.count : 0, tick);
      const geometry = buildGeometry(this.projection, frame), camera = frame.camera?.is_default ? {} : frame.camera ?? {};
      let cx = 0, cy = 0, total = 0;
      box.minX = box.minY = Infinity; box.maxX = box.maxY = -Infinity;
      for (const entry of geometry.objects.values()) {
        const weight = entry && this.weights.get(entry.obj.unique_id);
        if (weight === undefined) continue;
        own.minX = own.minY = Infinity; own.maxX = own.maxY = -Infinity;
        if (!figureBounds(entry, own)) continue;
        if (weight > 0) { cx += (own.minX + own.maxX) / 2 * weight; cy += (own.minY + own.maxY) / 2 * weight; total += weight; }
        box.minX = Math.min(box.minX, own.minX); box.minY = Math.min(box.minY, own.minY); box.maxX = Math.max(box.maxX, own.maxX); box.maxY = Math.max(box.maxY, own.maxY);
      }
      const o = (tick - this.base) * RAW, d = this.data;
      d[o] = total > 0 ? 1 : 0; d[o + 1] = total > 0 ? cx / total : width / 2; d[o + 2] = total > 0 ? cy / total : height / 2;
      d[o + 3] = total > 0 ? box.maxX - box.minX : 0; d[o + 4] = total > 0 ? box.maxY - box.minY : 0;
      d[o + 5] = camera.x ?? 0; d[o + 6] = camera.y ?? 0; d[o + 7] = camera.scale ?? 1; d[o + 8] = camera.angle_rad ?? 0;
      followStats.samples++;
    }
    this.count = last - this.base + 1;
  }
}

/** A critically damped spring stepped one frame at a time. */
function spring(state, key, velocity, target, time) {
  if (!(time > 0)) { state[key] = target; state[velocity] = 0; return target; }
  const omega = 2 / time, decay = 1 / (1 + omega + .48 * omega * omega + .235 * omega * omega * omega);
  const change = state[key] - target, temp = state[velocity] + omega * change;
  state[velocity] = (state[velocity] - omega * temp) * decay;
  state[key] = target + (change + temp) * decay;
  return state[key];
}

/** One clip's shaped offsets (output pixels) and log zoom per clip frame; independent of fades and influence. */
class ShapedPath {
  constructor(clip, samples) { this.clip = clip; this.samples = samples; this.data = new Float32Array(clip.duration * STRIDE); this.count = 0; this.checkpoints = []; this.state = null; }
  truncate(count) {
    count = Math.max(0, Math.floor(count));
    if (count >= this.count) return;
    const k = Math.floor(count / CHECKPOINT);
    this.checkpoints.length = k;
    this.state = k ? {...this.checkpoints[k - 1]} : null;
    this.count = k * CHECKPOINT;
  }
  /** The sample used for a clip frame, holding the last seen figure while it is missing. */
  target(report, i) {
    const s = this.samples, clip = this.clip, tick = clip.start + i;
    s.ensure(report, tick);
    const o = (tick - s.base) * RAW;
    if (s.data[o]) this.state.held = o;
    else if (this.state.held < 0) for (let t = tick + 1, end = clip.start + clip.duration + Math.round(clip.params.lookAhead); t < end; t++) {
      s.ensure(report, t); const j = (t - s.base) * RAW; if (s.data[j]) { this.state.held = j; break; }
    }
    return this.state.held;
  }
  ensure(report, upto) {
    const clip = this.clip, p = clip.params, width = report.canvas_width, height = report.canvas_height, lead = Math.round(p.lookAhead);
    const deadX = p.deadZone * width / 2, deadY = p.deadZone * height / 2, s = this.samples;
    upto = Math.min(clip.duration - 1, upto);
    for (let i = this.count; i <= upto; i++) {
      this.state ??= {held: -1, x: 0, xv: 0, y: 0, yv: 0, z: 0, zv: 0, hx: 0, hy: 0, primed: false};
      const state = this.state, target = this.target(report, Math.min(clip.duration - 1 + lead, i + lead));
      s.ensure(report, clip.start + i);
      const d = s.data, camera = (clip.start + i - s.base) * RAW;
      let lx = 0, ly = 0, zoom = 0;
      if (target >= 0) {
        const scale = d[camera + 7] || 1, cos = Math.cos(d[camera + 8]), sin = Math.sin(d[camera + 8]);
        // The target's distance from the authored frame centre, in the frame's output pixels.
        const dx = d[target + 1] - width / 2 - d[camera + 5], dy = d[target + 2] - height / 2 - d[camera + 6];
        lx = (cos * dx + sin * dy) / scale - p.offsetX;
        ly = (cos * dy - sin * dx) / scale - p.offsetY;
        if (p.zoomFit > 0 && (d[target + 3] > 0 || d[target + 4] > 0)) {
          const room = Math.max(.05, 1 - 2 * p.padding), fit = Math.max(d[target + 3] / (width * room), d[target + 4] / (height * room)) / scale;
          zoom = p.zoomFit * Math.max(-Math.log(p.maxZoom), Math.min(Math.log(p.maxZoom), Math.log(Math.max(1e-6, fit))));
        }
      }
      // The dead zone moves the camera only once the target leaves it (hysteresis).
      state.hx = Math.max(lx - deadX, Math.min(lx + deadX, state.primed ? state.hx : 0));
      state.hy = Math.max(ly - deadY, Math.min(ly + deadY, state.primed ? state.hy : 0));
      if (!state.primed) { state.primed = true; state.x = state.hx; state.y = state.hy; state.z = zoom; }
      const o = i * STRIDE;
      this.data[o] = spring(state, 'x', 'xv', state.hx, p.lag) * p.followX;
      this.data[o + 1] = spring(state, 'y', 'yv', state.hy, p.lag) * p.followY;
      this.data[o + 2] = spring(state, 'z', 'zv', zoom, p.lag);
      this.count = i + 1;
      if (this.count % CHECKPOINT === 0) this.checkpoints.push({...state});
    }
  }
}

function followCache(report) {
  let cache = reports.get(report);
  const generation = evaluationGeneration(report), clips = report._styk?.cameraMotion?.clips;
  if (!cache) reports.set(report, cache = {generation, clips, samples: new Map()});
  else if (cache.generation !== generation) {
    cache.generation = generation;
    if (cache.clips !== clips) {
      // Parameter previews replace clips; drop shaped paths of clips that are gone.
      cache.clips = clips;
      const live = new Set(clips);
      for (const samples of cache.samples.values()) for (const clip of samples.paths.keys()) if (!live.has(clip)) samples.paths.delete(clip);
    }
    const followed = new Set((clips ?? []).filter(clip => clip.type === 'follow').map(clip => JSON.stringify(clip.targets)));
    for (const [key, samples] of cache.samples) {
      if (!followed.has(key)) { cache.samples.delete(key); continue; }
      const next = dependencies(report, samples.uids), changed = earliestChange(samples.dependencies, next);
      samples.dependencies = next;
      if (changed === Infinity) continue;
      samples.projection = null; samples.rows = null;
      samples.invalidate(changed);
    }
  }
  return cache;
}

function shapedPath(report, clip) {
  const cache = followCache(report), key = JSON.stringify(clip.targets);
  let samples = cache.samples.get(key);
  if (!samples) {
    samples = new TargetSamples(clip.targets); samples.dependencies = dependencies(report, samples.uids); samples.reset(clip.start);
    cache.samples.set(key, samples);
  }
  if (clip.start < samples.base) samples.reset(clip.start);
  let path = samples.paths.get(clip);
  if (!path) { path = new ShapedPath(clip, samples); samples.paths.set(clip, path); }
  return path;
}

/** A clip's shaped path, computed through clip frame `upto`; the inspector graph reads it too. */
export function followPath(report, clip, upto = clip.duration - 1) {
  const path = shapedPath(report, clip);
  path.ensure(report, upto);
  return path.data;
}

const smooth = t => t * t * (3 - 2 * t);
export function followEnvelope(clip, age) {
  const p = clip.params;
  return Math.max(0, Math.min(1, p.strength)) * Math.min(p.fadeIn ? smooth(Math.min(1, age / p.fadeIn)) : 1, p.fadeOut ? smooth(Math.min(1, (clip.duration - age) / p.fadeOut)) : 1);
}

/** Output-pixel offset and log zoom of the active follow clips at a tick. Overlapping follows share one frame:
 * their weights blend toward each target instead of adding up, so a fade from one figure to another crosses over. */
export function sampleFollow(report, clips, tick) {
  let x = 0, y = 0, zoom = 0, total = 0;
  for (const clip of clips) {
    const age = tick - clip.start;
    if (clip.type !== 'follow' || !clip.enabled || age < 0 || age >= clip.duration || clip.mutedRanges?.some(r => tick >= r.start && tick < r.end)) continue;
    const weight = followEnvelope(clip, age);
    if (!(weight > 0)) continue;
    const i = Math.floor(age), t = age - i, next = Math.min(clip.duration - 1, i + 1), path = followPath(report, clip, next);
    const a = i * STRIDE, b = next * STRIDE;
    x += weight * (path[a] + (path[b] - path[a]) * t);
    y += weight * (path[a + 1] + (path[b + 1] - path[a + 1]) * t);
    zoom += weight * (path[a + 2] + (path[b + 2] - path[a + 2]) * t);
    total += weight;
  }
  if (total > 1) { x /= total; y /= total; zoom /= total; }
  return {x, y, zoom};
}

/** The framing offset that keeps these figures where they are in the shot at this frame, or null when absent. */
export function followFramingOffset(report, frame, targets) {
  const weights = new Map(targets.map(t => [t.uid, t.weight])), own = {};
  let cx = 0, cy = 0, total = 0;
  for (const entry of buildGeometry(report, frame).objects.values()) {
    const weight = entry && weights.get(entry.obj.unique_id);
    if (!(weight > 0)) continue;
    own.minX = own.minY = Infinity; own.maxX = own.maxY = -Infinity;
    if (!figureBounds(entry, own)) continue;
    cx += (own.minX + own.maxX) / 2 * weight; cy += (own.minY + own.maxY) / 2 * weight; total += weight;
  }
  if (!total) return null;
  const camera = frame.camera?.is_default ? {} : frame.camera ?? {}, scale = camera.scale ?? 1, angle = camera.angle_rad ?? 0;
  const dx = cx / total - report.canvas_width / 2 - (camera.x ?? 0), dy = cy / total - report.canvas_height / 2 - (camera.y ?? 0);
  return {x: (Math.cos(angle) * dx + Math.sin(angle) * dy) / scale, y: (Math.cos(angle) * dy - Math.sin(angle) * dx) / scale};
}
