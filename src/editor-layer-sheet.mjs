import {messageError} from './localized-error.mjs';
import {nativeTimeline, evaluatedFrame, evaluatedNativeFrame, timeline, movieclipPresenceIndex, buildGeometry} from './pivot/geometry.mjs';
import {composePoseChannels} from './animation-pose.mjs';
import {sheetKeyAt,validateLayerSheet,validateLayerSheetChanges,MAX_SHEET_TICKS} from './layer-sheet.mjs';
import {snapshotPoseFrame,poseObjectSignature} from './pose-snapshot.mjs';
import {createFrame} from './demo.mjs';
import {layerIdForUid,validateLayerState} from './layers.mjs';
import {LAYER_MIGRATION_LIMITS,LAYER_MIGRATION_WORKER_LIMITS} from './editor-layer-migration.mjs';
import {keyEasing, inheritedKeyEasing} from './keyframe-easing.mjs';
import {animationChannelId,composeAnimationChannels,normalizeAnimationTarget,validateAnimationValue} from './animation-channels.mjs';

import {remapVfxOwner} from './vfx.mjs';
import {remapIKFollowers,translateIKTargets} from './ik.mjs';
import {frameOrder,setOrder,normalizeFrame} from './pivot/structure.mjs';
import {movieclipTypes,validatePlayback,snapshotFigureDefinition} from './movieclips.mjs';
import {usesPresence,continuations,setContinuations,presenceElapsed} from './movieclip-presence.mjs';
import {drawingMetadata,isDrawingLayer,copyDrawingFigure} from './drawing-model.mjs';

const clone=value=>structuredClone(value);
const fixed=id=>id==='scene'||id==='camera';
const checkedTick=tick=>{if(!Number.isInteger(tick)||tick<0||tick>=MAX_SHEET_TICKS)throw messageError(new Error(''), "errors.editorLayerSheet.chooseAValidWholeFrame", {});return tick;};
function at(report,tick,options={}){const rows=timeline(report);let low=0,high=rows.length-1;while(low<high){const mid=(low+high+1)>>>1;if(rows[mid].start<=tick)low=mid;else high=mid-1;}
  const row=rows[low];return evaluatedFrame(report,low,row?.count?(tick-row.start)/row.count:0,tick,{skipMovieclips:true,...options});}
export function initializeLayerSheet(report){
  if(report._styk.layerSheet)return validateLayerSheet(report);
  const rows=timeline(report),native=nativeTimeline(report),duration=Math.max(1,(rows.at(-1)?.start??0)+(rows.at(-1)?.count??1));
  const legacyAnimation=report._styk.animation,tracks={},state={version:1,duration,nextId:1,tracks,...(legacyAnimation?{legacyAnimation}:{})},nativeKeys=new Map(native.map((row,index)=>[row.start,report.keyframes[index]]));
  for(const id of ['scene','camera',...report._styk.layers.order]){
    const times=new Set(native.filter(r=>r.count>0).map(r=>r.start));times.add(0);
    for(const channel of legacyAnimation?.channels??[]){const target=channel.target;
      if(target.kind===id||target.kind==='layer'&&target.id===id||target.uid!==undefined&&layerIdForUid(report,target.uid)===id)
        for(const key of channel.keys)if(!key.hidden&&key.tick<duration)times.add(key.tick);
    }
    tracks[id]={end:duration,keys:[...times].sort((a,b)=>a-b).map(tick=>({id:`cell-${state.nextId++}`,tick,sourceTick:tick,...(nativeKeys.get(tick)?._styk?.easing??{interpolation:report.version<5?'constant':report.auto_easing?'auto':'linear'}),...(!fixed(id)&&!legacyAnimation&&!report._styk.movieclipSource?{empty:!nativeKeys.get(tick)?.objects.some(o=>layerIdForUid(report,o.unique_id)===id)}:{})}))};
  }
  report._styk.layerSheet=state;delete report._styk.animation;delete report._styk.simpleFrameDraft;return validateLayerSheet(report);
}
function ownedFrame(report,frame,uids){
  const selected=new Set(uids),result=clone(frame),order=frameOrder(frame).filter(uid=>selected.has(uid));let geometry;
  result.objects=result.objects.filter(o=>selected.has(o.unique_id));
  for(const object of result.objects)if(object.join){const parent=frame.objects[object.join.target_object_slot]?.unique_id;
    if(selected.has(parent))object.join.target_unique_id=parent;
    else{geometry??=buildGeometry(report,frame);const root=geometry.objects.get(object.object_slot)?.root;if(root){object.root_x=root.x;object.root_y=root.y;}object.join=null;}}
  setContinuations(result,continuations(frame).filter(step=>selected.has(step.uid)));
  const slots=new Map(result.objects.map((object,slot)=>[object.unique_id,slot]));
  for(const object of result.objects)if(object.join)object.join.target_object_slot=slots.get(object.join.target_unique_id);
  setOrder(result,order);normalizeFrame(result);return result;
}
function shiftClipTime(frame,delta){
  for(const object of frame.objects)if(object._stykMovieclip&&!usesPresence(object)){const p=object._stykMovieclip;
    p.start=Math.max(0,(p.start??0)+delta);if(p.end!==null&&p.end!==undefined)p.end=Math.max(p.start+1,p.end+delta);
    if(p.restarts)p.restarts=p.restarts.map(k=>({...k,tick:Math.max(0,k.tick+delta)}));}
  return frame;
}
function assertLayers(editor,ids){
  if(!ids.length)throw messageError(new Error(''), "errors.editorLayerSheet.selectALayer", {});
  for(const id of ids){const layer=editor.getLayer(id);if(!layer)throw messageError(new Error(''), "errors.editorLayerSheet.theSelectedLayerNoLongerExists", {});if(layer.locked)throw messageError(new Error(''), "errors.editorLayerSheet.unlockBeforeEditingIt", {name: layer.name});}
}
// Commands resolve ownership once, before capturing any layer's pose. New
// figures use the active user layer; permanent scene/camera tracks cannot own
// figures. Existing identities (including clipboard movieclips) keep theirs.
function insertionOwner(editor,uid,hints){
  const layers=editor.report._styk.layers;
  const id=hints?.get(uid)??(editor._layerUidCounts.has(uid)||Object.hasOwn(layers.assignments,uid)?editor.layerForUid(uid):
    Object.hasOwn(layers.byId,editor.activeLayerId)?editor.activeLayerId:layers.defaultLayerId);
  if(!Object.hasOwn(layers.byId,id))throw messageError(new Error(''), "errors.editorLayerSheet.figuresBelongToAnExistingUserLayer", {});
  return id;
}
export function drawingSheetPlan(editor,ids){return planner(editor,ids);}
export function drawingSheetPublish(editor,plan,label,options){return publish(editor,plan,label,options);}
function planner(editor,ids){
  assertLayers(editor,ids);
  const before=editor.report._styk.layerSheet;if(!before)throw messageError(new Error(''), "errors.editorLayerSheet.openTheLayerTimelineFirst", {});
  const state={...before,tracks:{...before.tracks}},sources=[],layers=clone(editor.report._styk.layers),originalIds=new Set(editor._layerUidCounts.keys());
  const ownedKeys=new WeakSet(),copies=new WeakMap(),indices=new WeakMap();
  let nextFrame=editor._nextFrameIdentity;
  const capture=(frame,id)=>{
    const uids=fixed(id)?[]:frame.objects.filter(o=>layerIdForUid({...editor.report,_styk:{...editor.report._styk,layers}},o.unique_id)===id).map(o=>o.unique_id);
    const source=snapshotPoseFrame(frame,uids),frameId=`frame-${nextFrame++}`;source._styk={...source._styk,frameId};
    setContinuations(source,fixed(id)?[]:continuations(frame).filter(step=>layerIdForUid({...editor.report,_styk:{...editor.report._styk,layers}},step.uid)===id));
    sources.push({id:frameId,before:{exists:false},after:{exists:true,value:source}});return {frameId};
  };
  const get=id=>{
    if(state.tracks[id]!==before.tracks[id]&&state.tracks[id])return state.tracks[id];
    const previous=before.tracks[id]??{keys:[],end:0},track={...previous,keys:previous.keys.slice()};state.tracks[id]=track;
    indices.set(track,new Map(track.keys.map((key,index)=>[key,index])));
    return track;
  };
  // Track arrays are editable; their retained key records stay shared with
  // history until the command explicitly takes ownership of a key.
  const ownKey=(id,key)=>{
    if(ownedKeys.has(key))return key;
    const existing=copies.get(key);if(existing)return existing;
    const track=get(id);let lookup=indices.get(track),index=lookup?.get(key);
    if(track.keys[index]!==key){lookup=new Map(track.keys.map((value,position)=>[value,position]));indices.set(track,lookup);index=lookup.get(key);}
    if(index===undefined)throw new Error('The edited layer key no longer belongs to its track.');
    const copy={...key};track.keys[index]=copy;lookup.set(copy,index);copies.set(key,copy);ownedKeys.add(copy);return copy;
  };
  const materialize=(id,key)=>{key=copies.get(key)??key;if(key.sourceTick===undefined)return key;const old=before.tracks[id]?.keys.find(k=>k.id===key.id);key=ownKey(id,key);key.value=capture(at(editor.report,old?.tick??key.tick),id);delete key.sourceTick;return key;};
  const write=(id,tick,frame,{blank=false,easing,extend=false}={})=>{
    checkedTick(tick);const track=get(id),{key:previous,index}=sheetKeyAt(track,tick),existing=previous?.tick===tick?previous:undefined;
    const key=existing?ownKey(id,existing):{id:`cell-${state.nextId++}`,tick,...(easing?keyEasing(easing):inheritedKeyEasing(track.keys,tick))};ownedKeys.add(key);
    // A layer's end is an explicit absence boundary: bounded writes pad the gap
    // before the requested position, while placing a keyframe carries the last
    // exposure forward to reach it.
    if(!extend&&!fixed(id)&&tick>track.end&&track.keys.length)track.keys.push({id:`cell-${state.nextId++}`,tick:track.end,interpolation:'constant',value:{frameId:null},empty:true});
    for(const object of frame?.objects??[])if(!originalIds.has(object.unique_id)&&!Object.hasOwn(layers.assignments,object.unique_id))layers.assignments[object.unique_id]=insertionOwner(editor,object.unique_id,editor._newLayerHints);
    const owns=uid=>layerIdForUid({...editor.report,_styk:{...editor.report._styk,layers}},uid)===id;
    if (isDrawingLayer(layers.byId[id])) {
      const objects=(frame?.objects??[]).filter(o=>owns(o.unique_id));
      if(objects.length>1||objects.some(o=>!drawingMetadata((planDefinitions??editor.report.figure_types).find(f=>f.figure_type_id===o.figure_type_id))))
        throw messageError(new Error(''), "errors.editorLayerSheet.drawingLayersAcceptOneDrawingCelAtA", {});
    }
    const empty=!fixed(id)&&!frame?.objects.some(o=>owns(o.unique_id))&&!continuations(frame).some(step=>owns(step.uid));
    key.value=blank||empty?{frameId:null}:capture(frame,id);key.empty=blank||empty;delete key.sourceTick;if(easing)Object.assign(key,keyEasing(easing));
    delete key.patchOnly;delete key.movieclipPatches;
    if(!existing){if(!track.keys.length||tick>track.keys.at(-1).tick)track.keys.push(key);else track.keys.splice(index+1,0,key);}
    track.end=Math.max(track.end,tick+1);state.duration=Math.max(state.duration,track.end);return key;
  };
  let planDefinitions;
  return {state,sources,layers,get,ownKey,write,capture,materialize,before,set definitions(value){planDefinitions=value;},get nextFrame(){return nextFrame;}};
}
function retimeClips(editor,plan,id,map){
  if(!movieclipTypes(editor.report).size)return;
  const track=plan.get(id);
  for(const key of track.keys){
    const old=plan.before.tracks[id]?.keys.find(k=>k.id===key.id);
    const frame=key.sourceTick!==undefined?at(editor.report,old?.tick??key.tick):key.value?.frameId&&(plan.sources.find(s=>s.id===key.value.frameId)?.after.value??editor.getFrameById(key.value.frameId));
    if(!frame?.objects.some(o=>o._stykMovieclip&&editor.layerForUid(o.unique_id)===id))continue;
    const source=clone(frame);let changed=false;
    for(const object of source.objects)if(object._stykMovieclip&&!usesPresence(object)&&editor.layerForUid(object.unique_id)===id){const p=object._stykMovieclip,before=JSON.stringify(p);
      p.start=map(p.start??0);if(p.end!==null&&p.end!==undefined)p.end=Math.max(p.start+1,map(p.end));if(p.restarts)p.restarts=p.restarts.map(k=>({...k,tick:map(k.tick)}));changed||=before!==JSON.stringify(p);}
    if(changed){const owned=plan.ownKey(id,key);owned.value=plan.capture(source,id);delete owned.sourceTick;}
  }
}
function publish(editor,plan,label,{selection=editor._selectionState(),assets,selectUids,nextUid,retainGeometry=false}={}){
  const before=editor.report._styk.layerSheet,beforeLayers=editor.report._styk.layers;
  // Freeze only endpoints of edited spans. Unchanged imported spans continue
  // using their exact original easing; one key edit never copies the movie.
  if(plan.materialize)for(const [id,track] of Object.entries(plan.state.tracks))if(track!==before.tracks[id]){
    const previous=(before.tracks[id]?.keys??[]).filter(key=>!key.patchOnly),byId=new Map(previous.map((k,i)=>[k.id,{key:k,next:previous[i+1]}])),current=track.keys.filter(key=>!key.patchOnly);
    current.forEach((key,i)=>{const old=byId.get(key.id),next=current[i+1];
      if(old&&(key.tick!==old.key.tick||key.interpolation!==old.key.interpolation||JSON.stringify(key.bezier)!==JSON.stringify(old.key.bezier)||next?.id!==old.next?.id||next?.tick!==old.next?.tick)){
        plan.materialize(id,key);if(next)plan.materialize(id,next);
      }});
  }
  const report={...editor.report,_styk:{...editor.report._styk,layerSheet:plan.state,layers:plan.layers,
    frameSources:plan.sources.length?{...editor.report._styk.frameSources,...Object.fromEntries(plan.sources.map(s=>[s.id,s.after.value]))}:editor.report._styk.frameSources}};
  validateLayerState(plan.layers);validateLayerSheetChanges(report,editor.report);
  if(assets)for(const [field,change] of Object.entries(assets)){
    if(change.added&&change.index===undefined)change.index=editor.report[field].length;
    if(change.added)editor.report[field]=[...editor.report[field],...(field==='figure_types'?change.added.map(snapshotFigureDefinition):clone(change.added))];
    else editor.report[field]=change.after;
  }
  editor.report._styk.layerSheet=plan.state;editor.report._styk.layers=plan.layers;
  if(plan.layers.nextId!==beforeLayers.nextId){
    editor._includeCreatedLayersInFocus(plan.layers.order.filter(id=>!Object.hasOwn(beforeLayers.byId,id)));
    // Selection can ask for layer descriptors before the normal layer-change
    // publication below; discard descriptors from before the planned creation.
    editor._layerDescriptors=null;
  }
  if(plan.sources.length)editor.report._styk.frameSources=report._styk.frameSources;
  editor._nextFrameIdentity=plan.nextFrame;editor._invalidate({timing:true,retainGeometry});
  if(nextUid!==undefined)editor._nextUid=nextUid;
  if(selectUids?.length)editor._selectIds(selectUids);
  editor._newLayerHints=new Map(plan.sources.flatMap(source=>source.after.value.objects.map(o=>[o.unique_id,layerIdForUid(editor.report,o.unique_id)])));
  editor._record({kind:'layer-sheet',label,before,after:plan.state,beforeLayers:clone(beforeLayers),afterLayers:clone(plan.layers),
    frameSourceChanges:plan.sources,assets,beforeSelection:selection,afterSelection:editor._selectionState(),structural:true,timing:true,retainGeometry,
    precomputedBytes:JSON.stringify({tracks:Object.keys(plan.state.tracks).filter(id=>before.tracks[id]!==plan.state.tracks[id]).map(id=>[before.tracks[id],plan.state.tracks[id]]),beforeLayers,afterLayers:plan.layers,sources:plan.sources,assets}).length*2});
  // Recording and source collection already maintain membership. A compact
  // adoption retaining the exact layers needs only the revision/event change.
  editor._layerChanged({reindex:plan.layers!==beforeLayers});editor._emit('edit',{label,structural:true,timing:true,layerSheet:true,
    definition:Boolean(assets?.figure_types),frameIndices:[],sourceIds:plan.sources.map(source=>source.id)});return true;
}
/** Publishes a layer sheet the engine's planner computed (src/engine/engine-planning.mjs): the same bookkeeping, events
 * and history as a plan made here. `sheet.tracks` holds the tracks the call replaced and
 * `trackOrder` names every track; the others stay the editor's own objects. Every source
 * it names is new and its edited imported endpoints are already materialized. */
