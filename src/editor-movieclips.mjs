import {messageError} from './localized-error.mjs';
import {drawingResourcesFor} from './drawing-resources.mjs';
import {movieclipFigure,movieclipAsset,isMovieclip,playbackSettings,validatePlayback,invalidateMovieclipTypes,movieclipSourceFrames,movieclipTime} from './movieclips.mjs';
import {evaluatedFrame,timeline,buildGeometry,movieclipPresenceIndex} from './pivot/geometry.mjs';
import {createFrame,createObject,emptyDocument} from './demo.mjs';
import {frameOrder,setOrder,normalizeFrame} from './pivot/structure.mjs';
import {layerLocked,layerIdForUid} from './layers.mjs';
import {drawingMetadata,drawingId,isDrawingLayer} from './drawing-model.mjs';
import {storedFrameReport} from './pivot-frame-draft.mjs';
import {createMovieclipMaterializer} from './movieclip-materialize.mjs';
import {animationChannelId,validateAnimationDocument,sampleAnimationChannel} from './animation-channels.mjs';
import {snapshotPoseFrame} from './pose-snapshot.mjs';
import {presencePlayback,usesPresence,continuations,setContinuations,presenceElapsed} from './movieclip-presence.mjs';
import {initializeLayerSheet} from './editor-layer-sheet.mjs';

const clone=value=>structuredClone(value);
const allocateType=editor=>editor.report.figure_types.reduce((id,f)=>Math.max(id,f.figure_type_id+1),1);
function at(report,tick){
  const rows=timeline(report);let low=0,high=rows.length-1;
  while(low<high){const mid=Math.ceil((low+high)/2);if(rows[mid].start<=tick)low=mid;else high=mid-1;}
  const row=rows[low];return evaluatedFrame(report,low,row.count?(tick-row.start)/row.count:0,tick);
}
function filteredFrame(frame,selected){
  const source=frame.objects,objects=source.filter(o=>selected.has(o.unique_id)).map(object=>{
    const next=clone(object);delete next.runtime_segments;delete next._movieclipSample;
    if(next.join)next.join.target_unique_id=source[next.join.target_object_slot]?.unique_id;
    return next;
  });
  const result={...frame,objects,camera:{is_default:true,x:0,y:0,angle_rad:0,scale:1},background_id:0,background_id_b:0,background_mix:0};
  // Normalize against the filtered list: its slots may differ from the source.
  const slots=new Map(objects.map((object,slot)=>[object.unique_id,slot]));
  for(const object of objects)if(object.join)object.join.target_object_slot=slots.get(object.join.target_unique_id);
  delete result._stykBackgroundColor;delete result.background_color;delete result._stykVfx;
  result._styk={...frame._styk};setContinuations(result,continuations(frame).filter(step=>selected.has(step.uid)));setOrder(result,frameOrder(frame).filter(uid=>selected.has(uid)));normalizeFrame(result);return result;
}
/** Sparse capture retains the original curves as an immutable baseline. Local
 * stored poses provide editing boundaries; no per-output-frame baking occurs. */
