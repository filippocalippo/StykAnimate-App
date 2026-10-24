// Actual editor sheet planning/publication with a deterministic host progress clock.
import {writeFileSync,mkdirSync,readFileSync} from 'node:fs';
import {documentOf,limb,open,nextKey} from './fixture-kit.mjs';
import {planSheetAssignmentSteps,planSheetDeletionSteps} from '../../src/editor-layer-sheet.mjs';
const out=new URL('../tests/layer-sheet-migration/',import.meta.url);mkdirSync(out,{recursive:true});
Object.defineProperty(performance,'now',{value:()=>0,configurable:true});
const json=value=>JSON.stringify(value,(key,value)=>key==='runtime_segments'?undefined:value);
const wire=plan=>plan?{sheet:{...plan.state,tracks:Object.fromEntries(Object.entries(plan.state.tracks).filter(([id,track])=>track!==plan.before.tracks[id]))},trackOrder:Object.keys(plan.state.tracks),layers:plan.layers,sources:Object.fromEntries(plan.sources.map(source=>[source.id,source.after.value])),nextFrame:plan.nextFrame}:null;
function base(dense=false,joined=false){
  const figures=dense?[Array.from({length:6000},(_,i)=>[i+1,0,30+i%5,.2+i%4*.3]),limb()]:[limb(true),limb(),limb()];
  const e=open(documentOf(figures,i=>[150+i*180,180]));if(joined){e.select(2);e.joinTo(1,22);}nextKey(e,6);e.select(1);e.moveSelection(15,3);
  const data=structuredClone(e.report);return open(data,{layerTimeline:true,propertyChannels:false});
}
for(const name of ['shared','vacant','vacant-tail','combined','absence','delete-unused','delete-native','delete-joined','dense','noop','movieclip','delete-movieclip','view-changed']){
  let e=base(name==='dense',name==='delete-joined'),movedUid=1;
  if(name.includes('movieclip')){e.seek(0);e.select(3);e.createMovieclip({start:0,end:7});movedUid=e.evaluatedFrame.objects.find(object=>e.report.figure_types.find(figure=>figure.figure_type_id===object.figure_type_id)?._styk?.movieclip).unique_id;}
  e.createLayer('Destination');e.createLayer('Other');
  if(name==='shared'){
    const sheet=e.report._styk.layerSheet,track=structuredClone(sheet.tracks['layer-1']);
    track.keys=track.keys.map(key=>({...key,id:`cell-${sheet.nextId++}`,empty:true}));sheet.tracks['layer-2']=track;
  }
  if(name==='vacant-tail')e.report._styk.layerSheet.tracks['layer-2'].end=12,e.report._styk.layerSheet.duration=12;
  if(['combined','absence','dense','delete-joined','movieclip','delete-movieclip','view-changed'].includes(name)){
    e.assignFiguresToLayer([2],'layer-2');e.sheetInsertKey(['layer-2'],2);e.seek(2);e.select(2);e.moveSelection(-12,4);
  }
  if(name==='absence')e.sheetInsertKey(['layer-2'],3,{blank:true});
  if(name==='delete-native')e.assignFiguresToLayer([2],'layer-2');
  // Validate the authored input and expose its original unknown fields in snapshots.
  const raw=structuredClone(e.report);raw.keyframes[0].objects[0].futurePose={numbers:Array.from({length:name==='dense'?6000:3},(_,i)=>i+.125),text:'future'};
  e=open(raw,{layerTimeline:true,propertyChannels:false});e.seek(2);e.select(1);
  const deleting=name.startsWith('delete-'),deletedLayerId=deleting?(name==='delete-unused'?'layer-3':'layer-1'):undefined;
  const targetLayerId=deleting?e.report._styk.layers.order.find(id=>id!==deletedLayerId):name==='noop'?'layer-1':'layer-2';
  const uids=deleting?e.getLayerFigureUids(deletedLayerId):[movedUid];
  const request={uids,targetLayerId,nextFrameIdentity:e._nextFrameIdentity,...(deleting?{deletedLayerId}:{})};
  const document=json(e.report),initialState={selection:e._selectionState(),revision:e.revision,layerRevision:e.layerRevision,nextUid:e._nextUid,nextFrameIdentity:e._nextFrameIdentity};
  const steps=deleting?planSheetDeletionSteps(e,deletedLayerId,{background:true}):planSheetAssignmentSteps(e,uids,targetLayerId,{background:true});
  const progress=[];let plan;for(;;){const step=steps.next();if(step.done){plan=step.value;break;}progress.push(step.value);}
  const payload={plan:wire(plan)},events=[];e.addEventListener('change',event=>events.push(event.detail));
  const options=name==='view-changed'?{onProgress:()=>{e.seek(3);e.select(2);}}:{};
  const result=deleting?await e.deleteLayerAsync(deletedLayerId,options):await e.assignFiguresToLayerAsync(uids,targetLayerId,options);
  const after=json(e.report),state={revision:e.revision,layerRevision:e.layerRevision,nextFrameIdentity:e._nextFrameIdentity,undoLabel:e.undoLabel,canUndo:e.canUndo},editEvents=events.slice();
  e.undo();const undone=json(e.report),undoEvents=events.slice(editEvents.length);e.redo();const redone=json(e.report),redoEvents=events.slice(editEvents.length+undoEvents.length);
  writeFileSync(new URL(`${name}.json`,out),json({name,document,initialState,request,payload,progress,command:{name:deleting?'deleteLayerAsync':'assignFiguresToLayerAsync',result,after,state,events:editEvents,undone,redone,undoEvents,redoEvents}})+'\n');
}

