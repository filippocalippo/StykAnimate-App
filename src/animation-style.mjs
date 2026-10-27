import {messageError} from './localized-error.mjs';
/** Small per-instance style overlays; native figure definitions remain shared. */
import {normalizePaint, segmentPaint} from './paint.mjs';
import {validateDrawableZIndex} from './animation-properties.mjs';
const alphaByte = opacity => Math.round((1 - opacity) * 255);
const opacityOf = alpha => 1 - Number(alpha ?? 0) / 255;
const styleColor = rgb => ((rgb?.[0] ?? 0) << 16 | (rgb?.[1] ?? 0) << 8 | (rgb?.[2] ?? 0)) >>> 0;
const rgbOf = color => [color >>> 16 & 255, color >>> 8 & 255, color & 255];
/** Resolve only the small palette. Mesh topology and compiled bone bindings
 * remain the shared definition even when one instance changes its colours. */
export const meshPaletteColor = (figure, object, index) => {
  const value = object?._stykStyle?.meshColors?.[index];
  return value === undefined ? figure?._styk?.spatialMesh?.colors[index] : rgbOf(value);
};
export const polygonIdentity = (polygon,index) => polygon.polyfill_id ?? index + 1;
const nativeSegmentOpacity = segment => segment.transparency === undefined ? Number(segment.color_alpha ?? 1) : opacityOf(segment.transparency);

/** Validate the small persisted overlay without inspecting shared assets. */
export function validateAnimationStyle(object, figure) {
  if (object?._styk?.colorMode !== undefined && object._styk.colorMode !== 'segments') throw messageError(new Error(''), "errors.animationStyle.invalidInstanceColorMode", {});
  const style = object?._stykStyle; if (style === undefined) return object;
  const record = value => value && typeof value === 'object' && !Array.isArray(value);
  const opacity = value => { if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) throw messageError(new Error(''), "errors.animationStyle.instanceStyleOpacityMustBeBetweenZeroAnd", {}); };
  if (!record(style)) throw messageError(new Error(''), "errors.animationStyle.instanceStyleMustBeAPropertyRecord", {});
  if ('outlineOpacity' in style) opacity(style.outlineOpacity);
  const color = value => { if (!Number.isInteger(value) || value < 0 || value > 0xffffff) throw messageError(new Error(''), "errors.animationStyle.styleColorMustBeAnRgbInteger", {}); };
  const width = value => { if (!Number.isFinite(value) || value < 0 || value > 1e6) throw messageError(new Error(''), "errors.animationStyle.styleWidthIsOutsideTheSupportedRange", {}); };
  if ('outlineColor' in style) color(style.outlineColor);
  if ('outlineWidth' in style) width(style.outlineWidth);
  if (style.meshColors !== undefined) {
    if (!record(style.meshColors) || Object.keys(style.meshColors).length > 1024)
      throw messageError(new Error(''), 'errors.figureColors.chooseValidPaletteTargets', {});
    for (const [key, value] of Object.entries(style.meshColors)) {
      const index = Number(key);
      if (!Number.isInteger(index) || index < 0 || index >= 1024 || String(index) !== key ||
          figure && index >= (figure._styk?.spatialMesh?.colors.length ?? 0))
        throw messageError(new Error(''), 'errors.figureColors.chooseValidPaletteTargets', {});
      color(value);
    }
  }
  if (style.segments !== undefined) {
    if (!record(style.segments)) throw messageError(new Error(''), "errors.animationStyle.instanceSegmentStylesMustBeAHandleTable", {});
    for (const [handle, values] of Object.entries(style.segments)) {
      const id = Number(handle);
      if (!Number.isInteger(id) || id < 1 || id > 65535 || String(id) !== handle || !record(values)) throw messageError(new Error(''), "errors.animationStyle.instanceStyleHasAnInvalidSegmentHandle", {});
      if ('opacity' in values) opacity(values.opacity);
      if ('gradientOpacity' in values) opacity(values.gradientOpacity);
      if ('color' in values) color(values.color);
      if ('gradientColor' in values) color(values.gradientColor);
      if ('thickness' in values) width(values.thickness);
      if ('zIndex' in values) validateDrawableZIndex(values.zIndex);
      if ('paint' in values) normalizePaint(values.paint);
    }
  }
  if (style.polygons !== undefined) {
    if (!record(style.polygons)) throw messageError(new Error(''), "errors.animationStyle.polygonStylesMustBeAnIdentityTable", {});
    for (const [id, values] of Object.entries(style.polygons)) {
      if (!Number.isInteger(Number(id)) || Number(id) < 1 || Number(id) > 65535 || !record(values)) throw messageError(new Error(''), "errors.animationStyle.invalidPolygonStyleIdentity", {});
      if ('color' in values) color(values.color);
      if ('opacity' in values) opacity(values.opacity);
      if ('zIndex' in values) validateDrawableZIndex(values.zIndex);
    }
  }
  return object;
}

/** Read the displayed style, including a pose source's captured overrides. */
export function animationStyleValue(figure, object, target, property) {
  if (!figure || !object) return undefined;
  if (target.kind === 'polygon') {
    if (target.figureTypeId !== object.figure_type_id) return undefined;
    const polygon = figure.polyfills?.find((item,index) => polygonIdentity(item,index) === target.polygonId);
    if (!polygon) return undefined;
    if (property === 'zIndex') return object._stykStyle?.polygons?.[target.polygonId]?.zIndex ?? polygon.z_order ?? 0;
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
  if (property === 'zIndex') return override?.zIndex ?? segment.z_order ?? figure.segments.indexOf(segment) + 1;
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

/**
 * Resolve for every renderer/exporter. Only touched definitions are copied;
 * images, glyphs, geometry and unrelated segment records retain identity.
 * No retained cache means ordinary in-place native type edits remain visible.
 */
export function resolveInstanceFigure(figure, object) {
  const style = object?._stykStyle ?? {};
  if (!figure || !object?._stykStyle && object?._styk?.colorMode !== 'segments') return figure;
  let result = figure;
  const copy = () => { if (result === figure) result = {...figure}; };
  if(object?._styk?.colorMode === 'segments' && figure._styk?.colorMode !== 'segments'){
    copy();result._styk={...figure._styk,colorMode:'segments'};
  }
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
    if (Number.isFinite(override.zIndex)) next = {...next, z_order: override.zIndex, z_order_runtime_raw: override.zIndex - 1};
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
        ...(values.zIndex === undefined ? {} : {z_order:values.zIndex,z_order_runtime_raw:values.zIndex-1}),
        ...(values.opacity === undefined ? {} : {alpha_raw:alphaByte(values.opacity),color_alpha:opacityOf(alphaByte(values.opacity))})};
    });
    copy();result.polyfills=polyfills;
  }
  if (result !== figure && (Object.values(style.segments ?? {}).some(value => value.zIndex !== undefined) ||
    Object.values(style.polygons ?? {}).some(value => value.zIndex !== undefined))) {
    delete result.segment_z_raw; delete result.poly_z_raw;
  }
  return result;
}
