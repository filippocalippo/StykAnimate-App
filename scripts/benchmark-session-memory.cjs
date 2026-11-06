'use strict';
// Repeated real application actions in the existing isolated desktop runner.
// No debugger, production hooks, source writes or persistent user preferences.
const assert=require('node:assert/strict');
const {writeFile,appendFile}=require('node:fs/promises');
const path=require('node:path');

function install(forcedGC){
  const p=window.__sessionProbe={refs:[],errors:[],forcedGC};
  p.check=(value,message)=>{if(!value)throw new Error(message);};
  p.check(!forcedGC||typeof globalThis.gc==='function','Explicit renderer GC was not exposed');
  p.onError=event=>p.errors.push(event.message||String(event.reason));
  window.addEventListener('error',p.onError);window.addEventListener('unhandledrejection',p.onError);
  p.wait=async predicate=>{
    const deadline=performance.now()+120000;
    while(!predicate()){
      p.check(performance.now()<deadline,'Session operation timed out');
      await new Promise(resolve=>setTimeout(resolve,10));
    }
  };
  p.settle=async()=>{
    await p.wait(()=>!styk.state.importing&&!styk.state.dirtyRender);
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    await new Promise(resolve=>setTimeout(resolve,0));
  };
  p.capture=label=>{
    const report=styk.editor.report;
    p.refs.push({label,report:new WeakRef(report),frames:new WeakRef(report.keyframes),
      figures:new WeakRef(report.figure_types),firstFrame:new WeakRef(report.keyframes[0])});
  };
  p.pose=()=>JSON.stringify([...styk.editor.geometry.objects.values()].map(g=>({uid:g.obj.unique_id,
    root:g.root,joints:[...g.joints].sort((a,b)=>a[0]-b[0])})).sort((a,b)=>a.uid-b.uid));
  p.exercise=async()=>{
    const e=styk.editor,history=e._undo.length,revision=e.revision;
    const seeks=[];
    for(const fraction of [.2,.91,1]){
      const tick=Math.round((e.totalTicks-1)*fraction),at=performance.now();e.seek(tick);await p.settle();
      p.check(e.tick===tick&&e._undo.length===history&&e.revision===revision,'Seek changed document/history');
      seeks.push({tick,elapsedMs:performance.now()-at,preparation:structuredClone(styk.performance().editablePreparation)});
    }
    // Use an existing root so attached-object constraints are not bypassed.
    const object=e.frame.objects.find(object=>!object.join);p.check(object,'Session fixture needs a root figure');
    e.select(object.unique_id);await p.settle();const before=p.pose();
    e.updateObject({root_x:object.root_x+1});await p.settle();const edited=p.pose();
    p.check(edited!==before,'Session edit did not change the pose');
    await e.undo();await p.settle();p.check(p.pose()===before,'Undo did not restore every joint/root');
    await e.redo();await p.settle();p.check(p.pose()===edited,'Redo did not restore every joint/root');
    await e.undo();await p.settle();p.check(p.pose()===before,'Final undo did not restore the input pose');
    const renderer=styk.state.renderer,render=renderer.renderPrepared,presented=[];
    p.check(typeof render==='function','Session probe requires WebGPU');
    const loop=styk.state.loop;styk.state.loop=false;e.seek(0);await p.settle();
    renderer.renderPrepared=function(...args){const result=render.apply(this,args);
      if(result&&styk.state.playing&&presented.at(-1)!==e.tick)presented.push(e.tick);return result;};
    try{
      await styk.actions.play();
      await p.wait(()=>presented.length>=Math.min(8,e.totalTicks)||!styk.state.playing);
      p.check(presented.length>=Math.min(8,e.totalTicks)&&presented.every((tick,index)=>tick===index),'Playback skipped a requested tick');
    }finally{if(styk.state.playing)await styk.actions.play();renderer.renderPrepared=render;styk.state.loop=loop;}
    await p.settle();e.markSaved();
    await stykDesktop.setDocumentState({name:e.name,dirty:false});
    return {seeks,presented,history:e._undo.length,revision:e.revision};
  };
  p.sample=async()=>{
    const memory=()=>performance.memory?{used:performance.memory.usedJSHeapSize,total:performance.memory.totalJSHeapSize,
      limit:performance.memory.jsHeapSizeLimit}:null;
    const natural=memory();
    if(forcedGC){
      await new Promise(resolve=>setTimeout(resolve,0));globalThis.gc();
      await new Promise(resolve=>setTimeout(resolve,0));globalThis.gc();
    }
    // Dereference only after collection/task turns, and return labels, not objects.
    const retained=Object.fromEntries(['report','frames','figures','firstFrame'].map(key=>
      [key,p.refs.filter(ref=>Boolean(ref[key].deref())).map(ref=>ref.label)]));
    const performanceState=styk.performance();
    return {natural,collected:forcedGC?memory():null,retained,playback:performanceState.playback,
      renderer:performanceState.renderer,errors:[...p.errors]};
  };
}

