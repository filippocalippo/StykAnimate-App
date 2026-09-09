/** Keep instance styles and authored keys attached to physical rig segments. */
import {animationChannelId, validateAnimationDocument} from './animation-channels.mjs';
import {nativeSegmentOpacity} from './animation-style.mjs';

const clone = value => structuredClone(value);
const reverseProperty = property => property === 'opacity' ? 'gradientOpacity' : property === 'gradientOpacity' ? 'opacity' : property;

/** Reversing a gradient's geometry retains each endpoint's original color. */
export function reverseGradientEndpoints(segment) {
  if(segment.paint && ['radial','angular','diamond'].includes(segment.paint.type))return {...segment,paint:{...clone(segment.paint),angle:segment.paint.angle-180}};
  if (!segment.secondary) return segment;
  const transparency = Number(segment.secondary.a ?? 0);
  return {...segment, ...(segment.paint ? {paint:{...clone(segment.paint),stops:segment.paint.stops.map(s=>({...clone(s),offset:1-s.offset})).reverse()}} : {}), color_rgb:clone(segment.secondary.rgb), transparency,
    ...('color_alpha' in segment ? {color_alpha:1-transparency/255} : {}),
    secondary:{...segment.secondary,rgb:clone(segment.color_rgb),a:Math.round(255*(1-nativeSegmentOpacity(segment)))}};
}

function reverseOverrides(style) {
  const out = {...style}; delete out.opacity; delete out.gradientOpacity;
  if ('opacity' in style) out.gradientOpacity = style.opacity;
  if ('gradientOpacity' in style) out.opacity = style.gradientOpacity;
  return out;
}

export function topologyAnimationPatch(before, after) {
  if (before === after) return undefined;
  const records = animation => new Map((animation?.channels ?? []).map((channel, index) => [channel.id, {exists:true, index, channel}]));
  const old = records(before), next = records(after);
  const changes = [...new Set([...old.keys(), ...next.keys()])].filter(id => old.get(id)?.channel !== next.get(id)?.channel)
    .map(id => ({id, before:old.get(id) ?? {exists:false}, after:next.get(id) ?? {exists:false}}));
  const metadata = animation => {if (!animation) return {exists:false}; const {channels, ...fields}=animation;return {exists:true,fields};};
  return {changes, before:metadata(before), after:metadata(after)};
}

/** Map old endpoint IDs to physical replacements. Missing map entries retain
 * their ID if it still exists; an empty replacement removes the old segment. */
