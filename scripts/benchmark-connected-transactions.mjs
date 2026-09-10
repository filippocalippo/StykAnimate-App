/** Reproducible large-rig retiming and history-pressure regression benchmark. */
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {Editor} from '../src/editor.mjs';
import {emptyDocument,createFrame,createObject} from '../src/demo.mjs';
import {composePoseChannels} from '../src/animation-pose.mjs';
import {evaluatedNativeFrame,buildGeometry} from '../src/pivot/geometry.mjs';
const report=emptyDocument(),figure=report.figure_types[0];
report.keyframes=Array.from({length:1479},(_,i)=>createFrame(Array.from({length:105},(_,slot)=>
  createObject(figure,slot+1,100+i,200,{join:slot?{target_object_slot:slot-1,target_handle_id:1}:null})),3));
const editor=new Editor({demo:false,propertyChannels:true}).load(report);editor.select(1);
editor.beginTranslationDrag();editor.moveSelection(20,5);editor.commitDrag();
const selection=all=>{
  const keys=editor.animationChannels[0].keys,keyIds=all?keys.map(key=>key.id):[keys[1].id];
  return editor.animationChannels.map(channel=>({channelId:channel.id,keyIds}));
};
const results=[];
const measure=(name,fn)=>{
  const start=performance.now();fn();const ms=performance.now()-start;
  const sequences=new Set(editor.animationChannels.map(channel=>channel.keys)).size;
  assert.equal(sequences,1);
  results.push({name,ms,sequences,commandBytes:editor._undo.at(-1).bytes,historyBytes:editor.historySize});
};
measure('move one marker',()=>editor.moveAnimationKeys(selection(false),1));editor.undo();
measure('scale all markers',()=>editor.scaleAnimationKeys(selection(true),2,0));editor.undo();
for(let i=0;i<100;i++){
  measure('repeated retime',()=>editor.moveAnimationKeys(selection(true),1));
  if(i%10===0){const keys=editor.animationChannels[0].keys;editor.undo();editor.redo();assert.equal(editor.animationChannels[0].keys,keys);}
}
let samples=0;const start=performance.now();
composePoseChannels(editor.report,editor.frame,102,{sampleNative(...args){samples++;return evaluatedNativeFrame(...args);},resolveGeometry:buildGeometry});
const sampleMs=performance.now()-start;
assert.equal(samples,1);assert.ok(editor.historySize<=editor.historyBytes);assert.ok(editor._undo.length<=editor.historyLimit);
const repeated=results.slice(2).map(row=>row.ms).sort((a,b)=>a-b),output={frames:1479,parts:105,results,
  repeated:{p50:repeated[50],p95:repeated[95],max:repeated.at(-1)},samples,sampleMs,historyEntries:editor._undo.length,
  historyBytes:editor.historySize,historyLimit:editor.historyBytes};
await mkdir('artifacts/connected-editing/transactions',{recursive:true});
await writeFile('artifacts/connected-editing/transactions/report.json',JSON.stringify(output,null,2));
console.log(JSON.stringify({...output,results:results.slice(0,2)}));