module.exports=async function sessionMemory(window,{cycles,input,alternate,output,forcedGC,choose,metrics}){
  assert.ok(alternate&&cycles>0);const execute=code=>window.webContents.executeJavaScript(code);
  const rowsFile='session-rows.jsonl';await writeFile(path.join(output,rowsFile),'',{flag:'wx'});
  await execute("styk.settingsUI.commit({timelineMode:'advanced'});for(const dialog of document.querySelectorAll('dialog[open]'))dialog.close();");
  await execute(`(${install.toString()})(${JSON.stringify(forcedGC)})`);
  const started=performance.now();
  try{
    await execute("__sessionProbe.capture('initial');styk.editor.markSaved();");
    for(let cycle=0;cycle<cycles;cycle++){
      const file=cycle%2?input:alternate;choose(file);const at=performance.now();
      await execute("(async()=>{await styk.actions.open();for(const dialog of document.querySelectorAll('dialog[open]'))dialog.close();await __sessionProbe.settle();})()");
      await execute(`__sessionProbe.capture(${JSON.stringify(`cycle-${cycle}`)})`);
      const actions=await execute('__sessionProbe.exercise()');
      // Let bounded warm-up/thumbnail work reach its normal idle state.
      await execute("new Promise(resolve=>setTimeout(resolve,1000))");
      const sample=await execute('__sessionProbe.sample()');assert.deepEqual(sample.errors,[]);
      const row={cycle,file:path.basename(file),elapsedMs:performance.now()-at,actions,sample,
        processes:metrics().map(({pid,type,memory})=>({pid,type,memory}))};
      await appendFile(path.join(output,rowsFile),JSON.stringify(row)+'\n');
      await writeFile(path.join(output,'session-progress.json'),JSON.stringify({cycles,forcedGC,completed:cycle+1,last:row},null,2));
      console.log(JSON.stringify({sessionCycle:cycle,heap:sample.collected?.used??sample.natural?.used,retained:sample.retained}));
    }
    return {cycles,completed:cycles,forcedGC,elapsedMs:performance.now()-started,rowsFile,limitations:[
      'Repeated real open/seek/edit/undo/redo/playback actions; synthetic workload, not physical input latency.',
      'Benchmark-only precise-memory-info disables Chromium heap-counter caching. The counter includes current-isolate V8 external memory, not total application/GPU residency.',
      'Electron process working sets include workers and shared pages, exclude the Python codec, and cannot be summed as unique memory.',
      'Optional forced GC is outside actions; these runs measure collectibility and perturb natural GC behavior.',
      'Rows stream to disk; the external Node driver assembles them after Electron exits. The renderer retains four weak references and a label per visited document, bounded by 1001 documents.',
      'Backend and OS input caches remain enabled.',
      'Eight exact playback ticks and selected seek/edit outcomes do not certify every frame or multi-hour stability.'
    ]};
  }finally{
    await execute("if(window.__sessionProbe){window.removeEventListener('error',__sessionProbe.onError);window.removeEventListener('unhandledrejection',__sessionProbe.onError);delete window.__sessionProbe;}");
  }
};
