/** Motion-path trails on the overlay: where the engine says a figure's joint (or the camera) is at each tick, drawn and hit-tested here.
 * The session samples them from its document (the document as an open trail edit shows it, while a point is dragged); edits write through
 * ordinary editor commands. This module chooses what to show a trail of, holds what the engine sampled and draws it.
 */
import {falloffWeight} from './motion-path-falloff.mjs';

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function motionPathTargetKey(target) {
  return target ? (target.kind === 'camera' ? 'camera' : `${target.uid}:${target.handleId}`) : '';
}

/** Tip joints: segment ends that no other segment hangs from — hands, feet
 * and head on a stick figure — without assuming anatomical labels. */
export function figureTipJoints(figure) {
  const parents = new Set(), tips = [];
  for (const segment of figure?.segments ?? []) parents.add(Number(segment.parent_id));
  figure?.segments?.forEach((segment, index) => {
    if (segment.visible !== false && !parents.has(Number(segment.segment_id))) tips.push(index);
  });
  return tips;
}

/** Every trail target. `joints: 'tips'` follows each figure's origin and tip
 * joints so a whole character's arcs read at once; otherwise the primary
 * figure shows its selected joint and others their origins. The primary
 * target resolves first so its colour stays stable across selections. */
export function motionPathTargets(editor, {camera = false, all = false, joints = 'selected', maxTargets = 48} = {}) {
  if (camera) return [{kind: 'camera'}];
  const frame = editor.selectionFrame ?? editor.evaluatedFrame, out = [], seen = new Set();
  const figures = new Map(editor.report.figure_types.map(f => [f.figure_type_id, f]));
  const objects = new Map(frame?.objects.map(o => [o.unique_id, o]) ?? []);
  const add = (uid, figure, j) => {
    if (out.length >= maxTargets) return;
    const target = {kind: 'node', uid, handleId: j < 0 ? 0 : Number(figure.segments[j].segment_id), joint: j};
    const key = motionPathTargetKey(target);
    if (!seen.has(key)) { seen.add(key); out.push(target); }
  };
  const push = (uid, joint) => {
    if (uid === null || uid === undefined || out.length >= maxTargets) return;
    const figure = figures.get(objects.get(uid)?.figure_type_id);
    if (!figure?.segments?.length) return;
    const j = joint >= 0 && joint < figure.segments.length ? joint : -1;
    add(uid, figure, j);
    if (joints !== 'tips') return;
    add(uid, figure, -1);
    for (const tip of figureTipJoints(figure)) add(uid, figure, tip);
  };
  const selected = editor.selectedUids ?? new Set();
  if (all) {
    if (editor.selectedUid !== null && editor.selectedUid !== undefined)
      push(editor.selectedUid, editor.selectedJoint);
    for (const object of frame?.objects ?? []) { if (out.length >= maxTargets) break; push(object.unique_id, -1); }
  } else {
    if (selected.has(editor.selectedUid)) push(editor.selectedUid, editor.selectedJoint);
    for (const uid of selected) if (uid !== editor.selectedUid) push(uid, -1);
  }
  return out;
}

/**
 * The trails the engine samples for the overlay: each target's points by tick, a few more at every read until the trail is
 * `complete`. A trail is sent only when it has changed since the last read; pointer input reads what the last read left
 * (`peek`) and never asks the engine. A trail is `{key, ticks, points: Map(tick -> {tick, x, y, rx, ry, key, missing}), version, complete}`:
 * `rx, ry` are where the body the point belongs to is, unless the point is that body's origin.
 */
