/** Small per-instance style overlays; native figure definitions remain shared. */
const alphaByte = opacity => Math.round((1 - opacity) * 255);
const opacityOf = alpha => 1 - Number(alpha ?? 0) / 255;
export const nativeSegmentOpacity = segment => segment.transparency === undefined ? Number(segment.color_alpha ?? 1) : opacityOf(segment.transparency);

/** Validate the small persisted overlay without inspecting shared assets. */
export function validateAnimationStyle(object) {
  const style = object?._stykStyle; if (style === undefined) return object;
  const record = value => value && typeof value === 'object' && !Array.isArray(value);
  const opacity = value => { if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) throw new Error('Instance style opacity must be between zero and one.'); };
  if (!record(style)) throw new Error('Instance style must be a property record.');
  if ('outlineOpacity' in style) opacity(style.outlineOpacity);
  if (style.segments !== undefined) {
    if (!record(style.segments)) throw new Error('Instance segment styles must be a handle table.');
    for (const [handle, values] of Object.entries(style.segments)) {
      const id = Number(handle);
      if (!Number.isInteger(id) || id < 1 || id > 65535 || String(id) !== handle || !record(values)) throw new Error('Instance style has an invalid segment handle.');
      if ('opacity' in values) opacity(values.opacity);
      if ('gradientOpacity' in values) opacity(values.gradientOpacity);
    }
  }
  return object;
}

export function isAnimationStyleProperty(target, property) {
  return target.kind === 'segment' || (target.kind === 'figure' && property === 'outlineOpacity');
}

/** Read the displayed style, including a pose source's captured overrides. */
export function animationStyleValue(figure, object, target, property) {
  if (!figure || !object) return undefined;
  if (target.kind === 'segment' && target.figureTypeId !== undefined && target.figureTypeId !== object.figure_type_id) return undefined;
  if (target.kind === 'figure') return object._stykStyle?.outlineOpacity ?? opacityOf(figure.segment_decode?.global_style?.u30);
  const segment = figure.segments?.find(segment => Number(segment.segment_id) === target.handleId);
  if (!segment) return undefined;
  const override = object._stykStyle?.segments?.[target.handleId];
  if (property === 'opacity') return override?.opacity ?? nativeSegmentOpacity(segment);
  // A secondary endpoint is meaningful only on a native gradient segment.
  if (!segment.secondary) return undefined;
  return override?.gradientOpacity ?? opacityOf(segment.secondary.a);
}

/** Update an already copied object without copying assets or other segments. */
export function setAnimationStyle(object, target, property, value) {
  if (target.kind === 'segment' && target.figureTypeId !== undefined && target.figureTypeId !== object.figure_type_id) return object;
  const style = object._stykStyle = {...object._stykStyle};
  if (target.kind === 'figure') style.outlineOpacity = value;
  else {
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
  let segments;
  for (let index = 0; style.segments && index < (figure.segments?.length ?? 0); index++) {
    const segment = figure.segments[index], override = style.segments[segment.segment_id];
    if (!override) continue;
    let next = segment;
    if (Number.isFinite(override.opacity)) {
      const transparency = alphaByte(override.opacity);
      if (transparency !== alphaByte(nativeSegmentOpacity(segment))) next = {...next, transparency, color_alpha: opacityOf(transparency)};
    }
    if (segment.secondary && Number.isFinite(override.gradientOpacity)) {
      const a = alphaByte(override.gradientOpacity);
      if (a !== Number(segment.secondary.a ?? 0)) next = {...next, secondary: {...segment.secondary, a}};
    }
    if (next !== segment) { segments ??= [...figure.segments]; segments[index] = next; }
  }
  if (segments) {
    copy(); result.segments = segments;
    // Decoders may expose the same segment table through both aliases.
    if (figure.segment_decode?.segments) result.segment_decode = {...result.segment_decode, segments};
  }
  return result;
}
