import {writeFile,mkdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {createPerformanceEditor} from '../tests/animation-mode-performance-fixture.mjs';
import {beginNativePropertyEdit,previewNativePropertyEdit,commitNativePropertyEdit} from '../src/native-property-edit.mjs';
if(!globalThis.gc)throw new Error('Run with node --expose-gc.');
const config={frames:2000,figures:20,channels:20,keys:2000},editor=createPerformanceEditor(config),samples=[];
const propertyChannels=process.argv.includes('--property-channels');editor.propertyChannels=propertyChannels;
editor.historyLimit=12;editor.enableFrameDrafts();
for(let batch=0;batch<4;batch++) {
  for(let i=0;i<50;i++) {
    const token=beginNativePropertyEdit(editor,'root_y');previewNativePropertyEdit(token,300+batch*50+i);commitNativePropertyEdit(token);
    editor.commitFrameDraft({mode:'update'});
  }
  await new Promise(resolve=>setImmediate(resolve));globalThis.gc();
  samples.push({edits:(batch+1)*50,heapUsed:process.memoryUsage().heapUsed,historyBytes:editor.historySize,
    historyCommands:editor._undo.length,sources:Object.keys(editor.report._styk.frameSources??{}).length});
}
assert.ok(samples.every(sample=>sample.historyCommands===12&&sample.sources<=14));
const retainedGrowth=samples.at(-1).heapUsed-samples[1].heapUsed;
assert.ok(retainedGrowth<8*1024*1024,'Retained memory should plateau once bounded history is full.');
await mkdir('artifacts/animation-mode-performance',{recursive:true});
const result={config,propertyChannels,samples,retainedGrowthBytes:retainedGrowth,correct:editor.evaluatedFrame.objects.find(object=>object.unique_id===1).root_y===499};
assert.equal(result.correct,true);await writeFile(`artifacts/animation-mode-performance/memory${propertyChannels?'-property-channels':''}.json`,JSON.stringify(result,null,2));
console.log(JSON.stringify(result,null,2));