export class MotionTrails {
  constructor(editor, {budgetMs = 6} = {}) {
    this.editor = editor; this.budgetMs = budgetMs; this.held = new Map(); this.stamp = null;
  }
  clear() { this.held.clear(); this.stamp = null; }
  /** The trail last read for `target`, while the document is as it was then. */
  peek(target) {
    const trail = this.held.get(motionPathTargetKey(target)), {editor, stamp} = this;
    return trail && stamp.report === editor.report && stamp.revision === editor.revision && stamp.layerRevision === editor.layerRevision ? trail : null;
  }
  /** The trails of `targets` (each `null` where the engine does not hold the document), sampling for at most `budgetMs` more. */
  read(targets, {range = 0, maxPoints = 1600} = {}) {
    const {editor} = this, held = {};
    for (const [key, trail] of this.held) held[key] = trail.version;
    const answer = editor._shown?.trails({targets, range, maxPoints, budgetMs: this.budgetMs, held});
    if (!answer) { this.clear(); return targets.map(() => null); }
    const next = new Map();
    for (const wire of answer.entries) {
      let trail = this.held.get(wire.key);
      if (wire.ticks) trail = {key: wire.key, ticks: wire.ticks, points: pointsOf(wire.points), version: wire.version, complete: wire.complete};
      else trail.complete = wire.complete;
      next.set(wire.key, trail);
    }
    this.held = next;
    this.stamp = {report: editor.report, revision: editor.revision, layerRevision: editor.layerRevision};
    return targets.map(target => next.get(motionPathTargetKey(target)) ?? null);
  }
  /** The pose of the figures joined with `target` at `tick`, `{rx, ry, lines, circles}`, or `null`: shown while a trail point is hovered or dragged. */
  ghost(target, tick) {
    return target?.kind === 'node' ? this.editor._shown?.trailGhost(target, tick) ?? null : null;
  }
}

/** The points of a trail, from the flat `tick, x, y, flags, bodyX, bodyY` rows the engine sends (trails.rs). */
function pointsOf(flat) {
  const points = new Map();
  for (let i = 0; i < flat.length; i += 6) {
    const flags = flat[i + 3], tick = flat[i];
    points.set(tick, {tick, x: flat[i + 1], y: flat[i + 2], rx: flags & 4 ? flat[i + 4] : undefined, ry: flags & 4 ? flat[i + 5] : undefined,
      key: (flags & 1) !== 0, missing: (flags & 2) !== 0});
  }
  return points;
}

/** Callers' projections (view × camera) are affine, so three probes recover the
 * matrix and each sample then costs two multiply-adds instead of a call. */
export function affineProjection(project) {
  if (Array.isArray(project)) return project;
  const o = project({x: 0, y: 0}), ex = project({x: 1, y: 0}), ey = project({x: 0, y: 1});
  return [ex.x - o.x, ex.y - o.y, ey.x - o.x, ey.y - o.y, o.x, o.y];
}

/** The playhead sample whose body reference anchors a relative trail. */
function relativeAnchor(entry, relative, tick) {
  if (!relative) return null;
  const anchor = entry.points.get(tick);
  return anchor && !anchor.missing && anchor.rx !== undefined ? anchor : null;
}

/**
 * Screen positions of an entry's drawable samples, cached until its samples,
 * the projection or the relative anchor change. Drawing and pointer hit tests
 * share them, so hovering never re-projects a trail. `breaks[i]` marks a
 * missing pose between samples i-1 and i; unsampled ticks do not break it.
 */
export function projectMotionPath(entry, project, {relative = false, tick} = {}) {
  const m = affineProjection(project), anchor = relativeAnchor(entry, relative, tick);
  const ax = anchor?.rx, ay = anchor?.ry, cached = entry.screen;
  if (cached && cached.version === entry.version && cached.ticks === entry.ticks && cached.points === entry.points &&
      cached.ax === ax && cached.ay === ay && cached.m.every((v, i) => v === m[i])) return cached;
  const samples = [], breaks = [];
  let gap = false;
  for (const t of entry.ticks) {
    const sample = entry.points.get(t);
    if (!sample) continue;
    if (sample.missing) { gap = samples.length > 0; continue; }
    samples.push(sample); breaks.push(gap); gap = false;
  }
  const n = samples.length, xs = new Float64Array(n), ys = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const p = samples[i];
    let x = p.x, y = p.y;
    if (anchor && p.rx !== undefined) { x += ax - p.rx; y += ay - p.ry; }
    xs[i] = m[0] * x + m[2] * y + m[4]; ys[i] = m[1] * x + m[3] * y + m[5];
  }
  return entry.screen = {version: entry.version, ticks: entry.ticks, points: entry.points, m, ax, ay, samples, breaks, xs, ys, speed: null};
}

