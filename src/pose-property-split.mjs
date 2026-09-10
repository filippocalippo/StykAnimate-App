/** Separate changed instance properties from the skeleton/presence pose. */
import {ANIMATION_PROPERTIES, isFigurePoseTransform} from './animation-properties.mjs';
import {animationPropertyValue} from './animation-channels.mjs';
import {animationRotation} from './animation-origin.mjs';
import {handleOrientation} from './animation-pose.mjs';
import {rotateOriginSupport} from './animation-origin-support.mjs';
import {buildGeometry} from './pivot/geometry.mjs';

const scalarFields = ['scale', 'field28', 'color_override_raw',
  'color_override_rgb', 'color_override_mix', '_stykStyle', '_stykZIndex'];
const scalarProperties=new Set(['scale','color','opacity','outlineColor','outlineWidth','outlineOpacity','zIndex']);
const comparable = object => JSON.stringify(object, (key, value) =>
  key === 'runtime_segments' || key === 'object_slot' ? undefined :
    typeof value === 'number' ? Math.round(value * 1e9) / 1e9 : value);

export function splitPosePropertyChanges(report, source, frame, uids, tick) {
  const before = new Map(source.objects.map(object => [object.unique_id, object]));
  const definitions = new Map(report.figure_types.map(figure => [figure.figure_type_id, figure]));
  const indices=new Map([source,frame].map(value=>[value,new Map(value.objects.map((object,slot)=>[object.unique_id,slot]))]));
  const authored=new Map();
  for(const channel of report._styk?.animation?.channels??[])if(channel.target.kind==='figure'&&channel.keys.length){
    let properties=authored.get(channel.target.uid);if(!properties)authored.set(channel.target.uid,properties=new Set());properties.add(channel.property);
  }
  const entries = [], shapeIds = new Set(), handleIndices = new Map();
  let sourceGeometry, finalGeometry;
  const read = (value, target, property) => animationPropertyValue(report, value, target, property, {
    objectIndex:indices.get(value),figureIndex:definitions,
    resolveGeometry: () => value === source ? sourceGeometry ??= buildGeometry(report, source) : finalGeometry ??= buildGeometry(report, frame),
  });
  const objects = frame.objects.map(object => {
    if (!uids.has(object.unique_id)) return object;
    const original = before.get(object.unique_id), figure = definitions.get(object.figure_type_id);
    if (!original || original.figure_type_id !== object.figure_type_id) { shapeIds.add(object.unique_id); return object; }
    const unchangedScalars=scalarFields.every(field=>Object.is(object[field],original[field])),changedFigureProperties=new Set();
    const targets = [{kind:'figure', uid:object.unique_id}];
    const handles = new Set([...Object.keys(original._stykStyle?.segments ?? {}), ...Object.keys(object._stykStyle?.segments ?? {})]);
    for (const handle of handles) targets.push({kind:'segment', uid:object.unique_id, handleId:Number(handle), figureTypeId:object.figure_type_id});
    for (const id of new Set([...Object.keys(original._stykStyle?.polygons ?? {}),...Object.keys(object._stykStyle?.polygons ?? {})]))
      targets.push({kind:'polygon',uid:object.unique_id,polygonId:Number(id),figureTypeId:object.figure_type_id});
    for (const target of targets) for (const property of ANIMATION_PROPERTIES[target.kind]) {
      if (property === 'pose') continue;
      if(target.kind==='figure'&&unchangedScalars&&scalarProperties.has(property))continue;
      if (isFigurePoseTransform(target,property) && !authored.get(target.uid)?.has(property)) continue;
      if(target.kind==='figure' && object.join && ['x','y','rotation'].includes(property)) {
        const parent=frame.objects[object.join.target_object_slot],oldParent=before.get(parent?.unique_id);
        const existing=authored.get(object.unique_id)?.has(property);
        if(!existing && parent && oldParent && uids.has(parent.unique_id)) {
          if(property!=='rotation')continue;
          const parentFigure=definitions.get(parent.figure_type_id);
          const inherited=animationRotation(parentFigure,parent)-animationRotation(parentFigure,oldParent);
          const own=animationRotation(figure,object)-animationRotation(figure,original);
          if(Math.abs(inherited-own)<1e-9)continue;
        }
      }
      const value = read(frame, target, property), old = read(source, target, property);
      if (value !== undefined && JSON.stringify(value) !== JSON.stringify(old) && !(typeof value === 'number' && Math.abs(value - old) < 1e-9)) {
        entries.push({target, property, tick, value});
        if(target.kind==='figure')changedFigureProperties.add(property);
      }
    }
    const normalized = {...object};
    for (const field of scalarFields) {
      if (Object.hasOwn(original, field)) normalized[field] = original[field]; else delete normalized[field];
    }
    // Only legacy scalar rotation curves need to be excluded from the snapshot.
    const delta = changedFigureProperties.has('rotation') ? animationRotation(figure, object) - animationRotation(figure, original) : 0;
    for(const [property,field] of [['x','root_x'],['y','root_y']])if(changedFigureProperties.has(property))normalized[field]=original[field];
    if (Math.abs(delta) > 1e-12) {
      normalized.angles = object.angles.map(angle => angle - delta);
      rotateOriginSupport(figure, normalized, -delta);
    }
    delete normalized.runtime_segments;
    if (comparable(normalized) !== comparable(original)) shapeIds.add(object.unique_id);
    // A joined child's unchanged world angles can still be a new local pose.
    // Capture its parent reference with it, or later composition applies the
    // parent's newly baked IK rotation a second time after a cache refresh.
    if (object.join && !shapeIds.has(object.unique_id)) {
      const parent = frame.objects[object.join.target_object_slot], oldParent = before.get(parent?.unique_id);
      if (parent && oldParent && uids.has(parent.unique_id)) {
        const handle = object.join.target_handle_id;
        const oldAngle = handleOrientation(oldParent, handle, definitions, handleIndices);
        const newAngle = handleOrientation(parent, handle, definitions, handleIndices);
        if (oldAngle !== null && newAngle !== null && Math.abs(newAngle - oldAngle) > 1e-9) shapeIds.add(object.unique_id);
      }
    }
    return normalized;
  });
  const present = new Set(frame.objects.map(object => object.unique_id));
  for (const uid of uids) if (before.has(uid) && !present.has(uid)) shapeIds.add(uid);
  return {entries, shapeIds, frame:{...frame, objects}};
}
