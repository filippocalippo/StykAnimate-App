import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import path from 'node:path';
import {repo,repoUrl,open,documentOf,limb,createObject,createFrame} from './fixture-kit.mjs';
import {deflateSync} from 'node:zlib';
import assert from 'node:assert/strict';
const out=process.argv.includes('--out')?process.argv[process.argv.indexOf('--out')+1]:path.join(repo,'engine/tests/typed-pairing');
mkdirSync(out,{recursive:true});
const {createImageFigure,createImageBackground}=await import(`${repoUrl}/src/media-authoring.mjs`);
Object.defineProperty(performance,'now',{value:()=>0,configurable:true});
let ids=0;Object.defineProperty(globalThis.crypto,'randomUUID',{configurable:true,value:()=>`00000000-0000-4000-8000-${String(++ids).padStart(12,'0')}`});
const json=value=>JSON.stringify(value,(key,item)=>key==='runtime_segments'?undefined:item);
// Exact small PNG factory from the existing editor-built eval fixture owner.
function quadrants(width,height){
 const crc=bytes=>{let c=~0;for(const b of bytes){c^=b;for(let k=0;k<8;k++)c=c&1?(c>>>1)^0xedb88320:c>>>1;}return~c>>>0;};
 const chunk=(type,data)=>{const head=Buffer.alloc(8),tail=Buffer.alloc(4);head.writeUInt32BE(data.length);head.write(type,4);tail.writeUInt32BE(crc(Buffer.concat([Buffer.from(type),data])));return Buffer.concat([head,data,tail]);};
 const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=6;
 const rows=[];for(let y=0;y<height;y++){rows.push(0);for(let x=0;x<width;x++)rows.push(...(x<width/2?(y<height/2?[230,40,40,255]:[40,160,60,255]):(y<height/2?[40,70,220,255]:[240,200,30,255])));}
 return 'data:image/png;base64,'+Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.from(rows),{level:9})),chunk('IEND',Buffer.alloc(0))]).toString('base64');
}
const pictures={A:createImageFigure({dataUrl:quadrants(16,8),width:16,height:8,name:'First image',figureTypeId:2}),B:createImageFigure({dataUrl:quadrants(9,13),width:9,height:13,name:'Second image',figureTypeId:1}),C:createImageFigure({dataUrl:quadrants(5,7),width:5,height:7,name:'Branch image',figureTypeId:1}),background:createImageBackground({dataUrl:quadrants(11,3),width:11,height:3,name:'Image background'})};
pictures.Bfresh=structuredClone(pictures.B);
function base(){const d=documentOf([limb()]);d.figure_types.push(structuredClone(pictures.A));d.keyframes=[createFrame([...d.keyframes[0].objects,createObject(d.figure_types[1],2,220,140)],1)];d.unknownPairingBefore=null;d.unknownPairingAfter={keep:[3,2,1]};return d;}
function state(e){return {...e._selectionState(),tick:e.tick,frameIndex:e.frameIndex,selectedUid:e.selectedUid??null,selectedUids:[...(e.selectedUids??[])],selectedJoint:e.selectedJoint??-1,activeLayerId:e.activeLayerId,autoKey:Boolean(e.autoKey),sheetSelection:e._sheetSelection?{id:e._sheetSelection.id,contents:Boolean(e._sheetSelection.contents)}:null,layerRevision:e.layerRevision,nextFrameIdentity:e._nextFrameIdentity,nextUid:e._nextUid};}
function canonicalState(e){return {tick:e.tick,frameIndex:e.frameIndex,selectedUid:e.selectedUid??null,selectedUids:[...(e.selectedUids??[])],selectedJoint:e.selectedJoint??-1,canUndo:e.canUndo,canRedo:e.canRedo,undoLabel:e.undoLabel,redoLabel:e.redoLabel,dirty:e.dirty,layerRevision:e.layerRevision,nextFrameIdentity:e._nextFrameIdentity,nextUid:e._nextUid};}
function snap(e){return {canonicalState:canonicalState(e),document:json(e.report),frame:json(e.evaluatedFrame),state:state(e),history:{revision:e.revision,serial:e._revisionSerial,saved:e._savedRevision,size:e._historySize,undo:json(e._undo),redo:json(e._redo)},sourceIds:Object.keys(e.report._styk?.frameSources??{}),drag:Boolean(e._drag)};}
const output=[];
async function tape(name,options,initialDocument,calls){
 ids=0;const e=open(initialDocument,options),steps=[];let events=[];e.addEventListener('change',event=>events.push(JSON.parse(json(event.detail))));
 const before=snap(e);assert.equal(e._undo.length,0);assert.equal(e._redo.length,0);
 for(const call of calls){events=[];let result,error=null;
  const [method,...raw]=call;let args=raw.map(v=>typeof v==='string'&&v.startsWith('$')?pictures[v.slice(1)]:v);
  try{
   if(method==='@abortLoad'){const control=new AbortController();control.abort();result=await e.loadAsync(base(),'Cancelled incoming',{signal:control.signal});}
   else if(method==='@reset'){result=e.load(base(),'Fresh lineage');}
   else result=await e[method](...args);
  }catch(caught){error={name:caught.name,key:caught.messageKey??null,message:caught.message};}
  const after=snap(e);steps.push({call,resultDefined:result!==undefined,...(result!==undefined?{result:json(result)}:{}),error,events,after});
 }
 output.push({name,options,before,calls,steps});console.log(name,steps.length,'steps',steps.filter(s=>s.error).length,'errors');
}
const operations=[['select',2],['importFigure','$B'],['importFigure','$B'],['undo'],['undo'],['redo'],['redo'],['undo'],['importFigure','$C'],['redo'],['beginDrag','Image working pose'],['moveSelection',12,-4],['cancelDrag'],['@abortLoad'],['@reset'],['importFigure','$B'],['undo'],['redo'],['importBackground','$background'],['undo'],['redo']];
await tape('native-images',{layerTimeline:false,propertyChannels:false},base(),operations);
await tape('sheet-images',{layerTimeline:true,propertyChannels:true},base(),operations);
const nested=open(base(),{layerTimeline:false,propertyChannels:false});nested.select(2);nested.createMovieclip({name:'Nested image clip',replace:false});
await tape('nested-images',{layerTimeline:false,propertyChannels:false},JSON.parse(json(nested.report)),[['select',2],['beginDrag','Retained image pose'],['moveSelection',7,9],['cancelDrag'],['importFigure','$B'],['undo'],['redo'],['@abortLoad'],['@reset']]);
const sheet=open(base(),{layerTimeline:true,propertyChannels:true});sheet.select(2);sheet.beginDrag('Retained image source');sheet.moveSelection(8,3);sheet.commitDrag();sheet.importFigure(pictures.B);sheet.undo();sheet.redo();
await tape('retained-source-images',{layerTimeline:true,propertyChannels:true},JSON.parse(json(sheet.report)),[['importFigure','$B'],['undo'],['redo'],['importFigure','$C'],['undo'],['undo'],['redo'],['redo'],['@abortLoad'],['@reset']]);
await tape('sheet-distinct-payload-values',{layerTimeline:true,propertyChannels:true},base(),[['importFigure','$B'],['importFigure','$B'],['importFigure','$Bfresh'],['undo'],['redo'],['setFPS',30],['updateProject',{canvas_width:800,canvas_height:480}],['undo'],['redo']]);
const artifact={pictures,tapes:output};writeFileSync(path.join(out,'image-namespace.observation.json'),json(artifact)+'\n');
assert.equal(output.flatMap(t=>t.steps).length,70);console.log('Frozen actual Editor namespace semantics: 70 calls, five original loaded owners.');

