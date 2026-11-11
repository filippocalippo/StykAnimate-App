import {messageError} from './localized-error.mjs';
/** Layer exposure sheet: each key owns a complete pose on one layer. This reads the stored sheet (which key
 * governs a tick) and validates it; the engine evaluates it. */
import {poseSourceFrame} from './pivot/read-view.mjs';
import {validateKeyEasing} from './keyframe-easing.mjs';

export const MAX_SHEET_TICKS=10000000;
export function sheetKeyAt(track,tick){
  const keys=track?.keys??[];let low=0,high=keys.length;
  while(low<high){const mid=(low+high)>>>1;if(keys[mid].tick<=tick)low=mid+1;else high=mid;}
  return {key:keys[low-1],next:keys[low],index:low-1};
}
export function sheetKeyTimes(report){
  const state=report._styk?.layerSheet;if(!state)return [];
  return [...new Set([0,...Object.values(state.tracks).flatMap(track=>track.keys.map(key=>key.tick))])].filter(t=>t<state.duration).sort((a,b)=>a-b);
}
function sheetValidationState(report){
  const state=report._styk?.layerSheet;if(state===undefined)return report;
  if(!state||state.version!==1||!Number.isInteger(state.duration)||state.duration<1||state.duration>MAX_SHEET_TICKS||
    !Number.isSafeInteger(state.nextId)||state.nextId<1||!state.tracks||Array.isArray(state.tracks))throw messageError(new Error(''), "errors.layerSheet.invalidLayerTimeline", {});
  const allowed=new Set(['scene','camera',...(report._styk.layers?.order??[])]);
  if([...allowed].some(id=>!Object.hasOwn(state.tracks,id)))throw messageError(new Error(''), "errors.layerSheet.layerTimelineIsMissingAnExposureTrack", {});
  return {state,allowed};
}
function validateTrack(report,id,track,allowed,duration){
    if(!allowed.has(id)||!track||!Array.isArray(track.keys))throw messageError(new Error(''), "errors.layerSheet.layerTimelineReferencesAMissingLayer", {});
    if(!Number.isInteger(track.end)||track.end<0||track.end>duration)throw messageError(new Error(''), "errors.layerSheet.invalidLayerExposureLength", {});
    const ids=new Set(),sources=new Map();let previous=-1,largest=0;
    const sourceFor=frameId=>{if(sources.has(frameId))return sources.get(frameId);const frame=poseSourceFrame(report,frameId);if(frame)sources.set(frameId,frame);return frame;};
    for(const key of track.keys){
      if(ids.size>=1000000||!key||typeof key.id!=='string'||!key.id||ids.has(key.id)||!Number.isInteger(key.tick)||key.tick<0||key.tick<=previous||key.tick>=track.end)
        throw messageError(new Error(''), "errors.layerSheet.layerKeysNeedUniqueIdentitiesAndDistinctOrdered", {});
      ids.add(key.id);previous=key.tick;validateKeyEasing(key);
      if(key.patchOnly!==undefined&&key.patchOnly!==true)throw messageError(new Error(''), "errors.layerSheet.invalidMovieclipFrameBoundary", {});
      if(key.movieclipPatches!==undefined){
        if(!Array.isArray(key.movieclipPatches)||key.movieclipPatches.length>65535)throw messageError(new Error(''), "errors.layerSheet.invalidMovieclipFrameReplacements", {});
        const replaced=new Set();
        for(const patch of key.movieclipPatches){if(!patch||!Number.isInteger(patch.uid)||patch.uid<0||replaced.has(patch.uid)||!sourceFor(patch.frameId)||
          patch.replacementUid!==undefined&&!sourceFor(patch.frameId).objects.some(object=>object.unique_id===patch.replacementUid)||
          patch.orderIndex!==undefined&&(!Number.isInteger(patch.orderIndex)||patch.orderIndex<0||patch.orderIndex>65535))throw messageError(new Error(''), "errors.layerSheet.invalidMovieclipFrameReplacement", {});replaced.add(patch.uid);}
      }
      if(/^cell-\d+$/.test(key.id))largest=Math.max(largest,Number(key.id.slice(5)));
      if(key.sourceTick!==undefined){if(!Number.isFinite(key.sourceTick)||key.sourceTick<0||key.sourceTick>MAX_SHEET_TICKS)throw messageError(new Error(''), "errors.layerSheet.invalidImportedLayerTiming", {});}
      else if(key.value?.frameId!==null&&!sourceFor(key.value?.frameId))throw messageError(new Error(''), "errors.layerSheet.layerKeyReferencesAMissingPose", {});
    }
  return {keys:track.keys,count:track.keys.length,largest};
}
export function validateLayerSheet(report){
  if(report._styk?.layerSheet===undefined)return report;
  const {state,allowed}=sheetValidationState(report),summaries=new Map();
  let count=0,largest=0;
  for(const [id,track] of Object.entries(state.tracks)){
    if(!allowed.has(id))throw messageError(new Error(''), "errors.layerSheet.layerTimelineReferencesAMissingLayer", {});
    const summary=validateTrack(report,id,track,allowed,state.duration);
    summaries.set(id,summary);count+=summary.count;largest=Math.max(largest,summary.largest);
  }
  if(count>1000000)throw messageError(new Error(''), "errors.layerSheet.layerKeysNeedUniqueIdentitiesAndDistinctOrdered", {});
  if(state.nextId<=largest)throw messageError(new Error(''), "errors.layerSheet.layerKeyIdentityCounterIsInvalid", {});
  const owners=new Set();
  for(const summary of summaries.values())for(const key of summary.keys){
    if(owners.has(key.id))throw messageError(new Error(''), "errors.layerSheet.layerKeysNeedUniqueIdentitiesAndDistinctOrdered", {});
    owners.add(key.id);
  }
  return report;
}
