// Real editor checkpoints for deferred worker accounting. The readiness marker
// changes no editor behavior: its arguments capture the existing owner's settings
// and exact accumulated total, while ordinary calls still record all outcomes.
import {readFileSync} from 'node:fs';
import {record} from './history-fixtures.mjs';
const output=new URL('../tests/history-readiness/',import.meta.url);
for(const name of ['topology-native','topology-sheet','rig-drag-native','batch-sheet','audio-sheet','clip-capture-active-layer-native','clip-capture-active-anchor-native']){
  const url=new URL(`../tests/edit/${name}.scenario.json`,import.meta.url),scenario=JSON.parse(readFileSync(url,'utf8'));
  const document=typeof scenario.document==='string'?JSON.parse(readFileSync(new URL(scenario.document,url),'utf8')):scenario.document;
  const at=Math.max(1,Math.floor(scenario.steps.length*.65)),before=scenario.steps.slice(0,at),after=scenario.steps.slice(at);
  record(`warm-${name}`,document,{...scenario.editor,historyReady:false},[...before,['@prepareHistory'],...after,['undo'],['redo']],output);
}
const dense=JSON.parse(readFileSync(new URL('../tests/history/native-dense-retirement.json',import.meta.url),'utf8'));
record('warm-dense',JSON.parse(dense.steps[0].document),{historyReady:false},[['@select',1,-1],['moveSelection',1,2],['moveSelection',3,4],['@prepareHistory'],['undo'],['redo'],['moveSelection',5,6]],output);
const audio=JSON.parse(readFileSync(new URL('../tests/edit/audio-sheet.scenario.json',import.meta.url),'utf8'));
const audioUrl=new URL('../tests/edit/audio-sheet.scenario.json',import.meta.url),audioDocument=typeof audio.document==='string'?JSON.parse(readFileSync(new URL(audio.document,audioUrl),'utf8')):audio.document;
record('warm-retired-audio',audioDocument,{...audio.editor,historyReady:false},[...audio.steps,...Array.from({length:90},(_,i)=>['setFPS',i%2?30:24]),['@prepareHistory'],['undo'],['undo'],['redo'],['setFPS',27],['undo'],['redo']],output);
record('warm-fractional-retirement',audioDocument,{...audio.editor,historyReady:false},[['deleteAudioTrack','audio-b'],...Array.from({length:90},(_,i)=>['setFPS',i%2?30:24]),['@prepareHistory'],['undo'],['undo'],['redo'],['setFPS',27],['undo'],['redo']],output);
console.log('Warm history checkpoints generated from the real editor.');
