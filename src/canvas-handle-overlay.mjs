const TAU = Math.PI * 2;
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
/** Paints one handle at `point` (canvas units): what the overlay paints for each handle, in this order. */
export function paintCanvasHandle(context, handle, point, outline = false) {
  context.beginPath();
  const radius = handle.screenRadius;
  if (handle.connector) {
    context.moveTo(point.x, point.y - radius); context.lineTo(point.x + radius, point.y);
    context.lineTo(point.x, point.y + radius); context.lineTo(point.x - radius, point.y); context.closePath();
  } else context.arc(point.x, point.y, radius, 0, TAU);
  context.fillStyle = handle.color;
  context.strokeStyle = handle.ik ? '#0d99ff' : '#000000';
  context.lineWidth = 1;
  context.fill();
  if (outline || handle.ik) context.stroke();
}
/** `paintCanvasHandle` for a run of handles on one context state: the same commands, but a style is set only when it changes
 * (the context parses a colour string on every set, a good part of a handle's cost). Make one per save/restore block. */
function painter(context, outline) {
  let fill = null, stroke = null;
  context.lineWidth = 1;
  return (handle, x, y) => {
    context.beginPath();
    const radius = handle.screenRadius;
    if (handle.connector) {
      context.moveTo(x, y - radius); context.lineTo(x + radius, y);
      context.lineTo(x, y + radius); context.lineTo(x - radius, y); context.closePath();
    } else context.arc(x, y, radius, 0, TAU);
    if (fill !== handle.color) context.fillStyle = fill = handle.color;
    context.fill();
    if (outline || handle.ik) {
      const color = handle.ik ? '#0d99ff' : '#000000';
      if (stroke !== color) context.strokeStyle = stroke = color;
      context.stroke();
    }
  };
}

/** Retains the single overlay surface. Unchanged descriptor groups reuse projected handles; pose edits clear affected pixels
 * and repaint every overlapping group in native order. A pan (only the projection's translation changed) moves the pixels
 * already painted and paints only the strips that came into view; view/order/style changes use a full pass.
 *
 * `matrix` (`[a, b, c, d, e, f]`, screen = (a·x + c·y + e, b·x + d·y + f)) is the affine projection of world points to
 * canvas units; `projectionKey` then names everything else the picture depends on, and leaves out the translation `e, f`.
 * Without `matrix`, `project` projects each point and `projectionKey` names the whole projection (no pan is recognised).
 *
 * A pan moves the pixels by the nearest whole backing pixel and paints the new strips at the translation that leaves
 * (the one asked for after a pan by whole backing pixels, else less than half a backing pixel off it). The pixels moved
 * are the picture before, exactly; the strips are a full repaint's at that translation, exactly. A full repaint at the
 * new translation would still differ at some edge pixels (the rasteriser does not draw a moved circle as the same pixels
 * moved), so after any pan `draw` answers `settle: true`; a draw with `rest` at the same translation (the caller asks
 * for one once the view has rested a moment) repaints in full: the picture at rest is always a full repaint's.
 */
