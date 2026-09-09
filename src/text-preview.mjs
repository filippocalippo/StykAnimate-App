import {canvasPaint, textPaintGeometry} from './paint.mjs';
/** Canvas preview uses the portable paths that the figure exports. No system-font drawing. */
export function drawTextPreview(canvas, figure) {
  const dpr = Math.min(3, globalThis.devicePixelRatio || 1);
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width * dpr)),
    height = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, width, height);
  const index = figure?._styk?.textAuthoring?.assetIndex;
  const asset =
    index === undefined
      ? figure?.text_assets?.[0]
      : figure?.text_assets?.find(
          (a) => (a.asset_index ?? a.table_index) === index,
        );
  if (!asset?.bounds || !asset.svg_path) return;
  const assetIndex = asset.asset_index ?? asset.table_index ?? 0;
  const segment = figure.segments.find(
    (s) =>
      (s.primitive_code === 5 || s.segment_type === "text") &&
      (s.extra_u16 ?? s.extra?.[0] ?? 0) === assetIndex,
  );
  if (!segment) return;
  const style = figure.segment_decode?.global_style || {},
    outline = style.outline_thickness || 0;
  const b = asset.bounds,
    pad = 28 * dpr;
  const scale = Math.max(
    0.001,
    Math.min(
      (width - pad * 2) / (b.width + outline * 2),
      (height - pad * 2) / (b.height + outline * 2),
    ),
  );
  ctx.save();
  ctx.translate((width - b.width * scale) / 2, (height - b.height * scale) / 2);
  ctx.scale(scale, scale);
  ctx.translate(-b.left, -b.top);
  const path = new Path2D(asset.svg_path),
    rgb = (color) => `rgb(${(color || [0, 0, 0]).join(",")})`;
  if (outline > 0) {
    ctx.lineWidth = outline * 2;
    ctx.lineJoin = "round";
    ctx.strokeStyle = rgb(style.rgb);
    ctx.globalAlpha =
      (1 - (style.outline_transparency || 0) / 255) *
      (1 - (segment.transparency || 0) / 255);
    ctx.stroke(path);
  }
  ctx.globalAlpha = 1 - (segment.transparency || 0) / 255;
  if (segment.secondary) {
    const gradient = ctx.createLinearGradient(b.left, b.top, b.right, b.top);
    gradient.addColorStop(0, rgb(segment.color_rgb));
    gradient.addColorStop(1, rgb(segment.secondary.rgb));
    ctx.fillStyle = gradient;
  } else ctx.fillStyle = rgb(segment.color_rgb);
  if(segment.paint){const g=textPaintGeometry(b);ctx.globalAlpha=1;ctx.fillStyle=canvasPaint(ctx,segment.paint,g.start,g.end,c=>c,g.bounds);}
  ctx.fill(path);
  ctx.restore();
}
