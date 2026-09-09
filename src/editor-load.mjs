/** Prepare all authoritative validation and document indices before publication. */
import {validateSceneSteps} from './pivot/model.mjs';
import {ensureLayerState, validateLayerStateSteps, layerIdForUid} from './layers.mjs';
import {validateAnimationDocumentSteps} from './animation-channels.mjs';
import {validateFrameIdentitySteps} from './editor-frames.mjs';
import {validateSimpleFrameDraft} from './editor-frame-draft.mjs';
import {createFrame} from './demo.mjs';
import {internPoseSequencesSteps} from './pose-sequences.mjs';

const own = (value,key) => Object.prototype.hasOwnProperty.call(value,key);
export const yieldLoadTask = globalThis.scheduler?.yield
  ? () => globalThis.scheduler.yield()
  : () => new Promise(resolve => {
    const channel=new MessageChannel();
    channel.port1.onmessage=()=>{channel.port1.close();channel.port2.close();resolve();};
    channel.port2.postMessage(null);
  });

/** Incoming report ownership transfers to the editor on success. Its pose and
 * definition arrays are never cloned; no current-editor field is changed here. */
export function* prepareEditorLoadSteps(document, {sliceMs=4}={}) {
  const report=document?.document ?? document?.report ?? document;
  // Pivot permits a zero-key animation. Keep one private editable working pose;
  // Simple's stored-frame/export view represents the original zero-key file.
  const empty=report && Array.isArray(report.keyframes) && report.keyframes.length===0;
  if (empty) report.keyframes=[createFrame([],1)];
  yield* validateSceneSteps(report,{sliceMs});
  const layers=ensureLayerState(report);
  yield* validateLayerStateSteps(layers);
  yield* validateAnimationDocumentSteps(report);
  yield* internPoseSequencesSteps(report);
  let nextFrameIdentity=yield* validateFrameIdentitySteps(report);
  if (empty) {
    if (report._styk.simpleFrameDraft !== undefined) throw new Error('An empty native animation cannot contain a saved working frame.');
    if (!Number.isSafeInteger(nextFrameIdentity)) throw new Error('Frame identity capacity exceeded.');
    const id=`frame-${nextFrameIdentity++}`;report.keyframes[0]._styk={frameId:id};
    report._styk.simpleFrameDraft={version:1,mode:'add',index:0,frameId:id,empty:true};
  }
  validateSimpleFrameDraft(report,{validateFrame:false});
  const sources=[];
  let work=0;
  for (const id in report._styk.frameSources ?? {}) if (own(report._styk.frameSources,id)) {
    sources.push(report._styk.frameSources[id]);
    if (++work % 256===0) yield {phase:'retained sources',checked:work};
  }
  if (sources.length) yield* validateSceneSteps({...report,keyframes:sources},{sliceMs});
  if (report._styk.simpleFrameDraft?.baseline)
    yield* validateSceneSteps({...report,keyframes:[report._styk.simpleFrameDraft.baseline]},{sliceMs});
  if (own(report._styk.simpleFrameDraft ?? {}, 'animationBaseline'))
    yield* validateAnimationDocumentSteps({...report, _styk: {...report._styk, animation: report._styk.simpleFrameDraft.animationBaseline}});

  const layerUidCounts=new Map(), layerSeenUids=new Set(), layerGroups=new Map(layers.order.map(id=>[id,new Set()]));
  const figureNames=new Map(), tracks=[], trackByUid=new Map();
  const definitions=new Map();
  for (const figure of report.figure_types) {
    definitions.set(figure.figure_type_id,figure);
    if (++work % 256===0) yield {phase:'indexing',checked:work};
  }
  let nextUid=1;
  const missingIds=[];
  for (let index=0; index<report.keyframes.length+sources.length;index++) {
    const native=index<report.keyframes.length;
    const frame=native ? report.keyframes[index] : sources[index-report.keyframes.length];
    if (native && !frame._styk?.frameId) {
      if (!Number.isSafeInteger(nextFrameIdentity)) throw new Error('Frame identity capacity exceeded.');
      missingIds.push({frame,id:`frame-${nextFrameIdentity++}`});
    }
    for (const object of frame.objects) {
      const uid=object.unique_id;
      nextUid=Math.max(nextUid,uid+1);
      layerUidCounts.set(uid,(layerUidCounts.get(uid)??0)+1);
      if (!layerSeenUids.has(uid)) {
        layerSeenUids.add(uid); layerGroups.get(layerIdForUid(report,uid)).add(uid);
      }
      if (native) {
        let track=trackByUid.get(uid);
        if (!track) {
          const name=object._styk?.name || definitions.get(object.figure_type_id)?.name || `Figure ${uid}`;
          figureNames.set(uid,{name,figureTypeId:object.figure_type_id});
          track={uid,name,typeId:object.figure_type_id,frames:[]}; trackByUid.set(uid,track);tracks.push(track);
        }
        track.frames.push(index);
      }
      if (++work % 256===0) yield {phase:'indexing',checked:work};
    }
    if (++work % 256===0) yield {phase:'indexing',checked:work};
  }
  // Normalize the incoming owned report in bounded batches too. Publishing only
  // adopts completed indices; it never performs an animation-length ID loop.
  for (const {frame,id} of missingIds) {
    frame._styk={...frame._styk,frameId:id};
    if (++work % 256===0) yield {phase:'identities',checked:work};
  }
  return {report,nextFrameIdentity,nextUid,layerUidCounts,layerSeenUids,layerGroups,figureNames,tracks};
}

export function prepareEditorLoad(document) {
  const iterator=prepareEditorLoadSteps(document,{sliceMs:Infinity});
  for (;;) {const step=iterator.next();if(step.done)return step.value;}
}

export async function prepareEditorLoadAsync(document,{sliceMs=4,signal,onProgress,yieldControl=yieldLoadTask,checkCurrent=()=>{}}={}) {
  if (!Number.isFinite(sliceMs)||sliceMs<=0||sliceMs>16) throw new Error('Import time slices must be greater than zero and at most 16 milliseconds.');
  const check=()=>{if(signal?.aborted)throw new DOMException('Import cancelled.','AbortError');checkCurrent();};
  check();
  const iterator=prepareEditorLoadSteps(document,{sliceMs}),timings={started:performance.now(),slices:0,maxSliceMs:0,workMs:0,phases:{}};
  try {
    for (;;) {
      check(); const started=performance.now();let step;
      do {step=iterator.next();} while(!step.done && performance.now()-started<sliceMs);
      const elapsed=performance.now()-started;
      timings.slices++;timings.maxSliceMs=Math.max(timings.maxSliceMs,elapsed);timings.workMs+=elapsed;
      if(step.done){check();timings.preparedMs=performance.now()-timings.started;return {...step.value,timings};}
      timings.phases[step.value.phase]=(timings.phases[step.value.phase]??0)+elapsed;
      onProgress?.(step.value);check();await yieldControl();
    }
  } finally {iterator.return();}
}
