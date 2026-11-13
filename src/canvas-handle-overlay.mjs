import {HandleSprites} from './canvas-handle-sprites.mjs';

export {paintCanvasHandle} from './canvas-handle-sprites.mjs';
const intersects = (a, b) => a && b && a.x < b.x + b.width && a.x + a.width > b.x &&
  a.y < b.y + b.height && a.y + a.height > b.y;
function union(a, b) {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return {x, y, width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y};
}
/** A rectangle in canvas units (`minX…maxY`, already widened by the handles' outline and antialiasing), moved by
 * `tx, ty`, aligned to backing pixels so clips introduce no seams and clipped to the surface; `null` when off it. */
function damageRect(box, tx, ty, width, height, dpr) {
  if (!box) return null;
  const x = Math.max(0, Math.floor((box.minX + tx) * dpr) / dpr),
    y = Math.max(0, Math.floor((box.minY + ty) * dpr) / dpr),
    right = Math.min(width, Math.ceil((box.maxX + tx) * dpr) / dpr),
    bottom = Math.min(height, Math.ceil((box.maxY + ty) * dpr) / dpr);
  return right > x && bottom > y ? {x, y, width: right - x, height: bottom - y} : null;
}
/** The backing pixels a pan by `shift` brought into view along one axis (`length` of the surface that way, `across` the
 * other) as `{px, py, pw, ph}`, with the same rectangle in canvas units for culling. */
function strip(shift, length, across, vertical, dpr) {
  const span = Math.abs(shift), start = shift > 0 ? 0 : length - span;
  const rect = vertical ? {px: 0, py: start, pw: across, ph: span} : {px: start, py: 0, pw: span, ph: across};
  return Object.assign(rect, {x: rect.px / dpr, y: rect.py / dpr, width: rect.pw / dpr, height: rect.ph / dpr});
}
/** The delta every translated figure moves by, or null when there are none or they move by different deltas. */
function sharedDelta(translations) {
  let shared = null;
  for (const delta of translations?.values() ?? []) {
    if (!shared) shared = delta;
    else if (delta.x !== shared.x || delta.y !== shared.y) return null;
  }
  return shared;
}
/** Retains the single overlay surface. Unchanged descriptor groups reuse projected handles; pose edits clear affected pixels
 * and repaint every overlapping group in native order. A pan (only the projection's translation changed) moves the pixels
 * already painted and paints only the strips that came into view; view/order/style changes use a full pass. Every handle
 * is a stamp of its picture (`HandleSprites`), at whole backing pixels.
 *
 * `matrix` (`[a, b, c, d, e, f]`, screen = (a·x + c·y + e, b·x + d·y + f)) is the affine projection of world points to
 * canvas units; `projectionKey` then names everything else the picture depends on, and leaves out the translation `e, f`.
 * Without `matrix`, `project` projects each point and `projectionKey` names the whole projection (no pan is recognised).
 *
 * A pan moves the pixels by the nearest whole backing pixel and paints the new strips at the translation that leaves
 * (the one asked for after a pan by whole backing pixels, else less than half a backing pixel off it). The pixels moved
 * are the picture before, exactly; the strips, and the damage of a pose change, are a full repaint's at that translation,
 * exactly (their stamps are cut to their pixels). A full repaint at the new translation can still differ (a fractional
 * pan places each centre at another quarter of a backing pixel), so after any pan `draw` answers `settle: true`; a draw
 * with `rest` at the same translation (the caller asks for one once the view has rested a moment) repaints in full: the
 * picture at rest is always a full repaint's.
 *
 * `translations` (figure id → world delta) leave those figures out of the surface for the gesture. When they all move by
 * one delta, they are a second retained layer (`moving`, sharing the atlas) whose translation is the view's and the
 * delta's, so a drag is a pan of that layer, with the same settling; otherwise they are stamped over the picture each pass.
 * `zooming` stamps each handle at `quantizedRadius` and asks to settle; the next pass that is not zooming repaints exact.
 */
