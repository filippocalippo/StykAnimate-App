import {prepareEditorLoadAsync,yieldLoadTask} from './editor-load.mjs';
import {validateSceneSteps} from './pivot/model.mjs';
import {validateLayerStateSteps,ensureLayerState} from './layers.mjs';
import {invalidateFrameIndex} from './frame-ids.mjs';
import {storedFrameReport} from './pivot-frame-draft.mjs';
import {createFrame} from './demo.mjs';
import {prepareOwnedSparseClipboardPaste,commitSparseClipboardPaste} from './editor-clipboard-sparse.mjs';
import {prepareClipboardAssetProjection} from './clipboard-asset-plan.mjs';

const snapshots=new WeakMap(),views=new WeakMap();
const aborted=message=>new DOMException(message,'AbortError');
const META='_stykClipboard';

export function frameClipboardView(editor) {
  const frames=editor._frameClipboard;if(!frames?.length)return null;
  let view=views.get(frames);if(view)return view;
  const m=frames[META];if(!m)throw new Error('Copy frames with their referenced assets.');
  const ids=m.layers.order,first=ids[0]??'layer-1';
  const layers={version:1,nextId:Math.max(1,...ids.map(id=>Number(id.slice(6))))+1,
    order:ids.length?ids:['layer-1'],byId:ids.length?m.layers.byId:{'layer-1':{name:'Layer 1',visible:true,locked:false}},
    assignments:m.layers.assignments,defaultLayerId:first,activeId:first};
  view={version:m.version,canvas_width:m.canvas_width,canvas_height:m.canvas_height,fps:m.fps,
    ...(m.frame_delay_ms?{frame_delay_ms:m.frame_delay_ms}:{}),figure_types:m.figures,backgrounds:m.backgrounds,
    keyframes:frames,_styk:{name:'Copied keyframes',frameClipboardVersion:1,layers}};
  views.set(frames,view);return view;
}

function inputState(editor) {
  const drag=editor._drag,rig=drag?.rig,authored=editor._authoredPoseEdit;
  let pending=null;
  if(drag){const {documentToken,...fields}=drag;pending={...fields};
    if(rig){const {geometry,figure,...fields}=rig;pending.rig={...fields,changes:[...rig.changes],changedIndices:[...rig.changedIndices]};}}
  return {selection:editor._selectionState(),nextFrameIdentity:editor._nextFrameIdentity,nextUid:editor._nextUid,
    generatedFrameSources:[...editor._generatedFrameSources],sourceTableWasPresent:editor._sourceTableWasPresent,
    frameDraftEnabled:Boolean(editor._frameDraftEnabled),drag:pending,authored:authored?{...authored,owned:[...authored.owned]}:null};
}

function context(editor,options,operation) {
  if(editor._frameDraftStoredEdit)throw new Error('Finish the current stored-frame operation first.');
  if(editor._animationEdit)throw new Error('Finish the current property gesture first.');
  const controller=new AbortController(),report=editor.report,token=editor._documentToken,revision=editor.revision;
  const clipboard=editor._frameClipboard,frame=editor.frameIndex,tick=editor.tick,draft=editor.frameDraftRevision;
  const drag=editor._drag,authored=editor._authoredPoseEdit,animationEdit=editor._animationEdit,storedEdit=editor._frameDraftStoredEdit;
  const listener=event=>{if(['edit','history','document','selection','frame','seek','frame-draft'].includes(event.detail?.kind))controller.abort();};
  const abort=()=>controller.abort();options.signal?.addEventListener('abort',abort,{once:true});editor.addEventListener('change',listener);
  const check=()=>{
    if(controller.signal.aborted||options.signal?.aborted)throw aborted('Clipboard operation cancelled.');
    if(editor.report!==report||editor._documentToken!==token||editor.revision!==revision||editor.frameIndex!==frame||editor.tick!==tick||
      editor.frameDraftRevision!==draft||editor._drag!==drag||editor._authoredPoseEdit!==authored||editor._animationEdit!==animationEdit||editor._frameDraftStoredEdit!==storedEdit||
      (operation==='paste'&&editor._frameClipboard!==clipboard))
      throw aborted('The animation changed while the clipboard operation was prepared.');
  };
  return {report,token,controller,check,close(){editor.removeEventListener('change',listener);options.signal?.removeEventListener('abort',abort);}};
}

