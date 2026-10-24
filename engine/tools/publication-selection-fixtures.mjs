// Actual optional-selection owner views for prepared publication guards.
import {readFileSync,writeFileSync} from 'node:fs';
import {open} from './fixture-kit.mjs';
const folder=new URL('../tests/publication-selection/',import.meta.url);
const document=JSON.parse(readFileSync(new URL('source.document.json',folder),'utf8'));
const json=value=>JSON.stringify(value,(key,item)=>key==='runtime_segments'?undefined:item);
const view=e=>{
 const selection=e._selectionState();
 const state={tick:e.tick,frameIndex:e.frameIndex,selectedUid:e.selectedUid??null,selectedUids:[...e.selectedUids],selectedJoint:e.selectedJoint??-1,canUndo:e.canUndo,canRedo:e.canRedo,undoLabel:e.undoLabel,redoLabel:e.redoLabel,dirty:e.dirty,layerRevision:e.layerRevision,nextFrameIdentity:e._nextFrameIdentity,nextUid:e._nextUid};
 for(const key of ['polygonSelection','segmentIds','branch'])if(Object.hasOwn(selection,key))state[key]=selection[key];
 return {document:json(e.report),selection,state};
};
for(const field of ['polygonSelection','branch']){
 const e=open(structuredClone(document));e.select(1,0);
 const events=[];e.addEventListener('change',event=>events.push(event.detail));
 const metadata=unknown=>field==='polygonSelection'?{uid:1,index:0,typeId:1,unknown}:{uid:1,joint:1,unknown};
 const steps=[];
 const capture=(call)=>{steps.push({call,...view(e),events:[...events]});events.length=0;};
 capture(null);
 for(const unknown of ['before','newer']){
  const input={[field]:metadata(unknown)};
  e._restoreSelection({...e._selectionState(),...input});capture(['metadata',input]);
 }
 const reveal=field==='polygonSelection'?['selectMany',[1]]:['joint',1];
 if(reveal[0]==='selectMany')e.selectMany(reveal[1]);else e.selectedJoint=reveal[1];
 capture(reveal);
 if(steps[1].selection[field]!==undefined||steps[2].selection[field]!==undefined)throw Error('Metadata must be hidden for the guard recording');
 if(json(steps[1].selection)!==json(steps[2].selection)||steps[1].events.length||steps[2].events.length)throw Error('Hidden drift must preserve canonical selection and events');
 if(steps[3].selection[field]?.unknown!=='newer')throw Error('Actual owner did not reveal newer metadata');
 writeFileSync(new URL(`${field}.json`,folder),json({field,steps})+'\n');
}
console.log('Two actual hidden selection owner recordings generated.');
