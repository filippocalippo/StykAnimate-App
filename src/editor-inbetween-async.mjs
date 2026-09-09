/** Cancellable background planning and bounded, unpublished history staging. */
import {planInsertInbetweenSteps,INBETWEEN_LIMITS} from './editor-inbetween.mjs';
import {validateSceneSteps} from './pivot/model.mjs';
import {validateAnimationDocumentSteps} from './animation-channels.mjs';
import {nativeTimeline} from './pivot/geometry.mjs';
import {yieldLoadTask} from './editor-load.mjs';

const clone=value=>structuredClone(value);
const abort=message=>new DOMException(message,'AbortError');
const header=animation=>{const {channels,...fields}=animation;return {exists:true,fields};};
export function inbetweenPlanWire(plan) {
  const before=new Map(plan.animation?.before.channels.map(channel=>[channel.id,channel])??[]);
  return {version:1,entries:plan.entries.map(({pose,geometry,...entry})=>entry),skippedIndices:plan.skippedIndices,nextFrameIdentity:plan.nextFrameIdentity,
    animation:plan.animation?{channelUpdates:plan.animation.after.channels.filter(channel=>channel!==before.get(channel.id)).map(channel=>({id:channel.id,channel})),
      channelOrder:plan.animation.after.channels.map(channel=>channel.id),nextKeyId:plan.animation.after.nextKeyId,sources:plan.animation.sources}:null};
}
async function drain(iterator,check,options) {
  try {for (;;) {
    check();const started=performance.now();let next;
    do{next=iterator.next();}while(!next.done&&performance.now()-started<4);
    if(next.done)return next.value;
    options.onProgress?.(next.value);check();await(options.yieldControl??yieldLoadTask)();
  }}finally{iterator.return();}
}
async function stage(editor,wire,indices,ratio,check,options) {
  const report=editor.report,identity=editor._nextFrameIdentity;
  if(!wire||wire.version!==1||!Array.isArray(wire.entries)||wire.entries.length!==indices.length||
    !Number.isSafeInteger(wire.nextFrameIdentity)||wire.nextFrameIdentity<identity)throw new Error('The inbetween worker returned an invalid plan.');
  const rows=nativeTimeline(report),occupied=new Set([...report.keyframes.map(frame=>frame._styk?.frameId),...Object.keys(report._styk.frameSources??{})]);
  let cumulative=0;
  function checkIdentity(frame) {
    const id=frame?._styk?.frameId,n=Number(id?.slice(6));
    if(!/^frame-[1-9]\d*$/.test(id)||!Number.isSafeInteger(n)||n<identity||n>=wire.nextFrameIdentity||occupied.has(id))throw new Error('Invalid inserted source identity.');
    occupied.add(id);
  }
  for(let i=0;i<indices.length;i++) {
    const entry=wire.entries[i],index=indices[i],duration=report.keyframes[index===0||ratio>0?index:index-1].duration_raw;
    if(entry.index!==index||entry.insertedIndex!==index+i||entry.tick!==rows[index].start+cumulative||entry.duration!==duration||entry.frame?.duration_raw!==duration)
      throw new Error('The inbetween worker returned inconsistent frame positions or durations.');
    checkIdentity(entry.frame);cumulative+=duration;
  }
  const before=report._styk.animation,afterById=new Map((before?.channels??[]).map(channel=>[channel.id,channel]));
  let animation=null;const sourceFrames=wire.animation?.sources??[];
  if(!Array.isArray(sourceFrames))throw new Error('Invalid inbetween source table.');
  if(wire.nextFrameIdentity!==identity+wire.entries.length+sourceFrames.length)throw new Error('Invalid inserted source identity counter.');
  if(wire.animation){
    if(!before?.channels?.length||!Array.isArray(wire.animation.channelUpdates)||!Array.isArray(wire.animation.channelOrder))throw new Error('Invalid inbetween animation update.');
    const changed=new Set();
    for(const update of wire.animation.channelUpdates){
      if(!update||changed.has(update.id)||!afterById.has(update.id)||update.channel?.id!==update.id)throw new Error('Invalid inbetween channel identity.');
      changed.add(update.id);afterById.set(update.id,update.channel);
    }
    const order=wire.animation.channelOrder;
    if(order.length!==afterById.size||new Set(order).size!==order.length||order.some(id=>!afterById.has(id)))throw new Error('Invalid inbetween channel order.');
    const after={...before,nextKeyId:wire.animation.nextKeyId,channels:order.map(id=>afterById.get(id))};
    animation={before,after,sources:sourceFrames,patch:{before:header(before),after:header(after),changes:before.channels.flatMap((channel,index)=>{
      const next=afterById.get(channel.id);return next===channel?[]:[{id:channel.id,before:{exists:true,index,channel},after:{exists:true,index:order.indexOf(channel.id),channel:next}}];
    })}};
  } else if(before?.channels?.length)throw new Error('The inbetween plan omitted authored animation.');
  for(const frame of sourceFrames)checkIdentity(frame);
  const frames=[...wire.entries.map(entry=>entry.frame),...sourceFrames];
  if(frames.length)await drain(validateSceneSteps({...report,keyframes:frames}),check,options);
  const sourceTable={...report._styk.frameSources};for(const frame of sourceFrames)sourceTable[frame._styk.frameId]=frame;
  if(animation)await drain(validateAnimationDocumentSteps({...report,_styk:{...report._styk,animation:animation.after,frameSources:{...sourceTable,
    ...Object.fromEntries(wire.entries.map(entry=>[entry.frame._styk.frameId,entry.frame]))}}}),check,options);

  const preparedFrames=[],preparedFrameSources={},nativeCounts=new Map(),sourceCounts=new Map();
  let bytes=1024,objects=0,values=0,lastYield=performance.now(),completed=0;
  const pause=async()=>{options.onProgress?.({phase:'staging',completed,total:frames.length});await(options.yieldControl??yieldLoadTask)();check();lastYield=performance.now();};
  for(const frame of frames){
    const copy=clone({...frame,objects:[]}),counts=completed<wire.entries.length?nativeCounts:sourceCounts;
    bytes+=JSON.stringify(copy).length*2;
    for(const {runtime_segments,...object} of frame.objects){
      objects++;values+=(object.angles?.length??0)+(object.lengths?.length??0)+(object.bends?.length??0);
      if(objects>INBETWEEN_LIMITS.objectPoses||values>INBETWEEN_LIMITS.segmentValues)throw new Error('The inbetween plan exceeds the captured-pose budget.');
      copy.objects.push(clone(object));bytes+=JSON.stringify(object).length*2;
      counts.set(object.unique_id,(counts.get(object.unique_id)??0)+1);
      if(performance.now()-lastYield>=4)await pause();
    }
    if(completed<wire.entries.length)preparedFrames.push(copy);else preparedFrameSources[frame._styk.frameId]=copy;
    completed++;if(performance.now()-lastYield>=4||completed===frames.length)await pause();
  }
  // Account for sparse channel snapshots one key at a time; no large stringify
  // or clone occurs in the publication/history task.
  for(const change of animation?.patch.changes??[])for(const side of ['before','after']){
    bytes+=512;
    for(const key of change[side].channel.keys){bytes+=JSON.stringify(key).length*2;if(performance.now()-lastYield>=4)await pause();}
  }
  const keyframes=[];let entryIndex=0;
  for(let index=0;index<report.keyframes.length;index++){
    if(wire.entries[entryIndex]?.index===index)keyframes.push(preparedFrames[entryIndex++]);
    keyframes.push(report.keyframes[index]);if(performance.now()-lastYield>=4)await pause();
  }
  check();return {entries:wire.entries,skippedIndices:wire.skippedIndices??[],nextFrameIdentity:wire.nextFrameIdentity,animation,
    prepared:{keyframes,preparedFrameSources,frameUidCounts:{before:[],after:[...nativeCounts]},frameSourceUidCounts:{before:[],after:[...sourceCounts]},precomputedBytes:bytes*2}};
}
export const editorInbetweenAsyncMethods={
  setInbetweenPlanner(planner){if(planner!==null&&typeof planner!=='function')throw new Error('Provide an inbetween planning function.');this._inbetweenPlanner=planner;return this;},
  async insertInbetweenFramesAsync(ratio=.5,indices=[this.frameIndex],options={}){
    const started=performance.now();
    if(typeof ratio!=='number'||!Number.isFinite(ratio)||ratio<0||ratio>1)throw new Error('Choose an interpolation ratio from zero to one.');
    indices=this._frameIndices(indices);
    if(indices.length>INBETWEEN_LIMITS.insertedFrames||this.report.keyframes.length+indices.length>100000)throw new Error('Insert fewer inbetweens within the native frame limit.');
    if(!indices.length)return this._commitInbetweenPlan({entries:[],skippedIndices:[]},ratio);
    if(this._animationEdit)this.commitAnimationEdit();if(this._drag)this.commitDrag();
    this._beforeFrameDraftGlobalEdit?.();
    const report=this.report,revision=this.revision,identity=this._nextFrameIdentity,frame=this.frameIndex,tick=this.tick,draft=this.frameDraftRevision;
    const check=()=>{if(options.signal?.aborted)throw abort('Inbetween insertion cancelled.');
      if(this.report!==report||this.revision!==revision||this._nextFrameIdentity!==identity||this.frameIndex!==frame||this.tick!==tick||this.frameDraftRevision!==draft||this._drag||this._animationEdit)
        throw abort('The animation changed while inbetweens were prepared.');};
    check();const planner=options.planInbetweens??this._inbetweenPlanner;
    const wire=planner?await planner({ratio,indices,nextFrameIdentity:identity},{signal:options.signal,onProgress:options.onProgress})
      :inbetweenPlanWire(await drain(planInsertInbetweenSteps(this,ratio,indices),check,options));
    check();const stagingStart=performance.now(),plan=await stage(this,wire,indices,ratio,check,options);check();
    const commitStart=performance.now(),result=this._commitInbetweenPlan(plan,ratio);
    this.lastInbetweenTimings={totalMs:performance.now()-started,stagingMs:commitStart-stagingStart,commitMs:performance.now()-commitStart,
      insertedFrames:result.insertedFrames,historyBytes:plan.prepared.precomputedBytes,worker:Boolean(planner)};
    return result;
  },
};