async function copyProjection(editor,indices,state,check,options) {
  if(editor._drag||editor.animationChannels.length)return editor.report;
  const report=storedFrameReport(editor.report,{validate:false}),frames=[],types=new Set();let last=performance.now(),visited=0;
  for(const index of indices){
    const frame=report.keyframes[index];if(!frame)throw new Error('Choose stored frames to copy.');frames.push(frame);
    for(const object of frame.objects){types.add(object.figure_type_id);
      if(++visited%256===0&&performance.now()-last>=4){check();options.onProgress?.({phase:'preparing',completed:visited});await(options.yieldControl??yieldLoadTask)();last=performance.now();}}
  }
  const metadata={...report._styk};delete metadata.frameSources;delete metadata.animation;delete metadata.simpleFrameDraft;
  const projected={...report,keyframes:frames,figure_types:report.figure_types.filter(figure=>types.has(figure.figure_type_id)),_styk:metadata};
  delete projected._stykSource;
  state.indices=indices.map((_,i)=>i);state.frameDraftEnabled=false;state.generatedFrameSources=[];state.sourceTableWasPresent=false;
  state.selection={...state.selection,frameIndex:0,tick:0,uid:null,uids:[],joint:-1};
  check();return projected;
}

async function nativePasteProjection(editor,state,check,options,clipboard) {
  const report=editor.report,frames=[],uidCounts=[];let objectCount=0,visited=0,last=performance.now();
  const pause=async()=>{if(++visited%256===0&&performance.now()-last>=4){check();options.onProgress?.({phase:'preparing',completed:visited});await(options.yieldControl??yieldLoadTask)();last=performance.now();}};
  for(const original of report.keyframes){const frame=createFrame([],original.duration_raw);frame._styk={frameId:original._styk.frameId};frames.push(frame);objectCount+=original.objects.length;await pause();}
  for(const entry of editor._layerUidCounts){uidCounts.push(entry);await pause();}
  const metadata={...report._styk};delete metadata.frameSources;delete metadata.animation;delete metadata.simpleFrameDraft;
  const projected={...report,keyframes:frames,_styk:metadata};delete projected._stykSource;
  state.destinationSummary={uidCounts,objectCount};state.generatedFrameSources=[];state.sourceTableWasPresent=false;
  // A legacy-to-modern source needs worker-side asset conversion before exact
  // comparison. Same-version native data can send confirmed matches only.
  if(clipboard.version===report.version){
    const assets=await prepareClipboardAssetProjection(clipboard,report,{...options,checkCurrent:check});
    state.destinationSummary.assets=assets.summary;projected.figure_types=assets.figures;projected.backgrounds=assets.backgrounds;
  }
  state.selection={...state.selection,uid:null,uids:[],joint:-1};check();return projected;
}

async function drain(iterator,check,options) {
  try{for(;;){check();const start=performance.now();let step;
    do{step=iterator.next();}while(!step.done&&performance.now()-start<4);
    if(step.done)return step.value;
    options.onProgress?.({phase:'validating',...step.value});await(options.yieldControl??yieldLoadTask)();
  }}finally{iterator.return();}
}

async function checkClipboard(document,check,options) {
  if(document?._styk?.frameClipboardVersion!==1)throw new Error('The clipboard worker returned an invalid clipboard.');
  await drain(validateSceneSteps(document),check,options);
  await drain(validateLayerStateSteps(ensureLayerState(document)),check,options);
}