export function adoptLayerSheet(editor,{sheet,trackOrder,layers,sources,nextFrame,definitions},label,{selection,retainGeometry=false}={}){
  const before=editor.report._styk.layerSheet;
  const state={...sheet,tracks:Object.fromEntries(trackOrder.map(id=>[id,Object.hasOwn(sheet.tracks,id)?sheet.tracks[id]:before.tracks[id]]))};
  const plan={state,layers,nextFrame,sources:Object.entries(sources??{}).map(([id,value])=>({id,before:{exists:false},after:{exists:true,value}}))};
  // Definitions the call added (a paste's copies) are published with the sheet, as assets.
  const assets=definitions?.length?{figure_types:{added:definitions}}:undefined;
  return publish(editor,plan,label,{selection,retainGeometry,assets});
}
function replaceAt(editor,plan,id,tick,uid,frame,options={},end=tick+1){
  checkedTick(tick);const track=plan.get(id);
  if(tick>=track.end)return;
  const boundary=time=>{
    let key=track.keys.find(key=>key.tick===time);
    if(!key){key={id:`cell-${plan.state.nextId++}`,tick:time,interpolation:'constant',patchOnly:true,value:{frameId:null},empty:!at(editor.report,time).objects.some(object=>editor.layerForUid(object.unique_id)===id)};track.keys.push(key);track.keys.sort((a,b)=>a.tick-b.tick);}
    return plan.ownKey(id,key);
  };
  const previous=sheetKeyAt(track,tick).key?.movieclipPatches??[];
  if(end<track.end&&!track.keys.some(key=>key.tick===end)){
    const restored=boundary(end);if(previous.length)restored.movieclipPatches=previous;
  }
  const {frameId=plan.capture(frame,id).frameId,...patchOptions}=options;
  const key=boundary(tick);key.movieclipPatches=[...previous.filter(patch=>patch.uid!==uid),{uid,frameId,...patchOptions}];
  const members=new Set(at(editor.report,tick).objects.filter(object=>editor.layerForUid(object.unique_id)===id).map(object=>object.unique_id));
  for(const patch of key.movieclipPatches){members.delete(patch.uid);const source=plan.sources.find(source=>source.id===patch.frameId)?.after.value??editor.getFrameById(patch.frameId);for(const object of source.objects)members.add(object.unique_id);}
  key.empty=!members.size;
}
function* sampleSheetTracksSteps(editor,plan,ids,{background=false,maxSourceBytes=128*1024*1024}={},transform=frame=>frame){
  const affected=new Set(ids),end=Math.max(0,...ids.map(id=>plan.state.tracks[id].end));
  const limits=background?LAYER_MIGRATION_WORKER_LIMITS:LAYER_MIGRATION_LIMITS;
  if(end>limits.maxTicks)throw messageError(new Error(''), "errors.editorLayerSheet.thisLayerChangeNeedsMoreThan10000", {});
  if(Object.entries(plan.state.tracks).reduce((sum,[id,track])=>sum+(affected.has(id)?track.end:track.keys.length),0)>1000000)
    throw messageError(new Error(''), "errors.editorLayerSheet.preservingThisLayerChangeWouldExceedTheOne", {});
  if(!(maxSourceBytes>0))throw messageError(new Error(''), "errors.editorLayerMigration.layerMigrationSourceMemoryBudgetMustBePositive", {});
  for(const id of ids)plan.state.tracks[id]={...plan.state.tracks[id],keys:[]};
  let objectPoses=0,segmentValues=0,keyCount=0,lastYield=performance.now();
  for(let tick=0;tick<end;tick++){
    const frame=transform(at(editor.report,tick));
    for(const id of ids)if(tick<plan.state.tracks[id].end){
      const key=plan.write(id,tick,frame,{easing:{interpolation:'constant'}});keyCount++;
      const source=key.value.frameId?plan.sources.at(-1).after.value:null;
      for(const object of source?.objects??[]){objectPoses++;segmentValues+=(object.angles?.length??0)+(object.lengths?.length??0)+(object.bends?.length??0);}
    }
    if(objectPoses>limits.maxObjectPoses||segmentValues>limits.maxSegmentValues||256*keyCount+512*objectPoses+8*segmentValues>maxSourceBytes)
      throw messageError(new Error(''), "errors.editorLayerMigration.thisLayerMigrationExceedsTheRetainedPoseMemory", {});
    if((tick+1)%8===0||performance.now()-lastYield>=8||tick+1===end){
      yield {phase:'sampling',completed:tick+1,total:end,sourceFrames:plan.sources.length,objectPoses,segmentValues};lastYield=performance.now();
    }
  }
}
/** Ownership changes never retime the source layers. A vacant destination can
 * share the source's immutable poses and exact curves. Combining independent
 * tracks requires sampling only the destination, including absence and clip
 * continuations; hold keys preserve every integer output frame. */
