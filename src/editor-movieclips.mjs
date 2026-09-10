import {movieclipFigure,movieclipAsset,isMovieclip,playbackSettings,validatePlayback,invalidateMovieclipTypes,movieclipSourceFrames,movieclipTime} from './movieclips.mjs';
import {evaluatedFrame,timeline,buildGeometry} from './pivot/geometry.mjs';
import {createFrame,createObject,emptyDocument} from './demo.mjs';
import {frameOrder,setOrder,normalizeFrame} from './pivot/structure.mjs';
import {layerIdForUid} from './layers.mjs';
import {storedFrameReport} from './pivot-frame-draft.mjs';
import {createMovieclipMaterializer} from './movieclip-materialize.mjs';
import {animationChannelId,validateAnimationDocument,sampleAnimationChannel} from './animation-channels.mjs';
import {snapshotPoseFrame} from './pose-snapshot.mjs';

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
  delete result._stykBackgroundColor;delete result.background_color;
  result._styk={...frame._styk};setOrder(result,frameOrder(frame).filter(uid=>selected.has(uid)));normalizeFrame(result);return result;
}
/** Sparse capture retains the original curves as an immutable baseline. Local
 * stored poses provide editing boundaries; no per-output-frame baking occurs. */
export function captureMovieclip(editor,{start=editor.tick,end=start+1,uids=[...editor.selectedUids],name='Movieclip'}={}){
  if(!Number.isInteger(start)||!Number.isInteger(end)||start<0||end<=start||end>Math.max(editor.totalTicks,start+1))throw new Error('Choose a valid movieclip range.');
  const report=editor.report,selected=new Set(uids);
  if(!selected.size)for(const frame of report.keyframes)for(const obj of frame.objects)selected.add(obj.unique_id);
  if(!selected.size)throw new Error('Select figures to create a movieclip.');
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
  delete metadata.simpleFrameDraft;
  if(metadata.movieclipSource){
    const retained=clone(metadata.movieclipSource.document);
    const prune=document=>{
      document.keyframes=document.keyframes.map(frame=>filteredFrame(frame,selected));
      if(document._styk?.frameSources)document._styk.frameSources=Object.fromEntries(Object.entries(document._styk.frameSources).map(([id,frame])=>[id,filteredFrame(frame,selected)]));
      if(document._styk?.animation)document._styk.animation.channels=document._styk.animation.channels.filter(c=>['figure','segment','polygon'].includes(c.target.kind)?selected.has(c.target.uid):c.target.kind==='layer'&&usedLayers.has(c.target.id));
      if(document._styk?.movieclipSource)prune(document._styk.movieclipSource.document);
    };
    prune(retained);metadata.movieclipSource={...metadata.movieclipSource,document:retained};
  }
  const source={...report,figure_types:clone(report.figure_types.filter(f=>usedTypes.has(f.figure_type_id))),keyframes:frames,backgrounds:[],_styk:metadata};
  // Layer membership is needed by retained layer Pose channels; outside members
  // are harmless but removed from the portable source.
  if(metadata.layers){metadata.layers=clone(metadata.layers);metadata.layers.assignments=Object.fromEntries(Object.entries(metadata.layers.assignments??{}).filter(([uid])=>selected.has(Number(uid))));}
  const rows=timeline(report),ticks=new Set([start,end-1]);
  for(const row of rows)if(row.start>start&&row.start<end)ticks.add(row.start);
  const ordered=[...ticks].sort((a,b)=>a-b);
  const localFrames=ordered.map((tick,i)=>{
    const frame=filteredFrame(at(report,tick),selected);
    frame.duration_raw=(ordered[i+1]??end)-tick;
    frame._styk={easing:clone(frame._styk?.easing),movieclipSourceTick:tick};
    return frame;
  });
  const first=at(report,start),rootObject=first.objects.find(o=>selected.has(o.unique_id)&&!o.join)??first.objects.find(o=>selected.has(o.unique_id));
  const root=rootObject&&buildGeometry(report,first).objects.get(rootObject.object_slot)?.root;
  const document={...source,keyframes:localFrames,_styk:{format:'StykAnimate',format_version:1,name,
    layers:metadata.layers,movieclipSource:{document:{...source,figure_types:[]},inheritFigures:true}}};
  return {figure:movieclipFigure(allocateType(editor),name,document,{duration:end-start,pivot:root??{x:0,y:0}}),selected,start,end};
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
function publishChannels(editor,channels,label){
  if(editor.report._styk?.layerSheet)return editor.sheetApplyChannels(channels,label);
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
    if(positions.length&&positions.at(-1)-positions[0]+1!==positions.length)throw new Error(`Selected figures cross other figures in the stacking order at frame ${tick+1}. Include those figures in the movieclip.`);
  }
}
export const editorMovieclipMethods={
  _insertMovieclip(operation){
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
  movieclipBatch(label,operation){
    if(this._movieclipBatch)return operation();
    const commands=[],revision=this.revision,beforeSelection=this._selectionState();this._movieclipBatch=commands;
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
    return this.editFrameDraftTimeline(()=>this.movieclipBatch(label,()=>{if(this.report._styk?.layerSheet)this._prepareSheetMovieclips();return operation();}));
  },
  createMovieclip(options={}){
    if(this._drag)this.commitDrag();
    const capture=captureMovieclip(this,options);
    if(options.replace!==false)validateReplacementOrder(this,capture.selected,capture.start,capture.end);
    const batch=options.end===undefined?this.movieclipBatch:this.movieclipTimelineEdit;
    return batch.call(this,'Create movieclip',()=>{
      if(this.report._styk?.layerSheet&&options.replace!==false)this._prepareSheetMovieclips();
      publishDefinition(this,capture.figure);
      if(options.replace===false)return capture.figure;
      const {start,selected,figure}=capture;
      const end=options.end===undefined?(this.timeline.find(row=>row.start>start)?.start??this.totalTicks):capture.end;
      if(options.end!==undefined||!this._frameDraftEnabled){
        const source=at(this.report,start),order=frameOrder(source),positions=order.map((uid,i)=>selected.has(uid)?i:-1).filter(i=>i>=0);
        if(positions.length&&positions.at(-1)-positions[0]+1!==positions.length)throw new Error('Select adjacent figures in the stacking order.');
        const uid=this._identity(),pivot=movieclipAsset(figure).pivot,instance=createObject(figure,uid,pivot.x,pivot.y,
          {_stykMovieclip:{start,end,offset:0,speed:1,mode:movieclipAsset(figure).duration===1?'single':'loop'}});
        const frame=createFrame([instance]),anchor=order[positions[0]]??[...selected][0];
        const channels=[...selected].map(id=>maskedPose(this,id,start,end));
        channels.push({...poseChannel(this,uid,[{tick:start,frame}],{start,orderAnchor:anchor}),clipEnd:end});
        assignChildrenLayer(this,[uid],this.layerForUid(anchor));publishChannels(this,channels,'Create movieclip');
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
          if(positions.length&&positions.at(-1)-positions[0]+1!==positions.length)throw new Error('Selected figures overlap other figures in the stacking order. Select the intervening figures too.');
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
    if(!isMovieclip(this.figure))throw new Error('Select a movieclip.');
    name=String(name).trim();if(!name||name.length>120)throw new Error('Use a name from 1 to 120 characters.');
    if(name===this.figure.name)return;
    return publishDefinition(this,{...this.figure,name},this.report.figure_types.indexOf(this.figure),'Rename movieclip');
  },
  setMovieclipPlayback(patch,{allFrames=false}={}){
    if(!isMovieclip(this.figure))throw new Error('Select a movieclip.');
    const settings=validatePlayback({...playbackSettings(this.object),...patch});
    if(allFrames){
      return this.movieclipTimelineEdit('Set movieclip playback',()=>{
        this._editMovieclipPoses('Set movieclip playback',object=>{object._stykMovieclip=settings;});return settings;
      });
    }
    this._objectEdit('Set movieclip playback',object=>{object._stykMovieclip=settings;});return settings;
  },
  restartMovieclip(){
    if(!isMovieclip(this.figure))throw new Error('Select a movieclip.');
    const p=playbackSettings(this.object),tick=Math.round(this.tick);
    const restarts=[...(p.restarts??[]).filter(key=>key.tick!==tick),{tick,offset:0}].sort((a,b)=>a.tick-b.tick);
    return this.setMovieclipPlayback({restarts},{allFrames:true});
  },
  removeMovieclipRestart(){
    if(!isMovieclip(this.figure))throw new Error('Select a movieclip.');
    return this.setMovieclipPlayback({restarts:(playbackSettings(this.object).restarts??[]).filter(key=>key.tick!==this.tick)},{allFrames:true});
  },
  placeMovieclip(patch,{move=false}={}){
    if(!isMovieclip(this.figure))throw new Error('Select a movieclip.');
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
    if(!isMovieclip(this.figure))throw new Error('Select a movieclip.');
    const p=playbackSettings(this.object),figure=this.figure,oldUid=this.selectedUid;
    if(!Number.isInteger(tick)||tick<=p.start||p.end!==null&&tick>=p.end)throw new Error('Place the playhead inside the movieclip.');
    const originalPose=this._movieclipPoseChannel(),originalChannels=this.animationChannels.filter(c=>c.target.uid===oldUid&&c.property!=='pose');
    const settings=validatePlayback({...p,start:tick,offset:movieclipTime(movieclipAsset(figure),p,tick,this.report.fps)??p.offset,restarts:(p.restarts??[]).filter(k=>k.tick>tick)});
    return this.movieclipTimelineEdit('Split movieclip',()=>{
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
    if(!isMovieclip(this.figure))throw new Error('Select a movieclip.');
    return this.movieclipBatch('Make movieclip unique',()=>{
      const figure={...this.figure,figure_type_id:allocateType(this),name:`${this.figure.name} copy`};
      publishDefinition(this,figure);
      this._editMovieclipPoses('Make movieclip unique',object=>{object.figure_type_id=figure.figure_type_id;});return figure;
    });
  },
  breakApartMovieclip(){
    if(!isMovieclip(this.figure))throw new Error('Select a movieclip.');
    const tick=Math.round(this.tick),uid=this.selectedUid,source=this.evaluatedFrame;
    const materializer=createMovieclipMaterializer(this.report),expanded=this._expandMovieclipPose(source,uid,materializer);
    return this.movieclipTimelineEdit('Break apart frame',()=>this._publishExpandedMovieclip([{tick,frame:expanded}],uid,materializer,{start:tick,end:tick+1,label:'Break apart frame',reuseParts:true}));
  },
  _expandMovieclipPose(frame,uid,materializer){
    const object=frame.objects.find(o=>o.unique_id===uid);if(!object)return createFrame();
    const root=buildGeometry(this.report,frame).objects.get(object.object_slot)?.root??{x:object.root_x,y:object.root_y};
    return materializer.frame(createFrame([{...object,object_slot:0,join:null,root_x:root.x,root_y:root.y}]));
  },
  _publishExpandedMovieclip(frames,uid,materializer,{start,end,label,reuseParts=false}){
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
    assignChildrenLayer(this,children,this.layerForUid(uid));publishChannels(this,channels,label);
    this.seek(start);this._selectIds(children);this._emit('selection');return children;
  },
  async bakeMovieclip(){
    if(!isMovieclip(this.figure))throw new Error('Select a movieclip.');
    if(this._drag)this.commitDrag();if(this._animationEdit)this.commitAnimationEdit();
    const report=this.report,revision=this.revision,uid=this.selectedUid,p=playbackSettings(this.object),start=p.start,end=Math.min(p.end??this.totalTicks,this.totalTicks);
    if(end-start>5000)throw new Error('Bake up to 5,000 frames at a time. Trim the movieclip first.');
    const materializer=createMovieclipMaterializer(report),frames=[];let count=0,lastYield=performance.now();
    for(let tick=start;tick<end;tick++){
      const frame=this._expandMovieclipPose(at(report,tick),uid,materializer);
      count+=frame.objects.length;if(count>250000)throw new Error('Bake a shorter range for this scene.');
      frames.push({tick,frame});
      if(performance.now()-lastYield>6){await new Promise(resolve=>setTimeout(resolve,0));lastYield=performance.now();if(this.report!==report||this.revision!==revision)throw new Error('The scene changed while baking. Try again.');}
    }
    if(!frames.length)return false;
    return this.movieclipTimelineEdit('Bake animation',()=>this._publishExpandedMovieclip(frames,uid,materializer,{start,end,label:'Bake animation'}));
  },
  enterMovieclip(typeId=this.figure?.figure_type_id){
    const figure=this.report.figure_types.find(f=>f.figure_type_id===typeId);if(!isMovieclip(figure))throw new Error('Choose a movieclip.');
    if(this._drag)this.commitDrag();if(this._animationEdit)this.commitAnimationEdit();
    const scopes=this._movieclipScopes??[],parent={};
    for(const key of Object.keys(this))if(key!=='_movieclipScopes')parent[key]=this[key];
    const document=clone(movieclipAsset(figure).document);
    this.load(document,figure.name);this._movieclipScopes=[...scopes,{parent,typeId,name:figure.name}];
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
    const changed=this.revision!==this._savedRevision;
    const scope=scopes.at(-1),document=save?storedFrameReport(this.report,{validate:false}):null;
    const duration=save?Math.max(1,this.totalTicks):0;
    for(const key of Object.keys(this))if(key!=='_movieclipScopes')delete this[key];
    Object.assign(this,scope.parent);this._movieclipScopes=scopes.slice(0,-1);
    if(save&&changed){
      const index=this.report.figure_types.findIndex(f=>f.figure_type_id===scope.typeId),figure=this.report.figure_types[index];
      publishDefinition(this,{...figure,_styk:{...figure._styk,movieclip:{...movieclipAsset(figure),document,duration}}},index,'Edit movieclip');
    }
    this._invalidate({timing:true});this._emit('document',{structural:true,timing:true,movieclipScope:true});return true;
  },
};