function validateResultState(wire,report) {
  const s=wire.selection,frames=report.keyframes;
  const uid=value=>value===null||Number.isInteger(value)&&value>=0&&value<=0xffffffff;
  if(!s||!Number.isInteger(s.frameIndex)||s.frameIndex<0||s.frameIndex>=frames.length||
    !Number.isFinite(s.tick)||s.tick<0||s.tick>10000000||!uid(s.uid)||!Array.isArray(s.uids)||s.uids.length>100000||
    s.uids.some(value=>!uid(value)||value===null)||new Set(s.uids).size!==s.uids.length||!Number.isInteger(s.joint)||s.joint< -1||s.joint>30000||
    typeof s.activeLayerId!=='string'||(!['scene','camera'].includes(s.activeLayerId)&&!report._styk.layers.byId[s.activeLayerId]))throw new Error('The clipboard worker returned an invalid selection.');
  if(!Array.isArray(wire.generatedFrameSources)||wire.generatedFrameSources.length>100000||wire.generatedFrameSources.some(id=>typeof id!=='string'||!/^frame-[1-9]\d{0,15}$/.test(id))||
    typeof wire.sourceTableWasPresent!=='boolean'||typeof wire.clipboardAuthored!=='boolean')throw new Error('The clipboard worker returned invalid source metadata.');
  return new Set(wire.generatedFrameSources);
}

function adoptClipboard(editor,document,token,authored=false) {
  const frames=document.keyframes,layers=document._styk.layers;
  Object.defineProperty(frames,META,{value:{documentToken:token,version:document.version,
    canvas_width:document.canvas_width,canvas_height:document.canvas_height,fps:document.fps,frame_delay_ms:document.frame_delay_ms,
    figures:document.figure_types,backgrounds:document.backgrounds??[],layers:{order:layers.order,byId:layers.byId,assignments:layers.assignments},authored}});
  views.set(frames,document);editor._frameClipboard=frames;
}

function currentState(editor) {
  return {report:editor.report,nextFrameIdentity:editor._nextFrameIdentity,nextUid:editor._nextUid,
    generatedFrameSources:editor._generatedFrameSources,sourceTableWasPresent:editor._sourceTableWasPresent,
    layerUidCounts:editor._layerUidCounts,layerSeenUids:editor._layerSeenUids,layerGroups:editor._layerGroups,
    figureNames:editor._loadedFigureNames,tracks:editor._loadedTimelineTracks};
}

export function applyAsyncClipboardCommand(editor,command,direction) {
  const pair=snapshots.get(command);if(!pair)return false;
  const state=pair[direction];
  editor.report=state.report;editor._nextFrameIdentity=state.nextFrameIdentity;editor._nextUid=state.nextUid;
  editor._generatedFrameSources=state.generatedFrameSources;editor._sourceTableWasPresent=state.sourceTableWasPresent;
  editor._layerUidCounts=state.layerUidCounts;editor._layerSeenUids=state.layerSeenUids;editor._layerGroups=state.layerGroups;
  editor._loadedFigureNames=state.figureNames;editor._loadedTimelineTracks=state.tracks;
  editor._layerRevision=(editor._layerRevision??0)+1;editor._layerDescriptors=null;editor._layerUidArrays=new Map();editor._layerEventPending=true;
  editor._nativeAnimationChannels=null;editor._authoredPoseEdit=null;editor._authoredCommitPreview=null;
  editor._frameDraft=null;invalidateFrameIndex(editor.report);editor._invalidate({timing:true});
  return true;
}