export function* planSheetAssignmentSteps(editor,uids,id,options={}){
  if(!Object.hasOwn(editor.report._styk.layers.byId,id))throw messageError(new Error(''), "errors.editorLayerSheet.figuresBelongToUserLayers", {});
  if(isDrawingLayer(editor.getLayer(id))||uids.some(uid=>isDrawingLayer(editor.getLayer(editor.layerForUid(uid)))))throw messageError(new Error(''), "errors.editorLayerSheet.useDrawingKeyCopyPasteBetweenDrawingLayers", {});
  const members=[...new Set(uids)];
  if(members.some(uid=>!Number.isInteger(uid)||!editor._layerUidCounts.has(uid)))throw messageError(new Error(''), "errors.editorLayerAsync.chooseFiguresPresentInThisAnimation", {});
  const moved=members.filter(uid=>editor.layerForUid(uid)!==id);if(!moved.length)return null;
  const sourceIds=[...new Set(moved.map(uid=>editor.layerForUid(uid)))],plan=planner(editor,[id,...sourceIds]);
  for(const uid of moved)plan.layers.assignments[uid]=id;
  const owns=(uid,destination)=>layerIdForUid({_styk:{layers:plan.layers}},uid)===destination;
  const empty=(frame,destination)=>!frame.objects.some(o=>owns(o.unique_id,destination))&&!continuations(frame).some(step=>owns(step.uid,destination));
  function* refreshMembership(destination){
    const keys=plan.get(destination).keys;let lastYield=performance.now(),completed=0;
    for(const key of keys){
      plan.ownKey(destination,key).empty=empty(at(editor.report,key.tick),destination);completed++;
      if(completed%8===0||performance.now()-lastYield>=8){yield {phase:'planning',completed,total:keys.length};lastYield=performance.now();}
    }
  }
  const vacant=!editor.getLayerFigureUids(id).length;
  const trackSignature=track=>JSON.stringify({...track,keys:track.keys.map(({id,empty,...key})=>key)});
  const destinationSignature=trackSignature(plan.before.tracks[id]);
  const shared=sourceIds.every(source=>trackSignature(plan.before.tracks[source])===destinationSignature);
  if(shared){
    yield* refreshMembership(id);
  }else if(vacant&&sourceIds.length===1){
    const source=plan.before.tracks[sourceIds[0]];
    plan.state.tracks[id]={...source,keys:source.keys.map(key=>({...key,id:`cell-${plan.state.nextId++}`}))};
    yield* refreshMembership(id);
    const previousEnd=plan.before.tracks[id].end;
    if(previousEnd>source.end){plan.write(id,source.end,createFrame(),{blank:true,easing:{interpolation:'constant'}});plan.get(id).end=previousEnd;}
  }else{
    const end=Math.max(...[id,...sourceIds].map(layer=>plan.before.tracks[layer].end));
    plan.state.tracks[id]={end,keys:[]};
    yield* sampleSheetTracksSteps(editor,plan,[id],options);
  }
  // Empty indicators describe the new membership, while every source key,
  // patch, duration and curve retains its original meaning.
  for(const source of sourceIds)yield* refreshMembership(source);
  return plan;
}
export function commitSheetAssignment(editor,plan){return plan?publish(editor,plan,'Move figures to layer'):false;}
/** Remove ownership and content atomically. Only tracks which can inherit
 * deleted native members or depend on their attachment geometry need baking.
 * Detached children retain their world poses and movieclip presence clocks. */
