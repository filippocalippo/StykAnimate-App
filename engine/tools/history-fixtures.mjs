// Recorded real editor history count/byte ownership. Generated before Rust changes.
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {documentOf,limb,open} from './fixture-kit.mjs';
import {withDraws} from '../../src/editor-draws.mjs';
const out=new URL('../tests/history/',import.meta.url);mkdirSync(out,{recursive:true});
const json=value=>JSON.stringify(value,(key,item)=>key==='runtime_segments'?undefined:item);
const plain=(value,depth=4)=>value===null||['number','string','boolean'].includes(typeof value)?value:value instanceof Set?plain([...value],depth):typeof value!=='object'||depth<=0?undefined:Array.isArray(value)?value.map(item=>plain(item,depth-1)).filter(item=>item!==undefined):Object.fromEntries(Object.entries(value).map(([key,item])=>[key,plain(item,depth-1)]).filter(([,item])=>item!==undefined));
const decode=value=>Array.isArray(value)?value.map(decode):value===null||typeof value!=='object'?value:Object.hasOwn(value,'@array')?Object.assign(decode(value['@array']),Object.fromEntries(Object.entries(value).filter(([key])=>key!=='@array'))):Object.fromEntries(Object.entries(value).map(([key,item])=>[key,decode(item)]));
export function record(name,document,options,calls,output=out){
  mkdirSync(output,{recursive:true});
  const e=open(structuredClone(document),options),events=[],recorded=[];e.autoKey=Boolean(options.autoKey);
  const original=e._record;e._record=function(command){const pending=this._pendingSourceBytes??0;original.call(this,command);const {bytes,...enumerable}=command;recorded.push({kind:command.kind,label:command.label,bytes,pending,enumerableJSON:json(enumerable)});};
  e.addEventListener('change',event=>events.push(plain(event.detail)));
  const state=()=>({tick:e.tick,frameIndex:e.frameIndex,selectedUid:e.selectedUid??null,selectedUids:[...e.selectedUids],selectedJoint:e.selectedJoint??-1,canUndo:e.canUndo,canRedo:e.canRedo,undoLabel:e.undoLabel,redoLabel:e.redoLabel,dirty:e.dirty,layerRevision:e.layerRevision,nextFrameIdentity:e._nextFrameIdentity,nextUid:e._nextUid});
  const entry=c=>({label:c.label,bytes:c.bytes,...(c.commands?{children:c.commands.map(entry)}:{})});
  const history=()=>({size:e.historySize,undo:e._undo.map(entry),redo:e._redo.map(entry),revision:e.revision,revisionSerial:e._revisionSerial,savedRevision:e._savedRevision});
  const initialHistory={limit:e.historyLimit,bytes:e.historyBytes,...history(),...(options.historyReady===false?{ready:false}:{})};
  let previous=json(e.report),drawn=0;
  const steps=[{step:0,call:null,state:state(),document:previous,events:[],history:history(),commands:[]}];
  const run=([method,...args])=>method==='@batch'?e.movieclipBatch(args[0],()=>{let last;for(const call of args[1])last=run(call);return last;}):method==='@prepareHistory'?undefined:method==='@historyLimits'?void Object.assign(e,{historyLimit:args[0],historyBytes:args[1]}):method==='@trimHistory'?e._trimHistory():e[method==='@seek'?'seek':method==='@select'?'select':method](...args.map(decode));
  const source=kind=>{drawn++;if(kind==='uuid')return `d0d0d0d0-0000-4000-8000-${String(drawn).padStart(12,'0')}`;const bits=Math.imul(drawn,0x9e3779b1)>>>0;return kind==='seed'?bits:bits/2**32;};
  for(const [i,given]of calls.entries()){
    const call=given[0]==='@prepareHistory'?[given[0],e.historyLimit,e.historyBytes,e.historySize]:given;
    events.length=0;recorded.length=0;let result,error=null,draws=[];
    try{({result,draws}=withDraws(()=>run(call),source));}catch(caught){error={message:caught.message,key:caught.messageKey??null};draws=caught.draws??[];}
    const text=json(e.report);steps.push({step:i+1,call,...(draws.length?{draws}:{}),result:plain(result??null),error,state:state(),documentSha:createHash('sha256').update(text).digest('hex'),...(text!==previous?{document:text}:{}),events:[...events],history:history(),commands:[...recorded]});previous=text;
  }
  writeFileSync(new URL(`${name}.json`,output),json({scenario:name,editor:options,initialHistory,steps})+'\n');
  return steps;
}
const native=documentOf([limb(),limb(true)]),moves=[['@select',1,-1],...Array.from({length:12},(_,i)=>['moveSelection',i+1,0]),['undo'],['undo'],['undo'],['redo'],['moveSelection',20,1],['redo'],['undo'],['undo'],['undo']];
for(const limit of [0,1,2,80])record(`native-count-${limit}`,native,{historyLimit:limit},moves);
for(const bytes of [0,1,1800,4500])record(`native-budget-${bytes}`,native,{historyBytes:bytes},moves);
const two=record('native-boundary-probe',native,{},moves.slice(0,3)),boundary=two[3-1].history.size;
for(const bytes of [boundary,boundary-1])record(`native-exact-${bytes}`,native,{historyBytes:bytes},moves.slice(0,6).concat([['undo'],['undo'],['redo']]));
record('native-unicode',native,{historyLimit:2},[['@select',1,-1],['beginDrag','Move 🦊 é "line"\n'],['moveSelection',1,2],['commitDrag'],['beginDrag','Move 🦊 中文'],['moveSelection',2,3],['commitDrag'],['undo'],['redo']]);
record('native-fields-batch',native,{historyBytes:1100},[['setFPS',24],['setCanvasSize',720,480],['@batch','Mixed 🦊',[['setFPS',30],['addPaletteColor','#abcdef']]],['undo'],['redo'],['setFPS',25],['undo'],['redo']]);
record('native-farthest-redo',native,{historyLimit:3},moves.slice(0,5).concat([['undo'],['undo'],['@historyLimits',3,0],['@trimHistory'],['redo'],['undo'],['@historyLimits',0,50331648],['@trimHistory'],['undo'],['redo']]));
for(const originalName of ['batch-sheet','builder-styles-native','range-native','camera-motion-sheet','audio-sheet','palette-sheet','topology-sheet','topology-native','vfx-clips-sheet','movieclip-sheet','movieclip-rename-sheet','rig-drag-native','clip-capture-active-layer-native','clip-capture-active-anchor-native','clip-capture-active-plain-native','clip-capture-active-cancel-native','clip-break-active-layer-native']){
  const scenarioUrl=new URL(`../tests/edit/${originalName}.scenario.json`,import.meta.url);
  let scenario;try{scenario=JSON.parse(readFileSync(scenarioUrl,'utf8'));}catch(error){if(error.code==='ENOENT')continue;throw error;}
  const document=typeof scenario.document==='string'?JSON.parse(readFileSync(new URL(scenario.document,scenarioUrl),'utf8')):scenario.document;
  record(`owned-${originalName}`,document,{...scenario.editor,historyLimit:3,historyBytes:12000},scenario.steps);
}
const sheet=open(native,{layerTimeline:true});const sheetDocument=structuredClone(sheet.report);
record('sheet-source-retirement',sheetDocument,{layerTimeline:true,historyLimit:2,historyBytes:4000},[['@select',1,-1],['moveSelection',1,1],['moveSelection',2,2],['moveSelection',3,3],['undo'],['undo'],['redo'],['moveSelection',4,4],['undo'],['redo']]);
const dense=documentOf([Array.from({length:6000},(_,i)=>[i+1,0,20+i%5,.2+i%3])]);dense.keyframes[0].objects[0].futurePose={numbers:Array.from({length:6000},(_,i)=>i+.125),text:'🦊'.repeat(20000)};
record('native-dense-retirement',dense,{historyBytes:4000},[['@select',1,-1],['moveSelection',1,2],['moveSelection',3,4],['undo'],['redo'],['undo'],['moveSelection',5,6],['redo']]);
console.log('History recordings generated from the real editor.');