async function run(editor,operation,request,options={}) {
  const started=performance.now(),client=options.client??editor._frameClipboardWorker;
  if(!client?.run)throw new Error('The background clipboard worker is not connected.');
  const c=context(editor,options,operation);let wire,prepared,generatedFrameSources,retainedFrameSourceIds,receivedAt,stagingPhases,assetPreflight,sparse=false;
  if(operation!=='paste')editor._emit('clipboard-pending',{clipboard:true});
  try{
    c.check();const state=inputState(editor),clipboard=operation==='paste'?frameClipboardView(editor):null;
    const {indices,...control}=request;if(indices)state.indices=indices;
    const nativePaste=operation==='paste'&&!options.storedFrames&&!options.afterMode&&!editor.animationChannels.length&&!editor._frameDraftEnabled&&!editor.report._styk.simpleFrameDraft&&!editor._drag&&
      !(editor.report.version<5&&clipboard.version>=5);
    const report=operation==='copy'?await copyProjection(editor,indices,state,c.check,options):nativePaste?await nativePasteProjection(editor,state,c.check,
      {...options,signal:c.controller.signal,onTiming:value=>{assetPreflight=value;}},clipboard):c.report;
    wire=await client.run({report,clipboard,state,request:{operation,...control,
      sameDocument:editor._frameClipboard?.[META]?.documentToken===c.token,sparseNativePaste:nativePaste,storedFrames:Boolean(options.storedFrames),preserveWorking:options.preserveWorking!==false,afterMode:options.afterMode}},
      {signal:c.controller.signal,checkCurrent:c.check,onProgress:options.onProgress});
    receivedAt=performance.now();c.check();
    if(!wire||wire.version!==1||wire.operation!==operation||!Number.isInteger(wire.count)||wire.count<0||wire.count>100000||!wire.selection)
      throw new Error('The clipboard worker returned an invalid result.');
    if(wire.clipboard)await checkClipboard(wire.clipboard,c.check,options);
    if(operation!=='paste'&&!wire.clipboard)throw new Error('The clipboard worker omitted the copied frames.');
    if(wire.sparsePaste){
      if(!nativePaste||wire.count!==wire.sparsePaste.frames?.length)throw new Error('The clipboard worker returned an unexpected sparse paste.');
      options.onProgress?.({phase:'staging'});
      prepared=await prepareOwnedSparseClipboardPaste(editor,{...wire.sparsePaste,precomputedBytes:client.lastTimings?.outputLogicalBytes??client.lastTimings?.outputBytes??0},
        {signal:c.controller.signal,checkCurrent:c.check,yieldControl:options.yieldControl,onProgress:progress=>options.onProgress?.({phase:'staging',...progress}),onTiming:value=>{stagingPhases=value;}});
      sparse=true;
    }else if(operation!=='copy'){
      options.onProgress?.({phase:'staging'});
      prepared=await prepareEditorLoadAsync(wire.report,{signal:c.controller.signal,checkCurrent:c.check,yieldControl:options.yieldControl,
        onProgress:progress=>options.onProgress?.({phase:'staging',...progress})});
      if(!Number.isSafeInteger(wire.nextFrameIdentity)||wire.nextFrameIdentity<prepared.nextFrameIdentity||!Number.isSafeInteger(wire.nextUid)||wire.nextUid<prepared.nextUid)
        throw new Error('The clipboard worker returned invalid identity counters.');
    }
    if(!sparse){generatedFrameSources=validateResultState(wire,prepared?.report??c.report);
      retainedFrameSourceIds=[...new Set([...Object.keys(c.report._styk.frameSources??{}),...Object.keys(prepared?.report._styk.frameSources??{})])];}
    c.check();
  }finally{c.close();}
  // Everything above is unpublished, including a pending gesture's isolated
  // commit. Cancellation cannot consume the gesture or a history entry.
  const commitStart=performance.now();editor.commitDrag();
  if(wire.clipboard)adoptClipboard(editor,wire.clipboard,c.token,wire.clipboardAuthored);
  if(sparse)commitSparseClipboardPaste(editor,prepared);
  else if(operation!=='copy'&&wire.count){
    const before=currentState(editor),after={...prepared,nextFrameIdentity:wire.nextFrameIdentity,nextUid:wire.nextUid,
      generatedFrameSources,sourceTableWasPresent:wire.sourceTableWasPresent};
    const command={kind:'clipboard-async',label:operation==='cut'?'Cut keyframes':'Paste keyframes',structural:true,timing:true,
      beforeSelection:editor._selectionState(),afterSelection:wire.selection,
      precomputedBytes:(client.lastTimings?.inputLogicalBytes??client.lastTimings?.inputBytes??0)+
        (client.lastTimings?.outputLogicalBytes??client.lastTimings?.outputBytes??0)+2048,
      retainedFrameSourceIds};
    snapshots.set(command,{before,after});
    Object.defineProperty(command,'frameDraftState',{value:{before:before.report._styk.simpleFrameDraft,after:after.report._styk.simpleFrameDraft}});
    const suspended=editor._frameDraftSuspended;editor._frameDraftSuspended=true;
    try{applyAsyncClipboardCommand(editor,command,'after');editor._restoreSelection(command.afterSelection);editor._record(command);editor._applyFrameDraftHistory(command,'after');}
    finally{editor._frameDraftSuspended=suspended;}
    editor._emit('edit',{label:command.label,structural:true,timing:true,animation:Boolean(editor.animationChannels.length),prepared:true});
  }
  if(wire.clipboard)editor._emit('clipboard',{clipboard:true});
  editor.lastClipboardTimings={...client.lastTimings,operation,workerRoundTripMs:client.lastTimings?.totalMs,stagingMs:commitStart-receivedAt,
    totalMs:performance.now()-started,commitMs:performance.now()-commitStart,planning:wire.planningTimings,stagingPhases,assetPreflight};
  return wire.count;
}

