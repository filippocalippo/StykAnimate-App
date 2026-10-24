import assert from 'node:assert/strict';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {documentOf,limb,open,nextKey} from '../engine/tools/fixture-kit.mjs';
const MAX=Number.MAX_SAFE_INTEGER;
const plain=report=>JSON.stringify(report,(key,value)=>key==='runtime_segments'?undefined:value);
function prepared(){
 const e=open(documentOf([limb(),limb(),limb()],i=>[180+i*170,150]));
 nextKey(e,4);e.seek(0);e.select(2);e.createMovieclip({uids:[2],start:0,end:5,replace:false});
 e.addFigure(4);e.createLayer('Second');e.setActiveLayer('layer-2');e.seek(2);e.addFigure(4);
 return JSON.parse(plain(e.report));
}
function report(counter,collisions=[]){
 const document=prepared(),channel=document._styk.animation.channels.find(channel=>channel.target.kind==='layer'&&channel.target.id==='layer-2');
 document._styk.animation.nextKeyId=counter;
 if(collisions.length){channel.keys[0].id=`key-${collisions[0]}`;for(const id of collisions.slice(1))channel.keys.push({...structuredClone(channel.keys[0]),id:`key-${id}`,tick:3,hidden:true});}
 open(structuredClone(document)).serialize();return document;
}
function snapshot(e){return JSON.stringify({report:plain(e.report),selection:e._selectionState(),uid:e._nextUid,frame:e._nextFrameIdentity,revision:e.revision,serial:e._revisionSerial,layer:e.layerRevision,undo:e._undo,redo:e._redo,bytes:e.historySize,pendingSource:e._pendingSourceBytes??0,pendingLayers:e._pendingSourceLayerChanges??[],hints:[...e._newLayerHints??[]],generated:[...e._generatedFrameSources??[]]});}
for(const [label,counter,collisions] of [['maximum',MAX,[]],['single collision',MAX,[MAX]],['near maximum collision',MAX-1,[MAX-1]]]){
 test(`native insertion preserves saving/history/counters at ${label}`,()=>{
  const e=open(report(counter,collisions));e.seek(3);const before=snapshot(e),saved=plain(e.serialize()),events=[];e.addEventListener('change',event=>events.push(event.detail));
  assert.throws(()=>e.addFigure(4),error=>error.messageKey==='errors.animationChannels.invalidAnimationKeyIdentityCounter');
  assert.equal(snapshot(e),before);assert.deepEqual(events,[]);assert.equal(plain(e.serialize()),saved);open(JSON.parse(saved)).serialize();
 });
}
test('last safe counter allocation remains saveable and undo/redo preserves it',()=>{
 const e=open(report(MAX-1));e.seek(3);e.addFigure(4);assert.equal(e.report._styk.animation.nextKeyId,MAX);const saved=plain(e.serialize());open(JSON.parse(saved)).serialize();e.undo();e.redo();assert.equal(plain(e.serialize()),saved);
});
test('valid double key collision terminates atomically instead of freezing insertion',()=>{
 const code=`import fs from 'node:fs';import {Editor} from './src/editor.mjs';const plain=report=>JSON.stringify(report,(key,value)=>key==='runtime_segments'?undefined:value);const e=new Editor({demo:false}).load(JSON.parse(fs.readFileSync(0,'utf8')));e.seek(3);const before=plain(e.report),state=JSON.stringify(e._selectionState()),counters=JSON.stringify([e._nextUid,e._nextFrameIdentity,e.revision,e._revisionSerial,e.layerRevision,e.historySize]),events=[];e.serialize();e.addEventListener('change',event=>events.push(event.detail));let key=null;try{e.addFigure(4);}catch(error){key=error.messageKey;}e.serialize();new Editor({demo:false}).load(JSON.parse(plain(e.serialize()))).serialize();console.log(JSON.stringify({key,same:before===plain(e.report),stateSame:state===JSON.stringify(e._selectionState()),countersSame:counters===JSON.stringify([e._nextUid,e._nextFrameIdentity,e.revision,e._revisionSerial,e.layerRevision,e.historySize]),events:events.length}));`;
 const result=spawnSync(process.execPath,['--import','./tests/support/register-engine.mjs','--input-type=module','-e',code],{cwd:process.cwd(),input:JSON.stringify(report(MAX,[MAX,MAX+1])),encoding:'utf8',timeout:4000});
 assert.equal(result.status,0,`actual editor insertion did not finish: ${result.error?.code??result.stderr}`);
 assert.deepEqual(JSON.parse(result.stdout),{key:'errors.animationChannels.invalidAnimationKeyIdentityCounter',same:true,stateSame:true,countersSame:true,events:0});
});