export function* planSheetDeletionSteps(editor,id,options={}){
  const state=editor.report._styk.layers;
  if(!Object.hasOwn(state.byId,id))throw messageError(new Error(''), "errors.editorLayerSheet.sceneAndCameraCannotBeDeleted", {});
  if(state.order.length===1)throw messageError(new Error(''), "errors.editorLayerAsync.keepAtLeastOneUserLayer", {});
  const target=state.order.find(value=>value!==id),plan=planner(editor,[id]),removed=new Set(editor.getLayerFigureUids(id));
  for(const [uid,owner] of Object.entries(state.assignments))if(owner===id)removed.add(Number(uid));
  // Inspect only sources used by surviving user tracks. Retained undo assets
  // and scene/camera templates must not force unrelated layers to be baked.
  const nativeFrames=new Set(editor.report.keyframes),importedLayers=new Set(),explicitOwners=new Map(),affected=new Set();
  for(const channel of plan.before.legacyAnimation?.channels??[])if(channel.property==='pose')
    for(const key of channel.keys){const frame=key.value?.frameId&&editor.getFrameById(key.value.frameId);if(frame)nativeFrames.add(frame);}
  for(const owner of state.order)if(owner!==id)for(const key of plan.before.tracks[owner].keys){
    if(key.sourceTick!==undefined)importedLayers.add(owner);
    for(const value of [key.value,...(key.movieclipPatches??[])]){
      const frame=value?.frameId&&editor.getFrameById(value.frameId);if(!frame)continue;
      if(!explicitOwners.has(frame))explicitOwners.set(frame,new Set());explicitOwners.get(frame).add(owner);
    }
  }
  const sources=[...new Set([...explicitOwners.keys(),...(importedLayers.size?nativeFrames:[])])];
  let nativeMembers=false,work=0,lastYield=performance.now();
  for(const frame of sources){
    for(const step of continuations(frame))if(editor.layerForUid(step.uid)===id)removed.add(step.uid);
    if(nativeFrames.has(frame)&&[...frame.objects.map(o=>o.unique_id),...continuations(frame).map(step=>step.uid)].some(uid=>removed.has(uid)))nativeMembers=true;
    for(const object of frame.objects)if(object.join&&editor.layerForUid(object.unique_id)!==id&&
      removed.has(frame.objects[object.join.target_object_slot]?.unique_id??object.join.target_unique_id)){
      const owner=editor.layerForUid(object.unique_id);
      if(explicitOwners.get(frame)?.has(owner)||nativeFrames.has(frame)&&importedLayers.has(owner))affected.add(owner);
    }
    if(++work%64===0||performance.now()-lastYield>=8){yield {phase:'planning',completed:work,total:sources.length};lastYield=performance.now();}
  }
  const fallback=plan.before.tracks[target];
  if(fallback.keys.some(key=>key.sourceTick!==undefined&&nativeMembers||[key.value,...(key.movieclipPatches??[])].some(value=>{
    const frame=value?.frameId&&editor.getFrameById(value.frameId);
    return frame&&[...frame.objects.map(o=>o.unique_id),...continuations(frame).map(step=>step.uid)].some(uid=>removed.has(uid));
  })))affected.add(target);
  yield* sampleSheetTracksSteps(editor,plan,[...affected],options,frame=>ownedFrame(editor.report,frame,
    [...frame.objects.map(o=>o.unique_id),...continuations(frame).map(step=>step.uid)].filter(uid=>!removed.has(uid))));
  for(const uid of removed)plan.layers.assignments[uid]=target;
  plan.layers.order=plan.layers.order.filter(value=>value!==id);delete plan.layers.byId[id];delete plan.state.tracks[id];
  if(plan.layers.defaultLayerId===id)plan.layers.defaultLayerId=target;if(plan.layers.activeId===id)plan.layers.activeId=target;
  plan.state.duration=Math.max(1,...Object.values(plan.state.tracks).map(track=>track.end));
  return plan;
}
export function commitSheetDeletion(editor,plan){return publish(editor,plan,'Delete layer');}
export function applyLayerSheetCommand(editor,command,direction){
  if(command.kind!=='layer-sheet')return false;
  editor.report._styk.layerSheet=command[direction];editor.report._styk.layers=clone(command[`${direction}Layers`]);
  if(command.layerChanges?.length)editor._applyLayerChanges(command.layerChanges,direction);
  if(command.assets)for(const [field,change] of Object.entries(command.assets)){
    if(change.added)editor.report[field].splice(change.index,direction==='before'?change.added.length:0,...(direction==='after'?(field==='figure_types'?change.added.map(snapshotFigureDefinition):clone(change.added)):[]));
    else editor.report[field]=change[direction].slice();
  }
  editor._applyFrameSourceChanges(command,direction);editor._trackLayerCommand(command,direction);editor._layerChanged({reindex:true});editor._invalidate({timing:true,retainGeometry:command.retainGeometry});
  editor._restoreSelection(command[`${direction}Selection`]);editor._revision=command[`${direction}Revision`];
  editor._emit('history',{label:command.label,structural:true,timing:true,layerSheet:true,
    definition:Boolean(command.assets?.figure_types),frameIndices:[],sourceIds:(command.frameSourceChanges||[]).map(source=>source.id)});return true;
}
export const editorLayerSheetMethods={
  /** Motion-path drag support: a live plan writes layer/camera keys at one
   * tick, and every further pointer move recaptures the same retained sources
   * in place so one gesture produces one key per track. */
  _sheetPoseDraftBegin(tick, layerIds) {
    return {tick, plan: planner(this, layerIds), writes: new Map()};
  },
  _sheetPoseDraftWrite(draft, id, frame, changedUids) {
    const {plan, tick} = draft, owns = uid => layerIdForUid({...this.report, _styk: {...this.report._styk, layers: plan.layers}}, uid) === id;
    let entry = draft.writes.get(id);
    if (!entry) {
      const track = plan.get(id);let {key, next} = sheetKeyAt(track, tick);
      const patchUids = new Set((key?.movieclipPatches ?? []).flatMap(p => this.getFrameById(p.frameId)?.objects.map(o => o.unique_id) ?? []));
      const changedHere = [...changedUids].filter(uid => owns(uid));
      if (!this.autoKey && key?.movieclipPatches && changedHere.length && changedHere.every(uid => patchUids.has(uid))) {
        key = plan.ownKey(id, key);
        key.empty = !frame.objects.some(o => owns(o.unique_id));
        entry = {key, writeTick: tick, nextTick: next?.tick ?? track.end, patchSources: new Map(), patchOnly: true};
        draft.writes.set(id, entry);
      } else {
        // Auto key writes at the playhead; otherwise a held cell edits its preceding key.
        const writeTick = !this.autoKey && key && ['constant', 'hold'].includes(key.interpolation) ? key.tick : tick;
        const written = plan.write(id, writeTick, frame, {easing: key ?? {interpolation: 'constant'}});
        const sourceRecord = written?.value?.frameId ? plan.sources.at(-1) : null;
        entry = {key: written, writeTick, sourceRecord, patchSources: new Map()};
        entry.nextTick = sheetKeyAt(plan.get(id), writeTick).next?.tick ?? plan.get(id).end;
        draft.writes.set(id, entry);
        return entry;
      }
    }
    const {key} = entry;
    if (entry.patchOnly) {
      const changedHere = [...changedUids].filter(uid => owns(uid));
      key.empty = !frame.objects.some(o => owns(o.unique_id));
      key.movieclipPatches = key.movieclipPatches.map(patch => {
        const record = entry.patchSources.get(patch.uid);
        const retained = record ? plan.sources.find(s => s.id === record.frameId)?.after.value : this.getFrameById(patch.frameId);
        const members = [...(retained?.objects ?? []).map(o => o.unique_id)];
        if (!changedHere.some(uid => members.includes(uid))) return patch;
        const patchFrame = ownedFrame(this.report, frame, members);
        setContinuations(patchFrame, continuations(retained));
        const source = snapshotPoseFrame(patchFrame, members);
        if (record) {
          source._styk = {...source._styk, frameId: record.frameId};
          setContinuations(source, continuations(patchFrame).filter(step => owns(step.uid)));
          record.source.after.value = source;
          return record.target;
        }
        const frameId = plan.capture(patchFrame, id).frameId;
        const target = {...patch, frameId};
        entry.patchSources.set(patch.uid, {frameId, target, source: plan.sources.at(-1)});
        return target;
      });
      return entry;
    }
    if (entry.sourceRecord) {
      const uids = fixed(id) ? [] : frame.objects.filter(o => owns(o.unique_id)).map(o => o.unique_id);
      const source = (draft.snapshot ?? snapshotPoseFrame)(frame, uids);
      source._styk = {...source._styk, frameId: entry.sourceRecord.id};
      setContinuations(source, fixed(id) ? [] : continuations(frame).filter(step => owns(step.uid)));
      entry.sourceRecord.after.value = source;
      key.empty = !fixed(id) && !frame?.objects.some(o => owns(o.unique_id)) && !continuations(frame).some(s => owns(s.uid));
    } else if (!fixed(id)) {
      const has = frame?.objects.some(o => owns(o.unique_id)) || continuations(frame).some(s => owns(s.uid));
      if (has) { const value = plan.capture(frame, id); key.value = value; key.empty = false; entry.sourceRecord = plan.sources.at(-1); }
    }
    return entry;
  },
  _sheetPoseDraftPublish(draft, label, selection) {
    return publish(this, draft.plan, label, {selection});
  },
  sheetExtendMovieclip(count){
    const uid=this.selectedUid,id=this.layerForUid(uid),plan=planner(this,[id]);
    const track=plan.get(id),keys=track.keys.filter(key=>!key.patchOnly&&key.tick>this.tick&&key.tick<track.end).slice(0,count);
    const source=ownedFrame(this.report,this.selectionFrame,[uid]);
    const orderIndex=frameOrder(this.selectionFrame).filter(value=>this.layerForUid(value)===id).indexOf(uid);
    let added=0;
    for(const key of keys){
      if(at(this.report,key.tick).objects.some(object=>object.unique_id===uid))continue;
      // Only existing boundaries: preserve the original pose and easing.
      const index=track.keys.indexOf(key),end=track.keys[index+1]?.tick??track.end;
      replaceAt(this,plan,id,key.tick,uid,source,{orderIndex},end);added++;
    }
    if(added)publish(this,plan,'Add movieclip to next keyframes');
    return added;
  },
  sheetReplaceMovieclipFrames(frames,uid,children,label,options={}){
    const id=this.layerForUid(uid),plan=planner(this,[id]);
    for(const child of children)plan.layers.assignments[child]=id;
    for(const {tick,frame} of frames)replaceAt(this,plan,id,tick,uid,frame,options);
    return publish(this,plan,label);
  },
  /** Replace only the captured membership. Existing pose keys remain the exact
   * interpolation baseline, including curves crossing either range boundary. */
  sheetCreateMovieclip({selected,start,end,instance,anchor,layerName='Movieclip'}){
    const ids=[...new Set([...selected].map(uid=>this.layerForUid(uid)))],plan=planner(this,ids);
    let owner=this.layerForUid(anchor);
    // Drawing layers hold only drawing cels: a clip made of drawings alone
    // gets its own figure layer directly above the anchor drawing layer.
    const ownLayer=isDrawingLayer(plan.layers.byId[owner]);
    if(ownLayer){
      const id=`layer-${plan.layers.nextId}`,order=plan.layers.order.slice();order.splice(order.indexOf(owner)+1,0,id);
      plan.layers.byId[id]={name:String(layerName).slice(0,120)||'Movieclip',visible:true,locked:false,...(plan.layers.byId[owner]?.folderId?{folderId:plan.layers.byId[owner].folderId}:{})};plan.layers.order=order;plan.layers.nextId++;owner=id;
    }
    plan.layers.assignments[instance.unique_id]=owner;
    if(ownLayer){
      if(start>0)plan.write(owner,0,createFrame(),{blank:true});
      plan.write(owner,start,createFrame([instance]));
      if(end<plan.state.duration)plan.write(owner,end,createFrame(),{blank:true});
    }
    const captured=new Map();
    for(const id of ids){
      const track=plan.get(id),uids=[...selected].filter(uid=>this.layerForUid(uid)===id);
      if(id===owner&&end>track.end){
        // Extend only the container's presence, leaving an ended base layer empty.
        plan.write(id,track.end,createFrame(),{blank:true});track.end=end;
      }
      const times=[...new Set([start,...track.keys.filter(key=>key.tick>start&&key.tick<end).map(key=>key.tick)])];
      for(let i=0;i<times.length;i++){
        const tick=times[i];if(tick>=track.end)continue;
        const source=at(this.report,tick),objects=new Map(source.objects.map(object=>[object.unique_id,object]));
        for(const uid of uids){
          const frame=createFrame(uid===anchor&&!ownLayer?[instance]:[]),object=objects.get(uid);
          // Consumed source frames must still advance a replaced presence clip
          // when that same instance reappears after the converted range.
          const step=usesPresence(object)?{uid,typeId:object.figure_type_id,playback:object._stykMovieclip}:continuations(source).find(value=>value.uid===uid);
          if(step)setContinuations(frame,[step]);
          const signature=JSON.stringify([id,frame]);
          let frameId=captured.get(signature);
          if(!frameId){frameId=plan.capture(frame,id).frameId;captured.set(signature,frameId);}
          replaceAt(this,plan,id,tick,uid,frame,{frameId},Math.min(times[i+1]??end,track.end));
        }
      }
    }
    return publish(this,plan,'Create movieclip');
  },
  sheetSetMovieclipPlayback(uid,patch,{allFrames=false,typeId}={}){
    const id=this.layerForUid(uid),plan=planner(this,[id]),track=plan.get(id);
    const ticks=allFrames?track.keys.filter(key=>!key.patchOnly).map(key=>key.tick):[this.tick];
    let result;
    for(const tick of ticks){
      const frame=clone(at(this.report,tick,{skipMovieclipPatches:true}));let changed=false;
      for(const object of frame.objects)if(object.unique_id===uid&&usesPresence(object)){
        const settings=validatePlayback({...object._stykMovieclip,...patch});
        result=settings;changed||=JSON.stringify(settings)!==JSON.stringify(object._stykMovieclip);object._stykMovieclip=settings;
        if(typeId!==undefined){object.figure_type_id=typeId;changed=true;}
      }
      for(const step of continuations(frame))if(step.uid===uid){step.playback=validatePlayback({...step.playback,...patch});if(typeId!==undefined)step.typeId=typeId;changed=true;}
      if(changed){const key=sheetKeyAt(track,tick).key,patches=key?.movieclipPatches,empty=key?.empty;const written=plan.write(id,tick,frame,{easing:key});if(patches){written.movieclipPatches=patches;written.empty=empty;}}
    }
    if(allFrames)for(const key of track.keys)if(key.movieclipPatches)plan.ownKey(id,key).movieclipPatches=key.movieclipPatches.map(replacement=>{
      const source=this.getFrameById(replacement.frameId);
      if(!continuations(source).some(step=>step.uid===uid)&&!source.objects.some(object=>object.unique_id===uid&&usesPresence(object)))return replacement;
      const frame=clone(source);for(const object of frame.objects)if(object.unique_id===uid&&usesPresence(object)){object._stykMovieclip=validatePlayback({...object._stykMovieclip,...patch});result=object._stykMovieclip;if(typeId!==undefined)object.figure_type_id=typeId;}
      for(const step of continuations(frame))if(step.uid===uid){step.playback=validatePlayback({...step.playback,...patch});if(typeId!==undefined)step.typeId=typeId;}
      return {...replacement,frameId:plan.capture(frame,id).frameId};
    });
    if(plan.sources.length)publish(this,plan,'Set movieclip playback');
    return result;
  },
  /** Deletion creates a missing output frame, so the clock pauses for that frame.
   * Sparse replacement boundaries preserve the surrounding poses and curves. */
  sheetDeleteFigures(selected){
    const ids=[...new Set([...selected].map(uid=>this.layerForUid(uid)))],plan=planner(this,ids),tick=this.tick;
    for(const uid of selected)replaceAt(this,plan,this.layerForUid(uid),tick,uid,createFrame());
    const selection=this._selectionState();this._selectIds([]);
    return publish(this,plan,'Delete figures',{selection});
  },
  _commitSheetRange(plans,payload,label,selection,operation={}){
    const owner=uid=>insertionOwner(this,uid,payload?.hints);
    const ids=[...new Set(plans.flatMap(p=>p.changedUids.map(owner)))],plan=planner(this,ids);
    for(const uid of payload?.order??[])plan.layers.assignments[uid]=owner(uid);
    for(const entry of plans){
      if(operation.kind==='delete'&&entry.beforeFrame.objects.some(object=>entry.changedUids.includes(object.unique_id)&&object._stykMovieclip)){
        for(const uid of operation.uids)if(entry.beforeFrame.objects.some(object=>object.unique_id===uid))replaceAt(this,plan,owner(uid),entry.tick,uid,createFrame());
        continue;
      }
      for(const id of new Set(entry.changedUids.map(owner))){const track=plan.get(id),{key,next}=sheetKeyAt(track,entry.tick),inside=entry.tick<track.end;
        if(inside&&payload?.objects?.length&&payload.objects.every(object=>object._stykMovieclip&&!object.join)){
          // Clip-only insertion changes the chosen exposure's membership and
          // poses without resampling the surrounding figures' motion curves.
          for(const object of payload.objects)if(owner(object.unique_id)===id)replaceAt(this,plan,id,entry.tick,object.unique_id,
            createFrame([object]),{replacementUid:object.unique_id},next?.tick??plan.get(id).end);
          continue;
        }
        const clipPaste=operation.kind==='paste'&&payload?.objects.some(object=>object._stykMovieclip&&owner(object.unique_id)===id);
        if(key?.patchOnly){const end=sheetKeyAt(plan.get(id),entry.tick).next?.tick;if(end!==undefined)plan.write(id,end,at(this.report,end),{easing:sheetKeyAt(plan.get(id),end).key});}
        plan.write(id,!this.autoKey&&!clipPaste&&inside&&key&&['constant','hold'].includes(key.interpolation)?key.tick:entry.tick,entry.frame,{easing:key??{interpolation:'constant'}});
      }
    }
    const assets=payload?.definitions.length?{figure_types:{index:this.report.figure_types.length,added:payload.definitions.map(snapshotFigureDefinition)}}:undefined;
    // Insertion leaves existing definitions and poses untouched. The retained
    // cache still compares each UID/pose/join before reusing its geometry.
    return publish(this,plan,label,{selection,assets,selectUids:payload?.order,nextUid:payload?.nextUid,retainGeometry:Boolean(payload?.objects)});
  },
  sheetMoveSelection(dx,dy,ticks,{movePins=false}={}){
    const plans=[];
    for(const tick of ticks){const before=at(this.report,tick),frame=clone(before),resolved=this.resolveTranslationSelection(this.selectedUids,{frame:before}),roots=new Set(resolved.rootUids),affected=new Set(resolved.affectedUids),changed=[];
      for(const object of frame.objects){let moved=false;
        if(roots.has(object.unique_id)){object.root_x+=dx;object.root_y+=dy;moved=true;}
        if(movePins&&affected.has(object.unique_id))moved=translateIKTargets(object,dx,dy,{pinnedOnly:true})||moved;
        if(moved){delete object.runtime_segments;changed.push(object.unique_id);}}
      this._synchronizeAnimationOrigins(frame,before.objects);if(changed.length)plans.push({tick,frame,changedUids:changed});}
    if(!plans.length)return 0;this._commitSheetRange(plans,null,'Move figures across frames',this._selectionState());return plans.length;
  },
  sheetSpan(id=this.activeLayerId,tick=this.tick){const track=this.report._styk.layerSheet.tracks[id],{key,next}=sheetKeyAt(track,tick);return {start:key?.tick??tick,end:next?.tick??Math.max(tick+1,track?.end??0)};},
  sheetEditTimes(indices=[this.frameIndex]){
    const times=indices.sheetTicks??this._frameIndices(indices).map(index=>indices.length===1&&index===this.frameIndex?this.tick:this.timeline[index].start);
    return [...new Set(times.map(checkedTick))].sort((a,b)=>a-b);
  },
  sheetSetDuration(value,id=this.activeLayerId,tick=this.tick){
    if(!Number.isInteger(value)||value<1||value>65535)throw messageError(new Error(''), "errors.editorLayerSheet.exposureMustBe165535Frames", {});
    const {start,end}=this.sheetSpan(id,tick),delta=value-(end-start);if(!delta)return false;
    return delta>0?this.sheetInsertFrames([id],end,delta):this.sheetRemoveFrames([id],start+value,end-1);
  },
  sheetAppendFrame({duration=1}={}){
    if(!Number.isInteger(duration)||duration<1||duration>65535)throw messageError(new Error(''), "errors.editorLayerSheet.exposureMustBe165535Frames", {});
    const ids=['scene','camera',...this.report._styk.layers.order],plan=planner(this,ids),tick=this.totalTicks,sourceTick=Math.min(this.tick,tick-1),frame=shiftClipTime(clone(at(this.report,sourceTick)),tick-sourceTick);
    for(const object of frame.objects)if(object._stykMovieclip&&!usesPresence(object))object._stykMovieclip.end=tick+duration;
    for(const id of ids){plan.write(id,tick,frame);plan.get(id).end=tick+duration;}plan.state.duration=tick+duration;
    publish(this,plan,'Add scene frame');this.seek(tick);return this.evaluatedFrame;
  },
  _prepareSheetMovieclips(){
    const affected=new Set([...this.selectedUids].map(uid=>this.layerForUid(uid)));
    const ids=this.report._styk.layers.order.filter(id=>affected.has(id)&&!this.getLayer(id).locked&&this.report._styk.layerSheet.tracks[id]?.keys.some(key=>key.sourceTick!==undefined));
    if(!ids.length)return;
    const plan=planner(this,ids);
    for(const id of ids)for(const key of plan.get(id).keys)plan.materialize(id,key);publish(this,plan,'Prepare movieclip poses');
  },
  sheetApplyChannels(channels,label,{preserveDuration=false,continuation=null,replacePresence=null}={}){
    const ids=[...new Set(channels.map(c=>fixed(c.target.kind)?c.target.kind:c.target.kind==='layer'?c.target.id:this.layerForUid(c.target.uid)))];
    const plan=planner(this,ids),ticks=new Set();
    for(const id of ids)for(const key of this.layerFrameKeys(id))ticks.add(key.tick);
    for(const channel of channels){for(const key of channel.keys)if(!key.hidden&&key.tick>=0)ticks.add(key.tick);for(const [start,end] of channel.maskedRanges??[]){ticks.add(start);ticks.add(end);}if(channel.clipEnd!==undefined)ticks.add(channel.clipEnd);}
    const source={...this.report,_styk:{...this.report._styk,animation:{version:1,channels}}};
    for(const tick of [...ticks].sort((a,b)=>a-b)){
      if(preserveDuration&&tick>=plan.before.duration)continue;
      let frame=at(this.report,tick);
      const replaced=replacePresence&&tick>=replacePresence.start&&tick<replacePresence.end?frame.objects.filter(object=>replacePresence.uids.has(object.unique_id)&&usesPresence(object)).map(object=>({uid:object.unique_id,typeId:object.figure_type_id,playback:clone(object._stykMovieclip)})):[];
      frame=composePoseChannels(source,frame,tick,{sampleNative:evaluatedNativeFrame,resolveGeometry:buildGeometry});frame=composeAnimationChannels(source,frame,tick,{resolveGeometry:buildGeometry});
      if(replaced.length)frame=setContinuations({...frame},[...continuations(frame).filter(step=>!replaced.some(value=>value.uid===step.uid)),...replaced]);
      if(continuation&&tick>=continuation.start&&tick<continuation.end)frame=setContinuations({...frame},[...continuations(frame).filter(step=>step.uid!==continuation.step.uid),continuation.step]);
      for(const id of ids){const current=sheetKeyAt(this.report._styk.layerSheet.tracks[id],tick).key;plan.write(id,tick,frame,{easing:current??{interpolation:'constant'}});}
    }
    return publish(this,plan,label);
  },
  sheetAssignFigures(uids,id){
    if(this._drag)this.commitDrag();if(this._animationEdit)this.commitAnimationEdit();
    const steps=planSheetAssignmentSteps(this,uids,id);
    for(;;){const step=steps.next();if(step.done)return commitSheetAssignment(this,step.value);}
  },
  sheetDeleteLayer(id){
    if(this._drag)this.commitDrag();if(this._animationEdit)this.commitAnimationEdit();
    const steps=planSheetDeletionSteps(this,id);
    for(;;){const step=steps.next();if(step.done)return commitSheetDeletion(this,step.value);}
  },
  selectSheetLayer(id,{contents=true}={}){
    if(!this.getLayer(id)||this.isLayerFocusLocked(id))return false;this.setActiveLayer(id);this._sheetSelection={id,contents};
    if(contents)this._followSheetSelection();this._emit('selection',{sheetSelection:true});return true;
  },
  /** Keep the current figure selection across seeks (Simple frame navigation). */
  keepSelectionOnSeek(){if(this._sheetSelection?.contents)this._sheetSelection={...this._sheetSelection,contents:false};},
  _followSheetSelection(){
    const selection=this._sheetSelection;if(!selection?.contents||!this.report._styk.layerSheet)return;
    if(this.isLayerFocusLocked(selection.id)){this._sheetSelection=null;return;}
    const objects=this.evaluatedFrame.objects.filter(o=>this.layerForUid(o.unique_id)===selection.id);
    if(objects.length!==this.selectedUids.size||objects.some(o=>!this.selectedUids.has(o.unique_id)))this.selectedUids=new Set(objects.map(o=>o.unique_id));
    this._selectedUid=objects.find(o=>!o.join)?.unique_id??objects[0]?.unique_id??null;this.selectedJoint=-1;this._branchSelection=null;
  },
  layerFrameKeys(id=this.activeLayerId){return this.report._styk.layerSheet?.tracks[id]?.keys??[];},
  sheetInsertKey(ids=[this.activeLayerId],tick=this.tick,{blank=false}={}){
    if(ids.some(id=>isDrawingLayer(this.getLayer(id))))return this.drawingKey(ids,tick,{blank});
    checkedTick(tick);const plan=planner(this,ids);
    for(const id of ids){const track=plan.get(id),previous=sheetKeyAt(track,tick).key;
      const sourceTick=!blank&&tick>=track.end?Math.max(0,track.end-1):tick;
      const frame=shiftClipTime(clone(at(this.report,sourceTick)),tick-sourceTick);
      plan.write(id,tick,frame,{blank,easing:previous??{interpolation:'constant'},extend:true});}
    return publish(this,plan,blank?'Insert blank keyframe':'Insert keyframe');
  },
  /** Insert a new pose after the current cell, shifting later keys atomically. */
  sheetDuplicateFrameAfter(ids=[this.activeLayerId],tick=this.tick){
    if(ids.some(id=>isDrawingLayer(this.getLayer(id))))return this.nextDrawing(ids,{blank:false});
    checkedTick(tick);const start=checkedTick(tick+1),plan=planner(this,ids);
    for(const id of ids){const track=plan.get(id),sourceTick=Math.min(tick,Math.max(0,track.end-1));
      const frame=shiftClipTime(clone(at(this.report,sourceTick)),start-sourceTick),previous=sheetKeyAt(track,sourceTick).key;
      for(const key of track.keys)if(key.tick>=start)plan.ownKey(id,key).tick++;
      track.end=Math.max(start,track.end)+1;
      retimeClips(this,plan,id,time=>time>=start?time+1:time);
      plan.write(id,start,frame,{easing:previous??{interpolation:'constant'},extend:true});
      plan.state.duration=Math.max(plan.state.duration,track.end);
    }
    const selection=this._selectionState();
    publish(this,plan,'Duplicate frame after current',{selection});this.seek(start);
    const command=this._undo.at(-1);if(command?.kind==='layer-sheet')command.afterSelection=this._selectionState();
    return true;
  },
  sheetSetEasing(ids,start,end,easing){
    if(ids.some(id=>isDrawingLayer(this.getLayer(id)))&&!['constant','hold'].includes(easing.interpolation))throw messageError(new Error(''), "errors.editorLayerSheet.drawingExposuresHoldTheirPixelsAndPoseUse", {});
    const plan=planner(this,ids),fields=keyEasing(easing);
    for(const id of ids){const track=plan.get(id),first=sheetKeyAt(track,start).key;
      for(const key of track.keys)if(key===first||key.tick>=start&&key.tick<=end){const owned=plan.ownKey(id,key);delete owned.bezier;Object.assign(owned,fields);}}
    return publish(this,plan,'Set frame interpolation');
  },
  sheetClearKeys(ids,start,end=start){
    const plan=planner(this,ids);for(const id of ids){const track=plan.get(id);track.keys=track.keys.filter(k=>k.tick<start||k.tick>end);}
    return publish(this,plan,'Clear keyframes');
  },
  sheetClearFrames(ids,start,end=start){
    const plan=planner(this,ids),after=at(this.report,end+1);
    for(const id of ids){const track=plan.get(id),finish=track.end;track.keys=track.keys.filter(k=>k.tick<start||k.tick>end);
      plan.write(id,start,at(this.report,start),{blank:true});if(end+1<finish&&(!track.keys.some(k=>k.tick===end+1)||track.keys.find(k=>k.tick===end+1)?.patchOnly))plan.write(id,end+1,after);}
    return publish(this,plan,'Clear frames');
  },
  sheetInsertFrames(ids,start,count=1){
    if(this.audioRipple&&!this._audioRippling&&['scene','camera',...this.report._styk.layers.order].every(id=>ids.includes(id)))
      return this.movieclipBatch('Insert scene frames with audio',()=>{this._audioRippling=true;try{this.rippleAudio(start,0,count);return this.sheetInsertFrames(ids,start,count);}finally{this._audioRippling=false;}});
    checkedTick(start);if(!Number.isInteger(count)||count<1||start+count>=MAX_SHEET_TICKS)throw messageError(new Error(''), "errors.editorLayerSheet.chooseAValidFrameCount", {});
    const plan=planner(this,ids),frame=at(this.report,Math.max(0,start-1));
    for(const id of ids){const track=plan.get(id),had=track.keys.some(k=>k.tick===start);
      for(const key of track.keys)if(key.tick>=start)plan.ownKey(id,key).tick+=count;
      track.end=Math.max(start,track.end)+count;
      retimeClips(this,plan,id,tick=>tick>=start?tick+count:tick);
      if(had&&start===0){
        // The new opening exposure starts now; only the original keys move.
        const opening=clone(frame);
        for(const object of opening.objects)if(object._stykMovieclip&&!usesPresence(object)){const p=object._stykMovieclip;
          if(p.start>0)p.start+=count;if(p.end!==null&&p.end!==undefined)p.end+=count;
          if(p.restarts)p.restarts=p.restarts.map(k=>k.tick>0?{...k,tick:k.tick+count}:k);}
        plan.write(id,start,opening);
      }
      plan.state.duration=Math.max(plan.state.duration,track.end);}
    return publish(this,plan,'Insert frames');
  },
  sheetRemoveFrames(ids,start,end=start){
    if(this.audioRipple&&!this._audioRippling&&['scene','camera',...this.report._styk.layers.order].every(id=>ids.includes(id)))
      return this.movieclipBatch('Remove scene frames with audio',()=>{this._audioRippling=true;try{this.rippleAudio(start,end-start+1,0);return this.sheetRemoveFrames(ids,start,end);}finally{this._audioRippling=false;}});
    const count=end-start+1;if(count<1)throw messageError(new Error(''), "errors.editorLayerSheet.selectFramesToRemove", {});
    const plan=planner(this,ids),frame=at(this.report,end+1);
    for(const id of ids){const track=plan.get(id),restore=track.keys.some(k=>k.tick>=start&&k.tick<=end);
      track.keys=track.keys.filter(k=>k.tick<start||k.tick>end);for(const key of track.keys)if(key.tick>end)plan.ownKey(id,key).tick-=count;
      track.end=Math.max(0,track.end-Math.max(0,Math.min(count,track.end-start)));if(restore&&start<track.end&&!track.keys.some(k=>k.tick===start))plan.write(id,start,frame);
      retimeClips(this,plan,id,tick=>tick>=start?Math.max(start,tick-count):tick);}
    plan.state.duration=Math.max(1,...Object.values(plan.state.tracks).map(track=>track.end));
    return publish(this,plan,'Remove frames');
  },
  sheetCopyFrames(ids,start,end=start){
    if(new Set(ids).size!==ids.length)throw messageError(new Error(''), "errors.editorLayerSheet.selectDistinctSourceLayers", {});
    assertLayers(this,ids);const rows=[];
    for(const id of ids){const track=this.report._styk.layerSheet.tracks[id],ticks=[start,...(track?.keys??[]).filter(k=>k.tick>start&&k.tick<=end).map(k=>k.tick),...(!fixed(id)&&track.end>start&&track.end<=end?[track.end]:[])];
      rows.push({id,drawing:isDrawingLayer(this.getLayer(id)),keys:ticks.map(tick=>{const frame=at(this.report,tick);return {offset:tick-start,frame:ownedFrame(this.report,frame,fixed(id)?[]:[...frame.objects.filter(o=>this.layerForUid(o.unique_id)===id).map(o=>o.unique_id),...continuations(frame).filter(step=>this.layerForUid(step.uid)===id).map(step=>step.uid)]),easing:keyEasing(sheetKeyAt(track,tick).key??{interpolation:'constant'})};})});}
    const types=new Set(rows.flatMap(row=>row.keys.flatMap(key=>[...key.frame.objects.map(o=>o.figure_type_id),...continuations(key.frame).map(step=>step.typeId)]))),phases={};
    for(const row of rows)for(const key of row.keys){
      const members=[...key.frame.objects.filter(usesPresence).map(o=>({uid:o.unique_id,typeId:o.figure_type_id,playback:o._stykMovieclip})),...continuations(key.frame)];
      for(const member of members)if(!Object.hasOwn(phases,member.uid)){
        const asset=this.report.figure_types.find(f=>f.figure_type_id===member.typeId)?._styk?.movieclip;
        const raw=(member.playback.offset??0)+presenceElapsed(movieclipPresenceIndex(this.report),member.uid,start+key.offset)*(asset?.document.fps??this.report.fps)/this.report.fps;
        phases[member.uid]=member.playback.mode==='single'?member.playback.offset??0:member.playback.mode==='loop'?raw%asset.duration:Math.min(raw,asset.duration-(member.playback.mode==='once'?0:1));
      }
    }
    this._sheetClipboard={version:1,start,duration:end-start+1,rows,phases,document:this._documentToken,figures:clone(this.report.figure_types.filter(f=>types.has(f.figure_type_id))),backgrounds:clone(this.report.backgrounds??[])};if(this._sheetClipboard.figures.some(drawingMetadata))this.drawingResources.captureClipboard(this._sheetClipboard);return this._sheetClipboard;
  },
  sheetPasteFrames(ids,tick,{insert=false}={}){
    const clipboard=this._sheetClipboard;if(!clipboard)throw messageError(new Error(''), "errors.editorLayerSheet.copyTimelineFramesFirst", {});
    checkedTick(tick);
    if(new Set(ids).size!==ids.length)throw messageError(new Error(''), "errors.editorLayerSheet.selectDistinctDestinationLayers", {});
    const foreign=clipboard.document!==this._documentToken;
    if(ids.length!==1&&ids.length!==clipboard.rows.length)throw messageError(new Error(''), "errors.editorLayerSheet.selectOneDestinationLayerOrTheSameNumber", {});
    const ordered=this.getLayers().filter(l=>l.kind==='layer').map(l=>l.id).reverse(),offset=ordered.indexOf(ids[0]);
    const destinations=ids.length===clipboard.rows.length?ids:ordered.slice(offset,offset+clipboard.rows.length);
    if(destinations.length!==clipboard.rows.length)throw messageError(new Error(''), "errors.editorLayerSheet.createEnoughDestinationLayersForThisRange", {});
    if(clipboard.rows.some((row,i)=>Boolean(row.drawing)!==isDrawingLayer(this.getLayer(destinations[i]))))throw messageError(new Error(''), "errors.editorLayerSheet.pasteDrawingKeysIntoDrawingLayersAndFigure", {});
    if(clipboard.rows.some((row,index)=>(fixed(row.id)||fixed(destinations[index]))&&row.id!==destinations[index]))
      throw messageError(new Error(''), "errors.editorLayerSheet.pasteFramesIntoTheSameTrackKindFigures", {});
    const plan=planner(this,destinations),finish=tick+clipboard.duration,uidMap=new Map();
    if(finish>MAX_SHEET_TICKS)throw messageError(new Error(''), "errors.editorLayerSheet.pastedFramesExceedTheTimelineLimit", {});
    const typeMap=new Map(),backgroundMap=new Map([[0,0]]),assets={},drawingForks=[];
    let nextUid=this._nextUid;
    // Allocate the entire range once, including identities represented only by
    // a broken frame. Remap before writing so joins and continuation references
    // also work when their owner first appears later in the copied range.
    for(let i=0;i<destinations.length;i++){
      for(const entry of clipboard.rows[i].keys)for(const uid of [...entry.frame.objects.map(o=>o.unique_id),...continuations(entry.frame).map(step=>step.uid),...entry.frame.objects.flatMap(o=>o._stykMovieclipPart?[o._stykMovieclipPart.instance]:[])]){
        if(!foreign&&clipboard.rows[i].id===destinations[i]&&this.layerForUid(uid)===destinations[i])continue;
        if(!uidMap.has(uid)){if(nextUid>0x7ffffffe)throw messageError(new Error(''), "errors.editorLayerSheet.objectIdentityCapacityReached", {});uidMap.set(uid,nextUid++);}
      }
    }
    if(foreign||clipboard.figures.some(drawingMetadata)){
      const figures=this.report.figure_types.slice(),backgrounds=(this.report.backgrounds??[]).slice();let type=Math.max(0,...figures.map(f=>f.figure_type_id))+1,bg=Math.max(0,...backgrounds.map(b=>b.background_id))+1;
      for(const figure of clipboard.figures??[]){if(!foreign&&!drawingMetadata(figure))continue;typeMap.set(figure.figure_type_id,type);const copy=drawingMetadata(figure)?copyDrawingFigure(figure,type++):{...clone(figure),figure_type_id:type++};figures.push(copy);if(drawingMetadata(figure)&&!foreign)drawingForks.push([figure,copy]);}
      if(foreign&&clipboard.rows.some(row=>row.id==='scene'))for(const background of clipboard.backgrounds??[]){backgroundMap.set(background.background_id,bg);backgrounds.push({...clone(background),background_id:bg++});}
      assets.figure_types={added:figures.slice(this.report.figure_types.length)};if(backgrounds.length>(this.report.backgrounds?.length??0))assets.backgrounds={added:backgrounds.slice(this.report.backgrounds?.length??0)};
      plan.definitions=figures;
    }
    for(let i=0;i<destinations.length;i++){
      const id=destinations[i],row=clipboard.rows[i],track=plan.get(id),restore=at(this.report,finish),oldEnd=track.end;
      if(insert){for(const key of track.keys)if(key.tick>=tick)plan.ownKey(id,key).tick+=clipboard.duration;}
      else track.keys=track.keys.filter(k=>k.tick<tick||k.tick>=finish);
      if(!fixed(id)&&tick>oldEnd&&track.keys.length)plan.write(id,oldEnd,createFrame(),{blank:true});
      // Reserve the complete range before writing its sparse keys. Its interior
      // is one copied exposure sequence, not separate insertions beyond an end.
      track.end=Math.max(finish,oldEnd+(insert?clipboard.duration:0));
      for(const entry of row.keys){const frame=shiftClipTime(clone(entry.frame),tick-clipboard.start);
        for(const object of frame.objects)if(typeMap.has(object.figure_type_id)){remapVfxOwner(object,typeMap.get(object.figure_type_id));object.figure_type_id=typeMap.get(object.figure_type_id);}
        if(foreign)for(const field of ['background_id','background_id_b'])frame[field]=backgroundMap.get(frame[field])??0;
        if(uidMap.size||foreign){
          for(const object of frame.objects){const old=object.unique_id;object.unique_id=uidMap.get(old)??old;if(uidMap.has(old))plan.layers.assignments[object.unique_id]=id;
            if(uidMap.has(old)&&usesPresence(object)&&clipboard.phases?.[old]!==undefined)object._stykMovieclip.offset=clipboard.phases[old];
            if(object._stykMovieclipPart)object._stykMovieclipPart.instance=uidMap.get(object._stykMovieclipPart.instance)??object._stykMovieclipPart.instance;}
          for(const step of continuations(frame)){const old=step.uid;step.uid=uidMap.get(old)??old;if(uidMap.has(old))plan.layers.assignments[step.uid]=id;if(foreign)step.typeId=typeMap.get(step.typeId);if(uidMap.has(old)&&clipboard.phases?.[old]!==undefined)step.playback.offset=clipboard.phases[old];}
          for(const object of frame.objects){if(object.join)object.join.target_unique_id=uidMap.get(object.join.target_unique_id)??object.join.target_unique_id;remapIKFollowers(object,uidMap);}
          frame.object_draw_order_unique_ids=frame.object_draw_order.map(slot=>frame.objects[slot].unique_id);
        }
        plan.write(id,tick+entry.offset,frame,{easing:entry.easing});
      }
      if(!insert&&finish<oldEnd&&(!track.keys.some(k=>k.tick===finish)||track.keys.find(k=>k.tick===finish)?.patchOnly))plan.write(id,finish,restore);
      track.end=Math.max(finish,oldEnd+(insert?clipboard.duration:0));plan.state.duration=Math.max(plan.state.duration,track.end);
    }
    if(drawingForks.length)this.drawingResources.checkClipboard(drawingForks,clipboard);
    const result=publish(this,plan,'Paste frames',{assets:Object.keys(assets).length?assets:undefined});this._nextUid=nextUid;if(drawingForks.length)this.drawingResources.pasteClipboard(drawingForks,clipboard);return result;
  },
  sheetMoveFrames(ids,start,end,delta,{copy=false,replace=true}={}){
    if(!Number.isInteger(delta)||start+delta<0)throw messageError(new Error(''), "errors.editorLayerSheet.framesCannotMoveBeforeFrame1", {});if(!delta)return false;
    const plan=planner(this,ids),finish=end+delta,added=[],forks=[];let drawingType=this.report.figure_types.reduce((n,f)=>Math.max(n,f.figure_type_id+1),1);
    for(const id of ids){const track=plan.get(id);let selected=track.keys.filter(k=>k.tick>=start&&k.tick<=end);
      if(!selected.length){const key=plan.write(id,start,at(this.report,start));selected.push(key);}
      const selectedIds=new Set(selected.map(k=>k.id));
      if(!replace&&track.keys.some(key=>(copy||!selectedIds.has(key.id))&&key.tick>=start+delta&&key.tick<=finish))
        throw messageError(new Error(''), "errors.editorLayerSheet.theDestinationContainsKeyframesEnableReplaceKeyframesOn", {});
      selected=selected.map(key=>plan.materialize(id,key));
      // Snapshot the selection before removing collisions, including overlapping
      // copies. Only exact landing ticks replace keys; intervening keys survive.
      const landingTicks=new Set(selected.map(key=>key.tick+delta));
      track.keys=track.keys.filter(key=>!landingTicks.has(key.tick)&&(copy||!selectedIds.has(key.id)));
      for(const key of selected){const moved={...key,tick:key.tick+delta,...(copy?{id:`cell-${plan.state.nextId++}`}:{})};
        const source=key.value?.frameId&&(plan.sources.find(s=>s.id===key.value.frameId)?.after.value??this.getFrameById(key.value.frameId));
        if(copy&&source&&isDrawingLayer(this.getLayer(id))){const frame=clone(source);for(const object of frame.objects){const original=this.report.figure_types.find(f=>f.figure_type_id===object.figure_type_id),figure=copyDrawingFigure(original,drawingType++);added.push(figure);forks.push([original,figure]);object.figure_type_id=figure.figure_type_id;}moved.value=plan.capture(frame,id);}
        if(source?.objects.some(o=>o._stykMovieclip))moved.value=plan.capture(shiftClipTime(clone(source),delta),id);
        track.keys.push(moved);}
      track.keys.sort((a,b)=>a.tick-b.tick);track.end=Math.max(track.end,finish+1);plan.state.duration=Math.max(plan.state.duration,track.end);
    }
    if(forks.length)this.drawingResources.checkForks(forks.map(([old])=>old));
    const result=publish(this,plan,copy?'Copy frames':'Move frames',{assets:added.length?{figure_types:{added}}:undefined});for(const [old,figure] of forks)this.drawingResources.fork(old,figure);return result;
  },
  sheetTransferFrames(ids,destinations,start,end,tick,{copy=false}={}){
    assertLayers(this,[...ids,...destinations]);const clipboard=this._sheetClipboard;
    this.sheetCopyFrames(ids,start,end);
    try{return this.movieclipBatch(copy?'Copy frames to layer':'Move frames to layer',()=>{
      if(!copy){
        this.sheetClearFrames(ids,start,end);
        // The same animation is still represented on the destination layer.
        // Retain consumed steps on the source so a later source appearance does
        // not jump backward merely because its intervening frames were moved.
        const plan=planner(this,ids);let changed=false;
        for(const row of this._sheetClipboard.rows)for(const entry of row.keys){
          const steps=[...continuations(entry.frame),...entry.frame.objects.filter(usesPresence).map(object=>({uid:object.unique_id,typeId:object.figure_type_id,playback:object._stykMovieclip}))];
          if(!steps.length)continue;
          const frame=setContinuations({...entry.frame,objects:[],object_draw_order:[],object_draw_order_unique_ids:[]},[...new Map(steps.map(step=>[step.uid,clone(step)])).values()]);
          plan.write(row.id,start+entry.offset,frame);changed=true;
        }
        if(changed)publish(this,plan,'Retain moved movieclip phase');
      }
      return this.sheetPasteFrames(destinations,tick);
    });}finally{this._sheetClipboard=clipboard;}
  },
  _commitSheetPose(edit,drag){
    // Auto key behaves like pressing A during the gesture: every edited track keys the playhead.
    const atPlayhead=Boolean(edit.keyAtPlayhead||this.autoKey);
    const before=edit.source,after=edit.frame,ids=new Set(edit.keyAtPlayheadLayers??[]),old=new Map(before.objects.map(o=>[o.unique_id,o])),current=new Map(after.objects.map(o=>[o.unique_id,o]));
    const owner=uid=>insertionOwner(this,uid,this._newLayerHints);
    const candidates=edit.transaction?[...new Set([...old.keys(),...current.keys()])]:drag.before.map(object=>object.unique_id);
    const changedUids=candidates.filter(uid=>{
      const a=old.get(uid),b=current.get(uid);
      return a!==b&&(!a||!b||poseObjectSignature(a,before)!==poseObjectSignature(b,after));
    });
    for(const uid of changedUids)ids.add(owner(uid));
    const beforeOrder=frameOrder(before),afterOrder=frameOrder(after);
    if(beforeOrder.length!==afterOrder.length||beforeOrder.some((uid,index)=>uid!==afterOrder[index])){
      const group=order=>{const groups=new Map();for(const uid of order){const id=owner(uid);let members=groups.get(id);if(!members)groups.set(id,members=[]);members.push(uid);}return groups;};
      const previous=group(beforeOrder),next=group(afterOrder);
      for(const id of new Set([...previous.keys(),...next.keys()])){const a=previous.get(id)??[],b=next.get(id)??[];
        if(a.length!==b.length||a.some((uid,index)=>uid!==b[index]))ids.add(id);}
    }
    if(JSON.stringify(before.camera)!==JSON.stringify(after.camera))ids.add('camera');
    if(['background_id','background_id_b','background_mix','background_color','_stykBackgroundColor','_stykVfx'].some(k=>JSON.stringify(before[k])!==JSON.stringify(after[k])))ids.add('scene');
    if(!ids.size){this._drag=null;this._authoredPoseEdit=null;this._invalidate();return false;}
    const plan=planner(this,[...ids]);
    // Resolve insertion ownership before any layer captures the complete scene.
    // Capture order, normalized slots and unrelated edits must not choose it.
    for(const object of after.objects)if(!this._layerUidCounts.has(object.unique_id))plan.layers.assignments[object.unique_id]=owner(object.unique_id);
    for(const id of ids){const track=plan.get(id);let {key}=sheetKeyAt(track,edit.tick);const hold=key&&edit.tick<track.end&&['constant','hold'].includes(key.interpolation);
      const patchUids=new Set((key?.movieclipPatches??[]).flatMap(patch=>this.getFrameById(patch.frameId).objects.map(object=>object.unique_id)));
      const changed=changedUids.filter(uid=>owner(uid)===id);
      if(!atPlayhead&&key?.movieclipPatches&&changed.length&&changed.every(uid=>patchUids.has(uid))){
        key=plan.ownKey(id,key);
        key.empty=!after.objects.some(object=>owner(object.unique_id)===id);
        key.movieclipPatches=key.movieclipPatches.map(patch=>{
          const source=this.getFrameById(patch.frameId),members=new Set(source.objects.map(object=>object.unique_id));
          if(!changed.some(uid=>members.has(uid)))return patch;
          const frame=ownedFrame(this.report,after,[...members]);setContinuations(frame,continuations(source));
          return {...patch,frameId:plan.capture(frame,id).frameId};
        });
        continue;
      }
      if(key?.patchOnly){const end=sheetKeyAt(plan.get(id),edit.tick).next?.tick;if(end!==undefined)plan.write(id,end,at(this.report,end),{easing:sheetKeyAt(plan.get(id),end).key});}
      const membershipChanged=[...before.objects,...after.objects].some(object=>usesPresence(object)&&owner(object.unique_id)===id&&old.has(object.unique_id)!==current.has(object.unique_id));
      plan.write(id,hold&&!membershipChanged&&!atPlayhead?key.tick:edit.tick,after,{easing:key??{interpolation:'constant'}});}
    // Keep the exact gesture preview through publication. Membership and clock
    // edits must be sampled again; ordinary transforms already have their final
    // pose and incremental geometry, including attached descendants.
    const retainPreview=!edit.transaction&&changedUids.every(uid=>old.has(uid)&&current.has(uid)&&
      JSON.stringify(old.get(uid)._stykMovieclip)===JSON.stringify(current.get(uid)._stykMovieclip));
    const preview=retainPreview?{frame:after,geometry:this._geometry,incremental:this._incremental}:null;
    this._drag=null;this._authoredPoseEdit=null;
    const assets={};
    for(const [field,previous] of [['figure_types',edit.beforeFigures],['backgrounds',edit.beforeBackgrounds]])if(previous&&JSON.stringify(previous)!==JSON.stringify(this.report[field]))assets[field]={before:previous,after:this.report[field].slice()};
    this._authoredCommitPreview=preview;
    try{return publish(this,plan,drag.label,{selection:drag.beforeSelection,assets:Object.keys(assets).length?assets:undefined,retainGeometry:retainPreview});}
    finally{this._authoredCommitPreview=null;}
  },
  /** Explicit property/pose authoring. An edit inside a tween writes a boundary
   * at the entry's tick; editing a held cell edits its preceding key. Canvas
   * pose edits keep the same held-cell rule in the draft path. */
  _sheetBakeCameraFrames(frames){
    const plan=planner(this,['camera']);
    for(const {tick,camera,restore} of frames){const easing=restore?(sheetKeyAt(plan.before.tracks.camera,tick).key??{interpolation:'constant'}):{interpolation:'constant'};
      const key=plan.write('camera',tick,{objects:[],camera,duration_raw:1},{easing});if(easing.interpolation!=='bezier')delete key.bezier;}
    publish(this,plan,'Bake camera motion',{retainGeometry:true});
  },
  _sheetPropertyEntries(entries,label='Edit layer pose'){
    const byTick=new Map();for(const entry of entries){const tick=checkedTick(entry.tick??this.tick),list=byTick.get(tick)??[];list.push(entry);byTick.set(tick,list);}
    const ids=[...new Set(entries.map(e=>fixed(e.target.kind)?e.target.kind:e.target.kind==='layer'?e.target.id:this.layerForUid(e.target.uid)))],plan=planner(this,ids),result=[];
    for(const [tick,list] of byTick){
      const channels=[];
      for(const e of list){
        // A pose entry without a value captures the pose already at the tick.
        if(e.property==='pose'&&e.value===undefined)continue;
        const target=e.exactTarget?normalizeAnimationTarget(e.target):this.resolveAnimationTarget(e.target,e.property,tick);
        channels.push({id:animationChannelId(target,e.property),target,property:e.property,
          keys:[{id:`preview-${channels.length}`,tick,value:e.property==='pose'?e.value:validateAnimationValue(target,e.property,e.value),interpolation:'constant'}]});
      }
      const source=channels.length?{...this.report,_styk:{...this.report._styk,animation:{channels}}}:null;
      const composed=new Map(),frameAt=skipPatches=>{
        if(!composed.has(skipPatches)){let frame=at(this.report,tick,skipPatches?{skipMovieclipPatches:true}:{});
          if(source){frame=composePoseChannels(source,frame,tick,{sampleNative:evaluatedNativeFrame,resolveGeometry:buildGeometry});
            frame=composeAnimationChannels(source,frame,tick,{resolveGeometry:buildGeometry});}
          composed.set(skipPatches,frame);}
        return composed.get(skipPatches);};
      for(const id of ids){const selected=list.filter(e=>(fixed(e.target.kind)?e.target.kind:e.target.kind==='layer'?e.target.id:this.layerForUid(e.target.uid))===id);if(!selected.length)continue;
        const {key:owner}=sheetKeyAt(plan.get(id),tick),
          target=owner?.tick===tick||!this.autoKey&&['constant','hold'].includes(owner?.interpolation)?owner:null,
          patches=target?.movieclipPatches,
          easing=selected.findLast(e=>e.interpolation!==undefined)??target??owner??{interpolation:'constant'};
        const written=plan.write(id,target?target.tick:tick,frameAt(Boolean(patches?.length)||Boolean(target?.patchOnly)),{easing});
        if(patches?.length){written.movieclipPatches=patches;written.empty=target.empty;}
        result.push(written);}
    }
    publish(this,plan,label);return result;
  },
};