export const editorClipboardAsyncMethods={
  setFrameClipboardWorker(client){if(client!==null&&typeof client?.run!=='function')throw new Error('Provide a clipboard worker client.');this._frameClipboardWorker=client;return this;},
  frameClipboardDocumentView(){return frameClipboardView(this);},
  copyFramesAsync(indices=[this.frameIndex],options={}){
    indices=this._frameIndices(indices);if(!indices.length)return Promise.resolve(0);
    const previous=this._frameClipboardCopyPromise,token=this._documentToken,report=this.report;
    this._frameClipboardCopyController?.abort();const controller=new AbortController();
    const abort=()=>controller.abort();options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted)controller.abort();
    const promise=Promise.resolve(previous).catch(()=>{}).then(()=>{
      if(token!==this._documentToken||report!==this.report)throw aborted('The document changed before copy started.');
      return run(this,'copy',{indices},{...options,signal:controller.signal});
    }).finally(()=>{options.signal?.removeEventListener('abort',abort);if(this._frameClipboardCopyPromise===promise){this._frameClipboardCopyPromise=null;this._frameClipboardCopyController=null;}});
    this._frameClipboardCopyPromise=promise;this._frameClipboardCopyController=controller;return promise;
  },
  async cutFramesAsync(indices=[this.frameIndex],options={}){indices=this._frameIndices(indices);if(!indices.length)return 0;return run(this,'cut',{indices},options);},
  async pasteFramesAsync(index=this.frameIndex+1,options={}){
    const token=this._documentToken;
    while(this._frameClipboardCopyPromise){const pending=this._frameClipboardCopyPromise;
      try{await pending;}catch(error){if(this._frameClipboardCopyPromise&&this._frameClipboardCopyPromise!==pending)continue;throw error;}
      if(token!==this._documentToken)throw aborted('The document changed before paste started.');
      if(options.signal?.aborted)throw aborted('Paste cancelled.');
    }
    if(!this.hasFrameClipboard)return 0;
    const maximum=options.storedFrames&&this.frameDraft?.empty?0:this.report.keyframes.length;
    if(!Number.isInteger(index)||index<0||index>maximum)throw new Error('Choose a valid paste position.');
    return run(this,'paste',{index},options);
  },
  async restoreFrameClipboardAsync(document,options={}){
    const check=()=>{if(options.signal?.aborted)throw aborted('Clipboard restoration cancelled.');options.checkCurrent?.();};
    await checkClipboard(document,check,options);check();adoptClipboard(this,document,null,false);return document.keyframes.length;
  },
};