export class CanvasHandleOverlay {
  /** `panShiftFrom`: the handles on the surface from which a pan moves the pixels; with fewer, repainting them costs less. */
  constructor(surface, {panShiftFrom = 0, sprites = null} = {}) {
    this.surface = surface;
    this.panShiftFrom = panShiftFrom;
    this.context = surface.getContext('2d');
    // The handles' pictures, in an atlas made like the surface so both paint the same way.
    this.sprites = sprites ?? new HandleSprites((width, height) => {
      const canvas = new surface.constructor(width, height);
      canvas.getContext('2d', this.context.getContextAttributes?.());
      return canvas;
    });
    /** The figures a translation moves, on a layer of their own (`draw`), made at the first such gesture. */
    this.moving = null;
    this.run = {handles: [], xs: new Float64Array(64), ys: new Float64Array(64), count: 0};
    this.clear();
  }
  clear() { this.groups = []; this.key = null; this.at = null; this.requested = null; this.moved = false; this.moving?.clear(); }
  /** Adds a handle centred at canvas units `x, y` to the run `stamp` paints next. */
  queue(handle, x, y) {
    const run = this.run;
    if (run.count === run.xs.length) {
      const xs = new Float64Array(2 * run.count), ys = new Float64Array(2 * run.count);
      xs.set(run.xs); ys.set(run.ys); run.xs = xs; run.ys = ys;
    }
    run.handles[run.count] = handle; run.xs[run.count] = x; run.ys[run.count++] = y;
  }
  /** Paints the queued handles on `into` (only the backing pixels `crop`, if given), in the order queued, and empties
   * the run; answers how many there were. */
  stamp(into, dpr, outline, crop = null, quantize = false) {
    const run = this.run, count = run.count;
    this.sprites.paint(into, run.handles, run.xs, run.ys, count, {dpr, outline, crop, quantize});
    run.handles.fill(undefined, 0, count); run.count = 0;
    return count;
  }
  draw(target, handles, {project, matrix, projectionKey, width, height, dpr = 1, translations, outline = false, rest = false, zooming = false}) {
    const surface = this.surface, context = this.context;
    const [a, b, c, d, tx, ty] = matrix ?? [1, 0, 0, 1, 0, 0];
    const linear = matrix ? null : project;
    const groups = handles.groups ?? [{uid: null, handles}];
    // The figures a translation moves all by one delta are a retained layer of their own, panned by the delta (`moving`).
    const delta = matrix && handles.groups ? sharedDelta(translations) : null;
    // A matrix probed from a projection carries rounding in its last bits that changes with the translation: not a new view.
    // A zooming pass paints quantised sizes (`HandleSprites.paint`): the next one that is not repaints in full.
    const key = `${projectionKey}|${matrix ? [a, b, c, d].map(value => value.toPrecision(12)).join() : ''}|${width}|${height}|${dpr}|${outline}|${zooming}|${[...(translations?.keys() ?? [])].join(',')}`;
    let full = this.key !== key || groups.length !== this.groups.length ||
      groups.some((group, i) => group.uid !== this.groups[i]?.uid);
    const physicalWidth = Math.round(width * dpr), physicalHeight = Math.round(height * dpr);
    if (surface.width !== physicalWidth) { surface.width = physicalWidth; full = true; }
    if (surface.height !== physicalHeight) { surface.height = physicalHeight; full = true; }
    // Where the pixels already painted stand: a pan moves them by whole backing pixels.
    let paintX = tx, paintY = ty, shiftX = 0, shiftY = 0;
    if (!full && this.at) {
      const dx = (tx - this.at.x) * dpr, dy = (ty - this.at.y) * dpr;
      shiftX = Math.round(dx); shiftY = Math.round(dy);
      const exact = Math.abs(dx - shiftX) < 1e-6 && Math.abs(dy - shiftY) < 1e-6;
      if (Math.abs(shiftX) >= physicalWidth || Math.abs(shiftY) >= physicalHeight || (shiftX || shiftY || !exact) && (this.visible ?? 0) < this.panShiftFrom) full = true;
      // The view rests after a pan: repaint in full.
      else if (this.moved && rest && this.requested.x === tx && this.requested.y === ty) full = true;
      else if (!exact) { paintX = this.at.x + shiftX / dpr; paintY = this.at.y + shiftY / dpr; }
    }
    // Past a few dozen changed groups (a seek changes them all) the pass is full: merging their damage is quadratic and would
    // cover most of the surface.
    let changed = 0, changedHandles = 0, allHandles = 0;
    for (let index = 0; index < groups.length; index++) {
      const group = groups[index], count = translations?.has(group.uid) ? 0 : group.handles.length;
      allHandles += count;
      if (this.groups[index]?.handles !== group.handles) { changed++; changedHandles += count; }
    }
    if (changed > 64) full = true;
    if (full) { paintX = tx; paintY = ty; shiftX = shiftY = 0; }
    // The handles projected in this pass share one array: a group of a dense frame is often a single origin.
    const coords = new Float64Array(2 * (full ? allHandles : changedHandles)), next = [], dirty = [];
    let filled = 0;
    for (let index = 0; index < groups.length; index++) {
      const group = groups[index], previous = this.groups[index];
      if (!full && previous?.handles === group.handles) { next.push(previous); continue; }
      const count = translations?.has(group.uid) ? 0 : group.handles.length, at = filled;
      let box = null;
      for (let i = 0; i < count; i++) {
        const handle = group.handles[i], point = handle.point;
        let x, y;
        if (linear) ({x, y} = linear(point));
        else { x = a * point.x + c * point.y; y = b * point.x + d * point.y; }
        coords[filled++] = x; coords[filled++] = y;
        // Include the outline and antialias coverage.
        const radius = handle.screenRadius + 1;
        if (!box) box = {minX: x - radius, minY: y - radius, maxX: x + radius, maxY: y + radius};
        else {
          if (x - radius < box.minX) box.minX = x - radius;
          if (y - radius < box.minY) box.minY = y - radius;
          if (x + radius > box.maxX) box.maxX = x + radius;
          if (y + radius > box.maxY) box.maxY = y + radius;
        }
      }
      next.push({uid: group.uid, handles: group.handles, coords, at, count, box});
      if (!full) {
        const damage = union(damageRect(previous?.box, paintX, paintY, width, height, dpr), damageRect(box, paintX, paintY, width, height, dpr));
        if (damage) dirty.push(damage);
      }
    }
    // The strips a pan brought into view, in backing pixels. Each is its own region: merged, a horizontal and a vertical
    // strip would make the whole surface.
    const strips = [];
    if (!full && shiftX) strips.push(strip(shiftX, physicalWidth, physicalHeight, false, dpr));
    if (!full && shiftY) strips.push(strip(shiftY, physicalHeight, physicalWidth, true, dpr));
    // A few moving groups stay local. Large damage/order changes are cheaper
    // and simpler as a full pass than many clips or a second raster cache.
    const merged = [];
    for (const damage of dirty) {
      let rect = damage;
      for (let index = 0; index < merged.length;)
        if (intersects(merged[index], rect)) { rect = union(rect, merged.splice(index, 1)[0]); index = 0; }
        else index++;
      merged.push(rect);
    }
    if (merged.length > 16 || [...merged, ...strips].reduce((area, rect) => area + rect.width * rect.height, 0) > width * height / 2) full = true;
    if (full) { paintX = tx; paintY = ty; shiftX = shiftY = 0; }
    const paint = (rect, crop = null) => {
      const left = rect ? rect.x : 0, top = rect ? rect.y : 0, right = rect ? rect.x + rect.width : width, bottom = rect ? rect.y + rect.height : height;
      for (const group of next) {
        const box = group.box;
        if (!box || box.minX + paintX >= right || box.maxX + paintX <= left || box.minY + paintY >= bottom || box.maxY + paintY <= top) continue;
        const {handles: list, coords: points, at, count} = group;
        for (let i = 0; i < count; i++) {
          const handle = list[i], radius = handle.screenRadius + 1, x = points[at + 2 * i] + paintX, y = points[at + 2 * i + 1] + paintY;
          if (x + radius > left && x - radius < right && y + radius > top && y - radius < bottom) this.queue(handle, x, y);
        }
      }
      return this.stamp(context, dpr, outline, crop, zooming);
    };
    let visible = this.visible ?? 0;
    if (full) { context.setTransform(dpr, 0, 0, dpr, 0, 0); context.clearRect(0, 0, width, height); visible = paint(null); }
    else {
      if (shiftX || shiftY) {
        // Drawing a canvas onto itself draws a copy of it; `copy` leaves what the pixels moved off transparent.
        context.setTransform(1, 0, 0, 1, 0, 0);
        context.globalCompositeOperation = 'copy';
        context.drawImage(surface, shiftX, shiftY);
        context.globalCompositeOperation = 'source-over';
      }
      // The strips a pan brought in and the damage of a pose change are cleared and the handles reaching into them stamped
      // again, each stamp cut to their backing pixels: they are a full repaint's exactly, with no clip to blend through.
      context.setTransform(1, 0, 0, 1, 0, 0);
      for (const rect of strips) { context.clearRect(rect.px, rect.py, rect.pw, rect.ph); paint(rect, {x: rect.px, y: rect.py, width: rect.pw, height: rect.ph}); }
      for (const rect of merged) {
        const px = Math.round(rect.x * dpr), py = Math.round(rect.y * dpr), crop = {x: px, y: py, width: Math.round((rect.x + rect.width) * dpr) - px, height: Math.round((rect.y + rect.height) * dpr) - py};
        context.clearRect(crop.x, crop.y, crop.width, crop.height); paint(rect, crop);
      }
      if (strips.length || merged.length) visible = this.count(next, paintX, paintY, width, height);
    }
    this.groups = next; this.key = key; this.visible = visible;
    this.moved = !full && (this.moved || Boolean(shiftX || shiftY) || paintX !== tx || paintY !== ty);
    this.at = {x: paintX, y: paintY}; this.requested = {x: tx, y: ty};
    target.drawImage(surface, 0, 0, width, height);
    // The retained layer excludes translated figures for the whole gesture. Moved all by one delta (a selection dragged by
    // an origin), they are a layer of their own whose translation is the view's and the delta's: moving them is a pan of that
    // layer, its pixels moved and only the strips brought into view stamped, painted afresh when the gesture rests.
    let settle = this.moved || zooming, shown = null;
    if (delta) {
      if (!this.moving) {
        // Made like the surface, so both paint the same way.
        const layer = new surface.constructor(1, 1);
        layer.getContext('2d', context.getContextAttributes?.());
        this.moving = new CanvasHandleOverlay(layer, {panShiftFrom: this.panShiftFrom, sprites: this.sprites});
      }
      const moving = this.moving;
      shown = moving.draw(target, {groups: groups.filter(group => translations.has(group.uid))}, {matrix: [a, b, c, d, tx + a * delta.x + c * delta.y, ty + b * delta.x + d * delta.y],
        projectionKey, width, height, dpr, outline, rest, zooming});
      settle ||= shown.settle;
    } else if (this.moving && this.moving.key !== null) {
      // The gesture is over: the layer's pixels go, and the next gesture paints it afresh.
      this.moving.clear(); this.moving.surface.width = this.moving.surface.height = 1;
    }
    // Translated figures moved by different deltas are stamped over the picture each pass.
    if (translations && !delta) {
      for (const handle of handles) {
        const delta = translations.get(handle.uid);
        if (!delta) continue;
        const world = {x: handle.point.x + delta.x, y: handle.point.y + delta.y};
        const {x, y} = matrix ? {x: a * world.x + c * world.y + tx, y: b * world.x + d * world.y + ty} : project(world);
        const radius = handle.screenRadius + 1;
        if (x + radius > 0 && x - radius < width && y + radius > 0 && y - radius < height) this.queue(handle, x, y);
      }
      this.stamp(target, dpr, outline, null, zooming);
    }
    return {full, regions: full ? 1 : merged.length + strips.length, visible, shifted: Boolean(shiftX || shiftY), settle, moving: shown};
  }
  /** The handles on the surface at translation `x, y`. */
  count(groups, x, y, width, height) {
    let visible = 0;
    for (const group of groups) {
      const box = group.box;
      if (!box || box.minX + x >= width || box.maxX + x <= 0 || box.minY + y >= height || box.maxY + y <= 0) continue;
      if (box.minX + x >= 0 && box.maxX + x <= width && box.minY + y >= 0 && box.maxY + y <= height) { visible += group.count; continue; }
      for (let i = 0; i < group.count; i++) {
        const radius = group.handles[i].screenRadius + 1, px = group.coords[group.at + 2 * i] + x, py = group.coords[group.at + 2 * i + 1] + y;
        if (px + radius > 0 && px - radius < width && py + radius > 0 && py - radius < height) visible++;
      }
    }
    return visible;
  }
}