export function repairTopologyStyles(editor, before, figure, explicit = new Map(), reversedGradients = new Set()) {
  const handles = new Set(figure.segments.map(segment => segment.segment_id)), changes = new Map();
  for (const segment of before.figure.segments) {
    const old = segment.segment_id, next = explicit.has(old) ? explicit.get(old) : handles.has(old) ? [old] : [];
    if (!Array.isArray(next) || new Set(next).size !== next.length || next.some(id => !handles.has(id))) throw new Error('Invalid physical segment style mapping.');
    if (next.length !== 1 || next[0] !== old || reversedGradients.has(old)) changes.set(old, next);
  }
  if (!changes.size) return;
  const uids = new Set();
  for (const entry of before.frames) for (const object of entry.objects) if (object.figure_type_id === figure.figure_type_id) uids.add(object.unique_id);
  const animation = editor.report._styk.animation, channels = animation?.channels ?? [];
  const affectedChannels = channels.filter(channel => channel.target.kind === 'segment' && uids.has(channel.target.uid) && changes.has(channel.target.handleId) &&
    (channel.target.figureTypeId===undefined||channel.target.figureTypeId===figure.figure_type_id));
  const keyed = new Set(affectedChannels.filter(channel=>channel.target.figureTypeId===undefined).map(channel => channel.target.uid)),typesByUid=new Map();
  // UID tracks may switch native rig definitions. Split only the affected
  // legacy curve into definition-specific curves; no timeline sampling or pose
  // baking is needed, so continuous interpolation remains exactly unchanged.
  if(keyed.size)for(const frame of editor._allSourceFrames())for(const object of frame.objects)if(keyed.has(object.unique_id)){
    const types=typesByUid.get(object.unique_id)??new Set();types.add(object.figure_type_id);typesByUid.set(object.unique_id,types);
  }
  for (const entry of before.frames) {
    const frame = entry.draft ? editor.report._styk.simpleFrameDraft?.baseline : entry.sourceId ? editor.report._styk.frameSources[entry.sourceId] : editor.report.keyframes[entry.index];
    for (const object of frame.objects) {
      if (object.figure_type_id !== figure.figure_type_id || !object._stykStyle?.segments) continue;
      const original = object._stykStyle.segments;
      const entries = Object.entries(original);
      if (!entries.some(([handle]) => changes.has(Number(handle)))) continue;
      const segments = {};
      for (const [handle, style] of entries) {
        const replacements = changes.get(Number(handle));
        if (replacements) for (const target of replacements) segments[target] = clone(reversedGradients.has(Number(handle)) ? reverseOverrides(style) : style);
        else segments[handle] = style;
      }
      const style = {...object._stykStyle};
      if (Object.keys(segments).length) style.segments = segments; else delete style.segments;
      if (Object.keys(style).length) object._stykStyle = style; else delete object._stykStyle;
    }
  }
  if (!affectedChannels.length) return;
  const affected = new Set(affectedChannels), channelById=new Map(channels.map(channel=>[channel.id,channel])), after = {...animation, nextKeyId:animation.nextKeyId ?? 1, channels:[]};
  let usedIds;const emitted=new Map();
  const emit=(value,source)=>{
    const old=emitted.get(value.id),specific=source.target.figureTypeId!==undefined;
    if(old){
      if(old.specific&&!specific)return;
      if(old.specific===specific)throw new Error('Physical segment mapping conflicts with another animated segment.');
      after.channels[old.index]=value;emitted.set(value.id,{index:old.index,specific});return;
    }
    emitted.set(value.id,{index:after.channels.length,specific});after.channels.push(value);
  };
  const freshKey = () => {
    usedIds ??= new Set(channels.flatMap(channel => channel.keys.map(key => key.id)));
    let id;
    do { if (!Number.isSafeInteger(after.nextKeyId) || after.nextKeyId < 1) throw new Error('Animation key identity capacity exceeded.'); id=`key-${after.nextKeyId++}`; } while (usedIds.has(id));
    usedIds.add(id);return id;
  };
  for (const channel of channels) {
    if (!affected.has(channel)) {emit(channel,channel);continue;}
    const replacements = changes.get(channel.target.handleId);
    const property = reversedGradients.has(channel.target.handleId) ? reverseProperty(channel.property) : channel.property;
    const scopes=typesByUid.get(channel.target.uid),split=channel.target.figureTypeId===undefined&&scopes?.size>1;
    const mapped=replacements.map((handleId,index)=>({target:{...channel.target,handleId,...(split?{figureTypeId:figure.figure_type_id}:{})},property,
      copied:(handleId!==channel.target.handleId&&replacements.includes(channel.target.handleId))||index>0}));
    if(split)for(const type of scopes)if(type!==figure.figure_type_id)mapped.push({target:{...channel.target,figureTypeId:type},property:channel.property,copied:mapped.length>0});
    for(const result of mapped){
      const id=animationChannelId(result.target,result.property);
      // A more specific authored curve already owns this unaffected rig. The
      // legacy fallback must not replace that curve during a split.
      const existing=channelById.get(id);
      if(existing&&existing!==channel&&!affected.has(existing))continue;
      if(id===channel.id){emit(channel,channel);continue;}
      emit({...channel,target:result.target,property:result.property,id,
        keys:result.copied?channel.keys.map(key=>({...clone(key),id:freshKey()})):channel.keys},channel);
    }
  }
  validateAnimationDocument({...editor.report,_styk:{...editor.report._styk,animation:after}});
  editor.report._styk.animation=after;
}
