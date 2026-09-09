/** Small per-instance style overlays; native figure definitions remain shared. */
import {normalizePaint, segmentPaint} from './paint.mjs';
const alphaByte = opacity => Math.round((1 - opacity) * 255);
const opacityOf = alpha => 1 - Number(alpha ?? 0) / 255;
export const styleColor = rgb => ((rgb?.[0] ?? 0) << 16 | (rgb?.[1] ?? 0) << 8 | (rgb?.[2] ?? 0)) >>> 0;
const rgbOf = color => [color >>> 16 & 255, color >>> 8 & 255, color & 255];
export const polygonIdentity = (polygon,index) => polygon.polyfill_id ?? index + 1;
export const nativeSegmentOpacity = segment => segment.transparency === undefined ? Number(segment.color_alpha ?? 1) : opacityOf(segment.transparency);

/** Validate the small persisted overlay without inspecting shared assets. */
export function validateAnimationStyle(object) {
  const style = object?._stykStyle; if (style === undefined) return object;
  const record = value => value && typeof value === 'object' && !Array.isArray(value);
  const opacity = value => { if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) throw new Error('Instance style opacity must be between zero and one.'); };
  if (!record(style)) throw new Error('Instance style must be a property record.');
  if ('outlineOpacity' in style) opacity(style.outlineOpacity);
  const color = value => { if (!Number.isInteger(value) || value < 0 || value > 0xffffff) throw new Error('Style color must be an RGB integer.'); };
  const width = value => { if (!Number.isFinite(value) || value < 0 || value > 1e6) throw new Error('Style width is outside the supported range.'); };
  if ('outlineColor' in style) color(style.outlineColor);
  if ('outlineWidth' in style) width(style.outlineWidth);
  if (style.segments !== undefined) {
    if (!record(style.segments)) throw new Error('Instance segment styles must be a handle table.');
    for (const [handle, values] of Object.entries(style.segments)) {
      const id = Number(handle);
      if (!Number.isInteger(id) || id < 1 || id > 65535 || String(id) !== handle || !record(values)) throw new Error('Instance style has an invalid segment handle.');
      if ('opacity' in values) opacity(values.opacity);
      if ('gradientOpacity' in values) opacity(values.gradientOpacity);
      if ('color' in values) color(values.color);
      if ('gradientColor' in values) color(values.gradientColor);
      if ('thickness' in values) width(values.thickness);
      if ('paint' in values) normalizePaint(values.paint);
    }
  }
  if (style.polygons !== undefined) {
    if (!record(style.polygons)) throw new Error('Polygon styles must be an identity table.');
    for (const [id, values] of Object.entries(style.polygons)) {
      if (!Number.isInteger(Number(id)) || Number(id) < 1 || Number(id) > 65535 || !record(values)) throw new Error('Invalid polygon style identity.');
      if ('color' in values) color(values.color);
      if ('opacity' in values) opacity(values.opacity);
    }
  }
  return object;
}

export function isAnimationStyleProperty(target, property) {
  if (target.kind === 'polygon') return true;
  return target.kind === 'segment' || (target.kind === 'figure' && ['outlineOpacity', 'outlineColor', 'outlineWidth'].includes(property));
}

/** Read the displayed style, including a pose source's captured overrides. */
export function animationStyleValue(figure, object, target, property) {
  if (!figure || !object) return undefined;
  if (target.kind === 'polygon') {
    if (target.figureTypeId !== object.figure_type_id) return undefined;
    const polygon = figure.polyfills?.find((item,index) => polygonIdentity(item,index) === target.polygonId);
    if (!polygon) return undefined;
    return object._stykStyle?.polygons?.[target.polygonId]?.[property] ?? (property === 'color' ? styleColor(polygon.color_rgb) : polygon.alpha_raw === undefined ? polygon.color_alpha ?? 1 : opacityOf(polygon.alpha_raw));
  }
  if (target.kind === 'segment' && target.figureTypeId !== undefined && target.figureTypeId !== object.figure_type_id) return undefined;
  if (target.kind === 'figure') {
    const style = figure.segment_decode?.global_style;
    return object._stykStyle?.[property] ?? (property === 'outlineColor' ? styleColor(style?.rgb) : property === 'outlineWidth' ? style?.outline_thickness ?? 0 : opacityOf(style?.u30));
  }
  const segment = figure.segments?.find(segment => Number(segment.segment_id) === target.handleId);
  if (!segment) return undefined;
  const override = object._stykStyle?.segments?.[target.handleId];
  if (property === 'paint') return override?.paint ?? segmentPaint(segment);
  if (property === 'opacity') return override?.opacity ?? override?.paint?.stops[0]?.opacity ?? nativeSegmentOpacity(segment);
  if (property === 'color') return override?.color ?? (override?.paint ? styleColor(override.paint.stops[0].color) : styleColor(segment.color_rgb));
  if (property === 'thickness') return override?.thickness ?? segment.thickness ?? 0;
  // A secondary endpoint is meaningful only on a native gradient segment.
  const endpoint = override?.paint && override.paint.type !== 'solid' ? override.paint.stops.at(-1) : null;
  if (!segment.secondary && !endpoint) return undefined;
  if (property === 'gradientColor') return override?.gradientColor ?? (endpoint ? styleColor(endpoint.color) : styleColor(segment.secondary.rgb));
  return override?.gradientOpacity ?? (endpoint?.opacity ?? opacityOf(segment.secondary.a));
}

