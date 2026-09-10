/** Native Pivot stores segment/outline appearance on reusable figure types. */
import {resolveInstanceFigure, nativeSegmentOpacity, styleColor, polygonIdentity} from './animation-style.mjs';
import {evaluatedFrame, timeline} from './pivot/geometry.mjs';

const byte = value => Math.round((1 - value) * 255);
export const hasNativeStyleOverrides = report => report.keyframes.some(frame => frame.objects.some(object => object._stykStyle));

/** One table per export. Native byte equality, rather than float identity,
 * determines whether a new figure record is necessary. Assets remain shared. */
export function createNativeStyleTable(report) {
  const figures = new Map(report.figure_types.map(figure => [figure.figure_type_id, figure])), handles = new Map(), variants = new Map();
  let nextId = 1, copied = false;
  for (const id of figures.keys()) nextId = Math.max(nextId, id + 1);
  return object => {
    const figure = figures.get(object.figure_type_id), style = object._stykStyle; if (!figure || !style) return object.figure_type_id;
    let indices = handles.get(figure); if (!indices) {indices = new Map(figure.segments.map(segment => [segment.segment_id, segment])); handles.set(figure, indices);}
    const signature = [];
    for (const [id,values] of Object.entries(style.polygons ?? {})) if (figure.polyfills?.some((polygon,index) => polygonIdentity(polygon,index) === Number(id))) signature.push(`p:${id}:${JSON.stringify(values)}`);
    if (Number.isFinite(style.outlineColor) && style.outlineColor !== styleColor(figure.segment_decode?.global_style?.rgb)) signature.push(`oc:${style.outlineColor}`);
    if (Number.isFinite(style.outlineWidth) && style.outlineWidth !== Number(figure.segment_decode?.global_style?.outline_thickness ?? 0)) signature.push(`ow:${style.outlineWidth}`);
    if (Number.isFinite(style.outlineOpacity)) {const alpha = byte(style.outlineOpacity); if (alpha !== Number(figure.segment_decode?.global_style?.u30 ?? 0)) signature.push(`o:${alpha}`);}
    for (const id of Object.keys(style.segments ?? {}).sort((a,b) => Number(a)-Number(b))) {
      const segment = indices.get(Number(id)), override = style.segments[id]; if (!segment || !override) continue;
      if (override.paint) signature.push(`paint:${id}:${JSON.stringify(override)}`);
      if (Number.isFinite(override.color) && override.color !== styleColor(segment.color_rgb)) signature.push(`c:${id}:${override.color}`);
      if (Number.isFinite(override.thickness) && override.thickness !== segment.thickness) signature.push(`w:${id}:${override.thickness}`);
      if (segment.secondary && Number.isFinite(override.gradientColor) && override.gradientColor !== styleColor(segment.secondary.rgb)) signature.push(`gc:${id}:${override.gradientColor}`);
      if (Number.isFinite(override.opacity)) {const alpha = byte(override.opacity); if (alpha !== byte(nativeSegmentOpacity(segment))) signature.push(`s:${id}:${alpha}`);}
      if (segment.secondary && Number.isFinite(override.gradientOpacity)) {const alpha = byte(override.gradientOpacity); if (alpha !== Number(segment.secondary.a ?? 0)) signature.push(`g:${id}:${alpha}`);}
    }
    if (!signature.length) return figure.figure_type_id;
    const key = `${figure.figure_type_id}|${signature.join('|')}`;
    if (variants.has(key)) return variants.get(key);
    if (report.figure_types.length >= 65534) throw new Error('Animated figure styles exceed the native Pivot figure table capacity.');
    const resolved = resolveInstanceFigure(figure, object), id = nextId++;
    if (!copied) {report.figure_types = [...report.figure_types]; copied = true;}
    report.figure_types.push({...resolved, figure_type_id: id, name: `${figure.name || 'Figure'} · Style ${variants.size + 1}`});
    variants.set(key, id); return id;
  };
}

/** STK exports the selected figure's displayed style at one authored tick. */
export function materializeStyledFigureForStk(report, {figureTypeId, figureUid, tick = 0} = {}) {
  const rows = timeline(report); let index = 0;
  while (index + 1 < rows.length && rows[index + 1].start <= tick) index++;
  const row = rows[index], frame = evaluatedFrame(report, index, row.count ? Math.max(0, Math.min(1, (tick - row.start) / row.count)) : 0, tick);
  const object = frame.objects.find(object => figureUid === undefined || figureUid === null ? object.figure_type_id === figureTypeId : object.unique_id === figureUid);
  if (!object?._stykStyle) return {report, figureTypeId};
  const output = {...report}, variantId = createNativeStyleTable(output)(object);
  return {report: output, figureTypeId: variantId};
}
