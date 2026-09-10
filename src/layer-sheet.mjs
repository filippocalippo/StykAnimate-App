/** Layer exposure sheet. Each key owns a complete pose on one layer. Imported
 * spans reference their original evaluator until their endpoints are edited. */
import {layerIdForUid} from './layers.mjs';
import {poseSourceFrame, samplePoseTrack} from './animation-pose.mjs';
import {validateKeyEasing} from './keyframe-easing.mjs';
import {snapshotPoseFrame} from './pose-snapshot.mjs';

const cache=new WeakMap();
export const MAX_SHEET_TICKS=10000000;
export function sheetTrack(report,id){return report._styk?.layerSheet?.tracks[id];}
export function sheetKeyAt(track,tick){
  const keys=track?.keys??[];let low=0,high=keys.length;
  while(low<high){const mid=(low+high)>>>1;if(keys[mid].tick<=tick)low=mid+1;else high=mid;}
  return {key:keys[low-1],next:keys[low],index:low-1};
}
export function sheetKeyTimes(report){
  const state=report._styk?.layerSheet;if(!state)return [];
  return [...new Set([0,...Object.values(state.tracks).flatMap(track=>track.keys.map(key=>key.tick))])].filter(t=>t<state.duration).sort((a,b)=>a-b);
}
export function validateLayerSheet(report){
  const state=report._styk?.layerSheet;if(state===undefined)return report;
  if(!state||state.version!==1||!Number.isInteger(state.duration)||state.duration<1||state.duration>MAX_SHEET_TICKS||
    !Number.isSafeInteger(state.nextId)||state.nextId<1||!state.tracks||Array.isArray(state.tracks))throw new Error('Invalid layer timeline.');
  const allowed=new Set(['scene','camera',...(report._styk.layers?.order??[])]),ids=new Set();let count=0,largest=0;
  if([...allowed].some(id=>!Object.hasOwn(state.tracks,id)))throw new Error('Layer timeline is missing an exposure track.');
  for(const [id,track] of Object.entries(state.tracks)){
    if(!allowed.has(id)||!track||!Array.isArray(track.keys))throw new Error('Layer timeline references a missing layer.');
    if(!Number.isInteger(track.end)||track.end<0||track.end>state.duration)throw new Error('Invalid layer exposure length.');
    let previous=-1;
    for(const key of track.keys){
      if(++count>1000000||!key||typeof key.id!=='string'||!key.id||ids.has(key.id)||!Number.isInteger(key.tick)||key.tick<0||key.tick<=previous||key.tick>=track.end)
        throw new Error('Layer keys need unique identities and distinct ordered frame positions.');
      ids.add(key.id);previous=key.tick;validateKeyEasing(key);
      if(/^cell-\d+$/.test(key.id))largest=Math.max(largest,Number(key.id.slice(5)));
      if(key.sourceTick!==undefined){if(!Number.isFinite(key.sourceTick)||key.sourceTick<0||key.sourceTick>MAX_SHEET_TICKS)throw new Error('Invalid imported layer timing.');}
      else if(key.value?.frameId!==null&&!poseSourceFrame(report,key.value?.frameId))throw new Error('Layer key references a missing pose.');
    }
  }
  if(state.nextId<=largest)throw new Error('Layer key identity counter is invalid.');
  return report;
}
export function legacySheetReport(report){
  const state=report._styk.layerSheet;
  const metadata={...report._styk,animation:state.legacyAnimation};delete metadata.layerSheet;
  return {...report,_styk:metadata};
}
export function invalidateLayerSheet(report){cache.delete(report);}
function ordered(frame){return (frame.object_draw_order??frame.objects.map((_,i)=>i)).map(i=>frame.objects[i]).filter(Boolean);}
export function sampleLayerSheet(report,tick,{sampleLegacy,sampleNative}){
  const state=report._styk.layerSheet;
  let cached=cache.get(report);
  if(!cached||cached.state!==state){cached={state,legacy:legacySheetReport(report),samples:new Map(),channels:new Map(),endpoints:new WeakMap(),imported:new WeakMap()};cache.set(report,cached);}
  // All imported layers at the same time share one complete scene evaluation.
  cached.samples.clear();
  const sourceAt=time=>{let value=cached.samples.get(time);if(!value){value=sampleLegacy(cached.legacy,time);cached.samples.set(time,value);}return value;};
  const sample=(id)=>{
    const track=state.tracks[id],{key,next,index}=sheetKeyAt(track,tick);
    if(track&&tick>=track.end&&!['scene','camera'].includes(id))return null;
    if(!key)return null;
    if(key.value?.frameId===null)return null;
    if(next?.value?.frameId===null)return key.sourceTick!==undefined?sourceAt(key.sourceTick):poseSourceFrame(report,key.value?.frameId);
    if(key.sourceTick!==undefined&&(!next||next.sourceTick!==undefined)){
      const fraction=next?Math.max(0,Math.min(1,(tick-key.tick)/(next.tick-key.tick))):0;
      return sourceAt(key.sourceTick+fraction*((next?.sourceTick??key.sourceTick)-key.sourceTick));
    }
    let imported=cached.imported.get(track);if(imported===undefined){imported=track.keys.some(k=>k.sourceTick!==undefined);cached.imported.set(track,imported);}
    if(imported){
      const first=Math.max(0,index-1),last=Math.min(track.keys.length,index+3);
      const frames=track.keys.slice(first,last).map((entry,i)=>{
        let frame;
        if(entry.sourceTick!==undefined){frame=cached.endpoints.get(entry);if(!frame){const source=sourceAt(entry.sourceTick);frame=snapshotPoseFrame(source,['scene','camera'].includes(id)?[]:source.objects.filter(o=>layerIdForUid(report,o.unique_id)===id).map(o=>o.unique_id));cached.endpoints.set(entry,frame);}}
        else frame=poseSourceFrame(report,entry.value?.frameId);
        return {...(frame??report.keyframes[0]),...(!frame?{objects:[],object_count:0,object_draw_order:[],object_draw_order_unique_ids:[]}:{}),
          _styk:{...frame?._styk,easing:{interpolation:entry.interpolation,...(entry.bezier?{bezier:entry.bezier}:{})}},duration_raw:(track.keys[first+i+1]?.tick??entry.tick+1)-entry.tick};
      });
      const metadata={...report._styk};delete metadata.animation;delete metadata.layerSheet;
      return sampleNative({...report,version:5,keyframes:frames,_styk:metadata},index-first,next?(tick-key.tick)/(next.tick-key.tick):0);
    }
    let channel=cached.channels.get(track);
    if(!channel){channel={target:['scene','camera'].includes(id)?{kind:id}:{kind:'layer',id},property:'pose',keys:track.keys};cached.channels.set(track,channel);}
    return samplePoseTrack(report,channel,tick,{sampleNative:(source,index,t)=>sampleNative({...source,version:5},index,t)});
  };
  const template=report.keyframes[0],scene=sample('scene')??{background_id:0,background_id_b:0,background_mix:0},camera=sample('camera'),records=[];
  const frames=new Map(report._styk.layers.order.map(id=>[id,sample(id)]));
  // Imported layers commonly share one native pose. Retain its objects and
  // geometry identities instead of cloning the entire scene on every seek.
  if(camera===scene&&scene.objects?.every(object=>frames.get(layerIdForUid(report,object.unique_id))===scene)&&
    [...frames.values()].every(frame=>!frame||frame===scene||!frame.objects.length))return scene;
  for(const id of report._styk.layers.order){
    const frame=frames.get(id);if(!frame)continue;
    for(const object of ordered(frame))if(layerIdForUid(report,object.unique_id)===id)records.push({object,parent:object.join?frame.objects[object.join.target_object_slot]?.unique_id:null});
  }
  const slots=new Map(records.map(({object},slot)=>[object.unique_id,slot]));
  const objects=records.map(({object,parent},slot)=>{
    const parentSlot=slots.get(parent),joined=object.join&&parentSlot!==undefined;
    if(object.object_slot===slot&&(!object.join||joined&&object.join.target_object_slot===parentSlot))return object;
    return {...object,object_slot:slot,join:joined?{...object.join,target_object_slot:parentSlot,target_unique_id:parent}:null};
  });
  const result={...template,objects,object_count:objects.length,object_draw_order:objects.map((_,i)=>i),object_draw_order_unique_ids:objects.map(o=>o.unique_id),camera:camera?.camera??{is_default:true,x:0,y:0,scale:1,angle_rad:0}};
  for(const field of ['background_id','background_id_b','background_mix','background_color','_stykBackgroundColor']){
    if(field in scene)result[field]=scene[field];else delete result[field];
  }
  return result;
}
