import {nativeTimeline,evaluatedFrame,evaluatedNativeFrame,timeline} from './pivot/geometry.mjs';
import {composePoseChannels} from './animation-pose.mjs';
import {sheetKeyAt,validateLayerSheet,MAX_SHEET_TICKS} from './layer-sheet.mjs';
import {snapshotPoseFrame} from './pose-snapshot.mjs';
import {layerIdForUid} from './layers.mjs';
import {keyEasing} from './keyframe-easing.mjs';
import {animationChannelId,composeAnimationChannels,validateAnimationValue} from './animation-channels.mjs';
import {buildGeometry} from './pivot/geometry.mjs';
import {remapIKFollowers} from './ik.mjs';
import {frameOrder,setOrder,normalizeFrame} from './pivot/structure.mjs';
import {movieclipTypes} from './movieclips.mjs';

const clone=value=>structuredClone(value);
const fixed=id=>id==='scene'||id==='camera';
const checkedTick=tick=>{if(!Number.isInteger(tick)||tick<0||tick>=MAX_SHEET_TICKS)throw new Error('Choose a valid whole frame.');return tick;};
function at(report,tick){const rows=timeline(report);let low=0,high=rows.length-1;while(low<high){const mid=(low+high+1)>>>1;if(rows[mid].start<=tick)low=mid;else high=mid-1;}
  const row=rows[low];return evaluatedFrame(report,low,row?.count?(tick-row.start)/row.count:0,tick,{skipMovieclips:true});}
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
  report._styk.layerSheet=state;delete report._styk.animation;delete report._styk.simpleFrameDraft;return report;
}
function ownedFrame(report,frame,uids){
  const selected=new Set(uids),result=clone(frame),order=frameOrder(frame).filter(uid=>selected.has(uid));let geometry;
  result.objects=result.objects.filter(o=>selected.has(o.unique_id));
  for(const object of result.objects)if(object.join){const parent=frame.objects[object.join.target_object_slot]?.unique_id;
    if(selected.has(parent))object.join.target_unique_id=parent;
    else{geometry??=buildGeometry(report,frame);const root=geometry.objects.get(object.object_slot)?.root;if(root){object.root_x=root.x;object.root_y=root.y;}object.join=null;}}
  setOrder(result,order);normalizeFrame(result);return result;
}
function shiftClipTime(frame,delta){
  for(const object of frame.objects)if(object._stykMovieclip){const p=object._stykMovieclip;
    p.start=Math.max(0,(p.start??0)+delta);if(p.end!==null&&p.end!==undefined)p.end=Math.max(p.start+1,p.end+delta);
    if(p.restarts)p.restarts=p.restarts.map(k=>({...k,tick:Math.max(0,k.tick+delta)}));}
  return frame;
}
function assertLayers(editor,ids){
  if(!ids.length)throw new Error('Select a layer.');
  for(const id of ids){const layer=editor.getLayer(id);if(!layer)throw new Error('The selected layer no longer exists.');if(layer.locked)throw new Error(`Unlock ${layer.name} before editing it.`);}
}
function planner(editor,ids){
  assertLayers(editor,ids);
  const before=editor.report._styk.layerSheet;if(!before)throw new Error('Open the layer timeline first.');
  const state={...before,tracks:{...before.tracks}},sources=[],layers=clone(editor.report._styk.layers),originalIds=new Set(editor._layerUidCounts.keys());
  let nextFrame=editor._nextFrameIdentity;
  const capture=(frame,id)=>{
    const uids=fixed(id)?[]:frame.objects.filter(o=>layerIdForUid({...editor.report,_styk:{...editor.report._styk,layers}},o.unique_id)===id).map(o=>o.unique_id);
    const source=snapshotPoseFrame(frame,uids),frameId=`frame-${nextFrame++}`;source._styk={...source._styk,frameId};
    sources.push({id:frameId,before:{exists:false},after:{exists:true,value:source}});return {frameId};
  };
  const get=id=>{
    if(state.tracks[id]!==before.tracks[id]&&state.tracks[id])return state.tracks[id];
    const previous=before.tracks[id]??{keys:[],end:0},track={...previous,keys:previous.keys.map(key=>({...key}))};state.tracks[id]=track;
    return track;
  };
  const materialize=(id,key)=>{if(key.sourceTick===undefined)return;const old=before.tracks[id]?.keys.find(k=>k.id===key.id);key.value=capture(at(editor.report,old?.tick??key.tick),id);delete key.sourceTick;};
  const write=(id,tick,frame,{blank=false,easing}={})=>{
    checkedTick(tick);const track=get(id),existing=track.keys.find(key=>key.tick===tick),key=existing??{id:`cell-${state.nextId++}`,tick,interpolation:'constant'};
    for(const object of frame?.objects??[])if(!originalIds.has(object.unique_id)&&!Object.hasOwn(layers.assignments,object.unique_id))layers.assignments[object.unique_id]=fixed(id)?layers.defaultLayerId:id;
    const empty=!fixed(id)&&!frame?.objects.some(o=>layerIdForUid({...editor.report,_styk:{...editor.report._styk,layers}},o.unique_id)===id);
    key.value=blank||empty?{frameId:null}:capture(frame,id);key.empty=blank||empty;delete key.sourceTick;if(easing)Object.assign(key,keyEasing(easing));
    if(!existing)track.keys.push(key);track.keys.sort((a,b)=>a.tick-b.tick);track.end=Math.max(track.end,tick+1);state.duration=Math.max(state.duration,track.end);return key;
  };
  return {state,sources,layers,get,write,capture,materialize,before,get nextFrame(){return nextFrame;}};
}
function retimeClips(editor,plan,id,map){
  if(!movieclipTypes(editor.report).size)return;
  const track=plan.get(id);
  for(const key of track.keys){
    const old=plan.before.tracks[id]?.keys.find(k=>k.id===key.id);
    const frame=key.sourceTick!==undefined?at(editor.report,old?.tick??key.tick):key.value?.frameId&&(plan.sources.find(s=>s.id===key.value.frameId)?.after.value??editor.getFrameById(key.value.frameId));
    if(!frame?.objects.some(o=>o._stykMovieclip&&editor.layerForUid(o.unique_id)===id))continue;
    const source=clone(frame);let changed=false;
    for(const object of source.objects)if(object._stykMovieclip&&editor.layerForUid(object.unique_id)===id){const p=object._stykMovieclip,before=JSON.stringify(p);
      p.start=map(p.start??0);if(p.end!==null&&p.end!==undefined)p.end=Math.max(p.start+1,map(p.end));if(p.restarts)p.restarts=p.restarts.map(k=>({...k,tick:map(k.tick)}));changed||=before!==JSON.stringify(p);}
    if(changed){key.value=plan.capture(source,id);delete key.sourceTick;}
  }
}
function publish(editor,plan,label,{selection=editor._selectionState(),assets,selectUids,nextUid,retainGeometry=false}={}){
  const before=editor.report._styk.layerSheet,beforeLayers=editor.report._styk.layers;
  // Freeze only endpoints of edited spans. Unchanged imported spans continue
  // using their exact original easing; one key edit never copies the movie.
  for(const [id,track] of Object.entries(plan.state.tracks))if(track!==before.tracks[id]){
    const previous=before.tracks[id]?.keys??[],byId=new Map(previous.map((k,i)=>[k.id,{key:k,next:previous[i+1]}]));
    track.keys.forEach((key,i)=>{const old=byId.get(key.id),next=track.keys[i+1];
      if(old&&(key.tick!==old.key.tick||key.interpolation!==old.key.interpolation||JSON.stringify(key.bezier)!==JSON.stringify(old.key.bezier)||next?.id!==old.next?.id||next?.tick!==old.next?.tick)){
        plan.materialize(id,key);if(next)plan.materialize(id,next);
      }});
  }
  const report={...editor.report,_styk:{...editor.report._styk,layerSheet:plan.state,layers:plan.layers,
    frameSources:{...editor.report._styk.frameSources,...Object.fromEntries(plan.sources.map(s=>[s.id,s.after.value]))}}};
  validateLayerSheet(report);
  if(assets)for(const [field,change] of Object.entries(assets)){
    if(change.added)editor.report[field]=[...editor.report[field],...clone(change.added)];
    else editor.report[field]=change.after;
  }
  editor.report._styk.layerSheet=plan.state;editor.report._styk.layers=plan.layers;
  for(const source of plan.sources)(editor.report._styk.frameSources??={})[source.id]=source.after.value;
  editor._nextFrameIdentity=plan.nextFrame;editor._invalidate({timing:true,retainGeometry});
  if(nextUid!==undefined)editor._nextUid=nextUid;
  if(selectUids?.length)editor._selectIds(selectUids);
  editor._newLayerHints=new Map(plan.sources.flatMap(source=>source.after.value.objects.map(o=>[o.unique_id,layerIdForUid(editor.report,o.unique_id)])));
  editor._record({kind:'layer-sheet',label,before,after:plan.state,beforeLayers:clone(beforeLayers),afterLayers:clone(plan.layers),
    frameSourceChanges:plan.sources,assets,beforeSelection:selection,afterSelection:editor._selectionState(),structural:true,timing:true,retainGeometry,
    precomputedBytes:JSON.stringify({tracks:Object.keys(plan.state.tracks).filter(id=>before.tracks[id]!==plan.state.tracks[id]).map(id=>[before.tracks[id],plan.state.tracks[id]]),beforeLayers,afterLayers:plan.layers,sources:plan.sources,assets}).length*2});
  editor._layerChanged({reindex:true});editor._emit('edit',{label,structural:true,timing:true,layerSheet:true});return true;
}
export function applyLayerSheetCommand(editor,command,direction){
  if(command.kind!=='layer-sheet')return false;
  editor.report._styk.layerSheet=command[direction];editor.report._styk.layers=clone(command[`${direction}Layers`]);
  if(command.layerChanges?.length)editor._applyLayerChanges(command.layerChanges,direction);
  if(command.assets)for(const [field,change] of Object.entries(command.assets)){
    if(change.added)editor.report[field].splice(change.index,direction==='before'?change.added.length:0,...(direction==='after'?clone(change.added):[]));
    else editor.report[field]=change[direction].slice();
  }
  editor._applyFrameSourceChanges(command,direction);editor._trackLayerCommand(command,direction);editor._layerChanged({reindex:true});editor._invalidate({timing:true,retainGeometry:command.retainGeometry});
  editor._restoreSelection(command[`${direction}Selection`]);editor._revision=command[`${direction}Revision`];
  editor._emit('history',{label:command.label,structural:true,timing:true,layerSheet:true});return true;
}
export const editorLayerSheetMethods={
  _commitSheetRange(plans,payload,label,selection){
    const owner=uid=>payload?.hints.get(uid)??(this._layerUidCounts.has(uid)?this.layerForUid(uid):this.activeLayerId);
    const ids=[...new Set(plans.flatMap(p=>p.changedUids.map(owner)))],plan=planner(this,ids);
    for(const uid of payload?.order??[])plan.layers.assignments[uid]=owner(uid);
    for(const entry of plans)for(const id of new Set(entry.changedUids.map(owner))){const key=sheetKeyAt(plan.get(id),entry.tick).key;
      plan.write(id,key&&['constant','hold'].includes(key.interpolation)?key.tick:entry.tick,entry.frame,{easing:key??{interpolation:'constant'}});}
    const assets=payload?.definitions.length?{figure_types:{index:this.report.figure_types.length,added:clone(payload.definitions)}}:undefined;
    // Insertion leaves existing definitions and poses untouched. The retained
    // cache still compares each UID/pose/join before reusing its geometry.
    return publish(this,plan,label,{selection,assets,selectUids:payload?.order,nextUid:payload?.nextUid,retainGeometry:Boolean(payload?.objects)});
  },
  sheetMoveSelection(dx,dy,ticks){
    const plans=[];
    for(const tick of ticks){const before=at(this.report,tick),frame=clone(before),roots=new Set(this.resolveTranslationSelection(this.selectedUids,{frame:before}).rootUids),changed=[];
      for(const object of frame.objects)if(roots.has(object.unique_id)){object.root_x+=dx;object.root_y+=dy;changed.push(object.unique_id);}
      this._synchronizeAnimationOrigins(frame,before.objects);if(changed.length)plans.push({tick,frame,changedUids:changed});}
    if(!plans.length)return 0;this._commitSheetRange(plans,null,'Move figures across frames',this._selectionState());return plans.length;
  },
  sheetSpan(id=this.activeLayerId,tick=this.tick){const track=this.report._styk.layerSheet.tracks[id],{key,next}=sheetKeyAt(track,tick);return {start:key?.tick??tick,end:next?.tick??Math.max(tick+1,track?.end??0)};},
  sheetEditTimes(indices=[this.frameIndex]){
    const times=indices.sheetTicks??this._frameIndices(indices).map(index=>indices.length===1&&index===this.frameIndex?this.tick:this.timeline[index].start);
    return [...new Set(times.map(checkedTick))].sort((a,b)=>a-b);
  },
  sheetSetDuration(value,id=this.activeLayerId,tick=this.tick){
    if(!Number.isInteger(value)||value<1||value>65535)throw new Error('Exposure must be 1–65,535 frames.');
    const {start,end}=this.sheetSpan(id,tick),delta=value-(end-start);if(!delta)return false;
    return delta>0?this.sheetInsertFrames([id],end,delta):this.sheetRemoveFrames([id],start+value,end-1);
  },
  sheetAppendFrame({duration=1}={}){
    if(!Number.isInteger(duration)||duration<1||duration>65535)throw new Error('Exposure must be 1–65,535 frames.');
    const ids=['scene','camera',...this.report._styk.layers.order],plan=planner(this,ids),tick=this.totalTicks,sourceTick=Math.min(this.tick,tick-1),frame=shiftClipTime(clone(at(this.report,sourceTick)),tick-sourceTick);
    for(const object of frame.objects)if(object._stykMovieclip)object._stykMovieclip.end=tick+duration;
    for(const id of ids){plan.write(id,tick,frame);plan.get(id).end=tick+duration;}plan.state.duration=tick+duration;
    publish(this,plan,'Add scene frame');this.seek(tick);return this.evaluatedFrame;
  },
  _prepareSheetMovieclips(){
    const ids=this.report._styk.layers.order.filter(id=>!this.getLayer(id).locked&&this.report._styk.layerSheet.tracks[id]?.keys.some(key=>key.sourceTick!==undefined));
    if(!ids.length)return;
    const plan=planner(this,ids);
    for(const id of ids)for(const key of plan.get(id).keys)plan.materialize(id,key);publish(this,plan,'Prepare movieclip poses');
  },
  sheetApplyChannels(channels,label){
    const ids=[...new Set(channels.map(c=>fixed(c.target.kind)?c.target.kind:c.target.kind==='layer'?c.target.id:this.layerForUid(c.target.uid)))];
    const plan=planner(this,ids),ticks=new Set();
    for(const id of ids)for(const key of this.layerFrameKeys(id))ticks.add(key.tick);
    for(const channel of channels){for(const key of channel.keys)if(!key.hidden&&key.tick>=0)ticks.add(key.tick);for(const [start,end] of channel.maskedRanges??[]){ticks.add(start);ticks.add(end);}if(channel.clipEnd!==undefined)ticks.add(channel.clipEnd);}
    const source={...this.report,_styk:{...this.report._styk,animation:{version:1,channels}}};
    for(const tick of [...ticks].sort((a,b)=>a-b)){
      let frame=at(this.report,tick);frame=composePoseChannels(source,frame,tick,{sampleNative:evaluatedNativeFrame,resolveGeometry:buildGeometry});frame=composeAnimationChannels(source,frame,tick,{resolveGeometry:buildGeometry});
      for(const id of ids){const current=sheetKeyAt(this.report._styk.layerSheet.tracks[id],tick).key;plan.write(id,tick,frame,{easing:current??{interpolation:'constant'}});}
    }
    return publish(this,plan,label);
  },
  sheetAssignFigures(uids,id){
    if(!this.report._styk.layers.byId[id])throw new Error('Figures belong to user layers.');
    const moved=[...new Set(uids)].filter(uid=>this.layerForUid(uid)!==id);if(!moved.length)return false;
    if(moved.some(uid=>!this._layerUidCounts.has(uid)))throw new Error('Choose figures present in this animation.');
    const ids=[...new Set([id,...moved.map(uid=>this.layerForUid(uid))])],plan=planner(this,ids);
    const tracks=ids.map(id=>this.report._styk.layerSheet.tracks[id]);
    const ticks=[...new Set([0,...tracks.flatMap(track=>track?.keys.map(k=>k.tick)??[])])].sort((a,b)=>a-b);
    for(const uid of moved)plan.layers.assignments[uid]=id;
    const untouched=tracks.every(track=>!track?.keys.length||track.keys.every(k=>k.sourceTick!==undefined));
    for(const destination of ids){
      const original=this.report._styk.layerSheet.tracks[destination],end=Math.max(...tracks.map(t=>t?.end??0));
      const track={end,keys:[]};plan.state.tracks[destination]=track;
      for(const tick of ticks.filter(t=>t<end)){
        const easing=sheetKeyAt(original,tick).key??{interpolation:'linear'};
        if(untouched)track.keys.push({id:`cell-${plan.state.nextId++}`,tick,sourceTick:tick,...keyEasing(easing)});
        else plan.write(destination,tick,at(this.report,tick),{easing});
      }
    }
    return publish(this,plan,'Move figures to layer');
  },
  sheetDeleteLayer(id){
    const state=this.report._styk.layers;if(state.order.length===1)throw new Error('Keep at least one user layer.');
    const target=state.order.find(value=>value!==id),plan=planner(this,[id]),removed=new Set(this.getLayerFigureUids(id));
    // Native source poses still contain the deleted members. Materialize the
    // fallback layer before changing their metadata, so they cannot reappear.
    const track=plan.get(target);
    for(const key of track.keys)plan.materialize(target,key);
    for(const key of track.keys)if(key.value?.frameId){const source=plan.sources.find(s=>s.id===key.value.frameId)?.after.value??this.getFrameById(key.value.frameId);
      key.value=plan.capture(ownedFrame(this.report,source,source.objects.filter(o=>this.layerForUid(o.unique_id)===target&&!removed.has(o.unique_id)).map(o=>o.unique_id)),target);}
    for(const uid of removed)plan.layers.assignments[uid]=target;
    plan.layers.order=plan.layers.order.filter(value=>value!==id);delete plan.layers.byId[id];delete plan.state.tracks[id];
    if(plan.layers.defaultLayerId===id)plan.layers.defaultLayerId=target;if(plan.layers.activeId===id)plan.layers.activeId=target;
    plan.state.duration=Math.max(1,...Object.values(plan.state.tracks).map(t=>t.end));
    return publish(this,plan,'Delete layer');
  },
  selectSheetLayer(id,{contents=true}={}){
    if(!this.getLayer(id))return false;this.setActiveLayer(id);this._sheetSelection={id,contents};
    if(contents)this._followSheetSelection();this._emit('selection',{sheetSelection:true});return true;
  },
  _followSheetSelection(){
    const selection=this._sheetSelection;if(!selection?.contents||!this.report._styk.layerSheet)return;
    const objects=this.evaluatedFrame.objects.filter(o=>this.layerForUid(o.unique_id)===selection.id);
    if(objects.length!==this.selectedUids.size||objects.some(o=>!this.selectedUids.has(o.unique_id)))this.selectedUids=new Set(objects.map(o=>o.unique_id));
    this._selectedUid=objects.find(o=>!o.join)?.unique_id??objects[0]?.unique_id??null;this.selectedJoint=-1;this._branchSelection=null;
  },
  layerFrameKeys(id=this.activeLayerId){return this.report._styk.layerSheet?.tracks[id]?.keys??[];},
  sheetInsertKey(ids=[this.activeLayerId],tick=this.tick,{blank=false}={}){
    checkedTick(tick);const plan=planner(this,ids);
    for(const id of ids){const track=plan.get(id),previous=sheetKeyAt(track,tick).key;
      const sourceTick=!blank&&tick>=track.end?Math.max(0,track.end-1):tick;
      const frame=shiftClipTime(clone(at(this.report,sourceTick)),tick-sourceTick);
      plan.write(id,tick,frame,{blank,easing:previous??{interpolation:'constant'}});}
    return publish(this,plan,blank?'Insert blank keyframe':'Insert keyframe');
  },
  /** Insert a new pose after the current cell, shifting later keys atomically. */
  sheetDuplicateFrameAfter(ids=[this.activeLayerId],tick=this.tick){
    checkedTick(tick);const start=checkedTick(tick+1),plan=planner(this,ids);
    for(const id of ids){const track=plan.get(id),sourceTick=Math.min(tick,Math.max(0,track.end-1));
      const frame=shiftClipTime(clone(at(this.report,sourceTick)),start-sourceTick),previous=sheetKeyAt(track,sourceTick).key;
      for(const key of track.keys)if(key.tick>=start)key.tick++;
      track.end=Math.max(start,track.end)+1;
      retimeClips(this,plan,id,time=>time>=start?time+1:time);
      plan.write(id,start,frame,{easing:previous??{interpolation:'constant'}});
      plan.state.duration=Math.max(plan.state.duration,track.end);
    }
    const selection=this._selectionState();
    publish(this,plan,'Duplicate frame after current',{selection});this.seek(start);
    const command=this._undo.at(-1);if(command?.kind==='layer-sheet')command.afterSelection=this._selectionState();
    return true;
  },
  sheetSetEasing(ids,start,end,easing){
    const plan=planner(this,ids),fields=keyEasing(easing);
    for(const id of ids){const track=plan.get(id),first=sheetKeyAt(track,start).key;
      for(const key of track.keys)if(key===first||key.tick>=start&&key.tick<=end){delete key.bezier;Object.assign(key,fields);}}
    return publish(this,plan,'Set frame interpolation');
  },
  sheetClearKeys(ids,start,end=start){
    const plan=planner(this,ids);for(const id of ids){const track=plan.get(id);track.keys=track.keys.filter(k=>k.tick<start||k.tick>end);}
    return publish(this,plan,'Clear keyframes');
  },
  sheetClearFrames(ids,start,end=start){
    const plan=planner(this,ids),after=at(this.report,end+1);
    for(const id of ids){const track=plan.get(id),finish=track.end;track.keys=track.keys.filter(k=>k.tick<start||k.tick>end);
      plan.write(id,start,at(this.report,start),{blank:true});if(end+1<finish&&!track.keys.some(k=>k.tick===end+1))plan.write(id,end+1,after);}
    return publish(this,plan,'Clear frames');
  },
  sheetInsertFrames(ids,start,count=1){
    checkedTick(start);if(!Number.isInteger(count)||count<1||start+count>=MAX_SHEET_TICKS)throw new Error('Choose a valid frame count.');
    const plan=planner(this,ids),frame=at(this.report,Math.max(0,start-1));
    for(const id of ids){const track=plan.get(id),had=track.keys.some(k=>k.tick===start);
      for(const key of track.keys)if(key.tick>=start)key.tick+=count;
      track.end=Math.max(start,track.end)+count;
      retimeClips(this,plan,id,tick=>tick>=start?tick+count:tick);
      if(had&&start===0){
        // The new opening exposure starts now; only the original keys move.
        const opening=clone(frame);
        for(const object of opening.objects)if(object._stykMovieclip){const p=object._stykMovieclip;
          if(p.start>0)p.start+=count;if(p.end!==null&&p.end!==undefined)p.end+=count;
          if(p.restarts)p.restarts=p.restarts.map(k=>k.tick>0?{...k,tick:k.tick+count}:k);}
        plan.write(id,start,opening);
      }
      plan.state.duration=Math.max(plan.state.duration,track.end);}
    return publish(this,plan,'Insert frames');
  },
  sheetRemoveFrames(ids,start,end=start){
    const count=end-start+1;if(count<1)throw new Error('Select frames to remove.');
    const plan=planner(this,ids),frame=at(this.report,end+1);
    for(const id of ids){const track=plan.get(id),restore=track.keys.some(k=>k.tick>=start&&k.tick<=end);
      track.keys=track.keys.filter(k=>k.tick<start||k.tick>end);for(const key of track.keys)if(key.tick>end)key.tick-=count;
      track.end=Math.max(0,track.end-Math.max(0,Math.min(count,track.end-start)));if(restore&&start<track.end&&!track.keys.some(k=>k.tick===start))plan.write(id,start,frame);
      retimeClips(this,plan,id,tick=>tick>=start?Math.max(start,tick-count):tick);}
    plan.state.duration=Math.max(1,...Object.values(plan.state.tracks).map(track=>track.end));
    return publish(this,plan,'Remove frames');
  },
  sheetCopyFrames(ids,start,end=start){
    assertLayers(this,ids);const rows=[];
    for(const id of ids){const track=this.report._styk.layerSheet.tracks[id],ticks=[start,...(track?.keys??[]).filter(k=>k.tick>start&&k.tick<=end).map(k=>k.tick)];
      rows.push({id,keys:ticks.map(tick=>{const frame=at(this.report,tick);return {offset:tick-start,frame:ownedFrame(this.report,frame,fixed(id)?[]:frame.objects.filter(o=>this.layerForUid(o.unique_id)===id).map(o=>o.unique_id)),easing:keyEasing(sheetKeyAt(track,tick).key??{interpolation:'constant'})};})});}
    const types=new Set(rows.flatMap(row=>row.keys.flatMap(key=>key.frame.objects.map(o=>o.figure_type_id))));
    this._sheetClipboard={version:1,start,duration:end-start+1,rows,document:this._documentToken,figures:clone(this.report.figure_types.filter(f=>types.has(f.figure_type_id))),backgrounds:clone(this.report.backgrounds??[])};return this._sheetClipboard;
  },
  sheetPasteFrames(ids,tick,{insert=false}={}){
    const clipboard=this._sheetClipboard;if(!clipboard)throw new Error('Copy timeline frames first.');
    const foreign=clipboard.document!==this._documentToken;
    if(ids.length!==1&&ids.length!==clipboard.rows.length)throw new Error('Select one destination layer or the same number of layers as the copied range.');
    const ordered=this.getLayers().filter(l=>l.kind==='layer').map(l=>l.id).reverse(),offset=ordered.indexOf(ids[0]);
    const destinations=ids.length===clipboard.rows.length?ids:ordered.slice(offset,offset+clipboard.rows.length);
    if(destinations.length!==clipboard.rows.length)throw new Error('Create enough destination layers for this range.');
    const plan=planner(this,destinations),finish=tick+clipboard.duration,uidMap=new Map();
    if(finish>MAX_SHEET_TICKS)throw new Error('Pasted frames exceed the timeline limit.');
    const typeMap=new Map(),backgroundMap=new Map([[0,0]]),assets={};
    let nextUid=this._nextUid;
    if(foreign){
      const figures=this.report.figure_types.slice(),backgrounds=(this.report.backgrounds??[]).slice();let type=Math.max(0,...figures.map(f=>f.figure_type_id))+1,bg=Math.max(0,...backgrounds.map(b=>b.background_id))+1;
      for(const figure of clipboard.figures??[]){typeMap.set(figure.figure_type_id,type);figures.push({...clone(figure),figure_type_id:type++});}
      if(clipboard.rows.some(row=>row.id==='scene'))for(const background of clipboard.backgrounds??[]){backgroundMap.set(background.background_id,bg);backgrounds.push({...clone(background),background_id:bg++});}
      assets.figure_types={before:this.report.figure_types,after:figures};assets.backgrounds={before:this.report.backgrounds??[],after:backgrounds};
    }
    for(let i=0;i<destinations.length;i++){
      const id=destinations[i],row=clipboard.rows[i],track=plan.get(id),restore=at(this.report,finish),oldEnd=track.end;
      if(insert){for(const key of track.keys)if(key.tick>=tick)key.tick+=clipboard.duration;}
      else track.keys=track.keys.filter(k=>k.tick<tick||k.tick>=finish);
      for(const entry of row.keys){const frame=shiftClipTime(clone(entry.frame),tick-clipboard.start);
        if(foreign){for(const object of frame.objects)object.figure_type_id=typeMap.get(object.figure_type_id);for(const field of ['background_id','background_id_b'])frame[field]=backgroundMap.get(frame[field])??0;}
        if(foreign||row.id!==id){
          for(const object of frame.objects){const old=object.unique_id;if(!uidMap.has(old)){if(nextUid>0x7ffffffe)throw new Error('Object identity capacity reached.');uidMap.set(old,nextUid++);}object.unique_id=uidMap.get(old);plan.layers.assignments[object.unique_id]=id;}
          for(const object of frame.objects){if(object.join)object.join.target_unique_id=uidMap.get(object.join.target_unique_id)??object.join.target_unique_id;remapIKFollowers(object,uidMap);}
          frame.object_draw_order_unique_ids=frame.object_draw_order.map(slot=>frame.objects[slot].unique_id);
        }
        plan.write(id,tick+entry.offset,frame,{easing:entry.easing});
      }
      if(!insert&&finish<oldEnd&&!track.keys.some(k=>k.tick===finish))plan.write(id,finish,restore);
      track.end=Math.max(finish,oldEnd+(insert?clipboard.duration:0));plan.state.duration=Math.max(plan.state.duration,track.end);
    }
    const result=publish(this,plan,'Paste frames',{assets:foreign?assets:undefined});this._nextUid=nextUid;return result;
  },
  sheetMoveFrames(ids,start,end,delta,{copy=false}={}){
    if(!Number.isInteger(delta)||start+delta<0)throw new Error('Frames cannot move before frame 1.');if(!delta)return false;
    const plan=planner(this,ids),finish=end+delta;
    for(const id of ids){const track=plan.get(id),selected=track.keys.filter(k=>k.tick>=start&&k.tick<=end);
      if(!selected.length){const key=plan.write(id,start,at(this.report,start));selected.push(key);}
      const selectedIds=new Set(selected.map(k=>k.id));
      if(track.keys.some(k=>!selectedIds.has(k.id)&&k.tick>=start+delta&&k.tick<=finish))throw new Error('The destination contains keyframes. Clear it first or use Paste frames to replace it.');
      for(const key of selected){const moved={...key,tick:key.tick+delta,...(copy?{id:`cell-${plan.state.nextId++}`}:{})};
        const source=key.value?.frameId&&(plan.sources.find(s=>s.id===key.value.frameId)?.after.value??this.getFrameById(key.value.frameId));
        if(source?.objects.some(o=>o._stykMovieclip))moved.value=plan.capture(shiftClipTime(clone(source),delta),id);
        if(copy)track.keys.push(moved);else Object.assign(key,moved);}
      track.keys.sort((a,b)=>a.tick-b.tick);track.end=Math.max(track.end,finish+1);plan.state.duration=Math.max(plan.state.duration,track.end);
    }
    return publish(this,plan,copy?'Copy frames':'Move frames');
  },
  sheetTransferFrames(ids,destinations,start,end,tick,{copy=false}={}){
    assertLayers(this,[...ids,...destinations]);const clipboard=this._sheetClipboard;
    this.sheetCopyFrames(ids,start,end);
    try{return this.movieclipBatch(copy?'Copy frames to layer':'Move frames to layer',()=>{
      if(!copy)this.sheetClearFrames(ids,start,end);return this.sheetPasteFrames(destinations,tick);
    });}finally{this._sheetClipboard=clipboard;}
  },
  _commitSheetPose(edit,drag){
    const before=edit.source,after=edit.frame,ids=new Set(),old=new Map(before.objects.map(o=>[o.unique_id,o])),current=new Map(after.objects.map(o=>[o.unique_id,o]));
    for(const object of [...after.objects,...before.objects]){
      const next=current.get(object.unique_id);
      if(JSON.stringify(old.get(object.unique_id))!==JSON.stringify(next))ids.add(this._layerUidCounts.has(object.unique_id)?this.layerForUid(object.unique_id):this.activeLayerId);
    }
    if(JSON.stringify(before.camera)!==JSON.stringify(after.camera))ids.add('camera');
    if(['background_id','background_id_b','background_mix','background_color','_stykBackgroundColor'].some(k=>JSON.stringify(before[k])!==JSON.stringify(after[k])))ids.add('scene');
    if(!ids.size){this._drag=null;this._authoredPoseEdit=null;this._invalidate();return false;}
    const plan=planner(this,[...ids]);
    for(const id of ids){const {key}=sheetKeyAt(plan.get(id),edit.tick),hold=key&&['constant','hold'].includes(key.interpolation);
      plan.write(id,hold?key.tick:edit.tick,after,{easing:key??{interpolation:'constant'}});}
    this._drag=null;this._authoredPoseEdit=null;this._authoredCommitPreview=null;
    const assets={};
    for(const [field,previous] of [['figure_types',edit.beforeFigures],['backgrounds',edit.beforeBackgrounds]])if(previous&&JSON.stringify(previous)!==JSON.stringify(this.report[field]))assets[field]={before:previous,after:this.report[field].slice()};
    return publish(this,plan,drag.label,{selection:drag.beforeSelection,assets:Object.keys(assets).length?assets:undefined});
  },
  _sheetPropertyEntries(entries,label='Edit layer pose'){
    const byTick=new Map();for(const entry of entries){const tick=checkedTick(entry.tick??this.tick),list=byTick.get(tick)??[];list.push(entry);byTick.set(tick,list);}
    const ids=[...new Set(entries.map(e=>fixed(e.target.kind)?e.target.kind:e.target.kind==='layer'?e.target.id:this.layerForUid(e.target.uid)))],plan=planner(this,ids),result=[];
    for(const [tick,list] of byTick){let frame=at(this.report,tick);
      const channels=list.map((e,i)=>({id:animationChannelId(e.target,e.property),target:e.target,property:e.property,keys:[{id:`preview-${i}`,tick,value:e.property==='pose'?e.value:validateAnimationValue(e.target,e.property,e.value),interpolation:'constant'}]}));
      const source={...this.report,_styk:{...this.report._styk,animation:{channels}}};
      frame=composePoseChannels(source,frame,tick,{sampleNative:evaluatedNativeFrame,resolveGeometry:buildGeometry});
      frame=composeAnimationChannels(source,frame,tick,{resolveGeometry:buildGeometry});
      for(const id of ids){const selected=list.filter(e=>(fixed(e.target.kind)?e.target.kind:e.target.kind==='layer'?e.target.id:this.layerForUid(e.target.uid))===id);if(!selected.length)continue;
        const key=sheetKeyAt(plan.get(id),tick).key,targetTick=key&&['constant','hold'].includes(key.interpolation)?key.tick:tick;
        result.push(plan.write(id,targetTick,frame,{easing:key??{interpolation:'constant'}}));}
    }
    publish(this,plan,label);return result;
  },
};
