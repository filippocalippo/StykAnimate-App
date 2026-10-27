import { cameraIsIdentity, inverseCameraScale, effectiveCamera } from './pivot/background.mjs';
import { drawingPixelBounds } from './drawing-model.mjs';
import { drawableVfxPadding } from './vfx-drawable.mjs';

// The workspace view's pure math: where a world point lands on screen under the scene camera and the
// Draw view's rotation and mirror (the engine draws the same matrix, styk_eval::view::camera_matrix and
// orientation), and the conservative bounds the editor measures figures with.

export function cameraMatrix({ report, frame, view = {}, cameraEnabled = true }) {
  const zoom = Number(view.scale ?? 1), x = Number(view.x ?? 0), y = Number(view.y ?? 0);
  const rotate=matrix=>{if(!view.rotation)return matrix;const [a,b,c,d,e,f]=matrix,r=Math.cos(view.rotation),s=Math.sin(view.rotation),cx=x+(report?.canvas_width??640)*zoom/2,cy=y+(report?.canvas_height??480)*zoom/2;return [r*a-s*b,s*a+r*b,r*c-s*d,s*c+r*d,cx+r*(e-cx)-s*(f-cy),cy+s*(e-cx)+r*(f-cy)];};
  // A flipped view mirrors the screen horizontally about the stage centre,
  // after rotation, so painting can check proportions like Krita's mirror view.
  const place = matrix => {const m = rotate(matrix); if (!view.flip) return m; const cx = x + (report?.canvas_width ?? 640) * zoom / 2; return [-m[0], m[1], -m[2], m[3], 2 * cx - m[4], m[5]];};
  const camera = effectiveCamera(report, frame, cameraEnabled);
  if (cameraIsIdentity(camera)) return place([zoom, 0, 0, zoom, x, y]);
  const scale = inverseCameraScale(camera) * zoom;
  const angle = -Number(camera.angle_rad ?? 0), a = Math.cos(angle) * scale, b = Math.sin(angle) * scale;
  const cx = Number(report?.canvas_width ?? 640) / 2, cy = Number(report?.canvas_height ?? 480) / 2;
  const px = cx + Number(camera.x ?? 0), py = cy + Number(camera.y ?? 0);
  return place([a, b, -b, a, x + cx * zoom - a * px + b * py, y + cy * zoom - b * px - a * py]);
}
export function worldToScreen(point, options) {
  const [a, b, c, d, e, f] = cameraMatrix(options);
  return { x: a * point.x + c * point.y + e, y: b * point.x + d * point.y + f };
}
export function screenToWorld(point, options) {
  const [a, b, c, d, e, f] = cameraMatrix(options), det = a * d - b * c;
  return { x: (d * (point.x - e) - c * (point.y - f)) / det, y: (-b * (point.x - e) + a * (point.y - f)) / det };
}

/** Conservative bounds include anchored media, vector glyph extents, and outline. */
export function objectBounds(items, resources = {}) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const include = (x, y, pad = 0) => { if (!Number.isFinite(x + y + pad)) return; x0 = Math.min(x0, x - pad); y0 = Math.min(y0, y - pad); x1 = Math.max(x1, x + pad); y1 = Math.max(y1, y + pad); };
  for (const s of items) {
    let outline = 0;
    if (s.fig?.segment_decode?.global_style?.u28) outline = Math.abs(new Float32Array(new Uint32Array([s.fig.segment_decode.global_style.u28]).buffer)[0] * Number(s.obj.scale ?? 1));
    // Zero-width construction lines have handles/topology but paint no pixels.
    // Including distant control endpoints can reduce an entire isolated figure
    // to a handful of pixels at the texture-size limit. Outlines still paint.
    if (s.type === 'line' && (s.baseThickness ?? s.thickness) === 0 && !outline && !s.outline) continue;
    const pad = Math.max(0, s.thickness ?? 0) / 2 + (Number.isFinite(outline) ? outline : 0) + 3 + (resources.vfxBounds===false?0:drawableVfxPadding(s));
    if (s.type === 'mesh') { const b = s.spatialMesh.bounds; if (b) { include(b.x0, b.y0, pad); include(b.x1, b.y1, pad); } continue; }
    if (s.type === 'circle') include((s.start.x + s.end.x) / 2, (s.start.y + s.end.y) / 2, Math.abs(s.length) / 2 + pad);
    else for (const p of s.points || []) include(p.x, p.y, pad);
    if (s.type === 'image' && s.asset) {
      // v2 drawings size from authoritative tile bounds; the 1×1 carrier PNG
      // is never a raster source, so it must not be requested either: a lazy
      // request the render path never retains re-decodes and invalidates the
      // renderer every frame. A live store covers strokes still in flight.
      const a = s.asset, v2 = s.fig?._styk?.drawing?.version === 2, image = v2 ? null : resources.image?.(resources.url?.(a));
      const tiles = resources.drawing?.(s.fig)?.store?.bounds ?? drawingPixelBounds(s.fig);
      const width = tiles?.width ?? a.display_width ?? (image?.naturalWidth || a.width || a.pixel_width || 1), height = tiles?.height ?? a.display_height ?? (image?.naturalHeight || a.height || a.pixel_height || 1);
      const bx = tiles?.x ?? 0, by = tiles?.y ?? 0;
      const reverse = Boolean(s.seg.extra_u8_a ?? s.seg.extra?.[1]), mirror = Boolean(s.seg.extra_u8_b ?? s.seg.extra?.[2]) !== Boolean(s.obj.image_text_flags);
      const start = reverse ? s.end : s.start, angle = (mirror ? s.angle + a.anchor_angle_rad - Math.PI : s.angle - a.anchor_angle_rad) + (reverse ? Math.PI : 0);
      const scale = Math.hypot(s.end.x - s.start.x, s.end.y - s.start.y) / (a.anchor_length || 1), cos = Math.cos(angle), sin = Math.sin(angle);
      for (const [x, y] of [[bx, by], [bx + width, by], [bx + width, by + height], [bx, by + height]]) {
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
