import {svgPaintDefinition, segmentPaint, textPaintGeometry, shapePaintBounds} from './paint.mjs';
import { buildGeometry, mixColor } from './pivot/geometry.mjs';
import { backgroundBounds, sceneBackgroundColor } from './pivot/background.mjs';
import { cameraMatrix } from './renderer-geometry.mjs';
import { normalizeExportSmoothing } from './export-sampling.mjs';

const escape = value => String(value).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;'}[c]));
const clamp = value => Math.max(0, Math.min(1, Number(value) || 0));
function number(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error('SVG export encountered a non-finite scene coordinate.');
  return String(Number(n.toFixed(7)));
}
const rgb = value => `rgb(${(value || [0, 0, 0]).map(v => Math.round(Math.max(0, Math.min(255, Number(v) || 0)))).join(',')})`;
const paint = (color, alpha = 1) => ({color: rgb(color), alpha: clamp(alpha)});
const argb = raw => {
  const n = Number(raw) >>> 0;
  return paint([(n >>> 16) & 255, (n >>> 8) & 255, n & 255], (n >>> 24) / 255);
};
const brushAttributes = (brush, kind = 'fill') => `${kind}="${escape(brush.color)}" ${kind}-opacity="${number(brush.alpha)}"`;
const floatBits = raw => new Float32Array(new Uint32Array([raw]).buffer)[0];
const pathPoints = points => points.map((p, i) => `${i ? 'L' : 'M'}${number(p.x)} ${number(p.y)}`).join(' ');
function objectColor(base, obj) {
  if (!obj.color_transition) return mixColor(base, obj.color_override_raw);
  const {from, to, t} = obj.color_transition, a = mixColor(base, from), b = mixColor(base, to);
  return a.map((v, i) => Math.round(v + (b[i] - v) * t));
}
function strokeWidth(state, requested) {
  const width = Math.fround(Math.max(0, requested));
  if (Math.abs(width - state.width) > 1e-4) state.width = width;
  return state.width;
}
function dimension(value, label) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new RangeError(`${label} must be an integer from 1 to 65535.`);
  return n;
}
async function dataURL(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return `data:${blob.type || 'image/png'};base64,${btoa(binary)}`;
}
async function decodeImage(href, image) {
  if (image?.complete && image.naturalWidth) return image;
  if (!image) {
    if (typeof Image === 'undefined') return null;
    image = new Image(); image.decoding = 'async'; image.src = href;
  }
  if (typeof image.decode === 'function') await image.decode();
  else if (!image.complete) await new Promise((resolve, reject) => {
    image.addEventListener('load', resolve, {once: true});
    image.addEventListener('error', () => reject(new Error('Could not decode an SVG bitmap resource.')), {once: true});
  });
  if (!image.naturalWidth) throw new Error('Could not decode an SVG bitmap resource.');
  return image;
}
function hasTransparency(image, asset, resources) {
  if (resources.hasTransparency) return resources.hasTransparency(image, asset);
  if (asset.mime_type === 'image/jpeg') return false;
  if (!image) return true;
  const width = image.naturalWidth, height = image.naturalHeight;
  if (width * height > 64 * 1024 * 1024) throw new RangeError('Background alpha inspection is limited to 64 megapixels.');
  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(width, height) : document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d', {willReadFrequently: true});
  ctx.drawImage(image, 0, 0);
  const pixels = ctx.getImageData(0, 0, width, height).data;
  for (let i = 3; i < pixels.length; i += 4) if (pixels[i] !== 255) return true;
  return false;
}

/**
 * Export one evaluated Pivot frame as self-contained, editable SVG vectors.
 * Bitmap segments/backgrounds are embedded; text uses decoded glyph outlines.
 * `resources` has the renderer's `{url(asset), image(url)}` interface. Width and
 * height set the output dimensions, while scene coordinates retain their viewBox.
 */
