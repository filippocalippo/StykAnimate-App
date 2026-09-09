/** Native paste publication touches only inserted poses and appended assets.
 * History snapshots never alias the mutable report-owned copies. */
import {validateSceneSteps} from './pivot/model.mjs';
import {validateLayerStateSteps,layerIdForUid,FIXED_LAYER_IDS} from './layers.mjs';
import {nativeTimeline} from './pivot/geometry.mjs';
import {invalidateFrameIndex} from './frame-ids.mjs';
import {yieldLoadTask} from './editor-load.mjs';

const preparedStates=new WeakMap(),commandCopies=new WeakMap();
const own=(value,key)=>Object.prototype.hasOwnProperty.call(value,key);
const abort=()=>new DOMException('The animation changed while pasted frames were prepared.','AbortError');
const invalid=message=>{throw new Error(`Invalid pasted frames: ${message}.`);};
const record=value=>value&&typeof value==='object'&&!Array.isArray(value);
const integer=(value,min,max)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
const timingFields=()=>({elapsedMs:0,cpuMs:0,maxTaskMs:0,slices:0,yields:0});
function phaseMeter(timings,name){
  const value=timings.phases[name],started=performance.now();let taskStart=started;
  const endSlice=()=>{if(taskStart===null)return;const duration=performance.now()-taskStart;
    value.cpuMs+=duration;value.maxTaskMs=Math.max(value.maxTaskMs,duration);value.slices++;taskStart=null;};
  return {pause(){endSlice();value.yields++;},resume(){taskStart=performance.now();},
    finish(){endSlice();value.elapsedMs+=performance.now()-started;}};
}
function* copySteps(input,account){
  const seen=new Map(),pending=[];let work=0,lastCheckpoint=0;
  const write=(out,key,value)=>{
    if(key==='__proto__')Object.defineProperty(out,key,{value,writable:true,enumerable:true,configurable:true});
    else out[key]=value;
  };
  // Pose vectors dominate large clips. Enumerate arrays without allocating a
  // second array of string indices, and copy numbers directly in small batches.
  // Own custom keys and holes follow the same rules as ordinary object copying.
  function* arraySteps(value,out){
    let batch=0;
    for(const key in value){
      if(!own(value,key))continue;
      const item=value[key];
      if(typeof item==='number'&&key!=='__proto__'){out[key]=item;account.bytes+=16;}
      else write(out,key,copy(item));
      account.bytes+=key.length*2+24;work++;
      if(++batch===2048){batch=0;yield {phase:'staging',completed:work};}
    }
  }
  const copy=value=>{
    if(value===null||typeof value!=='object'){
      account.bytes+=typeof value==='string'?value.length*2+16:16;
      if(typeof value==='function'||typeof value==='symbol'||typeof value==='bigint')invalid('unsupported property');
      return value;
    }
    if(seen.has(value))return seen.get(value);
    if(!Array.isArray(value)&&Object.getPrototypeOf(value)!==Object.prototype&&Object.getPrototypeOf(value)!==null)invalid('unsupported record');
    const out=Array.isArray(value)?new Array(value.length):Object.create(Object.getPrototypeOf(value));
    seen.set(value,out);pending.push(Array.isArray(value)?{iterator:arraySteps(value,out)}:{value,out,keys:Object.keys(value),index:0});account.bytes+=48;
    return out;
  };
  const output=copy(input);
  while(pending.length){
    const entry=pending.at(-1);
    if(entry.iterator){
      const index=pending.length-1,next=entry.iterator.next();
      // Copying an object-valued array may queue child records above its walker.
      if(next.done)pending.splice(index,1);
      if(!next.done||work-lastCheckpoint>=256){lastCheckpoint=work;yield {phase:'staging',completed:work};}
      continue;
    }
    if(entry.index===entry.keys.length){pending.pop();continue;}
    const key=entry.keys[entry.index++],value=copy(entry.value[key]);
    write(entry.out,key,value);
    account.bytes+=key.length*2+24;
    if(++work-lastCheckpoint>=256){lastCheckpoint=work;yield {phase:'staging',completed:work};}
  }
  return output;
}
async function drain(iterator,check,options,timings,phase){
  let first=true;const meter=phaseMeter(timings,phase);
  try{for(;;){check();const started=performance.now();let next;
    do{next=iterator.next();}while(!next.done&&!first&&performance.now()-started<4);
    if(next.done){check();return next.value;}first=false;
    options.onProgress?.({...next.value,phase:'staging'});check();meter.pause();await(options.yieldControl??yieldLoadTask)();meter.resume();}}
  finally{iterator.return();meter.finish();}
}
function assetLayerState(state,patch){
  if(!record(patch)||!Array.isArray(patch.additions)||!Array.isArray(patch.assignments)||
    patch.beforeNextId!==state.nextId||patch.orderIndex!==state.order.length||
    !integer(patch.afterNextId,state.nextId,Number.MAX_SAFE_INTEGER))invalid('layer patch');
  const seen=new Set();
  for(const entry of patch.additions){
    if(!record(entry)||typeof entry.id!=='string'||own(state.byId,entry.id)||seen.has(entry.id))invalid('new layer identity');
    seen.add(entry.id);state.byId[entry.id]=entry.value;state.order.push(entry.id);
  }
  state.nextId=patch.afterNextId;seen.clear();
  for(const entry of patch.assignments){
    const uid=Number(entry?.uid);
    if(!record(entry)||!integer(uid,0,0xffffffff)||String(uid)!==String(entry.uid)||seen.has(uid)||!record(entry.before)||
      typeof entry.before.exists!=='boolean'||entry.before.exists!==own(state.assignments,entry.uid)||
      entry.before.exists&&entry.before.value!==state.assignments[entry.uid]||!own(state.byId,entry.after))invalid('layer assignment');
    seen.add(uid);state.assignments[entry.uid]=entry.after;
  }
  return state;
}
function applyAssets(editor,assets,forward,copies){
  const report=editor.report;
  const figures=forward?copies.figures:[],backgrounds=forward?copies.backgrounds:[];
  if(forward){report.figure_types.push(...figures);(report.backgrounds??=[]).push(...backgrounds);}
  else{
    copies.figures=report.figure_types.splice(assets.figureIndex,assets.figures.length);
    copies.backgrounds=(report.backgrounds??=[]).splice(assets.backgroundIndex,assets.backgrounds.length);
  }
  const patch=assets.layers,state=report._styk.layers;
  for(const entry of patch.additions){if(forward)state.byId[entry.id]=structuredClone(entry.value);else delete state.byId[entry.id];}
  if(forward)state.order.push(...patch.additions.map(entry=>entry.id));else state.order.splice(patch.orderIndex,patch.additions.length);
  state.nextId=forward?patch.afterNextId:patch.beforeNextId;
  for(const entry of patch.assignments){
    if(forward)state.assignments[entry.uid]=entry.after;
    else if(entry.before.exists)state.assignments[entry.uid]=entry.before.value;
    else delete state.assignments[entry.uid];
  }
  editor._layerChanged({reindex:true});
}

