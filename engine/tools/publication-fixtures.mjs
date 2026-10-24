// Actual async editor publication and history ownership; no simulated command.
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {open} from './fixture-kit.mjs';
const out=new URL('../tests/publication/',import.meta.url);mkdirSync(out,{recursive:true});
Object.defineProperty(performance,'now',{value:()=>0,configurable:true});
const json=value=>JSON.stringify(value,(key,item)=>key==='runtime_segments'?undefined:item);
function view(e){
  const entry=c=>({label:c.label,bytes:c.bytes,...(c.commands?{children:c.commands.map(entry)}:{})});
  return {document:json(e.report),state:{tick:e.tick,frameIndex:e.frameIndex,selectedUid:e.selectedUid??null,selectedUids:[...e.selectedUids],selectedJoint:e.selectedJoint??-1,canUndo:e.canUndo,canRedo:e.canRedo,undoLabel:e.undoLabel,redoLabel:e.redoLabel,dirty:e.dirty,layerRevision:e.layerRevision,nextFrameIdentity:e._nextFrameIdentity,nextUid:e._nextUid},selection:e._selectionState(),history:{size:e.historySize,undo:e._undo.map(entry),redo:e._redo.map(entry),revision:e.revision,revisionSerial:e._revisionSerial,savedRevision:e._savedRevision}};
}
for(const name of ['shared','vacant','vacant-tail','combined','absence','delete-unused','delete-native','delete-joined','dense','noop','movieclip','delete-movieclip']){
  const source=JSON.parse(readFileSync(new URL(`../tests/layer-sheet-migration/${name}.json`,import.meta.url),'utf8'));
  for(const budget of name==='combined'?[50331648,0]:[50331648]){
    const e=open(JSON.parse(source.document),{layerTimeline:true,propertyChannels:false,historyBytes:budget});e._restoreSelection(source.initialState.selection);
    const events=[];e.addEventListener('change',event=>events.push(event.detail));
    const request=source.request,operation=request.deletedLayerId?['deleteLayerAsync',request.deletedLayerId]:['assignFiguresToLayerAsync',request.uids,request.targetLayerId];
    const steps=[{call:null,...view(e),events:[]}];
    for(const call of [operation,['undo'],['redo'],['undo'],operation,['undo'],['redo']]){
      events.length=0;let result,error=null;
      try{result=await e[call[0]](...call.slice(1));}catch(caught){error={message:caught.message,key:caught.messageKey??null};}
      steps.push({call,result:result??null,error,...view(e),events:[...events]});
    }
    writeFileSync(new URL(`${name}${budget===0?'-zero-budget':''}.json`,out),json({name,request,options:{layerTimeline:true,propertyChannels:false},historyLimits:{count:e.historyLimit,bytes:e.historyBytes},steps})+'\n');
  }
}
console.log('Prepared publication recordings generated from actual async editor commands.');
