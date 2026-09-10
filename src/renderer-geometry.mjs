import earcut from '../vendor/earcut.mjs';
import { mixColor } from './pivot/geometry.mjs';
import { cameraIsIdentity, inverseCameraScale, effectiveCamera } from './pivot/background.mjs';

// Each record is six aligned vec4s, consumed directly by the GPU storage buffer.
export const SHAPE_FLOATS = 24;
export const SHAPE_BYTES = SHAPE_FLOATS * 4;
export const SHAPE = Object.freeze({ LINE: 0, CIRCLE: 1, SQUARE_LINE: 2, TRIANGLE: 3, TEXTURE: 4, RECT: 5, RADIAL_RECT: 6, DISABLED: -1 });

export function cameraMatrix({ report, frame, view = {}, cameraEnabled = true }) {
  const zoom = Number(view.scale ?? 1), x = Number(view.x ?? 0), y = Number(view.y ?? 0);
  const camera = effectiveCamera(report, frame, cameraEnabled);
  if (cameraIsIdentity(camera)) return [zoom, 0, 0, zoom, x, y];
  const scale = inverseCameraScale(camera) * zoom;
  const angle = -Number(camera.angle_rad ?? 0), a = Math.cos(angle) * scale, b = Math.sin(angle) * scale;
  const cx = Number(report?.canvas_width ?? 640) / 2, cy = Number(report?.canvas_height ?? 480) / 2;
  const px = cx + Number(camera.x ?? 0), py = cy + Number(camera.y ?? 0);
  return [a, b, -b, a, x + cx * zoom - a * px + b * py, y + cy * zoom - b * px - a * py];
}
export function worldToScreen(point, options) {
  const [a, b, c, d, e, f] = cameraMatrix(options);
  return { x: a * point.x + c * point.y + e, y: b * point.x + d * point.y + f };
}
export function screenToWorld(point, options) {
  const [a, b, c, d, e, f] = cameraMatrix(options), det = a * d - b * c;
  return { x: (d * (point.x - e) - c * (point.y - f)) / det, y: (-b * (point.x - e) + a * (point.y - f)) / det };
}