{
const fixture=JSON.parse(readFileSync(repo+'/engine/tests/session-live/sheet-drag-cancel.json','utf8'));
const imported=JSON.parse(readFileSync(repo+'/engine/crates/styk-eval/tests/fixtures/drawlist/outlined-text.json','utf8'));
const editor=open(JSON.parse(fixture.steps[0].document),fixture.options);
const history=()=>({revision:editor.revision,serial:editor._revisionSerial,saved:editor._savedRevision});
const state={...fixture.options,tick:editor.tick,frameIndex:editor.frameIndex,selectedUid:editor.selectedUid??null,selectedUids:[...(editor.selectedUids??[])],selectedJoint:editor.selectedJoint??-1,activeLayerId:editor.activeLayerId,autoKey:Boolean(editor.autoKey),sheetSelection:editor._sheetSelection?{id:editor._sheetSelection.id,contents:Boolean(editor._sheetSelection.contents)}:null,layerRevision:editor.layerRevision,nextFrameIdentity:editor._nextFrameIdentity,nextUid:editor._nextUid};
assert.equal(json(editor.report),fixture.steps[0].document);assert.deepEqual(history(),{revision:fixture.steps[0].history.revision,serial:fixture.steps[0].history.revisionSerial,saved:fixture.steps[0].history.savedRevision});
const before={document:json(editor.report),frame:json(editor.evaluatedFrame),history:history(),state};
let result,error=null;const events=[];editor.addEventListener('change',event=>events.push(JSON.parse(json(event.detail))));
try{result=await editor.importFigure(imported);}catch(caught){error={message:caught.message,key:caught.messageKey??null,name:caught.name};}
assert.equal(error,null);assert.equal(editor.report.figure_types.length,JSON.parse(before.document).figure_types.length+3);
const after={canonicalState:canonicalState(editor),document:json(editor.report),frame:json(editor.evaluatedFrame),history:history(),resultDefined:result!==undefined,...(result!==undefined?{resultJSON:json(result)}:{}),error,events};
writeFileSync(path.join(out,'glyph-import.observation.json'),json({options:fixture.options,before,call:['importFigure',imported],after})+'\n');
console.log('Recorded actual Editor importFigure: three text definitions; complete document/frame/result/event output.');

}