// Actual async refusal, cancellation and independent-edit stale behavior.
const combined=JSON.parse(readFileSync(new URL('combined.json',out),'utf8'));
for(const name of ['invalid-uid','missing-layer','locked-destination','locked-source','delete-camera','delete-last','zero-budget','small-budget','cancelled','stale']){
  let e=open(JSON.parse(combined.document),{layerTimeline:true,propertyChannels:false}),uids=[1],targetLayerId='layer-2',deletedLayerId;
  if(name==='invalid-uid')uids=[99999];
  if(name==='missing-layer')targetLayerId='missing';
  if(name==='locked-destination')e.report._styk.layers.byId['layer-2'].locked=true;
  if(name==='locked-source')e.report._styk.layers.byId['layer-1'].locked=true;
  if(name==='delete-camera')deletedLayerId='$camera';
  if(name==='delete-last'){e.deleteLayer('layer-3');e.deleteLayer('layer-2');deletedLayerId='layer-1';}
  e=open(structuredClone(e.report),{layerTimeline:true,propertyChannels:false});e.seek(2);e.select(1);
  const request={uids,targetLayerId,nextFrameIdentity:e._nextFrameIdentity,...(deletedLayerId?{deletedLayerId}:{})},options={};
  if(name==='zero-budget')options.maxSourceBytes=0;
  if(name==='small-budget')options.maxSourceBytes=1;
  const controller=new AbortController();
  if(name==='cancelled')options.signal=controller.signal,options.onProgress=()=>controller.abort();
  if(name==='stale')options.onProgress=()=>e.setLayerColor(['layer-3'],'blue');
  const progress=[],advance=options.onProgress;options.onProgress=step=>{progress.push(step);advance?.(step);};
  const document=json(e.report),initialState={selection:e._selectionState(),revision:e.revision,layerRevision:e.layerRevision,nextUid:e._nextUid,nextFrameIdentity:e._nextFrameIdentity},events=[];
  e.addEventListener('change',event=>events.push(event.detail));
  let failure;
  try{if(deletedLayerId)await e.deleteLayerAsync(deletedLayerId,options);else await e.assignFiguresToLayerAsync(uids,targetLayerId,options);throw new Error('Expected async refusal');}
  catch(error){failure={name:error.name,message:error.message,messageKey:error.messageKey,after:json(e.report),events,state:{revision:e.revision,layerRevision:e.layerRevision,nextFrameIdentity:e._nextFrameIdentity,canUndo:e.canUndo}};}
  writeFileSync(new URL(`${name}.json`,out),json({name,document,initialState,request,...(options.maxSourceBytes===undefined?{}:{maxSourceBytes:options.maxSourceBytes}),progress,failure})+'\n');
}

// Corrupt raw owner descriptors are rejected by editor loading. Keep both that
// evidence and the direct planner refusal; Rust's public borrowed API must never
// panic or mutate even if a permissive typed Loader received these raw nodes.
for(const name of ['malformed-order-missing','malformed-order-empty','malformed-order-numeric','malformed-byid-array','malformed-layer-null','malformed-tracks-missing','malformed-source-track-null','malformed-source-keys-null','malformed-source-key-null','malformed-fallback-track-missing']){
  const raw=JSON.parse(combined.document),layers=raw._styk.layers,sheet=raw._styk.layerSheet;
  if(name==='malformed-order-missing')delete layers.order;
  if(name==='malformed-order-empty')layers.order=[];
  if(name==='malformed-order-numeric')layers.order=[1,2];
  if(name==='malformed-byid-array')layers.byId=[];
  if(name==='malformed-layer-null')layers.byId['layer-1']=null;
  if(name==='malformed-tracks-missing')delete sheet.tracks;
  if(name==='malformed-source-track-null')sheet.tracks['layer-1']=null;
  if(name==='malformed-source-keys-null')sheet.tracks['layer-1'].keys=null;
  if(name==='malformed-source-key-null')sheet.tracks['layer-1'].keys[0]=null;
  if(name==='malformed-fallback-track-missing')delete sheet.tracks['layer-2'];
  const errorData=error=>({name:error.name,message:error.message,...(error.messageKey?{messageKey:error.messageKey}:{})});
  let loadError;try{open(structuredClone(raw),{layerTimeline:true,propertyChannels:false});}catch(error){loadError=errorData(error);}
  const e=open(JSON.parse(combined.document),{layerTimeline:true,propertyChannels:false});e.report._styk=raw._styk;
  const request={uids:[1],targetLayerId:'layer-2',nextFrameIdentity:e._nextFrameIdentity,...(name==='malformed-fallback-track-missing'?{deletedLayerId:'layer-1'}:{})};
  let planningError;try{const steps=request.deletedLayerId?planSheetDeletionSteps(e,request.deletedLayerId,{background:true}):planSheetAssignmentSteps(e,[1],'layer-2',{background:true});for(;;){if(steps.next().done)break;}}catch(error){planningError=errorData(error);}
  writeFileSync(new URL(`${name}.json`,out),json({name,document:json(raw),request,malformed:{loadError,planningError,after:json(e.report)}})+'\n');
}