export function pickMotionPathPoint(entry, point, {project, radius = 9, excludeTick, tick, relative = false} = {}) {
  const {samples, xs, ys} = projectMotionPath(entry, project, {relative, tick});
  let best = radius * radius, hit = -1;
  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i];
    if (excludeTick !== undefined && sample.tick === excludeTick) continue;
    const distance = (xs[i] - point.x) ** 2 + (ys[i] - point.y) ** 2;
    if (distance < best || (distance === best && (hit < 0 ||
        (tick !== undefined && Math.abs(sample.tick - tick) < Math.abs(samples[hit].tick - tick))))) {
      best = distance; hit = i;
    }
  }
  return hit < 0 ? null : {...samples[hit], distance: Math.sqrt(best)};
}

/** Slow → fast. Shared with the settings legend. */
export const MOTION_PATH_SPEED_COLORS = ['#3b82f6', '#06b6d4', '#22c55e', '#a3c211', '#eab308', '#f97316', '#ef4444'];

/** Per-segment speed bucket: screen distance per frame against the trail's
 * 90th percentile, so spacing reads as colour — cool is slow, warm is fast. */
function speedBuckets(screen) {
  if (screen.speed) return screen.speed;
  const {samples, xs, ys} = screen, n = samples.length, speed = new Float64Array(Math.max(0, n - 1));
  for (let i = 1; i < n; i++)
    speed[i - 1] = Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]) / Math.max(1, samples[i].tick - samples[i - 1].tick);
  const sorted = Float64Array.from(speed).sort(), reference = sorted[Math.floor((sorted.length - 1) * 0.9)] || 1;
  const buckets = new Uint8Array(speed.length), top = MOTION_PATH_SPEED_COLORS.length - 1;
  for (let i = 0; i < speed.length; i++) buckets[i] = Math.round(Math.min(1, speed[i] / reference) * top);
  return screen.speed = buckets;
}

const CELL = 12, cellOf = value => clamp(Math.floor(value / CELL), -32000, 32000) + 32768;

/**
 * Screen-space layout keeps dense/held paths legible without changing their
 * editable samples. Markers outside `bounds` (plus a margin) are skipped.
 */
export function layoutMotionPath(entry, project, {tick, hover, dragging, dots = true, labels = false, relative = false, bounds, currentBadge = true, badgeSuffix = ''} = {}) {
  const screen = projectMotionPath(entry, project, {relative, tick});
  const {samples, xs, ys} = screen, n = samples.length;
  const priority = p => p.tick === dragging?.tick ? 4 : p.tick === hover?.tick ? 3 : p.tick === tick ? 2 : p.key ? 1 : 0;
  // Stable priority makes the current/hovered point win at overlapping
  // positions: special points first, then keys, then the rest in time order.
  const order = [], keys = [], rest = [];
  for (let i = 0; i < n; i++) {
    const rank = priority(samples[i]);
    (rank >= 2 ? order : rank ? keys : rest).push(i);
  }
  order.sort((a, b) => priority(samples[b]) - priority(samples[a]) || a - b);
  order.push(...keys);
  if (dots) order.push(...rest);
  const margin = 24, cells = new Map(), markers = [], badges = [];
  const overlaps = (x, y, distance) => {
    const cx = cellOf(x), cy = cellOf(y);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++)
      for (const p of cells.get((cx + dx) * 65536 + cy + dy) ?? [])
        if ((x - p.x) ** 2 + (y - p.y) ** 2 < distance ** 2) return true;
    return false;
  };
  for (const i of order) {
    const p = samples[i], x = xs[i], y = ys[i], rank = priority(p);
    if (bounds && rank < 3 && (x < -margin || y < -margin || x > bounds.width + margin || y > bounds.height + margin)) continue;
    if (overlaps(x, y, rank ? 7 : 9)) continue;
    const key = cellOf(x) * 65536 + cellOf(y), marker = {tick: p.tick, key: p.key, x, y, rank};
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(marker);
    markers.push(marker);
    if (badges.length >= 48 || !(rank >= 3 || (labels && (rank === 2 ? currentBadge : p.key || i === 0 || i === n - 1)))) continue;
    const text = rank >= 3 && badgeSuffix ? `${p.tick + 1} ${badgeSuffix}` : String(p.tick + 1), width = text.length * 6.2 + 12;
    const box = {x: x + 9, y: y - 23, width, height: 18, text, rank};
    if (badges.some(b => box.x < b.x + b.width + 5 && box.x + width + 5 > b.x && box.y < b.y + b.height + 4 && box.y + box.height + 4 > b.y)) continue;
    badges.push(box);
  }
  return {screen, markers, badges};
}