const clamp = (n, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, Number(n) || 0));
export function rgbaFloats(rgb = [0, 0, 0], alpha = 1) { return [...rgb.map(v => clamp(v / 255)), clamp(alpha)]; }
export function argbFloats(raw = 0xffffffff) {
  const n = Number(raw) >>> 0;
  return [(n >>> 16 & 255) / 255, (n >>> 8 & 255) / 255, (n & 255) / 255, (n >>> 24) / 255];
}
function objectColor(rgb, obj) {
  if (!obj.color_transition) return mixColor(rgb, obj.color_override_raw);
  const { from, to, t } = obj.color_transition, a = mixColor(rgb, from), b = mixColor(rgb, to);
  return a.map((v, i) => Math.round(v + (b[i] - v) * t));
}
function brush(s, root) {
  const color = rgbaFloats(s.rgb, s.alpha), secondary = s.seg?.secondary;
  if (!secondary || Number(s.obj.color_override_raw) >>> 24 === 255) return { color, color2: color, gradient: [0, 0, 0, 0] };
  let end = s.end;
  const dx = end.x - s.start.x, dy = end.y - s.start.y;
  if (Math.abs(s.bend) > 1e-7 && s.type === 'line') {
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    for (const p of s.points) { minx = Math.min(minx, p.x); maxx = Math.max(maxx, p.x); miny = Math.min(miny, p.y); maxy = Math.max(maxy, p.y); }
    const w = maxx - minx, h = maxy - miny;
    if (w > 1e-6 && h > 1e-6) {
      const d = dx * dx / (w * w) + dy * dy / (h * h), gx = dx / (w * w * d), gy = dy / (h * h * d), norm = gx * gx + gy * gy;
      if (norm > 0) end = { x: s.start.x + gx / norm, y: s.start.y + gy / norm };
    }
  }
  const gx = end.x - s.start.x, gy = end.y - s.start.y, norm = gx * gx + gy * gy || 1;
  return { color, color2: rgbaFloats(objectColor(secondary.rgb, s.obj), 1 - secondary.a / 255), gradient: [s.start.x - root.x, s.start.y - root.y, gx / norm, gy / norm] };
}
export function shapeRecord({ a = [0, 0, 0, 0], b = [0, 0, 0, 0], color = [0, 0, 0, 1], color2 = color, gradient = [0, 0, 0, 0], mode = SHAPE.LINE, transform = 0, extra = 0, clipToCanvas = false }) {
  return [...a, ...b, ...color, ...color2, ...gradient, mode, transform, extra, clipToCanvas ? 1 : 0];
}
function needsEvenOddRaster(points) {
  if (points.length > 256) return true;
  const cross = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    for (let j = i + 2; j < points.length; j++) {
      if (i === 0 && j === points.length - 1) continue;
      const c = points[j], d = points[(j + 1) % points.length];
      if (Math.max(a.x, b.x) < Math.min(c.x, d.x) || Math.max(c.x, d.x) < Math.min(a.x, b.x) || Math.max(a.y, b.y) < Math.min(c.y, d.y) || Math.max(c.y, d.y) < Math.min(a.y, b.y)) continue;
      if (cross(a, b, c) * cross(a, b, d) <= 0 && cross(c, d, a) * cross(c, d, b) <= 0) return true;
    }
  }
  return false;
}
export function requiresCompatibilityTexture(items) {
  return items.some(s => movieclipTransparency(s) || (s.seg?.paint && s.seg.paint.type !== 'solid') || s.type === 'text' || s.type === 'image' || s.opacity < .999999 || s.fig?.segment_decode?.global_style?.u28 || ((s.alpha < .999999 || s.seg?.secondary?.a > 0) && Math.abs(s.bend) > 1e-7) || (s.type === 'poly' && needsEvenOddRaster(s.points)));
}
function movieclipTransparency(item) {
  if(item._movieclipOwner?.opacity < .999999)return true;
  for(let inner=item._movieclipInner;inner;inner=inner.inner)if(inner.owner.opacity < .999999)return true;
  return false;
}

/** Reuse worker vectors for the same document revision/tick when editing resumes.
 * The owner verifies that revision/tick; these checks validate the per-object
 * descriptors. Cropped compatibility images are deliberately never adopted.
 */
export function adoptPreparedVectors(packet, geometry, vectorCache, compatibilityCache) {
  let objects = 0, bytes = 0;
  if (!(packet?.shapes instanceof Float32Array) || !(packet.transforms instanceof Float32Array) || !packet.uids || !packet.groups) return {objects, bytes};
  for (const group of packet.groups) {
    const g = geometry.objects.get(group.slot), transform = group.transformIndex;
    if (!g || g.obj.unique_id !== group.uid || !Number.isInteger(transform) || transform < 1 ||
      packet.uids[transform] !== group.uid || packet.transforms[transform * 4] !== Math.fround(g.root.x) ||
      packet.transforms[transform * 4 + 1] !== Math.fround(g.root.y)) continue;
    if (group.compatibilityIndex !== undefined) {
      if (packet.compatibility?.[group.compatibilityIndex]?.uid === group.uid) compatibilityCache.set(g, true);
      continue;
    }
    const {firstInstance, instanceCount} = group;
    if (!Number.isInteger(firstInstance) || !Number.isInteger(instanceCount) || firstInstance < 0 || instanceCount < 0 ||
      (firstInstance + instanceCount) * SHAPE_FLOATS > packet.shapes.length) continue;
    if (vectorCache.has(g)) continue;
    const data = packet.shapes.slice(firstInstance * SHAPE_FLOATS, (firstInstance + instanceCount) * SHAPE_FLOATS);
    let valid = true;
    for (let i = 20; i < data.length; i += SHAPE_FLOATS) {
      if (data[i] < SHAPE.LINE || data[i] > SHAPE.TRIANGLE || !Number.isInteger(data[i]) || data[i + 1] !== transform) { valid = false; break; }
      data[i + 1] = 0;
    }
    if (!valid) continue;
    vectorCache.set(g, data); compatibilityCache.set(g, false); objects++; bytes += data.byteLength;
  }
  return {objects, bytes};
}