async function preparePlan(editor,wire,options,owned,timings){
  const report=editor.report,revision=editor.revision,token=editor._documentToken,frameIndex=editor.frameIndex,tick=editor.tick,
    draft=editor.frameDraftRevision,nextIdentity=editor._nextFrameIdentity,nextUid=editor._nextUid;
  const check=()=>{
    if(options.signal?.aborted)throw new DOMException('Frame paste cancelled.','AbortError');
    if(editor.report!==report||editor.revision!==revision||editor._documentToken!==token||editor.frameIndex!==frameIndex||editor.tick!==tick||
      editor.frameDraftRevision!==draft||editor._nextFrameIdentity!==nextIdentity||editor._nextUid!==nextUid||editor._drag||editor._animationEdit)throw abort();
    if(options.checkCurrent?.()===false)throw abort();
  };
  check();
  if(editor.animationChannels.length||report._styk?.simpleFrameDraft)invalid('native paste requires an ordinary stored frame');
  if(!record(wire)||!integer(wire.index,0,report.keyframes.length)||!Array.isArray(wire.frames)||!wire.frames.length||
    report.keyframes.length+wire.frames.length>100000||!record(wire.assets))invalid('insertion');
  const account={bytes:1024},history=owned?wire:await drain(copySteps(wire,account),check,options,timings,'history'),assets=history.assets;
  if(!Array.isArray(assets.figures)||!Array.isArray(assets.backgrounds)||assets.figureIndex!==report.figure_types.length||
    assets.backgroundIndex!==(report.backgrounds?.length??0)||report.figure_types.length+assets.figures.length>65535)invalid('asset positions');
  const state=await drain(copySteps(report._styk.layers,{bytes:0}),check,options,timings,'layers');
  const layerMeter=phaseMeter(timings,'layers');try{assetLayerState(state,assets.layers);}finally{layerMeter.finish();}
  await drain(validateLayerStateSteps(state),check,options,timings,'layers');
  const indexMeter=phaseMeter(timings,'indexing');
  let required,counts;
  try{
  const definitions=new Map(report.figure_types.map(figure=>[figure.figure_type_id,figure]));required=new Map();
  for(const figure of assets.figures){if(!record(figure)||definitions.has(figure.figure_type_id))invalid('duplicate figure identity');definitions.set(figure.figure_type_id,figure);required.set(figure.figure_type_id,figure);}
  const occupied=new Set([...report.keyframes.map(frame=>frame._styk?.frameId),...Object.keys(report._styk.frameSources??{})]);
  counts=new Map();let maximumUid=nextUid-1,objects=0,work=0,lastYield=performance.now();
  for(const frame of history.frames){
    const id=frame?._styk?.frameId,n=Number(id?.slice(6));
    if(!/^frame-[1-9]\d*$/.test(id)||!Number.isSafeInteger(n)||n<nextIdentity||n>=history.nextFrameIdentity||occupied.has(id))invalid('frame identity');
    occupied.add(id);
    if(!Array.isArray(frame.objects))invalid('pose table');
    for(const object of frame.objects){
      const figure=definitions.get(object.figure_type_id);if(!figure)invalid('unknown figure definition');
      required.set(figure.figure_type_id,figure);counts.set(object.unique_id,(counts.get(object.unique_id)??0)+1);maximumUid=Math.max(maximumUid,object.unique_id);objects++;
      if(++work%256===0){check();if(performance.now()-lastYield>=4){options.onProgress?.({phase:'staging',completed:work});indexMeter.pause();await(options.yieldControl??yieldLoadTask)();indexMeter.resume();check();lastYield=performance.now();}}
    }
  }
  if(objects+report.keyframes.reduce((total,frame)=>total+frame.objects.length,0)>2000000)invalid('object capacity');
  if(history.nextFrameIdentity!==nextIdentity+history.frames.length||!integer(history.nextUid,nextUid,0x100000000)||history.nextUid<=maximumUid)invalid('identity counters');
  for(const entry of assets.layers.assignments)if(!counts.has(Number(entry.uid)))invalid('assignment changes an existing figure');
  }finally{indexMeter.finish();}
  const validation={...report,figure_types:[...required.values()],backgrounds:[...(report.backgrounds??[]),...assets.backgrounds],keyframes:history.frames};
  await drain(validateSceneSteps(validation),check,options,timings,'validation');
  const live=await drain(copySteps({frames:history.frames,assets},account),check,options,timings,'live');
  const selectionMeter=phaseMeter(timings,'selection');
  try{
  const keyframes=[...report.keyframes.slice(0,history.index),...live.frames,...report.keyframes.slice(history.index)];
  const rows=nativeTimeline({...report,keyframes}),selection=history.afterSelection;
  if(!record(selection)||selection.frameIndex!==history.index||selection.tick!==rows[history.index]?.start||selection.uid!==null||
    !Array.isArray(selection.uids)||selection.uids.length||selection.joint!==-1||
    (!own(state.byId,selection.activeLayerId)&&!FIXED_LAYER_IDS.includes(selection.activeLayerId)))invalid('selection');
  check();const prepared={count:history.frames.length};
  preparedStates.set(prepared,{check,history,live,keyframes,rows,counts,bytes:account.bytes*(owned?2:1)});return prepared;
  }finally{selectionMeter.finish();}
}
async function prepare(editor,wire,options,owned){
  const started=performance.now(),timings={...timingFields(),completed:false,ownedHistory:owned,
    phases:Object.fromEntries(['history','layers','indexing','validation','live','selection'].map(name=>[name,timingFields()]))};
  try{const result=await preparePlan(editor,wire,options,owned,timings);timings.completed=true;return result;}
  finally{
    timings.elapsedMs=performance.now()-started;
    for(const phase of Object.values(timings.phases)){
      timings.cpuMs+=phase.cpuMs;timings.maxTaskMs=Math.max(timings.maxTaskMs,phase.maxTaskMs);
      timings.slices+=phase.slices;timings.yields+=phase.yields;
    }
    options.onTiming?.(timings);
  }
}