const FALLOFF_COLOR = '#f97316';

/** Falloff preview: rings sized and weighted by each frame's influence, keys a
 * release will change filled with the trail colour, and added hold keys drawn
 * as squares. `influence` is {tick, radius, shape, changed: Set, edges: Set}. */
function drawInfluence(context, screen, markers, influence, color, alpha) {
  const {samples, xs, ys} = screen, {tick, radius, shape} = influence, buckets = [[], [], [], [], []];
  for (let i = 0; i < samples.length; i++) {
    const distance = Math.abs(samples[i].tick - tick);
    if (!distance || distance > radius) continue;
    const weight = falloffWeight(distance, radius, shape);
    buckets[Math.min(4, Math.floor(weight * 5))].push(i);
  }
  buckets.forEach((list, b) => {
    if (!list.length) return;
    const weight = (b + 0.5) / 5, r = 3 + weight * 8;
    context.beginPath();
    for (const i of list) { context.moveTo(xs[i] + r, ys[i]); context.arc(xs[i], ys[i], r, 0, Math.PI * 2); }
    context.globalAlpha = (0.1 + weight * 0.28) * alpha; context.fillStyle = FALLOFF_COLOR; context.fill();
  });
  for (const p of markers) {
    if (influence.changed?.has(p.tick) && !influence.edges?.has(p.tick) && p.tick !== tick) {
      const r = 5;
      context.beginPath(); context.moveTo(p.x, p.y - r); context.lineTo(p.x + r, p.y); context.lineTo(p.x, p.y + r); context.lineTo(p.x - r, p.y); context.closePath();
      context.globalAlpha = alpha; context.fillStyle = color; context.fill(); context.strokeStyle = '#ffffff'; context.lineWidth = 1.5; context.stroke();
    } else if (influence.edges?.has(p.tick)) {
      context.beginPath(); context.rect(p.x - 3.5, p.y - 3.5, 7, 7);
      context.globalAlpha = alpha; context.fillStyle = '#ffffff'; context.fill(); context.strokeStyle = '#64748b'; context.lineWidth = 1.5; context.stroke();
    }
  }
}

/** Neutral contrast halo, quieter past, crisp keys, optional speed colours,
 * an optional falloff preview and collision-free labels. */