export function captureMovieclip(editor,{start=editor.tick,end=start+1,uids=[...editor.selectedUids],name='Movieclip'}={}){
  if(!Number.isInteger(start)||!Number.isInteger(end)||start<0||end<=start||end>Math.max(editor.totalTicks,start+1))throw messageError(new Error(''), "errors.editorMovieclips.chooseAValidMovieclipRange", {});
  const report=editor.report,selected=new Set(uids);
  // All contents: everything shown in the range, including drawing layers,
  // whose cels live in layer keys rather than the native frames.
  if(!selected.size){for(const frame of report.keyframes)for(const obj of frame.objects)selected.add(obj.unique_id);for(let tick=start;tick<end;tick++)for(const obj of at(report,tick).objects)selected.add(obj.unique_id);}
  if(!selected.size)throw messageError(new Error(''), "errors.editorMovieclips.selectFiguresToCreateAMovieclip", {});
  // Include the connected assembly across its complete animation.
  const neighbors=new Map();
  for(const frame of [...report.keyframes,...Object.values(report._styk?.frameSources??{})])for(const obj of frame.objects)if(obj.join){
    const parent=frame.objects[obj.join.target_object_slot]?.unique_id;
    if(parent===undefined)continue;
    for(const [a,b] of [[obj.unique_id,parent],[parent,obj.unique_id]]){const set=neighbors.get(a)??new Set();set.add(b);neighbors.set(a,set);}
  }
  const queue=[...selected];for(let i=0;i<queue.length;i++)for(const uid of neighbors.get(queue[i])??[])if(!selected.has(uid)){selected.add(uid);queue.push(uid);}
  const usedTypes=new Set(),usedLayers=new Set([...selected].map(uid=>layerIdForUid(report,uid)));
  const frames=report.keyframes.map(frame=>filteredFrame(frame,selected));
  for(const frame of frames)for(const obj of frame.objects)usedTypes.add(obj.figure_type_id);
  const sources=Object.fromEntries(Object.entries(report._styk?.frameSources??{}).map(([id,frame])=>[id,filteredFrame(frame,selected)]));
  for(const frame of Object.values(sources))for(const obj of frame.objects)usedTypes.add(obj.figure_type_id);
  const channels=(report._styk?.animation?.channels??[]).filter(channel=>['figure','segment','polygon'].includes(channel.target.kind)?selected.has(channel.target.uid):channel.target.kind==='layer'&&usedLayers.has(channel.target.id));
  const metadata={...report._styk,animation:{...report._styk?.animation,version:1,nextKeyId:report._styk?.animation?.nextKeyId??1,channels:clone(channels)},frameSources:sources};
  if(metadata.vfxClips)metadata.vfxClips={...metadata.vfxClips,clips:metadata.vfxClips.clips.filter(c=>c.target.kind!=='scene'&&selected.has(c.target.uid))};
  delete metadata.simpleFrameDraft;
  if(metadata.movieclipSource){
    const retained=clone(metadata.movieclipSource.document);
    const prune=document=>{
      if(document._styk?.vfxClips)document._styk.vfxClips={...document._styk.vfxClips,clips:document._styk.vfxClips.clips.filter(c=>c.target.kind!=='scene'&&selected.has(c.target.uid))};
      document.keyframes=document.keyframes.map(frame=>filteredFrame(frame,selected));
      if(document._styk?.frameSources)document._styk.frameSources=Object.fromEntries(Object.entries(document._styk.frameSources).map(([id,frame])=>[id,filteredFrame(frame,selected)]));
      if(document._styk?.animation)document._styk.animation.channels=document._styk.animation.channels.filter(c=>['figure','segment','polygon'].includes(c.target.kind)?selected.has(c.target.uid):c.target.kind==='layer'&&usedLayers.has(c.target.id));
      if(document._styk?.movieclipSource)prune(document._styk.movieclipSource.document);
    };
    prune(retained);metadata.movieclipSource={...metadata.movieclipSource,document:retained};
  }
  const source={...report,figure_types:clone(report.figure_types.filter(f=>usedTypes.has(f.figure_type_id))),keyframes:frames,backgrounds:[],_styk:metadata};
  // Captured drawings become the clip's own cels, as copied keys do: sharing
  // the project's cel identities would show and edit the project's pixels.
  for(const figure of source.figure_types){const d=drawingMetadata(figure);if(d)figure._styk.drawing={...d,celId:drawingId()};}
  // Layer membership is needed by retained layer Pose channels; outside members
  // are harmless but removed from the portable source.
  if(metadata.layers){metadata.layers=clone(metadata.layers);metadata.layers.assignments=Object.fromEntries(Object.entries(metadata.layers.assignments??{}).filter(([uid])=>selected.has(Number(uid))));}
  const rows=timeline(report),ticks=new Set([start,end-1]);
  for(const row of rows)if(row.start>start&&row.start<end)ticks.add(row.start);
  for(const track of Object.values(report._styk?.layerSheet?.tracks??{}))for(const key of track.keys)if(key.tick>start&&key.tick<end)ticks.add(key.tick);
  const ordered=[...ticks].sort((a,b)=>a-b);
  const localFrames=ordered.map((tick,i)=>{
    const frame=filteredFrame(at(report,tick),selected);
    for(const object of frame.objects)if(usesPresence(object)){
      const asset=report.figure_types.find(figure=>figure.figure_type_id===object.figure_type_id)._styk.movieclip;
      object._stykMovieclip={...object._stykMovieclip,offset:(object._stykMovieclip.offset??0)+presenceElapsed(movieclipPresenceIndex(report),object.unique_id,start)*asset.document.fps/report.fps};
    }
    frame.duration_raw=(ordered[i+1]??end)-tick;
    frame._styk={easing:clone(frame._styk?.easing),movieclipSourceTick:tick,...(continuations(frame).length?{movieclipContinuations:continuations(frame)}:{})};
    return frame;
  });
  const first=at(report,start),rootObject=first.objects.find(o=>selected.has(o.unique_id)&&!o.join)??first.objects.find(o=>selected.has(o.unique_id));
  const root=rootObject&&buildGeometry(report,first).objects.get(rootObject.object_slot)?.root;
  const document={...source,keyframes:localFrames,_styk:{format:'StykAnimate',format_version:1,name,
    layers:metadata.layers,movieclipSource:{document:{...source,figure_types:[]},inheritFigures:true}}};
  if(Object.values(metadata.layers?.byId??{}).some(layer=>isDrawingLayer(layer)))clipDrawingKeys(document,localFrames);
  return {figure:movieclipFigure(allocateType(editor),name,document,{duration:end-start,pivot:root??{x:0,y:0}}),selected,start,end};
}
/** Give a captured clip its layer sheet with ordinary drawing keys. Without
 * one, loading derives imported-timing keys, which draw the cels but cannot
 * be painted, copied or re-timed like drawing keys. Each exposure gets its own
 * pose frame; consecutive keys showing the same cel become one hold. */
