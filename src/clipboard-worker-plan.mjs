import {Editor} from './editor.mjs';
import {captureOwnedNativeClipboard} from './editor-frame-clipboard.mjs';

// Worker planning never needs JSON history sizing. It still executes every
// native command/draft/source hook used by the synchronous editor.
class PlanningEditor extends Editor {
  constructor(options){super(options);this._clipboardOwnedPlan=true;}
  _record(command) {command.precomputedBytes=0;return super._record(command);}
}

function validateAssetTableSummary(value,projected,key){
  if(!value||!Number.isInteger(value.count)||value.count<0||value.count>65535||!Array.isArray(value.ids)||value.ids.length!==value.count||
    value.ids.some(id=>!Number.isInteger(id)||(key==='background_id'&&id<1))||new Set(value.ids).size!==value.ids.length||
    !Array.isArray(value.matches)||value.matches.length>65535)throw new Error('Invalid clipboard asset reservation.');
  const occupied=new Set(value.ids),source=new Set(),matched=new Set();
  for(const row of value.matches){
    if(!Array.isArray(row)||row.length!==2||!Number.isInteger(row[0])||source.has(row[0])||!occupied.has(row[1]))throw new Error('Invalid clipboard asset match.');
    source.add(row[0]);matched.add(row[1]);
  }
  if(projected.length!==matched.size||projected.some(value=>!matched.has(value[key])))throw new Error('Invalid projected clipboard assets.');
}

export function restoreClipboardPlanningState(editor,state={}) {
  editor._nextFrameIdentity=state.nextFrameIdentity??editor._nextFrameIdentity;
  editor._nextUid=state.nextUid??editor._nextUid;
  editor._generatedFrameSources=new Set(state.generatedFrameSources??[]);
  editor._sourceTableWasPresent=Boolean(state.sourceTableWasPresent);
  if(state.destinationSummary){
    const summary=state.destinationSummary;
    if(!Number.isSafeInteger(summary.objectCount)||summary.objectCount<0||summary.objectCount>2000000||!Array.isArray(summary.uidCounts)||summary.uidCounts.length>2000000||
      summary.uidCounts.some(row=>!Array.isArray(row)||row.length!==2||!Number.isInteger(row[0])||row[0]<0||row[0]>0xffffffff||!Number.isSafeInteger(row[1])||row[1]<1))
      throw new Error('Invalid native clipboard destination summary.');
    editor._clipboardDestinationSummary=summary;editor._layerUidCounts=new Map(summary.uidCounts);editor._layerSeenUids=new Set(editor._layerUidCounts.keys());
    if(summary.assets){
      validateAssetTableSummary(summary.assets.figures,editor.report.figure_types,'figure_type_id');
      validateAssetTableSummary(summary.assets.backgrounds,editor.report.backgrounds??[],'background_id');
    }
  }
  if(state.frameDraftEnabled)editor.enableFrameDrafts();
  if(state.selection)editor._restoreSelection(state.selection);
  if(state.authored){editor._authoredPoseEdit={...state.authored,owned:new Set(state.authored.owned??[])};}
  if(state.drag){
    const drag={...state.drag,documentToken:editor._documentToken};
    if(drag.rig)drag.rig={...drag.rig,figure:editor.report.figure_types.find(figure=>figure.figure_type_id===drag.rig.typeId),
      changes:new Map(drag.rig.changes),changedIndices:new Set(drag.rig.changedIndices)};
    editor._drag=drag;
  }
}

export async function runClipboardWorkerRequest({report,clipboard,state,request},{onProgress=()=>{}}={}) {
  if(!request||!['copy','paste','cut'].includes(request.operation))throw new Error('Choose a clipboard operation.');
  const indices=state?.indices??request.indices;
  const timings={},started=performance.now();
  onProgress({phase:'validating'});
  const editor=new PlanningEditor({demo:false,historyBytes:Infinity}).load(report);
  timings.loadMs=performance.now()-started;let checkpoint=performance.now();
  restoreClipboardPlanningState(editor,state);
  if(clipboard){await editor.restoreFrameClipboardAsync(clipboard,{yieldControl:()=>Promise.resolve()});editor._frameClipboard._stykClipboard.documentToken=request.sameDocument?editor._documentToken:null;}
  if(state?.destinationSummary?.assets){
    if(!request.sparseNativePaste||clipboard?.version!==editor.report.version)throw new Error('Invalid clipboard asset projection mode.');
    for(const [name,key] of [['figures','figure_type_id'],['backgrounds','background_id']]){
      const values=clipboard[name==='figures'?'figure_types':'backgrounds']??[],ids=new Set(values.map(value=>value[key]));
      if(state.destinationSummary.assets[name].matches.some(([id])=>!ids.has(id)))throw new Error('Unknown copied asset match.');
    }
  }
  // Commit only this isolated preview; the visible gesture is untouched until
  // the caller validates and accepts the complete operation.
  editor.commitDrag();
  timings.restoreMs=performance.now()-checkpoint;checkpoint=performance.now();
  onProgress({phase:request.operation==='copy'?'copying':'planning'});
  const operation=()=>request.operation==='copy'?(editor.animationChannels.length?editor.copyFrames(indices):captureOwnedNativeClipboard(editor,indices))
    :request.operation==='cut'?editor.cutFrames(indices):editor.pasteFrames(request.index);
  const cutAll=request.operation==='cut'&&editor._frameDraftEnabled&&!editor.frameDraft?.empty&&
    Array.isArray(indices)&&new Set(indices).size===editor.report.keyframes.length;
  // Simple retains a working pose after its last stored key is cut, just as it
  // does after Delete All. Update must enter Add before the stored transaction.
  if(cutAll&&editor.frameDraft?.mode!=='add')editor.commitFrameDraft({mode:'add'});
  const count=request.storedFrames||cutAll?editor.editStoredFrames(operation,{preserveWorking:cutAll||request.preserveWorking!==false,empty:cutAll}):operation();
  if(request.afterMode==='add')editor.beginFrameDraft({mode:'add',index:editor.report.keyframes.length-1});
  timings.operationMs=performance.now()-checkpoint;
  const copied=request.operation==='copy'||request.operation==='cut';
  let sparsePaste=null;
  if(request.sparseNativePaste){
    const command=editor._undo.at(-1);
    if(request.operation!=='paste'||!state.destinationSummary||editor.animationChannels.length||state.frameDraftEnabled||state.drag||
      command?.kind!=='splice'||command.layerAnimationPatch||command.frameSourceChanges||!command.clipboardAssets)
      throw new Error('Native clipboard planning did not return a sparse paste.');
    sparsePaste={index:command.index,frames:command.after,assets:command.clipboardAssets,afterSelection:editor._selectionState(),
      nextFrameIdentity:editor._nextFrameIdentity,nextUid:editor._nextUid};
  }
  return {version:1,operation:request.operation,count,planningTimings:timings,clipboard:copied?editor.frameClipboardDocumentView():null,
    clipboardAuthored:copied?Boolean(editor._frameClipboard?._stykClipboard?.authored):false,
    report:request.operation==='copy'||sparsePaste?null:editor.report,sparsePaste,selection:editor._selectionState(),
    nextFrameIdentity:editor._nextFrameIdentity,nextUid:editor._nextUid,
    generatedFrameSources:[...editor._generatedFrameSources],sourceTableWasPresent:editor._sourceTableWasPresent};
}
