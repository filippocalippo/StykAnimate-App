/** Profile the actual figure clipboard path across frames, including UI listeners. */
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';

const source=process.argv[2]??'C:/Users/aleri/Downloads/tdd2 uriel nemesis 2.piv';
const output=`artifacts/figure-paste/${process.argv[3]??'local'}`;
await mkdir(output,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1600,height:1000}}),errors=[];
page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(180000);
try {
  await page.goto(process.env.STYK_URL??'http://127.0.0.1:47831');await page.waitForFunction(()=>window.styk?.ready);
  await page.locator('#file-input').setInputFiles(source);
  await page.waitForFunction(name=>!styk.state.importing&&styk.editor.name===name,path.basename(source,'.piv'));
  const scene=await page.evaluate(()=>{
    const e=styk.editor,counts=new Map(e.report.figure_types.map(f=>[f.figure_type_id,f.segments.length]));
    const frames=e.report.keyframes.map((f,i)=>({i,objects:f.objects.length,segments:f.objects.reduce((n,o)=>n+counts.get(o.figure_type_id),0)}));
    const heavy=frames.reduce((a,b)=>a.segments>b.segments?a:b);e.selectFrame(heavy.i);styk.fit();
    const groups=e.selectionFrame.objects.filter(o=>!o.join).map(o=>({uid:o.unique_id,...e.resolveTranslationSelection([o.unique_id])}));
    const group=groups.sort((a,b)=>b.affectedSlots.length-a.affectedSlots.length)[0];e.selectConnected(group.uid);
    window.pasteBench={heavy,group};
    return {frames:frames.length,heavy,parts:group.affectedSlots.length,definitions:e.report.figure_types.length};
  });
  await page.waitForFunction(()=>!styk.state.editablePreparing);
  const client=await page.context().newCDPSession(page);await client.send('Profiler.enable');await client.send('Profiler.start');
  const measured=await page.evaluate(async()=>{
    const e=styk.editor,calls=[],times={},tasks=[],raf=()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    for(const name of ['_authoredTransaction','commitAuthoredPoseDrag','_commitSheetPose','_commitSheetRange','_record','_emit','_layerChanged','_trackLayerCommand','_synchronizeAnimationOrigins','applyFigureRange']){
      const original=e[name];e[name]=function(...args){const start=performance.now();try{return original.apply(this,args);}finally{calls.push({name,ms:performance.now()-start});}};
    }
    const observer=new PerformanceObserver(list=>tasks.push(...list.getEntries().map(x=>({start:x.startTime,ms:x.duration}))));observer.observe({type:'longtask'});
    const measure=(name,fn)=>{const start=performance.now(),result=fn();times[name]=performance.now()-start;return result;};
    const copied=measure('copy',()=>e.copySelection());
    e.seek(Math.max(0,e.tick-1));await raf();while(styk.state.editablePreparing)await raf();
    const clean=()=>JSON.stringify(e.evaluatedFrame.objects.map(({runtime_segments,_movieclipSample,...o})=>o));
    const before=clean(),history=e._undo.length,start=performance.now();
    const pasted=measure('paste',()=>e.pasteSelection()).map(o=>o.unique_id);
    await raf();while(styk.state.editablePreparing)await raf();await styk.state.renderer.device?.queue.onSubmittedWorkDone();
    times.pasteToPresent=performance.now()-start;
    const after=clean(),commands=e._undo.length-history,bytes=e._undo.at(-1)?.bytes;
    measure('undo',()=>e.undo());const undo=clean()===before;await raf();
    measure('redo',()=>e.redo());const redo=clean()===after;await raf();
    observer.disconnect();e.markSaved();return {times,calls,tasks,copied,pasted:pasted.length,commands,bytes,undo,redo};
  });
  const {profile}=await client.send('Profiler.stop');await writeFile(`${output}/cpu.cpuprofile`,JSON.stringify(profile));
  await page.screenshot({path:`${output}/scene.png`});
  await writeFile(`${output}/report.json`,JSON.stringify({source,scene,...measured,errors},null,2));
  console.log(JSON.stringify({scene,...measured,errors}));
  assert.equal(measured.pasted,measured.copied);assert.equal(measured.commands,1);assert.ok(measured.undo);assert.ok(measured.redo);assert.deepEqual(errors,[]);
}finally{await browser.close();}