function clipDrawingKeys(document,localFrames){
  initializeLayerSheet(document);
  const {layers,layerSheet}=document._styk,sources=document._styk.frameSources??={},starts=[];let next=1,elapsed=0;
  for(const frame of localFrames){starts.push(elapsed);elapsed+=frame.duration_raw;}
  const frameAt=tick=>{let i=starts.length-1;while(i>0&&starts[i]>tick)i--;return localFrames[i];};
  for(const id of layers.order){
    if(!isDrawingLayer(layers.byId[id]))continue;
    let previous=null;const keys=[];
    for(const key of layerSheet.tracks[id].keys){
      const frame=frameAt(key.sourceTick??key.tick),owned=frame.objects.filter(o=>layers.assignments[o.unique_id]===id),cel=owned[0]?.figure_type_id??null;
      if(keys.length&&cel===previous)continue;previous=cel;
      if(cel===null){keys.push({id:key.id,tick:key.tick,interpolation:'constant',value:{frameId:null},empty:true});continue;}
      while(sources[`frame-${next}`])next++;
      const frameId=`frame-${next++}`,pose=snapshotPoseFrame(frame,owned.map(o=>o.unique_id));pose._styk={...pose._styk,frameId};sources[frameId]=pose;
      keys.push({id:key.id,tick:key.tick,interpolation:'constant',value:{frameId}});
    }
    layerSheet.tracks[id]={...layerSheet.tracks[id],keys};
  }
}
export function applyMovieclipCommand(editor,command,direction){
  if(command.kind==='movieclip-poses'){
    editor._prepareFrameDraftHistory?.(command,direction);
    for(const entry of command[direction].frames)editor._replaceObjects(entry.index,entry.objects,entry.sourceId,entry.draft,entry.sourceDepth);
    editor._invalidate({timing:true});editor._restoreSelection(command[`${direction}Selection`]);
    editor._revision=command[`${direction}Revision`];editor._applyFrameDraftHistory?.(command,direction);
    editor._emit('history',{structural:true,timing:true,label:command.label});return true;
  }
  if(command.kind!=='movieclip-definition')return false;
  const value=command[direction],other=command[direction==='before'?'after':'before'];
  const figures=editor.report.figure_types.slice();
  figures.splice(command.index,other?1:0,...(value?[value]:[]));editor.report.figure_types=figures;
  invalidateMovieclipTypes(editor.report);editor._invalidate({timing:true});editor._revision=command[`${direction}Revision`];
  editor._restoreSelection(command[`${direction}Selection`]);editor._emit('history',{structural:true,timing:true,definition:true,label:command.label});return true;
}
function publishDefinition(editor,figure,index=editor.report.figure_types.length,label='Create movieclip'){
  const before=editor.report.figure_types[index]??null,selection=editor._selectionState();
  const figures=editor.report.figure_types.slice();figures.splice(index,before?1:0,figure);editor.report.figure_types=figures;
  editor._record({kind:'movieclip-definition',index,before,after:figure,label,beforeSelection:selection,afterSelection:selection,
    structural:true,timing:true,precomputedBytes:JSON.stringify(figure).length*2+128});
  invalidateMovieclipTypes(editor.report);editor._invalidate({timing:true});editor._emit('edit',{structural:true,timing:true,definition:true,label});
  return figure;
}
function publishChannels(editor,channels,label,options){
  if(editor.report._styk?.layerSheet)return editor.sheetApplyChannels(channels,label,options);
  const before=editor.report._styk.animation??null,selection=editor._selectionState(),ids=new Set(channels.map(c=>c.id));
  const after={version:1,nextKeyId:1,...before,channels:[...(before?.channels??[]).filter(c=>!ids.has(c.id)),...channels]};
  validateAnimationDocument({...editor.report,_styk:{...editor.report._styk,animation:after}});
  editor.report._styk.animation=after;
  editor._record({kind:'animation',label,before,after,beforeSelection:selection,afterSelection:selection,structural:true,timing:true});
  editor._invalidate({timing:true});editor._emit('edit',{structural:true,timing:true,animation:true,label});
}
function maskRanges(ranges,start,end){
  const result=[];
  for(const range of [...(ranges??[]),[start,end]].sort((a,b)=>a[0]-b[0])){
    const last=result.at(-1);if(last&&last[1]>=range[0])last[1]=Math.max(last[1],range[1]);else result.push([...range]);
  }
  return result;
}
function maskedPose(editor,uid,start,end){
  const target={kind:'figure',uid},own=editor.animationChannel(target,'pose'),layer=editor.animationChannel({kind:'layer',id:editor.layerForUid(uid)},'pose');
  const channel=own??editor.nativePoseChannel(target);
  return {...channel,...(!own&&!layer?{useBasePose:true}:{}),maskedRanges:maskRanges(channel.maskedRanges,start,end)};
}
function poseChannel(editor,uid,frames,{start=0,end,orderAnchor,sourceUids=[uid]}={}){
  const target={kind:'figure',uid},keys=frames.map(({tick,frame},i)=>({id:`clip-pose-${uid}-${i}`,tick,interpolation:'hold',value:{frameId:editor.captureFrameSource(frame,{uids:sourceUids})}}));
  if(start>0)keys.unshift({id:`clip-blank-${uid}`,tick:0,interpolation:'hold',value:{frameId:null}});
  if(end!==undefined)keys.push({id:`clip-end-${uid}`,tick:end,interpolation:'hold',value:{frameId:null}});
  return {id:animationChannelId(target,'pose'),target,property:'pose',keys,...(orderAnchor!==undefined?{orderAnchor}:{})};
}
function assignChildrenLayer(editor,uids,layer){
  editor._layerEdit('Place movieclip figures',uids.map(uid=>[['assignments',String(uid)],layer]),{structural:true});
}
function validateReplacementOrder(editor,selected,start,end){
  if(selected.size<2)return;
  const ticks=new Set([start,end-1]);
  for(const row of editor.timeline)if(row.start>start&&row.start<end)ticks.add(row.start);
  for(const channel of editor.animationChannels)if(channel.property==='pose'||channel.property==='zIndex')
    for(const key of channel.keys)if(key.tick>start&&key.tick<end)ticks.add(key.tick);
  for(const tick of ticks){
    const order=frameOrder(at(editor.report,tick)),positions=order.map((uid,i)=>selected.has(uid)?i:-1).filter(i=>i>=0);
    if(positions.length&&positions.at(-1)-positions[0]+1!==positions.length)throw messageError(new Error(''), "errors.editorMovieclips.selectedFiguresCrossOtherFiguresInTheStacking", {value: tick+1});
  }
}
export const editorMovieclipMethods={
  addMovieclipToNextKeyframes(count){
    if(!isMovieclip(this.figure))throw messageError(new Error(''), "errors.editorMovieclips.selectAMovieclip", {});
    if(!Number.isSafeInteger(count)||count<1)throw messageError(new Error(''), "errors.editorMovieclips.enterAPositiveWholeNumberOfKeyframes", {});
    if(this.getLayer(this.layerForUid(this.selectedUid))?.locked)throw messageError(new Error(''), "errors.editorMovieclips.unlockTheMovieclipLayerBeforeEditingIt", {});
    if(this.report._styk?.layerSheet)return this.sheetExtendMovieclip(count);
    const uid=this.selectedUid,source=filteredFrame(this.selectionFrame,new Set([uid])).objects[0],selection=this._selectionState();
    const layer=this.layerForUid(uid),orderIndex=frameOrder(this.selectionFrame).filter(id=>this.layerForUid(id)===layer).indexOf(uid);
    const ticks=this.timeline.filter(row=>row.start>this.tick&&row.count>0).slice(0,count).map(row=>row.start);
    return this.movieclipTimelineEdit('Add movieclip to next keyframes',()=>{
      let added=0;
      try{for(const tick of ticks){
        this.seek(tick);
        if(this.selectionFrame.objects.some(object=>object.unique_id===uid))continue;
        this.transaction('Add movieclip to next keyframes',frame=>{
          const order=frameOrder(frame),siblings=order.filter(id=>this.layerForUid(id)===layer);
          const insertion=orderIndex<siblings.length?order.indexOf(siblings[orderIndex]):siblings.length?order.indexOf(siblings.at(-1))+1:order.length;
          frame.objects.push(clone(source));order.splice(insertion,0,uid);setOrder(frame,order);normalizeFrame(frame);
        },{structural:true});added++;
      }}finally{this._restoreSelection(selection);}
      return added;
    });
  },
  _insertMovieclip(operation){
    if(this.report._styk?.layerSheet){
      this._insertingMovieclip=true;
      try{return operation();}finally{this._insertingMovieclip=false;}
    }
    // A fractional native clip end is invalid; reject before poses or sources publish.
    if(!this.animationChannels.length&&!this.report._styk?.movieclipSource&&!Number.isInteger(this.tick))
      throw messageError(new Error(''), "errors.animationChannels.invalidMovieclipEnd", {});
    return this.movieclipBatch('Insert movieclip',()=>{
      if(this.report._styk?.layerSheet)this._prepareSheetMovieclips();
      this._insertingMovieclip=true;
      try{operation();}finally{this._insertingMovieclip=false;}
      const uid=this.selectedUid,tick=this.tick,asset=movieclipAsset(this.figure);
      const end=tick+Math.max(1,Math.ceil(asset.duration*this.report.fps/asset.document.fps));
      this._editMovieclipPoses('Insert movieclip',object=>{object._stykMovieclip={...playbackSettings(object),start:tick,end};});
      const channel={...poseChannel(this,uid,[{tick,frame:this.evaluatedFrame}],{start:tick}),clipEnd:end};
      publishChannels(this,[channel],'Insert movieclip');
      this.seek(tick);this.select(uid);return this.object;
    });
  },
  _editMovieclipPoses(label,mutate){
    const uid=this.selectedUid,selection=this._selectionState();
    this._prepareDraftTopology(this.object.figure_type_id);
    const draft=this.report._styk.simpleFrameDraft;
    const entries=[...this.report.keyframes.map((frame,index)=>({frame,index})),
      ...Object.entries(this.report._styk.frameSources??{}).map(([sourceId,frame])=>({sourceId,frame,index:-1})),
      ...(draft?.baseline?[{frame:draft.baseline,index:draft.index,draft:true}]:[]),...movieclipSourceFrames(this.report)];
    const before={frames:[]},after={frames:[]};
    for(const {frame,...location} of entries){
      const objects=frame.objects.filter(o=>o.unique_id===uid);if(!objects.length)continue;
      before.frames.push({...location,objects:objects.map(clone)});
      const next=objects.map(object=>{const value=clone(object);mutate(value);delete value._movieclipSample;return value;});
      after.frames.push({...location,objects:next});this._replaceObjects(location.index,next,location.sourceId,location.draft,location.sourceDepth);
    }
    this._record({kind:'movieclip-poses',label,before,after,beforeSelection:selection,afterSelection:selection,structural:true,timing:true});
    this._invalidate({timing:true});this._emit('edit',{structural:true,timing:true,label});
  },
  movieclipBatch(label,operation,{beforeSelection=this._selectionState()}={}){
    if(this._movieclipBatch)return operation();
    const commands=[],revision=this.revision;this._movieclipBatch=commands;
    try{
      const result=operation();this._movieclipBatch=null;
      if(commands.length){
        const command={kind:'movieclip-batch',commands,label,beforeSelection,afterSelection:this._selectionState(),precomputedBytes:commands.reduce((n,c)=>n+c.bytes,128),structural:true,timing:true};
        this._record(command);command.beforeRevision=revision;
        if(this.report._styk?.layerSheet)this._pruneFrameSources();
      }
      this._emit('edit',{structural:true,timing:true,label});return result;
    }catch(error){this._movieclipBatch=null;for(const command of commands.reverse())this._applyCommand(command,'before');this._revision=revision;throw error;}
  },
  movieclipTimelineEdit(label,operation){
    if(this._movieclipBatch)return operation();
    return this.editFrameDraftTimeline(()=>this.movieclipBatch(label,()=>{if(this.report._styk?.layerSheet&&!usesPresence(this.object))this._prepareSheetMovieclips();return operation();}));
  },
  createMovieclip(options={}){
    if(drawingResourcesFor(this.report)?.stats.unpublished)throw messageError(new Error(''), "errors.editorMovieclips.finishDrawingPublicationBeforeCreatingAMovieclip", {});
    if(this._drag)this.commitDrag();
    const capture=captureMovieclip(this,options);
    if(options.replace!==false)validateReplacementOrder(this,capture.selected,capture.start,capture.end);
    // Sheet replacement leaves native poses untouched; legacy preparation would
    // materialize the entire layer even for a one-frame capture.
    const batch=this.report._styk?.layerSheet||options.end===undefined?this.movieclipBatch:this.movieclipTimelineEdit;
    return batch.call(this,'Create movieclip',()=>{
      publishDefinition(this,capture.figure);
      if(options.replace===false)return capture.figure;
      const {start,selected,figure}=capture;
      const end=options.end===undefined?(this.timeline.find(row=>row.start>start)?.start??this.totalTicks):capture.end;
      if(options.end!==undefined||!this._frameDraftEnabled){
        const source=at(this.report,start),order=frameOrder(source),positions=order.map((uid,i)=>selected.has(uid)?i:-1).filter(i=>i>=0);
        if(positions.length&&positions.at(-1)-positions[0]+1!==positions.length)throw messageError(new Error(''), "errors.editorMovieclips.selectAdjacentFiguresInTheStackingOrder", {});
        const uid=this._identity(),pivot=movieclipAsset(figure).pivot,instance=createObject(figure,uid,pivot.x,pivot.y,
          {_stykMovieclip:this.report._styk?.layerSheet?presencePlayback():{start,end,offset:0,speed:1,mode:movieclipAsset(figure).duration===1?'single':'loop'}});
        // The clip belongs on a figure layer. Drawing layers hold only drawing
        // cels, so a clip of drawings alone gets a new layer above them.
        const onDrawing=uid=>isDrawingLayer(this.getLayer(this.layerForUid(uid)));
        const frame=createFrame([instance]),anchor=order.filter((uid,i)=>positions.includes(i)).find(uid=>!onDrawing(uid))??order[positions.at(-1)]??[...selected][0];
        if(this.report._styk?.layerSheet){
          this.sheetCreateMovieclip({selected,start,end,instance,anchor,layerName:figure.name});
          this.seek(start);this.select(uid);return figure;
        }
        const channels=[...selected].map(id=>maskedPose(this,id,start,end));
        channels.push(this.report._styk?.layerSheet?poseChannel(this,uid,[{tick:start,frame}],{start,end,orderAnchor:anchor}):{...poseChannel(this,uid,[{tick:start,frame}],{start,orderAnchor:anchor}),clipEnd:end});
        assignChildrenLayer(this,[uid],this.layerForUid(anchor));publishChannels(this,channels,'Create movieclip',{preserveDuration:true,replacePresence:{uids:selected,start,end}});
        this.seek(start);this.select(uid);return figure;
      }
      if (options.end!==undefined || start!==this.timeline[this.frameIndex]?.start || this.animationChannels.length) {
        const entries=[...selected].flatMap(uid=>[start,...(end<this.totalTicks?[end]:[])].map(tick=>({target:{kind:'figure',uid},property:'pose',tick})));
        this.addAnimationKeys(entries);
      }
      // Native range conversion and authored conversion use the same sparse
      // Pose capture commands. Outside objects keep their original tracks.
      const ticks=options.end===undefined?[start]:[...new Set([start,...this.timeline.map(row=>row.start).filter(t=>t>start&&t<end)])];
      const uid=this._identity(),pivot=movieclipAsset(figure).pivot,instance=createObject(figure,uid,pivot.x,pivot.y,
        {_stykMovieclip:{start,end,offset:0,speed:1,mode:movieclipAsset(figure).duration===1?'single':'loop'}});
      const layer=this.layerForUid([...selected][0]);this._newLayerHints=new Map([[uid,layer]]);
      for(const tick of ticks){
        this.seek(tick);this._selectIds(selected);
        this.transaction('Convert to movieclip',frame=>{
          const order=frameOrder(frame),insertAt=order.findIndex(id=>selected.has(id));
          const positions=order.map((id,i)=>selected.has(id)?i:-1).filter(i=>i>=0);
          if(positions.length&&positions.at(-1)-positions[0]+1!==positions.length)throw messageError(new Error(''), "errors.editorMovieclips.selectedFiguresOverlapOtherFiguresInTheStacking", {});
          for(const object of frame.objects)if(object.join)object.join.target_unique_id=frame.objects[object.join.target_object_slot]?.unique_id;
          frame.objects=frame.objects.filter(o=>!selected.has(o.unique_id));frame.objects.push(clone(instance));
          const next=order.filter(id=>!selected.has(id));next.splice(Math.max(0,insertAt),0,uid);setOrder(frame,next);normalizeFrame(frame);this._selectIds([uid]);
        },{structural:true});
      }
      this.seek(start);this.select(uid);
      // An independent owner track lets timeline placements move and trim
      // without changing any neighboring figure or layer pose sequence.
      if(options.end!==undefined||this.animationChannels.length){
        this.addAnimationKey({kind:'figure',uid},'pose',start);
        if(start>0)this.addAnimationKey({kind:'figure',uid},'pose',0,{frameId:null});
        if(options.end!==undefined||end<this.totalTicks)this.addAnimationKey({kind:'figure',uid},'pose',end,{frameId:null});
      }
      this.seek(start);this.select(uid);return figure;
    });
  },
  createEmptyMovieclip(name='Movieclip'){
    const document=emptyDocument();document.figure_types=[];document.keyframes=[createFrame()];document.fps=this.report.fps;
    document.canvas_width=this.report.canvas_width;document.canvas_height=this.report.canvas_height;
    return publishDefinition(this,movieclipFigure(allocateType(this),name,document,{duration:1,pivot:{x:document.canvas_width/2,y:document.canvas_height/2}}));
  },
  renameMovieclip(name){
    if(!isMovieclip(this.figure))throw messageError(new Error(''), "errors.editorMovieclips.selectAMovieclip", {});
    name=String(name).trim();if(!name||name.length>120)throw messageError(new Error(''), "errors.editorMovieclips.useANameFrom1To120Characters", {});
    if(name===this.figure.name)return;
    return publishDefinition(this,{...this.figure,name},this.report.figure_types.indexOf(this.figure),'Rename movieclip');
  },
  setMovieclipDrawing(uid,group,view){
    const object=this.selectionFrame.objects.find(o=>o.unique_id===uid),figure=this.report.figure_types.find(f=>f.figure_type_id===object?.figure_type_id),drawing=movieclipAsset(figure)?.drawingSets?.[group]?.views?.[view];
    if(!drawing||!Number.isInteger(group)||!Number.isInteger(view))throw messageError(new Error(''), "errors.editorMovieclips.chooseAnExistingDrawing", {});
    if(uid!==this.selectedUid&&object.join?.target_unique_id!==this.selectedUid)throw messageError(new Error(''), "errors.editorMovieclips.selectTheDrawingOrItsParentRig", {});
    if(layerLocked(this.report,uid))throw messageError(new Error(''), "errors.editorMovieclips.unlockTheDrawingLayerBeforeChangingIt", {});
    const settings=validatePlayback({...playbackSettings(object),mode:'single',offset:drawing.frame});
    return this._objectEdit('Change drawing',()=>{this.frame.objects.find(o=>o.unique_id===uid)._stykMovieclip=settings;});
  },
  setMovieclipPlayback(patch,{allFrames=false}={}){
    if(!isMovieclip(this.figure))throw messageError(new Error(''), "errors.editorMovieclips.selectAMovieclip", {});
    const settings=validatePlayback({...playbackSettings(this.object),...patch});
    if(usesPresence(this.object)&&this.report._styk?.layerSheet&&allFrames)return this.sheetSetMovieclipPlayback(this.selectedUid,patch,{allFrames});
    if(allFrames){
      return this.movieclipTimelineEdit('Set movieclip playback',()=>{
        this._editMovieclipPoses('Set movieclip playback',object=>{object._stykMovieclip=settings;});return settings;
      });
    }
    this._objectEdit('Set movieclip playback',object=>{object._stykMovieclip=settings;});return settings;
  },
  restartMovieclip(){
    if(!isMovieclip(this.figure))throw messageError(new Error(''), "errors.editorMovieclips.selectAMovieclip", {});
    const p=playbackSettings(this.object),tick=Math.round(this.tick);
    const restarts=[...(p.restarts??[]).filter(key=>key.tick!==tick),{tick,offset:0}].sort((a,b)=>a.tick-b.tick);
    return this.setMovieclipPlayback({restarts},{allFrames:true});
  },
  removeMovieclipRestart(){
    if(!isMovieclip(this.figure))throw messageError(new Error(''), "errors.editorMovieclips.selectAMovieclip", {});
    return this.setMovieclipPlayback({restarts:(playbackSettings(this.object).restarts??[]).filter(key=>key.tick!==this.tick)},{allFrames:true});
  },
  placeMovieclip(patch,{move=false}={}){
    if(!isMovieclip(this.figure))throw messageError(new Error(''), "errors.editorMovieclips.selectAMovieclip", {});
    const uid=this.selectedUid,previous=playbackSettings(this.object),tick=this.tick,delta=move?(patch.start??previous.start)-previous.start:0;
    const next=validatePlayback({...previous,...patch,...(move&&previous.restarts?{
      offset:movieclipTime(movieclipAsset(this.figure),previous,previous.start,this.report.fps)??previous.offset,
      restarts:previous.restarts.filter(key=>key.tick>=previous.start).map(key=>({...key,tick:key.tick+delta}))}:{})});
    return this.movieclipTimelineEdit('Set movieclip timing',()=>{
      const channel=this._movieclipPoseChannel();
      this._editMovieclipPoses('Set movieclip timing',object=>{object._stykMovieclip=next;});
      const channels=this.animationChannels.filter(c=>c.target.uid===uid).map(c=>{
        const source=c.property==='pose'?channel:c;
        return {...source,movieclipCurve:true,keys:source.keys.map(key=>({...key,tick:key.tick+delta})),
          ...(source.maskedRanges?{maskedRanges:source.maskedRanges.map(([a,b])=>[Math.max(0,a+delta),b+delta]).filter(([a,b])=>b>a)}:{}),
          ...(source.property==='pose'?{clipEnd:next.end??0}:{})};
      });
      if(!channels.some(c=>c.property==='pose'))channels.push({...channel,keys:channel.keys.map(key=>({...key,tick:key.tick+delta})),clipEnd:next.end??0});
      if(!move&&next.start<previous.start){
        const owner=channels.find(c=>c.property==='pose');
        if(owner.keys[0]?.tick>next.start)owner.keys=[{...owner.keys[0],id:`clip-trim-${uid}-${next.start}`,tick:next.start},...owner.keys];
      }
      publishChannels(this,channels,'Set movieclip timing');
      this.seek(Math.max(next.start,Math.min(next.end===null?tick:next.end-1,tick+delta)));this.select(uid);return next;
    });
  },
  _movieclipPoseChannel(){
    const uid=this.selectedUid,target={kind:'figure',uid},own=this.animationChannel(target,'pose')??(this.report._styk?.layerSheet?this.nativePoseChannel(target):null);
    if(!own)return poseChannel(this,uid,[{tick:playbackSettings(this.object).start,frame:this.evaluatedFrame}]);
    // Older clips stored redundant blank boundary keys. Bounds now gate the
    // instance, so those keys must never truncate a curve when extending it.
    const first=own.keys.findIndex(k=>k.value?.frameId!==null),last=own.keys.findLastIndex(k=>k.value?.frameId!==null);
    return {...own,nativeProperties:undefined,useBasePose:undefined,keys:first<0?[]:own.keys.slice(first,last+1)};
  },
  splitMovieclip(tick=this.tick){
    if(!isMovieclip(this.figure))throw messageError(new Error(''), "errors.editorMovieclips.selectAMovieclip", {});
    const p=playbackSettings(this.object),figure=this.figure,oldUid=this.selectedUid;
    if(!Number.isInteger(tick)||tick<=p.start||p.end!==null&&tick>=p.end)throw messageError(new Error(''), "errors.editorMovieclips.placeThePlayheadInsideTheMovieclip", {});
    const originalChannels=this.animationChannels.filter(c=>c.target.uid===oldUid&&c.property!=='pose');
    const settings=validatePlayback({...p,start:tick,offset:movieclipTime(movieclipAsset(figure),p,tick,this.report.fps)??p.offset,restarts:(p.restarts??[]).filter(k=>k.tick>tick)});
    return this.movieclipTimelineEdit('Split movieclip',()=>{
      const originalPose=this._movieclipPoseChannel();
      const uid=this._identity(),sources=new Map();
      const second={...originalPose,target:{kind:'figure',uid},id:animationChannelId({kind:'figure',uid},'pose'),clipEnd:p.end??0,orderAnchor:oldUid,
        keys:originalPose.keys.map(key=>{
          const id=key.value?.frameId;if(id===null)return clone(key);
          if(!sources.has(id)){
            const frame=snapshotPoseFrame(this.getFrameById(id),[oldUid]);
            for(const object of frame.objects)if(object.unique_id===oldUid){object.unique_id=uid;object._stykMovieclip=settings;}
            setOrder(frame,frameOrder(frame).map(id=>id===oldUid?uid:id));normalizeFrame(frame);
            sources.set(id,this.captureFrameSource(frame));
          }
          return {...clone(key),value:{frameId:sources.get(id)}};
        })};
      const channels=originalChannels.map(c=>({...c,target:{...c.target,uid},id:animationChannelId({...c.target,uid},c.property)}));
      assignChildrenLayer(this,[uid],this.layerForUid(oldUid));
      this.placeMovieclip({end:tick});
      publishChannels(this,[second,...channels],'Split movieclip');
      this.seek(tick);this.select(uid);return this.object;
    });
  },
  makeMovieclipUnique(){
    if(!isMovieclip(this.figure))throw messageError(new Error(''), "errors.editorMovieclips.selectAMovieclip", {});
    return this.movieclipBatch('Make movieclip unique',()=>{
      const figure={...this.figure,figure_type_id:allocateType(this),name:`${this.figure.name} copy`};
      if(this.report._styk?.layerSheet){
        const tick=Math.round(this.tick),previous=this.selectedUid,original=this.object,uid=this._identity();
        const frame=snapshotPoseFrame(this.selectionFrame,[previous]),object=frame.objects.find(object=>object.unique_id===previous);
        object.unique_id=uid;object.figure_type_id=figure.figure_type_id;
        object._stykMovieclip=presencePlayback({mode:object._stykMovieclip?.mode??'loop',speed:object._stykMovieclip?.speed??1,
          offset:original._movieclipSample??at(this.report,tick).objects.find(object=>object.unique_id===previous)?._movieclipSample??object._stykMovieclip?.offset??0});
        for(const member of frame.objects)if(member.join?.target_unique_id===previous)member.join.target_unique_id=uid;
        setOrder(frame,frameOrder(frame).map(id=>id===previous?uid:id));normalizeFrame(frame);
        // This is a conversion of the displayed pose, like Break Apart. Keep
        // the original's consumed step so its other appearances do not shift.
        setContinuations(frame,usesPresence(original)?[{uid:previous,typeId:original.figure_type_id,playback:clone(original._stykMovieclip)}]:[]);
        publishDefinition(this,figure);
        this.sheetReplaceMovieclipFrames([{tick,frame}],previous,[uid],'Make movieclip unique',{replacementUid:uid});
        this.seek(tick);this.select(uid);return figure;
      }
      publishDefinition(this,figure);
      this._editMovieclipPoses('Make movieclip unique',object=>{object.figure_type_id=figure.figure_type_id;});return figure;
    });
  },
  breakApartMovieclip(){
    if(!isMovieclip(this.figure))throw messageError(new Error(''), "errors.editorMovieclips.selectAMovieclip", {});
    const tick=Math.round(this.tick),uid=this.selectedUid,source=this.evaluatedFrame;
    const materializer=createMovieclipMaterializer(this.report),expanded=this._expandMovieclipPose(source,uid,materializer);
    const object=this.object,step=usesPresence(object)?{uid,typeId:object.figure_type_id,playback:clone(object._stykMovieclip)}:null;
    return this.movieclipTimelineEdit('Break apart frame',()=>this._publishExpandedMovieclip([{tick,frame:expanded}],uid,materializer,{start:tick,end:tick+1,label:'Break apart frame',reuseParts:true,step}));
  },
  _expandMovieclipPose(frame,uid,materializer){
    const object=frame.objects.find(o=>o.unique_id===uid);if(!object)return createFrame();
    const root=buildGeometry(this.report,frame).objects.get(object.object_slot)?.root??{x:object.root_x,y:object.root_y};
    return materializer.frame(createFrame([{...object,object_slot:0,join:null,root_x:root.x,root_y:root.y}]));
  },
  _publishExpandedMovieclip(frames,uid,materializer,{start,end,label,reuseParts=false,step=null}){
    const existing=new Set(this.report.figure_types.map(f=>f.figure_type_id));
    for(const figure of materializer.figures)if(!existing.has(figure.figure_type_id))publishDefinition(this,figure);
    const parts=new Map(this.animationChannels.filter(c=>reuseParts&&c.property==='pose'&&c.movieclipPart?.instance===uid).map(c=>[c.movieclipPart.path,c]));
    if(reuseParts&&this.report._styk?.layerSheet)for(const frame of Object.values(this.report._styk.frameSources??{}))for(const object of frame.objects){
      const part=object._stykMovieclipPart;
      if(part?.instance===uid&&!parts.has(part.path))parts.set(part.path,this.nativePoseChannel({kind:'figure',uid:object.unique_id}));
    }
    const paths=new Map([...materializer.identities].map(([path,id])=>[id,path])),ids=new Map(),partPaths=new Map();
    for(const {frame} of frames)for(const object of frame.objects)if(!ids.has(object.unique_id)){
      const path=paths.get(object.unique_id),id=parts.get(path)?.target.uid??this._identity();ids.set(object.unique_id,id);partPaths.set(id,path);
    }
    for(const {frame} of frames){
      const order=frameOrder(frame).map(id=>ids.get(id));
      for(const object of frame.objects){object.unique_id=ids.get(object.unique_id);if(reuseParts)object._stykMovieclipPart={instance:uid,path:partPaths.get(object.unique_id)};}
      setOrder(frame,order);normalizeFrame(frame);
    }
    if(this.report._styk?.layerSheet){
      const replacements=[];
      for(const entry of frames){
        const original=at(this.report,entry.tick).objects.find(object=>object.unique_id===uid);
        if(!original)continue;
        setContinuations(entry.frame,usesPresence(original)?[{uid,typeId:original.figure_type_id,playback:clone(original._stykMovieclip)}]:[]);
        replacements.push(entry);
      }
      const children=[...ids.values()];this.sheetReplaceMovieclipFrames(replacements,uid,children,label);
      this.seek(start);this._selectIds(children);this._emit('selection');return children;
    }
    const children=[...ids.values()],channels=[maskedPose(this,uid,start,end)];
    // One immutable source sequence is shared by all children. A large assembly
    // costs poses × objects, never one full scene copy for every child track.
    const shared=children.length?poseChannel(this,children[0],frames,{start,end,orderAnchor:uid,sourceUids:children}):null;
    for(const id of children){
      const target={kind:'figure',uid:id},path=partPaths.get(id),previous=parts.get(path);
      let keys=shared.keys;
      if(previous){
        const atEnd=sampleAnimationChannel(previous,end)??{frameId:null},merged=new Map(previous.keys.map(k=>[k.tick,k]));
        for(const key of keys)if(key.tick>=start)merged.set(key.tick,{...key,id:`clip-part-${id}-${key.tick}`,value:key.tick===end?atEnd:key.value});
        keys=[...merged.values()].sort((a,b)=>a.tick-b.tick);
      }
      channels.push({...shared,target,id:animationChannelId(target,'pose'),keys,...(reuseParts?{movieclipPart:{instance:uid,path}}:{})});
    }
    assignChildrenLayer(this,children,this.layerForUid(uid));publishChannels(this,channels,label,{preserveDuration:true,continuation:step?{start,end,step}:null});
    this.seek(start);this._selectIds(children);this._emit('selection');return children;
  },
  async bakeMovieclip(){
    if(!isMovieclip(this.figure))throw messageError(new Error(''), "errors.editorMovieclips.selectAMovieclip", {});
    if(this._drag)this.commitDrag();if(this._animationEdit)this.commitAnimationEdit();
    const report=this.report,revision=this.revision,uid=this.selectedUid,p=playbackSettings(this.object),start=p.clock==='presence'?0:p.start,end=Math.min(p.end??this.totalTicks,this.totalTicks);
    if(end-start>5000)throw messageError(new Error(''), "errors.editorMovieclips.bakeSupportsScenesUpTo5000Frames", {});
    const materializer=createMovieclipMaterializer(report),frames=[];let count=0,lastYield=performance.now();
    for(let tick=start;tick<end;tick++){
      const frame=this._expandMovieclipPose(at(report,tick),uid,materializer);
      count+=frame.objects.length;if(count>250000)throw messageError(new Error(''), "errors.editorMovieclips.bakeAShorterRangeForThisScene", {});
      frames.push({tick,frame});
      if(performance.now()-lastYield>6){await new Promise(resolve=>setTimeout(resolve,0));lastYield=performance.now();if(this.report!==report||this.revision!==revision)throw messageError(new Error(''), "errors.editorMovieclips.theSceneChangedWhileBakingTryAgain", {});}
    }
    if(!frames.length)return false;
    return this.movieclipTimelineEdit('Bake animation',()=>this._publishExpandedMovieclip(frames,uid,materializer,{start,end,label:'Bake animation'}));
  },
  enterMovieclip(typeId=this.figure?.figure_type_id){
    if(drawingResourcesFor(this.report)?.stats.unpublished)throw messageError(new Error(''), "errors.editorMovieclips.finishDrawingPublicationBeforeEditingAMovieclip", {});
    const figure=this.report.figure_types.find(f=>f.figure_type_id===typeId);if(!isMovieclip(figure))throw messageError(new Error(''), "errors.editorMovieclips.chooseAMovieclip", {});
    if(movieclipAsset(figure).spatialMeshes)throw messageError(new Error(''), "errors.editorMovieclips.thisIsAnAttachedMeshPoseItsParent", {});
    if(this._drag)this.commitDrag();if(this._animationEdit)this.commitAnimationEdit();
    const scopes=this._movieclipScopes??[],parent={};
    for(const key of Object.keys(this))if(key!=='_movieclipScopes')parent[key]=this[key];
    const document=clone(movieclipAsset(figure).document);
    this.load(document,figure.name,{preserveDrawingResources:true});this._movieclipScopes=[...scopes,{parent,typeId,name:figure.name}];
    this._emit('movieclip-scope',{structural:true,timing:true});return this;
  },
  movieclipProjectReport(){
    let document=this.report;
    for(const scope of [...(this._movieclipScopes??[])].reverse()){
      const parent=scope.parent.report,rows=timeline(storedFrameReport(document,{validate:false}));
      document={...parent,_styk:{...parent._styk},figure_types:parent.figure_types.map(figure=>figure.figure_type_id!==scope.typeId?figure:
        {...figure,_styk:{...figure._styk,movieclip:{...movieclipAsset(figure),document,duration:Math.max(1,rows.at(-1)?.end??((rows.at(-1)?.start??0)+(rows.at(-1)?.count??1)))}}})};
    }
    return document;
  },
  leaveMovieclip({save=true}={}){
    const scopes=this._movieclipScopes;if(!scopes?.length)return false;
    if(this._drag)this.commitDrag();if(this._animationEdit)this.commitAnimationEdit();
    if(save&&this._frameDraftEnabled)this.disableFrameDrafts();
    if(save&&drawingResourcesFor(this.report)?.stats.unpublished)throw messageError(new Error(''), "errors.editorMovieclips.finishDrawingPublicationBeforeLeavingThisMovieclip", {});
    const changed=this.revision!==this._savedRevision;
    const scope=scopes.at(-1),document=save?storedFrameReport(this.report,{validate:false}):null;
    const duration=save?Math.max(1,this.totalTicks):0;
    drawingResourcesFor(this.report)?.dispose();
    // Revisions never repeat across the projects one editor holds (editor-sessions.mjs).
    const serial=this._revisionSerial;
    for(const key of Object.keys(this))if(key!=='_movieclipScopes')delete this[key];
    Object.assign(this,scope.parent);this._movieclipScopes=scopes.slice(0,-1);this._revisionSerial=Math.max(this._revisionSerial,serial);
    if(save&&changed){
      const index=this.report.figure_types.findIndex(f=>f.figure_type_id===scope.typeId),figure=this.report.figure_types[index];
      publishDefinition(this,{...figure,_styk:{...figure._styk,movieclip:{...movieclipAsset(figure),document,duration}}},index,'Edit movieclip');
    }
    this._invalidate({timing:true});this._emit('document',{structural:true,timing:true,movieclipScope:true});return true;
  },
};
