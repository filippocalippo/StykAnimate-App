// Awaited real bakeMovieclip calls (D15); standalone async publication capture,
// following the existing publication fixture protocol. No synchronous Promise replay.
import {fileURLToPath} from 'node:url';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {open,documentOf,writeProject,writeReference} from './fixture-kit.mjs';
import {createMovieclipMaterializer} from '../../src/movieclip-materialize.mjs';
import {snapshotPoseFrame} from '../../src/pose-snapshot.mjs';
const folder=fileURLToPath(new URL('../tests/movieclip-bake/',import.meta.url));
const views=fileURLToPath(new URL('../crates/styk-eval/tests/fixtures/movieclip-bake/',import.meta.url));
mkdirSync(folder,{recursive:true});mkdirSync(views,{recursive:true});
const json=value=>JSON.stringify(value,(key,value)=>key==='runtime_segments'?undefined:value);
// Exactly edit-replay.mjs's plain-data protocol: absent fields remain absent.
const plain=(value,depth=4)=>value===null||['number','boolean','string'].includes(typeof value)?value:value instanceof Set?plain([...value],depth):typeof value!=='object'||depth<=0?undefined:Array.isArray(value)?value.map(item=>plain(item,depth-1)).filter(item=>item!==undefined):Object.fromEntries(Object.entries(value).map(([key,item])=>[key,plain(item,depth-1)]).filter(([,item])=>item!==undefined));
const view=e=>({document:json(e.report),state:{tick:e.tick,frameIndex:e.frameIndex,selectedUid:e.selectedUid??null,selectedUids:[...e.selectedUids],selectedJoint:e.selectedJoint??-1,canUndo:e.canUndo,canRedo:e.canRedo,undoLabel:e.undoLabel,redoLabel:e.redoLabel,dirty:e.dirty,layerRevision:e.layerRevision,nextFrameIdentity:e._nextFrameIdentity,nextUid:e._nextUid},selection:e._selectionState(),history:{size:e.historySize,undo:e._undo.map(c=>({kind:c.kind,label:c.label,bytes:c.bytes})),redo:e._redo.map(c=>({kind:c.kind,label:c.label,bytes:c.bytes})),revision:e.revision,revisionSerial:e._revisionSerial,savedRevision:e._savedRevision}});
const base=(sheet,presence=false)=>open(JSON.parse(readFileSync(new URL(`../tests/movieclip-native-extension/${presence?'extend-presence':'extend-imported'}.document.json`,import.meta.url),'utf8')),sheet?{layerTimeline:true,propertyChannels:true}:{});
const originalNow=Object.getOwnPropertyDescriptor(performance,'now');
const now=value=>Object.defineProperty(performance,'now',{value,configurable:true});
const normal=[['select',2,-1],['seek',2.25],['bakeMovieclip'],['seek',7.75],['undo'],['redo'],['undo'],['createEmptyMovieclip','Dropped baked branch'],['redo']];
async function write(name,e,calls,{sheet=false,stale=false,evaluate=true,materialize=false}={}){
 const options=sheet?{layerTimeline:true,propertyChannels:true}:{};
 e=open(JSON.parse(json(e.report)),options);e.serialize();
 let materialized;
 if(materialize){const owner=createMovieclipMaterializer(e.report),frame=snapshotPoseFrame(e.evaluatedFrame);materialized={frame,reference:{frame:owner.frame(frame),figures:owner.figures,identities:[...owner.identities]}};}
 const events=[],records=[],record=e._record;e.addEventListener('change',event=>events.push(plain(event.detail)));
 e._record=function(command){const pending=this._pendingSourceBytes??0;const result=record.call(this,command);const {bytes,...sized}=command;
  if(sized.sourceBytes!==undefined&&sized.frameSourceChanges)sized.frameSourceChanges=sized.frameSourceChanges.map(change=>({id:change.id,before:{exists:change.before.exists},after:{exists:change.after.exists}}));
  records.push({kind:command.kind,label:command.label,bytes,capturedPendingBytes:pending,sourceBytes:command.sourceBytes??null,precomputedBytes:command.precomputedBytes??null,enumerableJSON:JSON.stringify(sized)});return result;};
 const steps=[{call:null,...view(e),events:[],records:[]}];
 for(const call of calls){
  events.length=0;records.length=0;const interleavings=[];let result,error=null;now(()=>0);
  const savedTimeout=globalThis.setTimeout;let clock=0,changed=false;
  if(stale&&call[0]==='bakeMovieclip'){
   now(()=>clock+=8);
   globalThis.setTimeout=(resolve)=>{if(!changed){changed=true;const concurrentCall=['renameLayer','layer-1','Changed while baking'];interleavings.push(concurrentCall);e[concurrentCall[0]](...concurrentCall.slice(1));}savedTimeout(resolve,0);};
  }
  try{const method=call[0]==='@seek'?'seek':call[0]==='@select'?'select':call[0];result=await e[method](...call.slice(1));}catch(caught){error={key:caught.messageKey??null,message:caught.message,name:caught.name};}
  finally{globalThis.setTimeout=savedTimeout;now(()=>0);}
  e.serialize();steps.push({call,result:plain(result??null),error,...view(e),events:[...events],records:[...records],...(interleavings.length?{interleavings}:{})});
 }
 writeFileSync(`${folder}/${name}.json`,json({name,options,historyLimits:{count:e.historyLimit,bytes:e.historyBytes},scenario:name,editor:options,initialHistory:{...steps[0].history,limit:e.historyLimit,bytes:e.historyBytes},steps:steps.map((step,index)=>({step:index,...step})),...(materialized?{materializer:materialized}:{})})+'\n');
 if(evaluate){
  const applied=steps.find(step=>step.call?.[0]==='bakeMovieclip'&&!step.error)||steps[0];
  for(const [suffix,step] of [['applied',applied],['final',steps.at(-1)]]){
   const document=JSON.parse(step.document),last=open(structuredClone(document),options).totalTicks-1;
   const ticks=[0,.25,1.5,2.25,3.75,4.25,5.75,7.5,8.25,9.75,11.5,12.25,13.75,15.5,16].filter(tick=>tick<=last);
   writeReference(writeProject(views,`${name}-${suffix}`,document,ticks,{vfx:true,camera:true,scene:true}),`${name}-${suffix}`);
  }
 }
 console.log(`${name}: ${steps.length-1} awaited calls, ${steps.filter(step=>step.error).length} errors`);
}
try{
 for(const sheet of [false,true]){
  const mode=sheet?'sheet':'native';
  await write(`bake-${mode}`,base(sheet),normal,{sheet});
  await write(`bake-${mode}-presence`,base(sheet,true),normal,{sheet});
  const empty=base(sheet);empty.select(2);empty.placeMovieclip({start:30,end:40});
  await write(`bake-${mode}-outside-placement`,empty,[['select',2,-1],['bakeMovieclip'],['undo'],['redo']],{sheet});
  await write(`bake-${mode}-live`,base(sheet),[['select',1,-1],['beginTranslationDrag','Bake after drag'],['moveSelection',4.5,-2.25],['select',2,-1],['bakeMovieclip'],['undo'],['undo'],['redo'],['redo']],{sheet});
 }
 for(const presence of [false,true]){
  const saved=base(false,presence);saved.select(2);saved.placeMovieclip(presence?{clock:'presence',offset:.375,speed:1.25,mode:'loop'}:{start:1,end:15,offset:.375,speed:1.25,mode:'loop'});
  await write(`bake-native-saved${presence?'-presence':''}`,saved,normal);
 }
 const layerPose=open(JSON.parse(readFileSync(new URL('../tests/movieclip-insertion/insert-native-saved-layer2.document.json',import.meta.url),'utf8')));layerPose.seek(2);layerPose.addFigure(4);
 const layerCalls=[['seek',2],...normal.map(call=>call[0]==='select'?[call[0],layerPose.selectedUid,-1]:call)];
 await write('bake-native-layer-pose-fractional',layerPose,layerCalls);
 await write('bake-native-layer-pose',layerPose,layerCalls.map(call=>call[0]==='seek'&&call[1]===2.25?[call[0],2]:call));
 await write('bake-native-stale',base(false),[['select',2,-1],['bakeMovieclip'],['undo'],['redo']],{stale:true});
 const long=base(false);long.selectFrame(0);long.setFrameDuration(5001);long.select(2);long.setMovieclipPlayback({end:null},{allFrames:true});
 await write('bake-native-limit',long,[['select',2,-1],['bakeMovieclip'],['select',1,-1],['bakeMovieclip']],{evaluate:false});
 // These are actual effect-authoring calls. Stored pose stacks and timeline
 // clips have different materialization contracts; record both without folding
 // one into the other. IDs are deterministic only for this additive batch.
 const uuid=Object.getOwnPropertyDescriptor(globalThis.crypto,'randomUUID');let effectIdentity=0;
 Object.defineProperty(globalThis.crypto,'randomUUID',{configurable:true,value:()=>`babecafe-0000-4000-8000-${String(++effectIdentity).padStart(12,'0')}`});
 try{
  for(const sheet of [false,true])for(const transport of ['stored','timeline'])for(const placement of ['container','scene','child','outer-scene']){
   const e=base(sheet);e.select(2);const local=placement==='scene'||placement==='child';if(local)e.enterMovieclip();e.seek(0);
   const target=placement.includes('scene')?{kind:'scene'}:{kind:'figure',uid:local?e.evaluatedFrame.objects[0].unique_id:2};
   if(transport==='stored')e.addVfx(target,'blur');else{const id=e.addVfxClip(target,'blur',{start:0,duration:17});const effect=e.getVfxClips().find(clip=>clip.id===id).effects[0];e.setVfxClipParameter(id,effect.id,'radius',13.5);}
   if(local)e.leaveMovieclip();e.select(2);
   const refused=transport==='stored'&&(placement==='container'||placement==='scene');
   await write(`bake-${sheet?'sheet':'native'}-${transport}-${placement}`,e,[['select',2,-1],['seek',2.25],['bakeMovieclip'],['undo'],['redo']],{sheet,evaluate:!refused});
  }
  for(const sheet of [false,true]){
   const e=base(sheet);e.select(2);e.enterMovieclip();e.seek(4);e.addVfx({kind:'scene'},'blur');e.leaveMovieclip();
   await write(`bake-${sheet?'sheet':'native'}-stored-scene-late-live`,e,[['select',1,-1],['beginTranslationDrag','Bake before effect error'],['moveSelection',4.5,-2.25],['select',2,-1],['bakeMovieclip'],['undo'],['redo']],{sheet,evaluate:false});
  }
  for(const sheet of [false,true]){
   const e=base(sheet);e.select(2);e.enterMovieclip();e.seek(0);const child=e.evaluatedFrame.objects[0];e.select(child.unique_id);e.updateFigureStyle({name:'Remapped baked child'});
   const handle=e.figure.segments[0].segment_id,figure={kind:'figure',uid:child.unique_id};
   e.addVfx(figure,'blur');e.addVfx({kind:'segment',uid:child.unique_id,figureTypeId:child.figure_type_id,handleId:handle},'tint');e.addVfx({kind:'segment',uid:child.unique_id,handleId:handle},'outline');
   // Valid scope metadata authored through the real generic object command:
   // a stack on another definition stays there rather than moving accidentally.
   const stacks=e.evaluatedFrame.objects.find(object=>object.unique_id===child.unique_id)._stykVfx;
   e.updateObject({_stykVfx:{...stacks,[`999/${handle}`]:stacks.figure},privateEffectOwner:{preserve:['opaque',7]}});
   e.leaveMovieclip();e.select(2);
   await write(`bake-${sheet?'sheet':'native'}-stored-remapped-scopes`,e,[['select',2,-1],['seek',2.25],['bakeMovieclip'],['undo'],['redo']],{sheet,materialize:true});
   await write(`bake-owner-${sheet?'sheet':'native'}-break-remapped-scopes`,e,[['select',2,-1],['seek',2],['breakApartMovieclip'],['undo'],['redo']],{sheet,evaluate:false});
  }
 }finally{if(uuid)Object.defineProperty(globalThis.crypto,'randomUUID',uuid);else delete globalThis.crypto.randomUUID;}
 // A 48 KiB editor-built input crosses the *existing* materialized-object
 // limit at tick 4901 (51 x 4902 = 250002). No large publication is attempted.
 const dense=open(documentOf([[[11,0,1,0]]]));for(let i=1;i<51;i++)dense.addFigure(1);
 dense.selectMany(dense.evaluatedFrame.objects.map(object=>object.unique_id));dense.createMovieclip({start:0,end:1});const denseUid=dense.selectedUid;
 dense.selectFrame(0);dense.duplicateFrame();dense.selectFrame(0);dense.setFrameDuration(5000);dense.select(denseUid);dense.placeMovieclip({start:0,end:5000,mode:'loop'});
 await write('bake-native-object-limit',dense,[['select',denseUid,-1],['bakeMovieclip'],['undo'],['redo']],{evaluate:false});
 // Preserve the existing two remapper replay sets while capturing their full
 // optional selection, byte history and _record layouts for canonical replay.
 for(const scenarioName of ['figure-clipboard-vfx-sheet','topology-vfx-sheet']){
  const scenario=JSON.parse(readFileSync(new URL(`../tests/edit/${scenarioName}.scenario.json`,import.meta.url),'utf8'));
  const input=JSON.parse(readFileSync(new URL(`../tests/edit/${scenario.document}`,import.meta.url),'utf8'));
  await write(`bake-owner-${scenarioName}`,open(input,scenario.editor),scenario.steps,{sheet:true,evaluate:false});
 }
 // The same observer also covers canonical Frame/Ranges history variants.
 // Reuse recorded native scenarios and their real calls; derived-view reads
 // remain owned by their existing replay fixtures rather than async capture.
 for(const [scenarioName,end] of [['origin-join-layout-native',24],['origin-motion-layout-native',43]]){
  const scenario=JSON.parse(readFileSync(new URL(`../tests/edit/${scenarioName}.scenario.json`,import.meta.url),'utf8'));
  const input=JSON.parse(readFileSync(new URL(`../tests/edit/${scenario.document}`,import.meta.url),'utf8'));
  const calls=scenario.steps.slice(0,end).filter(([method])=>!method.startsWith('@')||['@seek','@select'].includes(method));
  await write(`bake-owner-${scenarioName}`,open(input,scenario.editor),calls,{evaluate:false});
 }
}finally{if(originalNow)Object.defineProperty(performance,'now',originalNow);else delete performance.now;}