/** Tessellate one figure into GPU-native primitives, in the decoder's painter order. */
export function compileVectorObject(items, root = { x: 0, y: 0 }, transform = 0) {
  const steps = compileVectorObjectSteps(items, root, transform);
  for (;;) { const step = steps.next(); if (step.done) return step.value; }
}
export function* compileVectorObjectSteps(items, root = { x: 0, y: 0 }, transform = 0) {
  let result = new Float32Array(Math.max(1, items.length * 2) * SHAPE_FLOATS), used = 0, paint;
  const add = (mode, ax, ay, bx, by, cx = 0, cy = 0, radius = 0, inner = 0, white = false) => {
    if (used + SHAPE_FLOATS > result.length) { const grown = new Float32Array(result.length * 2); grown.set(result); result = grown; }
    result[used] = ax; result[used + 1] = ay; result[used + 2] = bx; result[used + 3] = by;
    result[used + 4] = cx; result[used + 5] = cy; result[used + 6] = radius; result[used + 7] = inner;
    if (white) { result.fill(1, used + 8, used + 15); result[used + 11] = paint.color[3]; result[used + 15] = paint.color[3]; }
    else { result.set(paint.color, used + 8); result.set(paint.color2, used + 12); }
    result.set(paint.gradient, used + 16); result[used + 20] = mode; result[used + 21] = transform;
    used += SHAPE_FLOATS;
  };
  let completed = 0;
  for (const s of items) {
    if ((++completed & 127) === 0) yield {phase:'GPU vectors',completed,total:items.length};
    paint = brush(s, root);
    if (s.type === 'poly') {
      if (s.points.length < 3) continue;
      const points = new Float64Array(s.points.length * 2);
      for (let i = 0; i < s.points.length; i++) { points[i * 2] = s.points[i].x - root.x; points[i * 2 + 1] = s.points[i].y - root.y; }
      const indices = earcut(points);
      for (let i = 0; i < indices.length; i += 3) {
        const a = indices[i] * 2, b = indices[i + 1] * 2, c = indices[i + 2] * 2;
        add(SHAPE.TRIANGLE, points[a], points[a + 1], points[b], points[b + 1], points[c], points[c + 1]);
        if (i && i % 1536 === 0) yield {phase:'GPU polygon',completed:i,total:indices.length};
      }
    } else if (s.type === 'circle') {
      const width = Math.max(0, s.thickness), filled = s.seg.segment_kind === 'circleFill' || width >= Math.abs(s.length);
      const radius = (Math.abs(s.length) + (filled ? width : 0)) / 2;
      const cx = (s.start.x + s.end.x) / 2 - root.x, cy = (s.start.y + s.end.y) / 2 - root.y;
      if (!radius) continue;
      if (!filled && s.seg.segment_kind === 'circle') {
        add(SHAPE.CIRCLE, cx, cy, 0, 0, 0, 0, radius, 0, true);
      }
      if (filled) add(SHAPE.CIRCLE, cx, cy, 0, 0, 0, 0, radius);
      else if (width > 0) add(SHAPE.CIRCLE, cx, cy, 0, 0, 0, 0, radius + width / 2, Math.max(0, radius - width / 2));
    } else if (s.type === 'line' && s.thickness > 0) {
      const mode = s.seg.segment_kind === 'squareLine' ? SHAPE.SQUARE_LINE : SHAPE.LINE;
      for (let i = 1; i < s.points.length; i++) add(mode, s.points[i - 1].x - root.x, s.points[i - 1].y - root.y, s.points[i].x - root.x, s.points[i].y - root.y, 0, 0, s.thickness / 2);
    }
  }
  return result.slice(0, used);
}

