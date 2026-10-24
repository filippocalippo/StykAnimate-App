// Actual editor refusal and owning remapper records for malformed scope metadata.
// Invalid metadata is never certified as a loaded editor document.
import {mkdirSync,writeFileSync} from 'node:fs';
import {open,documentOf} from './fixture-kit.mjs';
import {remapVfxOwner} from '../../src/vfx.mjs';
import {createMovieclipMaterializer} from '../../src/movieclip-materialize.mjs';
import {snapshotPoseFrame} from '../../src/pose-snapshot.mjs';
const folder=new URL('../tests/vfx-owner-edges/',import.meta.url);mkdirSync(folder,{recursive:true});
const json=value=>JSON.stringify(value,(key,value)=>key==='runtime_segments'?undefined:value);
const scopes=['1','1/','1/11/extra','*','*/','*/NaN','*/Infinity','*/-Infinity','999/11/extra','opaque'];
const stacks={figure:[],...Object.fromEntries(scopes.map((key,index)=>[key,[{id:`edge-${index}`,type:'blur',enabled:true,params:{radius:1}}]]))};
const e=open(documentOf([[[11,0,20,0]]]));e.select(1);e.serialize();
const state=()=>({document:json(e.report),selection:e._selectionState(),historySize:e.historySize,revision:e.revision,revisionSerial:e._revisionSerial,savedRevision:e._savedRevision,layerRevision:e.layerRevision,nextFrameIdentity:e._nextFrameIdentity,nextUid:e._nextUid});
const refused=[];
for(const key of scopes){const before=state(),events=[];const listener=event=>events.push(event.detail);e.addEventListener('change',listener);let error;try{e.updateObject({_stykVfx:{[key]:stacks[key]}});}catch(caught){error={key:caught.messageKey,message:caught.message};}e.removeEventListener('change',listener);const after=state();
 const reopened=open(JSON.parse(after.document));refused.push({key,call:['updateObject',{_stykVfx:{[key]:stacks[key]}}],error,before,after,events,reopened:json(reopened.report)});
 if(!error||json(before)!==json(after)||json(reopened.report)!==before.document)throw new Error(`malformed metadata escaped rollback ${key}`);
}
const owner={...structuredClone(e.object),_stykVfx:stacks,privateEffectOwner:{preserve:['opaque',7]}};
const cases=[];for(const [name,typeId,handles] of [['clipboard-definition',5,undefined],['topology-handles',1,new Map([[11,[11,44]]])]]){const expected=structuredClone(owner);remapVfxOwner(expected,typeId,handles,1);cases.push({name,owner,typeId,handles:handles?[...handles]:null,sourceType:1,expected});}
const input=snapshotPoseFrame(e.evaluatedFrame);input.objects[0]=structuredClone(owner);const materializer=createMovieclipMaterializer(e.report),frame=materializer.frame(input);
writeFileSync(new URL('scopes.json',folder),json({document:JSON.parse(json(e.report)),refused,cases,materializer:{frame:input,reference:{frame,figures:materializer.figures,identities:[...materializer.identities]}}})+'\n');
console.log(`${refused.length} real editor refusals; ${cases.length} direct owning remapper records; actual materializer record`);