export function drawMotionPath(context, entry, project, options = {}) {
  const {tick, color = '#0d99ff', faint = false, speed = false, strong = false, influence = null} = options;
  const {screen, markers, badges} = layoutMotionPath(entry, project, options);
  const {samples, breaks, xs, ys} = screen, n = samples.length;
  if (!n) return;
  const alpha = faint ? 0.25 : 1, width = strong ? 2.2 : 1.6;
  const buckets = speed && n > 1 ? speedBuckets(screen) : null;
  context.save();
  context.lineCap = 'round'; context.lineJoin = 'round';
  // One canvas path per style; segment i joins sample i-1 to sample i.
  const stroke = (lineWidth, style, opacity, accept) => {
    context.beginPath();
    let pen = false;
    for (let i = 1; i < n; i++) {
      if (!breaks[i] && accept(i)) {
        if (!pen) context.moveTo(xs[i - 1], ys[i - 1]);
        context.lineTo(xs[i], ys[i]); pen = true;
      } else pen = false;
    }
    context.lineWidth = lineWidth; context.strokeStyle = style; context.globalAlpha = opacity * alpha; context.stroke();
  };
  const past = i => samples[i].tick <= tick;
  stroke(width + 2.4, '#ffffff', 0.65, () => true);
  if (buckets) {
    MOTION_PATH_SPEED_COLORS.forEach((style, b) => {
      stroke(width + 0.6, style, 0.45, i => buckets[i - 1] === b && past(i));
      stroke(width + 0.6, style, 0.95, i => buckets[i - 1] === b && !past(i));
    });
  } else {
    stroke(width, color, 0.38, past);
    stroke(width, color, 0.85, i => !past(i));
  }
  // Batch small dots into a single fill instead of a canvas call per frame.
  context.beginPath();
  for (const p of markers) if (!p.rank) { context.moveTo(p.x + 2, p.y); context.arc(p.x, p.y, 2, 0, Math.PI * 2); }
  context.globalAlpha = 0.65 * alpha; context.fillStyle = color; context.fill();
  context.beginPath();
  for (const p of markers) if (p.rank === 1) {
    const r = 3.5;
    context.moveTo(p.x, p.y - r); context.lineTo(p.x + r, p.y);
    context.lineTo(p.x, p.y + r); context.lineTo(p.x - r, p.y); context.closePath();
  }
  context.globalAlpha = alpha; context.fillStyle = '#ffffff'; context.fill();
  context.strokeStyle = color; context.lineWidth = 1.5; context.stroke();
  if (influence) drawInfluence(context, screen, markers, influence, color, alpha);
  // The current frame is a ring; a hovered or dragged point fills with colour.
  for (let i = markers.length - 1; i >= 0; i--) {
    const p = markers[i], active = p.rank >= 3;
    if (p.rank < 2) continue;
    context.beginPath(); context.arc(p.x, p.y, active ? 11 : 9, 0, Math.PI * 2);
    context.globalAlpha = (active ? 0.22 : 0.15) * alpha; context.fillStyle = color; context.fill();
    context.beginPath(); context.arc(p.x, p.y, active ? 6 : 5, 0, Math.PI * 2);
    context.globalAlpha = alpha; context.fillStyle = active ? color : '#ffffff'; context.fill();
    context.strokeStyle = active ? '#ffffff' : color; context.lineWidth = 2; context.stroke();
  }
  context.font = '600 10px Inter, system-ui, sans-serif';
  context.textAlign = 'center'; context.textBaseline = 'middle';
  for (const b of badges) {
    context.globalAlpha = (b.rank >= 2 ? 1 : 0.82) * alpha;
    context.beginPath(); context.roundRect(b.x, b.y, b.width, b.height, 5);
    context.fillStyle = b.rank >= 3 ? color : '#263445'; context.fill();
    context.fillStyle = '#ffffff'; context.fillText(b.text, b.x + b.width / 2, b.y + b.height / 2);
  }
  context.restore();
}

/** The pose at a hovered or dragged trail point: a dashed stick outline of the
 * target's component, shifted like its trail when paths are shown relative. */
export function drawMotionPathGhost(context, ghost, project, {color = '#0d99ff', entry, relative = false, tick} = {}) {
  if (!ghost) return;
  const m = affineProjection(project), anchor = entry ? relativeAnchor(entry, relative, tick) : null;
  const dx = anchor && ghost.rx != null ? anchor.rx - ghost.rx : 0, dy = anchor && ghost.ry != null ? anchor.ry - ghost.ry : 0;
  const sx = (x, y) => m[0] * (x + dx) + m[2] * (y + dy) + m[4], sy = (x, y) => m[1] * (x + dx) + m[3] * (y + dy) + m[5];
  const scale = Math.hypot(m[0], m[1]);
  context.save();
  context.lineCap = 'round'; context.lineJoin = 'round';
  context.beginPath();
  for (const [x, y, radius] of ghost.circles) {
    const r = radius * scale, cx = sx(x, y), cy = sy(x, y);
    if (r > 0.5) { context.moveTo(cx + r, cy); context.arc(cx, cy, r, 0, Math.PI * 2); }
  }
  for (const line of ghost.lines) {
    context.moveTo(sx(line[0], line[1]), sy(line[0], line[1]));
    for (let i = 2; i < line.length; i += 2) context.lineTo(sx(line[i], line[i + 1]), sy(line[i], line[i + 1]));
  }
  context.globalAlpha = 0.7; context.strokeStyle = '#ffffff'; context.lineWidth = 4.5; context.stroke();
  context.globalAlpha = 0.9; context.strokeStyle = color; context.lineWidth = 1.75; context.setLineDash([5, 3]); context.stroke();
  context.restore();
}