export async function exportSVG({report, frame, frameIndex = 0, geometry, width, height, resources = {}, cameraEnabled = true, smoothing = 'edges'} = {}) {
  smoothing = normalizeExportSmoothing(smoothing);
  if (!report) throw new TypeError('SVG export requires a decoded scene report.');
  frame ??= report.keyframes?.[frameIndex];
  if (!frame) throw new RangeError('The requested SVG frame does not exist.');
  const sceneWidth = dimension(report.canvas_width ?? 640, 'Scene width');
  const sceneHeight = dimension(report.canvas_height ?? 480, 'Scene height');
  width = dimension(width ?? sceneWidth, 'SVG width'); height = dimension(height ?? sceneHeight, 'SVG height');
  geometry ??= buildGeometry(report, frame);
  const definitions = [], bitmaps = resources.svgBitmaps ?? new Map();
  const matrix = cameraMatrix({report, frame, cameraEnabled});
  const pixelScale = Math.min(width / sceneWidth, height / sceneHeight) * Math.hypot(matrix[0], matrix[1]);
  const gradient = (kind, coordinates, stops) => {
    const id = `gradient-${definitions.length + 1}`;
    definitions.push(`<${kind} id="${id}" gradientUnits="userSpaceOnUse" ${coordinates}>${stops.map((s, i) => `<stop offset="${i / (stops.length - 1)}" stop-color="${s.color}" stop-opacity="${number(s.alpha)}"/>`).join('')}</${kind}>`);
    return {color: `url(#${id})`, alpha: 1};
  };
  const linear = (a, b, stops) => gradient('linearGradient', `x1="${number(a.x)}" y1="${number(a.y)}" x2="${number(b.x)}" y2="${number(b.y)}"`, stops);
  const bitmap = asset => {
    const url = resources.url?.(asset) || asset?.asset_url || asset?.data_url || asset?.asset_path_relative || asset?.asset_path;
    if (!url) throw new Error('An SVG bitmap resource has no usable URL.');
    if (!bitmaps.has(url)) bitmaps.set(url, (async () => {
      let href = url;
      if (!/^data:image\//i.test(url)) {
        const response = await (resources.fetch?.(url) ?? fetch(url));
        if (!response.ok) throw new Error(`Could not load SVG bitmap resource (${response.status}).`);
        const blob = await response.blob();
        if (blob.type && !blob.type.startsWith('image/') && blob.type !== 'application/octet-stream') throw new Error('SVG bitmap resource is not an image.');
        const embedded = blob.type.startsWith('image/') ? blob : new Blob([blob], {type: asset.mime_type || 'image/png'});
        href = await dataURL(embedded);
      }
      const image = await decodeImage(href, resources.image?.(url));
      const w = image?.naturalWidth || asset.width || asset.pixel_width, h = image?.naturalHeight || asset.height || asset.pixel_height;
      if (!(w > 0 && h > 0)) throw new Error('An SVG bitmap resource has no valid dimensions.');
      return {href, get image() { return resources.image?.(url) || image; }, width: w, height: h};
    })());
    return bitmaps.get(url);
  };
  async function imageElement(image, transform, scale = 1, opacity = 1) {
    const attributes = `opacity="${number(clamp(opacity))}" transform="${transform}"`;
    if (smoothing !== 'none') return `<image width="${number(image.width)}" height="${number(image.height)}" ${attributes} preserveAspectRatio="none" image-rendering="pixelated" href="${escape(image.href)}"/>`;
    if (!(scale * pixelScale > 0)) return '';
    // resvg applies coverage AA to image quads even when shape AA is disabled.
    // Extend edge texels beyond that boundary, then use a hard geometric clip.
    // The extension covers at least one output pixel at the smallest scale.
    const padding = Math.max(1, Math.ceil(1 / (Math.abs(scale) * pixelScale)));
    if (!image.padded || image.padded.padding < padding) {
      const paddedWidth = image.width + 2 * padding, paddedHeight = image.height + 2 * padding;
      if (paddedWidth > 16384 || paddedHeight > 16384 || paddedWidth * paddedHeight > 32 * 1024 * 1024)
        throw new RangeError('The aliased bitmap edge buffer exceeds 128 MiB or 16,384 pixels per side. Increase output size or use Smooth edges.');
      const source = image.image;
      if (!source) throw new Error('Aliased sprite export requires a decoded bitmap.');
      const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(paddedWidth, paddedHeight) : document.createElement('canvas');
      canvas.width = paddedWidth; canvas.height = paddedHeight;
      try {
        const ctx = canvas.getContext('2d'); ctx.imageSmoothingEnabled = false;
        const xs = [[0,1,0,padding],[0,image.width,padding,image.width],[image.width-1,1,padding+image.width,padding]];
        const ys = [[0,1,0,padding],[0,image.height,padding,image.height],[image.height-1,1,padding+image.height,padding]];
        for (const [sx,sw,dx,dw] of xs) for (const [sy,sh,dy,dh] of ys) ctx.drawImage(source,sx,sy,sw,sh,dx,dy,dw,dh);
        const blob = canvas.convertToBlob ? await canvas.convertToBlob({type:'image/png'}) : await new Promise((resolve,reject)=>canvas.toBlob(value=>value?resolve(value):reject(new Error('Could not prepare aliased bitmap edges.')),'image/png'));
        image.padded = {padding, href: await dataURL(blob), width:paddedWidth, height:paddedHeight};
      } finally {canvas.width=canvas.height=1;}
    }
    const padded = image.padded, id = `bitmap-clip-${definitions.length+1}`;
    definitions.push(`<clipPath id="${id}" clipPathUnits="userSpaceOnUse"><rect width="${number(image.width)}" height="${number(image.height)}" shape-rendering="crispEdges"/></clipPath>`);
    return `<g ${attributes} clip-path="url(#${id})"><image x="${-padded.padding}" y="${-padded.padding}" width="${padded.width}" height="${padded.height}" preserveAspectRatio="none" image-rendering="pixelated" href="${escape(padded.href)}"/></g>`;
  }
  // Fetch/decode independent resources together before building the XML.
  const assets = geometry.drawables.filter(s => s.type === 'image' && s.asset).map(s => s.asset);
  const override = sceneBackgroundColor(report, frame);
  for (const id of override === undefined ? [frame.background_id, ...(frame.background_mix ? [frame.background_id_b] : [])] : []) {
    const bg = report.backgrounds?.find(b => Number(b.background_id) === Number(id));
    if (bg && bg.kind !== 3 && bg.kind !== 4 && bg.kind !== 2 && bg.color === undefined) assets.push(bg);
  }
  await Promise.all(assets.map(bitmap));

  const bounds = backgroundBounds(frame, sceneWidth, sceneHeight, cameraEnabled, report);
  const rect = brush => `<rect x="${number(bounds.x)}" y="${number(bounds.y)}" width="${number(bounds.width)}" height="${number(bounds.height)}" ${brushAttributes(brush)}/>`;
  async function background(id, alpha = 1) {
    const bg = report.backgrounds?.find(b => Number(b.background_id) === Number(id));
    let content = '';
    if (bg?.paint) content=rect(await customBrush(bg.paint,{x:0,y:sceneHeight/2},{x:sceneWidth,y:sceneHeight/2},c=>c,bounds));
    else if (!bg) content = rect(paint([255, 255, 255]));
    else if (bg.kind === 3) content = rect(linear({x: bg.x1 * sceneWidth, y: bg.y1 * sceneHeight}, {x: bg.x2 * sceneWidth, y: bg.y2 * sceneHeight}, [argb(bg.color_a), argb(bg.color_b)]));
    else if (bg.kind === 4) {
      const outer = bg.y2 * sceneHeight;
      if (outer <= 0) content = rect(argb(bg.color_a));
      else {
        const x = bg.x1 * sceneWidth, y = bg.y1 * sceneHeight, inner = Math.min(Math.max(0, bg.x2 * sceneHeight), .99 * outer);
        content = rect(gradient('radialGradient', `cx="${number(x)}" cy="${number(y)}" r="${number(outer)}" fx="${number(x)}" fy="${number(y)}" fr="${number(inner)}"`, [argb(bg.color_b), argb(bg.color_a)]));
      }
    } else if (bg.kind === 2 || bg.color !== undefined) content = rect(argb(bg.color));
    else {
      const image = await bitmap(bg), scale = Math.max(sceneWidth / image.width, sceneHeight / image.height);
      if (alpha === 1 && bounds.clearRaster && !hasTransparency(image.image, bg, resources)) content += rect(paint([0, 0, 0]));
      content += await imageElement(image, `scale(${number(scale)})`, scale);
    }
    return `<g opacity="${number(clamp(alpha))}">${content}</g>`;
  }
  async function customBrush(p,start,end,mapColor=c=>c,paintBounds) {
    if(p.type==='solid')return paint(mapColor(p.stops[0].color),p.stops[0].opacity);
    const id=`paint-${definitions.length+1}`; definitions.push(await svgPaintDefinition(p,start,end,id,mapColor,paintBounds));return {color:`url(#${id})`,alpha:1};
  }
  async function segmentBrush(s) {
    if(s.seg?.paint && !s.outline && Number(s.obj.color_override_raw) >>> 24 !== 255)return customBrush(segmentPaint(s.seg),s.start,s.end,c=>objectColor(c,s.obj),shapePaintBounds(s));
    if (s.outline || !s.seg?.secondary || Number(s.obj.color_override_raw) >>> 24 === 255) return paint(s.rgb, s.alpha);
    let end = s.end;
    const dx = end.x - s.start.x, dy = end.y - s.start.y;
    if (Math.abs(s.bend) > 1e-7 && s.type === 'line') {
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const p of s.points) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); }
      const w = x1 - x0, h = y1 - y0;
      if (w > 1e-6 && h > 1e-6) {
        const d = dx * dx / (w * w) + dy * dy / (h * h), gx = dx / (w * w * d), gy = dy / (h * h * d), norm = gx * gx + gy * gy;
        if (norm > 0) end = {x: s.start.x + gx / norm, y: s.start.y + gy / norm};
      }
    }
    return linear(s.start, end, [paint(s.rgb, s.alpha), paint(objectColor(s.seg.secondary.rgb, s.obj), 1 - s.seg.secondary.a / 255)]);
  }
  async function primitives(items, stroke) {
    const parts = [];
    for (const s of items) {
      const brush = await segmentBrush(s), fill = brushAttributes(brush), line = brushAttributes(brush, 'stroke');
      if (s.type === 'text') {
        const a = s.asset;
        if (!a?.normalized_svg_path || !a.bounds?.width) continue;
        const reverse = Boolean(s.seg.extra_u8_a ?? s.seg.extra?.[1]), mirror = Boolean(s.seg.extra_u8_b ?? s.seg.extra?.[2]) !== Boolean(s.obj.image_text_flags);
        const start = reverse ? s.end : s.start, angle = s.angle + (reverse ? Math.PI : 0) - (mirror ? Math.PI : 0);
        const xs = Math.hypot(s.end.x - s.start.x, s.end.y - s.start.y) / a.bounds.width;
        const glyphs = [];
        for (const placement of a.placements || []) {
          if (!placement.visible) continue;
          const glyph = a.glyphs?.[placement.glyph_index];
          if (!glyph?.svg_path) continue;
          let attributes;
          if (s.outline) attributes = `fill="none" ${brushAttributes(paint(s.rgb), 'stroke')} stroke-width="${number(strokeWidth(stroke, 2 * s.outline / Math.abs(s.obj.scale ?? 1)))}" stroke-linecap="round" stroke-linejoin="round"`;
          else {
            let glyphBrush = paint(s.rgb, s.alpha);
            if (s.seg.paint && Number(s.obj.color_override_raw) >>> 24 !== 255) {
              const g=textPaintGeometry(a.bounds,placement);glyphBrush=await customBrush(segmentPaint(s.seg),g.start,g.end,c=>objectColor(c,s.obj),g.bounds);
            }
            else if (s.seg.secondary && Number(s.obj.color_override_raw) >>> 24 < 255 && glyph.bounds) glyphBrush = linear({x: 0, y: glyph.bounds.bottom}, {x: 0, y: glyph.bounds.top}, [glyphBrush, paint(objectColor(s.seg.secondary.rgb, s.obj), 1 - s.seg.secondary.a / 255)]);
            attributes = `${brushAttributes(glyphBrush)} fill-rule="evenodd"`;
          }
          glyphs.push(`<path transform="translate(${number(placement.x - a.bounds.left)} ${number(placement.y - a.bounds.bottom)})" d="${escape(glyph.svg_path)}" ${attributes}/>`);
        }
        parts.push(`<g transform="translate(${number(start.x)} ${number(start.y)}) rotate(${number(angle * 180 / Math.PI)}) scale(${number(mirror ? -xs : xs)} ${number(s.obj.scale ?? 1)})">${glyphs.join('')}</g>`);
      } else if (s.type === 'image') {
        if (!s.asset?.anchor_length) continue;
        const a = s.asset, image = await bitmap(a), reverse = Boolean(s.seg.extra_u8_a ?? s.seg.extra?.[1]), mirror = Boolean(s.seg.extra_u8_b ?? s.seg.extra?.[2]) !== Boolean(s.obj.image_text_flags);
        const start = reverse ? s.end : s.start, angle = (mirror ? s.angle + a.anchor_angle_rad - Math.PI : s.angle - a.anchor_angle_rad) + (reverse ? Math.PI : 0);
        const scale = Math.hypot(s.end.x - s.start.x, s.end.y - s.start.y) / a.anchor_length;
        parts.push(await imageElement(image, `translate(${number(start.x)} ${number(start.y)}) rotate(${number(angle * 180 / Math.PI)}) scale(${number(mirror ? -scale : scale)} ${number(scale)}) translate(${number(-a.anchor_start.x)} ${number(-a.anchor_start.y)})`, scale, s.alpha));
      } else if (s.type === 'poly') {
        if (s.points.length < 3) continue;
        const width = strokeWidth(stroke, s.outline ? 2 * s.outline : 0);
        parts.push(`<path d="${pathPoints(s.points)} Z" ${s.outline ? `fill="none" ${line} stroke-width="${number(width)}" stroke-linejoin="round"` : `${fill} fill-rule="evenodd"`}/>`);
      } else {
        let width = strokeWidth(stroke, s.baseThickness ?? s.thickness);
        if (s.outline) width = strokeWidth(stroke, width + 2 * s.outline);
        if (s.type === 'circle') {
          const filled = s.seg.segment_kind === 'circleFill' || width >= Math.abs(s.length), radius = (Math.abs(s.length) + (filled ? width : 0)) / 2;
          if (!radius) continue;
          const position = `cx="${number((s.start.x + s.end.x) / 2)}" cy="${number((s.start.y + s.end.y) / 2)}" r="${number(radius)}"`;
          // Keep fill/stroke as separate paint operations: each has segment alpha.
          if (filled || s.seg.segment_kind === 'circle') parts.push(`<circle ${position} ${!filled && !s.outline ? brushAttributes(paint([255, 255, 255], s.alpha)) : fill}/>`);
          if (!filled && width > 0) parts.push(`<circle ${position} fill="none" ${line} stroke-width="${number(width)}"/>`);
        } else if (s.points.length >= 2 && width > 0) parts.push(`<path d="${pathPoints(s.points)}" fill="none" ${line} stroke-width="${number(width)}" stroke-linecap="${s.seg.segment_kind === 'squareLine' ? 'square' : 'round'}" stroke-linejoin="round"/>`);
      }
    }
    return parts.join('');
  }
  const groups = [], mainStroke = {width: 1};
  for (const s of geometry.drawables) {
    let group = groups.at(-1);
    if (!group || group.slot !== s.slot) { group = {slot: s.slot, opacity: s.opacity, items: []}; groups.push(group); }
    group.items.push(s);
  }
  let scene = override !== undefined ? rect(argb(override)) : await background(frame.background_id);
  if (override === undefined && frame.background_mix) scene += await background(frame.background_id_b, frame.background_mix / 255);
  for (const group of groups) {
    if (group.opacity <= 0) continue;
    const stroke = group.opacity < 1 ? {width: 1} : mainStroke;
    const style = group.items.find(s => s.fig)?.fig.segment_decode?.global_style, outlineWidth = style ? floatBits(style.u28) : 0;
    let content = '';
    if (outlineWidth > 0 && Number.isFinite(outlineWidth)) {
      const outline = group.items.filter(s => s.type !== 'image').map(s => ({...s, outline: outlineWidth * Math.abs(s.obj.scale ?? 1), rgb: style.rgb, alpha: 1, baseThickness: s.thickness, thickness: s.thickness === undefined ? undefined : s.thickness + 2 * outlineWidth * Math.abs(s.obj.scale ?? 1)}));
      const opacity = clamp(1 - Number(style.u30 ?? 0) / 255);
      if (opacity > 0) content += `<g opacity="${number(opacity)}">${await primitives(outline, opacity < 1 ? {width: 1} : stroke)}</g>`;
    }
    content += await primitives(group.items, stroke);
    scene += `<g data-object-id="${escape(group.items[0].obj.unique_id ?? group.slot)}" opacity="${number(clamp(group.opacity ?? 1))}">${content}</g>`;
  }
  // SVG remains editable vector artwork. Crisp edges is an actual SVG rasterizer
  // hint; supersampling is reserved for fixed-resolution raster exports.
  const rendering = smoothing === 'none' ? ' shape-rendering="crispEdges"' : '';
  return new Blob([`<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${sceneWidth} ${sceneHeight}" preserveAspectRatio="none"${rendering}><title>StykAnimate frame ${Number(frameIndex) + 1}</title><defs>${definitions.join('')}</defs><g transform="matrix(${matrix.map(number).join(' ')})">${scene}</g></svg>`], {type: 'image/svg+xml'});
}