/** Update an already copied object without copying assets or other segments. */
export function setAnimationStyle(object, target, property, value) {
  if (target.kind === 'segment' && target.figureTypeId !== undefined && target.figureTypeId !== object.figure_type_id) return object;
  const style = object._stykStyle = {...object._stykStyle};
  if (target.kind === 'figure') style[property] = value;
  else if (target.kind === 'polygon') {
    if (target.figureTypeId !== object.figure_type_id) return object;
    style.polygons = {...style.polygons, [target.polygonId]:{...style.polygons?.[target.polygonId], [property]:value}};
  } else {
    style.segments = {...style.segments};
    style.segments[target.handleId] = {...style.segments[target.handleId], [property]: value};
  }
  return object;
}

/**
 * Resolve for every renderer/exporter. Only touched definitions are copied;
 * images, glyphs, geometry and unrelated segment records retain identity.
 * No retained cache means ordinary in-place native type edits remain visible.
 */
export function resolveInstanceFigure(figure, object) {
  const style = object?._stykStyle;
  if (!figure || !style) return figure;
  let result = figure;
  const copy = () => { if (result === figure) result = {...figure}; };
  if (Number.isFinite(style.outlineOpacity)) {
    const u30 = alphaByte(style.outlineOpacity);
    if (u30 !== Number(figure.segment_decode?.global_style?.u30 ?? 0)) {
      copy(); result.segment_decode = {...figure.segment_decode, global_style: {...figure.segment_decode?.global_style, u30}};
    }
  }
  for (const [property, field] of [['outlineColor', 'rgb'], ['outlineWidth', 'outline_thickness']]) if (Number.isFinite(style[property])) {
    copy(); result.segment_decode = {...result.segment_decode, global_style: {...result.segment_decode?.global_style,
      [field]: property === 'outlineColor' ? rgbOf(style[property]) : style[property]}};
    if (property === 'outlineWidth') result.segment_decode.global_style.u28 = new Uint32Array(new Float32Array([style[property]]).buffer)[0];
  }
  let segments;
  for (let index = 0; style.segments && index < (figure.segments?.length ?? 0); index++) {
    const segment = figure.segments[index], override = style.segments[segment.segment_id];
    if (!override) continue;
    let next = segment;
    if (override.paint) {
      const paint=normalizePaint(override.paint),first=paint.stops[0],last=paint.stops.at(-1);
      next={...next,paint,color_rgb:first.color,transparency:alphaByte(first.opacity),color_alpha:first.opacity,
        secondary:paint.type === 'solid' ? null : {rgb:last.color,a:alphaByte(last.opacity)}};
    }
    if (Number.isFinite(override.color)) next = {...next, color_rgb: rgbOf(override.color)};
    if (Number.isFinite(override.thickness)) next = {...next, thickness: override.thickness, visible: override.thickness > .01 || segment.primitive_code > 0};
    if (next.secondary && Number.isFinite(override.gradientColor)) next = {...next, secondary: {...next.secondary, rgb: rgbOf(override.gradientColor)}};
    if (Number.isFinite(override.opacity)) {
      const transparency = alphaByte(override.opacity);
      if (transparency !== alphaByte(nativeSegmentOpacity(next))) next = {...next, transparency, color_alpha: opacityOf(transparency)};
    }
    if (next.secondary && Number.isFinite(override.gradientOpacity)) {
      const a = alphaByte(override.gradientOpacity);
      if (a !== Number(next.secondary.a ?? 0)) next = {...next, secondary: {...next.secondary, a}};
    }
    if (next !== segment) { segments ??= [...figure.segments]; segments[index] = next; }
  }
  if (segments) {
    copy(); result.segments = segments;
    // Decoders may expose the same segment table through both aliases.
    if (figure.segment_decode?.segments) result.segment_decode = {...result.segment_decode, segments};
  }
  if (style.polygons && figure.polyfills) {
    const polyfills = figure.polyfills.map((polygon,index) => {
      const values=style.polygons[polygonIdentity(polygon,index)];if(!values)return polygon;
      return {...polygon,...(values.color === undefined ? {} : {color_rgb:rgbOf(values.color)}),
        ...(values.opacity === undefined ? {} : {alpha_raw:alphaByte(values.opacity),color_alpha:opacityOf(alphaByte(values.opacity))})};
    });
    copy();result.polyfills=polyfills;
  }
  return result;
}