/** Public callers retain their input; both mutable poses and history are copied. */
export function prepareSparseClipboardPaste(editor,wire,options={}){return prepare(editor,wire,options,false);}
/** Internal worker receiver only: ownership of the decoded wire graph transfers
 * here. Adopt it as history and construct one independent mutable scene copy. */
export function prepareOwnedSparseClipboardPaste(editor,wire,options={}){return prepare(editor,wire,options,true);}

export function applySparseClipboardFrames(editor,command,direction){
  const copies=commandCopies.get(command);if(!copies)return false;
  const forward=direction==='after',removed=forward?editor.report.keyframes.splice(command.index):editor.report.keyframes.splice(command.index,command.after.length);
  if(forward){
    const tail=removed;for(const frame of copies.frames)editor.report.keyframes.push(frame);for(const frame of tail)editor.report.keyframes.push(frame);
  }else copies.frames=removed;
  return true;
}
export function applySparseClipboardAssets(editor,command,direction){
  const copies=commandCopies.get(command);if(!copies)return false;
  applyAssets(editor,command.clipboardAssets,direction==='after',copies);return true;
}
export function commitSparseClipboardPaste(editor,prepared){
  const entry=preparedStates.get(prepared);if(!entry)invalid('prepared command');entry.check();
  const {history,live,keyframes,rows,counts,bytes}=entry;
  const command={kind:'splice',label:'Paste keyframes',index:history.index,before:[],after:history.frames,
    beforeSelection:editor._selectionState(),afterSelection:history.afterSelection,structural:true,timing:true,
    frameUidCounts:{before:[],after:[...counts]},precomputedBytes:bytes};
  Object.defineProperty(command,'clipboardAssets',{value:history.assets});
  const copies={frames:live.frames,figures:live.assets.figures,backgrounds:live.assets.backgrounds};commandCopies.set(command,copies);
  applyAssets(editor,history.assets,true,copies);editor.report.keyframes=keyframes;
  editor._nextFrameIdentity=history.nextFrameIdentity;editor._nextUid=history.nextUid;
  invalidateFrameIndex(editor.report);editor._invalidate({timing:true});editor._timeline=rows;
  editor._restoreSelection(command.afterSelection);
  editor._newLayerHints=new Map([...counts.keys()].map(uid=>[uid,layerIdForUid(editor.report,uid)]));
  editor._record(command);preparedStates.delete(prepared);
  editor._emit('edit',{label:command.label,structural:true,timing:true,prepared:true});return history.frames.length;
}
