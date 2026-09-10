/** Lazy native property projection shared by authoring and timeline markers. */
import {animationChannelId, findAnimationChannel, normalizeAnimationTarget, animationPropertyValue} from './animation-channels.mjs';
import {poseSourceFrame} from './animation-pose.mjs';
import {keyEasing} from './keyframe-easing.mjs';
import {isDiscreteAnimationProperty, isFigurePoseTransform} from './animation-properties.mjs';
import {buildGeometry} from './pivot/geometry.mjs';

function hasPropertyDependency(editor, target, property) {
  return editor.animationChannels.some(channel => {
    if (channel.property === 'pose') return false;
    if (target.kind === 'scene') return channel.target.kind === 'scene' &&
      (channel.property === property || property === 'color' && channel.property === 'backgroundId');
    if (target.kind === 'camera') return channel.target.kind === 'camera' && channel.property === property;
    // Absolute coordinates on an attached child can translate its root figure.
    if (target.kind === 'figure' && ['x','y'].includes(property)) return channel.target.kind === 'figure' && channel.property === property;
    return channel.target.uid === target.uid && channel.target.kind === target.kind &&
      (channel.property === property || target.kind === 'segment' && channel.property === 'paint');
  });
}

export function projectNativePropertyChannel(editor, target, property, {markersOnly=false}={}, evaluateFrame) {
  target = normalizeAnimationTarget(target);
  const id = animationChannelId(target, property), own = findAnimationChannel(editor.report, target, property);
  if (own) return own;
  const cache=editor._propertyChannelCache ??= {channels:new Map(),frames:new Map(),values:new Map(),dependencies:new Map()};
  cache.indices??=new WeakMap();cache.coordinates??=new WeakMap();
  const indexFor=frame=>{
    let index=cache.indices.get(frame);
    if(!index){index=new Map(frame.objects.map((object,slot)=>[object.unique_id,slot]));cache.indices.set(frame,index);}
    return index;
  };
  const read=(frame,property,resolveGeometry)=>animationPropertyValue(editor.report,frame,target,property,{objectIndex:indexFor(frame),resolveGeometry});
  const materialize=channel=>markersOnly?channel:{...channel,keys:channel.keys.map(key=>({...key}))};
  if(cache.channels.has(id))return materialize(cache.channels.get(id));
  const poseTarget = ['segment','polygon'].includes(target.kind) ? {kind:'figure', uid:target.uid} : target;
  const inheritedPose = editor.nativePoseChannel(poseTarget);
  const pose = target.kind === 'figure' && inheritedPose.nativeProperties && !isFigurePoseTransform(target, property)
    ? editor.nativePoseChannel(poseTarget, {nativeOnly:true}) : inheritedPose;
  const ticks = new Map();
  for (const key of pose.keys) if (!key.hidden) {
    const source=poseSourceFrame(editor.report,key.value?.frameId);
    const baseValue=source ? read(source,property) : undefined;
    if (target.uid !== undefined && baseValue === undefined) continue;
    const object=target.uid===undefined?null:source.objects[indexFor(source).get(target.uid)];
    const needsRig=target.kind==='figure'&&['x','y','rotation'].includes(property)&&(object?.join||object?._stykIK);
    const interpolation = isDiscreteAnimationProperty(property) ? 'hold' : key.interpolation ?? 'linear';
    const nativeCurve = key.interpolation === undefined && editor.report.auto_easing && ['x','y','scale','rotation'].includes(property) ? 'pchip' : undefined;
    const keyId=`native:${id}:${key.id}`;
    // Drawing markers needs identities and times, not evaluated scene frames.
    // Resolve values only when sampling, copying or adopting this curve.
    ticks.set(key.tick, {id:keyId, tick:key.tick, get value() {
      if(!cache.values.has(keyId)) {
        const position=target.kind==='figure'&&['x','y'].includes(property);
        const known=position&&cache.coordinates.get(key)?.get(target.uid);
        if(known){cache.values.set(keyId,known[property]);return known[property];}
        if(!cache.dependencies.has(id))cache.dependencies.set(id,hasPropertyDependency(editor,target,property));
        // Independent native fields can be read from their source snapshot.
        // Joins and cross-property dependencies use the shared evaluator.
        let frame=source,value=baseValue;
        if(!source||needsRig||cache.dependencies.get(id)) {
          frame=cache.frames.get(key.tick);
          if(!frame){frame=evaluateFrame(key.tick);if(cache.frames.size>=64)cache.frames.delete(cache.frames.keys().next().value);cache.frames.set(key.tick,frame);}
          let geometry;
          const resolveGeometry=()=>{
            if(geometry)return geometry;
            // World coordinates depend on this figure's ancestor chain, not on
            // unrelated scene artwork. Keep native slots and the exact builder.
            const objects=[],seen=new Set();let slot=indexFor(frame).get(target.uid);
            while(slot!==undefined&&frame.objects[slot]&&!seen.has(slot)){
              seen.add(slot);objects[slot]=frame.objects[slot];
              slot=frame.objects[slot].join?.target_object_slot;
            }
            return geometry=buildGeometry(editor.report,{...frame,objects,object_draw_order:[...seen]});
          };
          value=read(frame,property,resolveGeometry);
          if(position){
            let values=cache.coordinates.get(key);if(!values)cache.coordinates.set(key,values=new Map());
            values.set(target.uid,{x:read(frame,'x',resolveGeometry),y:read(frame,'y',resolveGeometry)});
          }
        }
        if(target.kind==='scene'&&property==='color')value=frame._stykBackgroundColor ?? editor.report.backgrounds?.find(bg=>bg.background_id===frame.background_id&&bg.kind===2)?.color ?? (frame.background_id ? null : 0xffffffff);
        cache.values.set(keyId,value);
      }
      return cache.values.get(keyId);
    },
      ...keyEasing({...key, interpolation:nativeCurve ? 'linear' : interpolation}),
      ...(nativeCurve ? {nativeCurve} : {}),
      ...(property === 'rotation' ? {nativeRotation:true} : {}),
      ...(target.kind === 'figure' && ['opacity','color'].includes(property) ? {nativeValueMode:property} : {})});
  }
  const result={id, target, property, keys:[...ticks.values()]};cache.channels.set(id,result);return materialize(result);
}
