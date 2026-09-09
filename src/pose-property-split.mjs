/** Separate changed instance properties from the skeleton/presence pose. */
import {ANIMATION_PROPERTIES, isFigurePoseTransform} from './animation-properties.mjs';
import {animationPropertyValue} from './animation-channels.mjs';
import {animationRotation} from './animation-origin.mjs';
import {rotateOriginSupport} from './animation-origin-support.mjs';
import {buildGeometry} from './pivot/geometry.mjs';

const scalarFields = ['scale', 'field28', 'color_override_raw',
  'color_override_rgb', 'color_override_mix', '_stykStyle', '_stykZIndex'];
const comparable = object => JSON.stringify(object, (key, value) =>
  key === 'runtime_segments' || key === 'object_slot' ? undefined :
    typeof value === 'number' ? Math.round(value * 1e9) / 1e9 : value);

export function splitPosePropertyChanges(report, source, frame, uids, tick) {
  const before = new Map(source.objects.map(object => [object.unique_id, object]));
  const definitions = new Map(report.figure_types.map(figure => [figure.figure_type_id, figure]));
  const entries = [], shapeIds = new Set();
  let sourceGeometry, finalGeometry;
  const read = (value, target, property) => animationPropertyValue(report, value, target, property, {
    resolveGeometry: () => value === source ? sourceGeometry ??= buildGeometry(report, source) : finalGeometry ??= buildGeometry(report, frame),
  });
  const objects = frame.objects.map(object => {
    if (!uids.has(object.unique_id)) return object;
    const original = before.get(object.unique_id), figure = definitions.get(object.figure_type_id);
    if (!original || original.figure_type_id !== object.figure_type_id) { shapeIds.add(object.unique_id); return object; }
    const targets = [{kind:'figure', uid:object.unique_id}];
    const handles = new Set([...Object.keys(original._stykStyle?.segments ?? {}), ...Object.keys(object._stykStyle?.segments ?? {})]);
    for (const handle of handles) targets.push({kind:'segment', uid:object.unique_id, handleId:Number(handle), figureTypeId:object.figure_type_id});
    for (const id of new Set([...Object.keys(original._stykStyle?.polygons ?? {}),...Object.keys(object._stykStyle?.polygons ?? {})]))
      targets.push({kind:'polygon',uid:object.unique_id,polygonId:Number(id),figureTypeId:object.figure_type_id});
    for (const target of targets) for (const property of ANIMATION_PROPERTIES[target.kind]) {
      if (property === 'pose') continue;
      if (isFigurePoseTransform(target,property) && !report._styk?.animation?.channels?.some(channel=>channel.target.kind==='figure'&&channel.target.uid===target.uid&&channel.property===property&&channel.keys.length)) continue;
      if(target.kind==='figure' && object.join && ['x','y','rotation'].includes(property)) {
        const parent=frame.objects[object.join.target_object_slot],oldParent=before.get(parent?.unique_id);
        const existing=report._styk?.animation?.channels?.some(channel=>channel.target.kind==='figure'&&channel.target.uid===object.unique_id&&channel.property===property&&channel.keys.length);
        if(!existing && parent && oldParent && uids.has(parent.unique_id)) {
          if(property!=='rotation')continue;
          const parentFigure=definitions.get(parent.figure_type_id);
          const inherited=animationRotation(parentFigure,parent)-animationRotation(parentFigure,oldParent);
          const own=animationRotation(figure,object)-animationRotation(figure,original);
          if(Math.abs(inherited-own)<1e-9)continue;
        }
      }
      const value = read(frame, target, property), old = read(source, target, property);
      if (value !== undefined && JSON.stringify(value) !== JSON.stringify(old) && !(typeof value === 'number' && Math.abs(value - old) < 1e-9))
        entries.push({target, property, tick, value});
    }
    const normalized = {...object};
    for (const field of scalarFields) {
      if (Object.hasOwn(original, field)) normalized[field] = original[field]; else delete normalized[field];
    }
    // Only legacy scalar rotation curves need to be excluded from the snapshot.
    const delta = entries.some(entry=>entry.target.kind==='figure'&&entry.target.uid===object.unique_id&&entry.property==='rotation') ? animationRotation(figure, object) - animationRotation(figure, original) : 0;
    for(const [property,field] of [['x','root_x'],['y','root_y']])if(entries.some(entry=>entry.target.kind==='figure'&&entry.target.uid===object.unique_id&&entry.property===property))normalized[field]=original[field];
    if (Math.abs(delta) > 1e-12) {
      normalized.angles = object.angles.map(angle => angle - delta);
      rotateOriginSupport(figure, normalized, -delta);
    }
    delete normalized.runtime_segments;
    if (comparable(normalized) !== comparable(original)) shapeIds.add(object.unique_id);
    return normalized;
  });
  const present = new Set(frame.objects.map(object => object.unique_id));
  for (const uid of uids) if (before.has(uid) && !present.has(uid)) shapeIds.add(uid);
  return {entries, shapeIds, frame:{...frame, objects}};
}
