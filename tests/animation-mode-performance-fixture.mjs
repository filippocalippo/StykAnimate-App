import {Editor} from '../src/editor.mjs';
import {emptyDocument,createFrame,createObject} from '../src/demo.mjs';
import {animationChannelId} from '../src/animation-channels.mjs';
import {beginNativePropertyEdit,previewNativePropertyEdit,commitNativePropertyEdit} from '../src/native-property-edit.mjs';

export const workloads = [
  {name:'small',frames:100,figures:10,channels:10,keys:100},
  {name:'long',frames:10000,figures:10,channels:10,keys:1000},
  {name:'dense',frames:200,figures:500,channels:500,keys:100},
  {name:'many-keys',frames:1000,figures:20,channels:20,keys:10000},
];
export function createPerformanceEditor(config) {
  const report=emptyDocument(),figure=report.figure_types[0];
  report.keyframes=Array.from({length:config.frames},(_,index)=>createFrame(Array.from({length:config.figures},(_,slot)=>
    createObject(figure,slot+1,50+(slot%40)*20+(index%20),100+Math.floor(slot/40)*35)),2));
  let serial=1;
  report._styk={animation:{version:1,nextKeyId:config.channels*config.keys+1,channels:Array.from({length:config.channels},(_,slot)=>{
    const target={kind:'figure',uid:slot+1},property='x';
    return {id:animationChannelId(target,property),target,property,keys:Array.from({length:config.keys},(_,index)=>
      ({id:`key-${serial++}`,tick:index,value:50+(slot%40)*20+(index%20),interpolation:'linear'}))};
  })}};
  const editor=new Editor({demo:false,historyLimit:40}).load(report);
  editor.selectFrame(config.frames-1);editor.select(1);
  return editor;
}
const round=value=>Math.round(value*1000)/1000;
export function summary(samples) {
  const sorted=samples.slice().sort((a,b)=>a-b),at=q=>sorted[Math.min(sorted.length-1,Math.ceil(sorted.length*q)-1)];
  return {samples:samples.length,p50:round(at(.5)),p95:round(at(.95)),max:round(sorted.at(-1)),total:round(samples.reduce((a,b)=>a+b,0))};
}
export async function measureEditor(editor,{repeats=7,yieldControl=()=>Promise.resolve(),onPhase=()=>{}}={}) {
  const samples={},measure=(name,action)=>{
    const start=performance.now(),value=action();(samples[name]??=[]).push(performance.now()-start);return value;
  };
  const target={kind:'figure',uid:1};
  // First-use caches are reported separately from warm samples.
  measure('coldGeometry',()=>editor.geometry);
  for(const mode of ['advanced','simple']) {
    if(mode==='simple')editor.enableFrameDrafts();
    else editor.disableFrameDrafts();
    for(let iteration=0;iteration<repeats;iteration++) {
      await yieldControl();
      measure(`${mode}.scalarBegin`,()=>editor.beginAnimationEdit(target,'x'));
      for(let step=0;step<8;step++)measure(`${mode}.scalarPreview`,()=>editor.previewAnimationEdit(500+iteration*10+step));
      measure(`${mode}.scalarCommit`,()=>editor.commitAnimationEdit());
      measure(`${mode}.undo`,()=>editor.undo());measure(`${mode}.redo`,()=>editor.redo());
      if(mode==='simple')editor.commitFrameDraft({mode:'update'});
      // Exercise the real inspector/canvas pose path, including composition.
      const token=measure(`${mode}.poseBegin`,()=>beginNativePropertyEdit(editor,'root_y'));
      for(let step=0;step<8;step++)measure(`${mode}.posePreview`,()=>previewNativePropertyEdit(token,200+iteration*10+step));
      measure(`${mode}.poseCommit`,()=>commitNativePropertyEdit(token));
      if(mode==='simple')editor.commitFrameDraft({mode:'update'});
    }
    onPhase(mode);
  }
  for(let iteration=0;iteration<repeats;iteration++) {
    await yieldControl();
    measure('cleanToAdvanced',()=>editor.disableFrameDrafts());measure('cleanToSimple',()=>editor.enableFrameDrafts());
  }
  for(let iteration=0;iteration<3;iteration++) {
    await yieldControl();editor.beginFrameDraft({mode:'add'});
    const token=beginNativePropertyEdit(editor,'root_y');previewNativePropertyEdit(token,400+iteration);commitNativePropertyEdit(token);
    measure('addWorkingFrame',()=>editor.addDraftFrame());
    measure('undoAdd',()=>editor.undo());
    measure('discardWorkingFrame',()=>editor.discardFrameDraft());
  }
  return {timingsMs:Object.fromEntries(Object.entries(samples).map(([name,values])=>[name,summary(values)])),
    history:{commands:editor._undo.length,accountedBytes:editor.historySize,sources:Object.keys(editor.report._styk.frameSources??{}).length},
    finalFrames:editor.report.keyframes.length};
}