/** Conservative bounds include anchored media, vector glyph extents, and outline. */
export function objectBounds(items, resources = {}) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const include = (x, y, pad = 0) => { if (!Number.isFinite(x + y + pad)) return; x0 = Math.min(x0, x - pad); y0 = Math.min(y0, y - pad); x1 = Math.max(x1, x + pad); y1 = Math.max(y1, y + pad); };
  for (const s of items) {
    let outline = 0;
    if (s.fig?.segment_decode?.global_style?.u28) outline = Math.abs(new Float32Array(new Uint32Array([s.fig.segment_decode.global_style.u28]).buffer)[0] * Number(s.obj.scale ?? 1));
    const pad = Math.max(0, s.thickness ?? 0) / 2 + (Number.isFinite(outline) ? outline : 0) + 3;
    if (s.type === 'circle') include((s.start.x + s.end.x) / 2, (s.start.y + s.end.y) / 2, Math.abs(s.length) / 2 + pad);
    else for (const p of s.points || []) include(p.x, p.y, pad);
    if (s.type === 'image' && s.asset) {
      const a = s.asset, image = resources.image?.(resources.url?.(a));
      const width = a.display_width ?? (image?.naturalWidth || a.width || a.pixel_width || 1), height = a.display_height ?? (image?.naturalHeight || a.height || a.pixel_height || 1);
      const reverse = Boolean(s.seg.extra_u8_a ?? s.seg.extra?.[1]), mirror = Boolean(s.seg.extra_u8_b ?? s.seg.extra?.[2]) !== Boolean(s.obj.image_text_flags);
      const start = reverse ? s.end : s.start, angle = (mirror ? s.angle + a.anchor_angle_rad - Math.PI : s.angle - a.anchor_angle_rad) + (reverse ? Math.PI : 0);
      const scale = Math.hypot(s.end.x - s.start.x, s.end.y - s.start.y) / (a.anchor_length || 1), cos = Math.cos(angle), sin = Math.sin(angle);
      for (const [x, y] of [[0, 0], [width, 0], [width, height], [0, height]]) {
        const px = (x - (a.anchor_start?.x || 0)) * scale * (mirror ? -1 : 1), py = (y - (a.anchor_start?.y || 0)) * scale;
        include(start.x + px * cos - py * sin, start.y + px * sin + py * cos, pad);
      }
    }
    if (s.type === 'text' && s.asset?.bounds) {
      const a = s.asset, reverse = Boolean(s.seg.extra_u8_a ?? s.seg.extra?.[1]), mirror = Boolean(s.seg.extra_u8_b ?? s.seg.extra?.[2]) !== Boolean(s.obj.image_text_flags);
      const start = reverse ? s.end : s.start, angle = s.angle + (reverse ? Math.PI : 0) - (mirror ? Math.PI : 0), cos = Math.cos(angle), sin = Math.sin(angle);
      const xs = Math.hypot(s.end.x - s.start.x, s.end.y - s.start.y) / (a.bounds.width || 1) * (mirror ? -1 : 1), ys = Number(s.obj.scale ?? 1);
      for (const pl of a.placements || []) {
        const gb = a.glyphs?.[pl.glyph_index]?.bounds;
        if (!pl.visible || !gb) continue;
        for (const [x, y] of [[gb.left, gb.top], [gb.right ?? gb.left + gb.width, gb.top], [gb.left, gb.bottom], [gb.right ?? gb.left + gb.width, gb.bottom]]) {
          const px = (pl.x - a.bounds.left + x) * xs, py = (pl.y - a.bounds.bottom + y) * ys;
          include(start.x + px * cos - py * sin, start.y + px * sin + py * cos, pad);
        }
      }
      // Some legacy glyph records omit per-glyph bounds.
      for (const [x, y] of [[0, -a.bounds.height], [a.bounds.width, -a.bounds.height], [0, 0], [a.bounds.width, 0]]) include(start.x + x * xs * cos - y * ys * sin, start.y + x * xs * sin + y * ys * cos, pad);
    }
  }
  if (!Number.isFinite(x0)) return { x: 0, y: 0, width: 1, height: 1 };
  return { x: Math.floor(x0), y: Math.floor(y0), width: Math.max(1, Math.ceil(x1) - Math.floor(x0)), height: Math.max(1, Math.ceil(y1) - Math.floor(y0)) };
}