export class CanvasHandleOverlay {
  constructor(surface) {
    this.surface = surface;
    this.context = surface.getContext('2d');
    this.clear();
  }
  clear() { this.groups = []; this.key = null; this.at = null; this.requested = null; this.moved = false; }
  draw(target, handles, {project, matrix, projectionKey, width, height, dpr = 1, translations, outline = false, rest = false}) {
    const surface = this.surface, context = this.context;
    const [a, b, c, d, tx, ty] = matrix ?? [1, 0, 0, 1, 0, 0];
    const linear = matrix ? null : project;
    // A matrix probed from a projection carries rounding in its last bits that changes with the translation: not a new view.
    const key = `${projectionKey}|${matrix ? [a, b, c, d].map(value => value.toPrecision(12)).join() : ''}|${width}|${height}|${dpr}|${outline}|${[...(translations?.keys() ?? [])].join(',')}`;
    const groups = handles.groups ?? [{uid: null, handles}];
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
      if (Math.abs(shiftX) >= physicalWidth || Math.abs(shiftY) >= physicalHeight) full = true;
      // The view rests after a pan: repaint in full.
      else if (this.moved && rest && this.requested.x === tx && this.requested.y === ty) full = true;
      else if (!exact) { paintX = this.at.x + shiftX / dpr; paintY = this.at.y + shiftY / dpr; }
    }
    // Past a few dozen changed groups (a seek changes them all) the pass is full: merging their damage is quadratic and would
    // cover most of the surface.
    if (!full) for (let index = 0, changed = 0; index < groups.length; index++)
      if (this.groups[index]?.handles !== groups[index].handles && ++changed > 64) { full = true; break; }
    if (full) { paintX = tx; paintY = ty; shiftX = shiftY = 0; }
    // The handles projected in this pass share one array: a group of a dense frame is often a single origin.
    let total = 0;
    for (let index = 0; index < groups.length; index++)
      if ((full || this.groups[index]?.handles !== groups[index].handles) && !translations?.has(groups[index].uid)) total += groups[index].handles.length;
    const coords = new Float64Array(2 * total), next = [], dirty = [];
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
    const paint = (rect, into = context) => {
      const paintOne = painter(into, outline);
      let visible = 0;
      const left = rect ? rect.x : 0, top = rect ? rect.y : 0, right = rect ? rect.x + rect.width : width, bottom = rect ? rect.y + rect.height : height;
      for (const group of next) {
        const box = group.box;
        if (!box || box.minX + paintX >= right || box.maxX + paintX <= left || box.minY + paintY >= bottom || box.maxY + paintY <= top) continue;
        const {handles: list, coords: points, at, count} = group;
        for (let i = 0; i < count; i++) {
          const handle = list[i], radius = handle.screenRadius + 1, x = points[at + 2 * i] + paintX, y = points[at + 2 * i + 1] + paintY;
          if (x + radius > left && x - radius < right && y + radius > top && y - radius < bottom) { paintOne(handle, x, y); visible++; }
        }
      }
      return visible;
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
      // A clip's edge changes the antialiasing of the pixels beside it, so a region is not repainted under a clip: the
      // handles that reach into it are painted whole on a spare surface of the same pixels (what that holds elsewhere does
      // not matter) and the region's pixels are copied over, the full repaint's exactly. The spare goes on the next draw
      // that repaints no region and leaves the picture where asked.
      const regions = [...strips, ...merged.map(rect => {
        const px = Math.round(rect.x * dpr), py = Math.round(rect.y * dpr), pw = Math.round((rect.x + rect.width) * dpr) - px, ph = Math.round((rect.y + rect.height) * dpr) - py;
        return {px, py, pw, ph, x: px / dpr, y: py / dpr, width: pw / dpr, height: ph / dpr};
      })];
      for (const rect of regions) {
        // Made like the surface, so both paint the same way (a browser may paint a canvas it reads back on the CPU).
        const spare = this.spare ??= new surface.constructor(physicalWidth, physicalHeight);
        const scratch = spare.getContext('2d', context.getContextAttributes?.());
        if (spare.width !== physicalWidth) spare.width = physicalWidth;
        if (spare.height !== physicalHeight) spare.height = physicalHeight;
        scratch.setTransform(1, 0, 0, 1, 0, 0); scratch.clearRect(rect.px, rect.py, rect.pw, rect.ph);
        scratch.setTransform(dpr, 0, 0, dpr, 0, 0); paint(rect, scratch);
        context.setTransform(1, 0, 0, 1, 0, 0); context.clearRect(rect.px, rect.py, rect.pw, rect.ph);
        context.drawImage(spare, rect.px, rect.py, rect.pw, rect.ph, rect.px, rect.py, rect.pw, rect.ph);
      }
      if (regions.length) visible = this.count(next, paintX, paintY, width, height);
    }
    this.groups = next; this.key = key; this.visible = visible;
    this.moved = !full && (this.moved || Boolean(shiftX || shiftY) || paintX !== tx || paintY !== ty);
    if (!this.moved && (full || !strips.length && !merged.length) && this.spare) { this.spare.width = this.spare.height = 1; this.spare = null; }
    this.at = {x: paintX, y: paintY}; this.requested = {x: tx, y: ty};
    target.drawImage(surface, 0, 0, width, height);
    // Keep translated figures in the existing foreground pass. The retained
    // layer excludes them for the whole gesture, so moving only updates these.
    if (translations) {
      const paintOne = painter(target, outline);
      for (const handle of handles) {
        const delta = translations.get(handle.uid);
        if (!delta) continue;
        const world = {x: handle.point.x + delta.x, y: handle.point.y + delta.y};
        const {x, y} = matrix ? {x: a * world.x + c * world.y + tx, y: b * world.x + d * world.y + ty} : project(world);
        const radius = handle.screenRadius + 1;
        if (x + radius > 0 && x - radius < width && y + radius > 0 && y - radius < height) paintOne(handle, x, y);
      }
    }
    return {full, regions: full ? 1 : merged.length + strips.length, visible, shifted: Boolean(shiftX || shiftY), settle: this.moved};
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
