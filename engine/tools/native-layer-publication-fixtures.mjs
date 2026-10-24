// Actual async native editor commands, migration descriptors and history (D15).
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {open} from './fixture-kit.mjs';
import {planLayerMembershipMigrationSteps, migrationPlanPayload} from '../../src/editor-layer-migration.mjs';
const out=new URL('../tests/native-layer-publication/',import.meta.url);mkdirSync(out,{recursive:true});
Object.defineProperty(performance,'now',{value:()=>0,configurable:true});
const json=value=>JSON.stringify(value,(key,item)=>key==='runtime_segments'?undefined:item);
function view(e){
  const entry=c=>({label:c.label,bytes:c.bytes,...(c.commands?{children:c.commands.map(entry)}:{})});
  return {document:json(e.report),state:{tick:e.tick,frameIndex:e.frameIndex,selectedUid:e.selectedUid??null,selectedUids:[...e.selectedUids],selectedJoint:e.selectedJoint??-1,canUndo:e.canUndo,canRedo:e.canRedo,undoLabel:e.undoLabel,redoLabel:e.redoLabel,dirty:e.dirty,layerRevision:e.layerRevision,nextFrameIdentity:e._nextFrameIdentity,nextUid:e._nextUid},selection:e._selectionState(),history:{size:e.historySize,undo:e._undo.map(entry),redo:e._redo.map(entry),revision:e.revision,revisionSerial:e._revisionSerial,savedRevision:e._savedRevision}};
}
const names=['native-only','independent','joined-scalars','delete-default','dense-single-figure'];
for(const name of names){
 const source=JSON.parse(readFileSync(new URL(`../tests/layer-migration/${name}.json`,import.meta.url),'utf8'));
 for(const variant of name==='independent'?['default','zero','count-one','source-retention','count-zero','active-view','delete-unused','empty-table','header-extra','invalid-uid','invalid-target','invalid-plan','invalid-channel','invalid-order','invalid-source','missing-source','cancel','stale']:name==='native-only'?['default','delete-last-layer','delete-same-target']:['default']){
  const doc=JSON.parse(source.document);
  if(variant==='empty-table')doc._styk.frameSources={};
  if(variant==='header-extra')doc._styk.animation.savedExtra={unicode:'🍀',unknown:[1,2,3]};
  if(variant==='delete-last-layer'){
   doc._styk.layers.order=['layer-1'];doc._styk.layers.byId={'layer-1':doc._styk.layers.byId['layer-1']};doc._styk.layers.assignments={};doc._styk.layers.activeId='layer-1';
  }
  const historyBytes=variant==='zero'?0:50331648,historyLimit=variant==='count-zero'?0:['count-one','source-retention'].includes(variant)?1:80;
  if(variant==='delete-unused'){
   doc._styk.layers.nextId=5;doc._styk.layers.order.push('layer-4');doc._styk.layers.byId['layer-4']={name:'Empty authored layer',visible:true,locked:false};
   doc._styk.animation.channels.push({id:'layer:layer-4:pose',target:{kind:'layer',id:'layer-4'},property:'pose',keys:[{id:'unused-key',tick:0,value:{frameId:doc.keyframes[0]._styk.frameId},interpolation:'hold'}]});
  }
  const e=open(doc,{historyBytes,historyLimit});e._restoreSelection(source.initialState.selection);
  const events=[],records=[];e.addEventListener('change',event=>events.push(event.detail));
  const record=e._record;e._record=function(command){const before=json(command);const result=record.call(this,command);records.push({beforeBytes:before,bytes:command.bytes,kind:command.kind});return result;};
  const request=variant==='delete-unused'?{...source.request,uids:[],deletedLayerId:'layer-4',targetLayerId:'layer-1'}:variant==='delete-last-layer'?{...source.request,deletedLayerId:'layer-1',targetLayerId:'missing'}:variant==='delete-same-target'?{...source.request,deletedLayerId:'layer-1',targetLayerId:'layer-1'}:variant==='invalid-uid'?{...source.request,uids:[999]}:variant==='invalid-target'?{...source.request,targetLayerId:'missing'}:source.request;
  const operation=request.deletedLayerId?['deleteLayerAsync',request.deletedLayerId]:['assignFiguresToLayerAsync',request.uids,request.targetLayerId];
  const steps=[{call:null,...view(e),events:[],records:[],progress:[]}];
  const calls=variant==='source-retention'?[operation,['deleteLayerAsync','layer-2','layer-1'],['undo'],['redo'],['undo'],['renameLayer','layer-3','Branch after delete'],['redo']]:variant.startsWith('invalid-')||['missing-source','cancel','stale','delete-last-layer','delete-same-target'].includes(variant)?[operation]:[operation,['undo'],['redo'],['undo'],operation,['undo'],['redo'],operation];
  for(const call of calls){
   events.length=0;records.length=0;const progress=[];let wire=null,result,error=null,controller=new AbortController();
   const planner=async params=>{
    const iterator=planLayerMembershipMigrationSteps({report:e.report,_nextFrameIdentity:params.nextFrameIdentity},params.uids,params.targetLayerId,{worker:true,deletedLayerId:params.deletedLayerId,maxSourceBytes:128*1024*1024});
    for(;;){const step=iterator.next();if(step.done){wire=migrationPlanPayload(step.value).plan;break;}progress.push(step.value);}
    if(variant==='invalid-plan')wire.version=2;
    if(variant==='invalid-channel')wire.channelUpdates.push(wire.channelUpdates[0]);
    if(variant==='invalid-order')wire.channelOrder.reverse().push(wire.channelOrder[0]);
    if(variant==='invalid-source')Object.values(wire.frameSources)[0]._styk.frameId='frame-1';
    if(variant==='missing-source'){const key=wire.channelUpdates.find(u=>u.channel)?.channel.keys[0];key.value.frameId='frame-999999';}
    if(variant==='active-view')e.setActiveLayer('layer-1');
    if(variant==='cancel')controller.abort();
    if(variant==='stale')e.renameLayer('layer-3','Changed while preparing');
    return wire;
   };
   try{result=call[0]==='deleteLayerAsync'?await e.deleteLayerAsync(call[1],{targetLayerId:call[2]??request.targetLayerId,planMigration:planner,signal:controller.signal,onProgress:p=>progress.push(p)}):call[0].endsWith('Async')?await e[call[0]](...call.slice(1),{planMigration:planner,signal:controller.signal,onProgress:p=>progress.push(p)}):e[call[0]](...call.slice(1));}
   catch(caught){error={key:caught.messageKey??null,name:caught.name};}
   steps.push({call,result:result??null,error,wire,progress,...view(e),events:[...events],records:[...records]});
  }
  writeFileSync(new URL(`${name}${variant==='default'?'':`-${variant}`}.json`,out),json({name,variant,request,historyLimits:{count:historyLimit,bytes:historyBytes},steps})+'\n');
 }
}
console.log('Native layer publication recordings generated from actual async editor commands.');
