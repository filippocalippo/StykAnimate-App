import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {workloads} from './animation-mode-performance-fixture.mjs';

const browser=await chromium.launch({channel:'chrome',headless:true}),results=[];
const fixture=(await readFile(new URL('./animation-mode-performance-fixture.mjs',import.meta.url),'utf8')).replaceAll("'../src/","'/src/");
await mkdir('artifacts/animation-mode-performance',{recursive:true});
try {
  for(const config of workloads.filter(row=>row.name!=='small')) {
    const page=await browser.newPage({viewport:{width:1440,height:960}}),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/benchmark-fixture.mjs',route=>route.fulfill({contentType:'text/javascript',body:fixture}));
    await page.goto(process.env.STYK_URL??'http://127.0.0.1:47831');await page.waitForFunction(()=>window.styk?.ready);
    console.log('BROWSER',config.name);
    await page.evaluate(async config=>{
      const {createPerformanceEditor}=await import('/benchmark-fixture.mjs');
      const source=createPerformanceEditor(config);await styk.editor.loadAsync(source.report);
      styk.editor.selectFrame(config.frames-1);styk.editor.select(1);styk.fit();
    },config);
    // Exclude document construction/startup from interactive measurements.
    await page.waitForTimeout(1200);
    const measured=await page.evaluate(async()=>{
      const {summary}=await import('/benchmark-fixture.mjs');
      const {beginNativePropertyEdit,previewNativePropertyEdit,commitNativePropertyEdit}=await import('/src/native-property-edit.mjs');
      const e=styk.editor,raf=()=>new Promise(resolve=>requestAnimationFrame(resolve)),timings={},frames=[],tasks=[],phases=[];
      let stopped=false,last;
      const heartbeat=time=>{if(last!==undefined)frames.push({at:last,duration:time-last});last=time;if(!stopped)requestAnimationFrame(heartbeat);};requestAnimationFrame(heartbeat);
      const observer=new PerformanceObserver(list=>{for(const entry of list.getEntries())tasks.push({at:entry.startTime,duration:entry.duration});});observer.observe({type:'longtask'});
      const run=(name,action)=>{const at=performance.now();action();const duration=performance.now()-at;(timings[name]??=[]).push(duration);return duration;};
      for(const mode of ['advanced','simple']) {
        const start=performance.now();run(`${mode}.switch`,()=>styk.settingsUI.commit({timelineMode:mode}));await raf();await raf();
        for(let iteration=0;iteration<5;iteration++) {
          run(`${mode}.begin`,()=>e.beginAnimationEdit({kind:'figure',uid:1},'x'));
          for(let step=0;step<8;step++){await raf();run(`${mode}.preview`,()=>e.previewAnimationEdit(600+iteration*10+step));}
          run(`${mode}.commit`,()=>e.commitAnimationEdit());await raf();
          run(`${mode}.undo`,()=>e.undo());await raf();run(`${mode}.redo`,()=>e.redo());await raf();
          if(mode==='simple')e.commitFrameDraft({mode:'update'});
          const token=beginNativePropertyEdit(e,'root_y');
          for(let step=0;step<8;step++){await raf();run(`${mode}.posePreview`,()=>previewNativePropertyEdit(token,300+iteration*10+step));}
          run(`${mode}.poseCommit`,()=>commitNativePropertyEdit(token));await raf();await raf();
          if(mode==='simple')e.commitFrameDraft({mode:'update'});
        }
        phases.push({mode,start,end:performance.now()});
      }
      const start=performance.now();e.beginFrameDraft({mode:'add'});
      const token=beginNativePropertyEdit(e,'root_y');previewNativePropertyEdit(token,550);commitNativePropertyEdit(token);
      const count=e.report.keyframes.length;await raf();run('addWorkingFrame',()=>e.addDraftFrame());await raf();await raf();
      phases.push({mode:'add',start,end:performance.now()});
      const correct=e.report.keyframes.length===count+1&&Math.abs(e.evaluatedFrame.objects.find(object=>object.unique_id===1).root_y-550)<1e-6;
      await new Promise(resolve=>setTimeout(resolve,100));stopped=true;observer.disconnect();
      return {correct,timingsMs:Object.fromEntries(Object.entries(timings).map(([name,values])=>[name,summary(values)])),
        phases:phases.map(({mode,start,end})=>({mode,frameIntervalsMs:summary(frames.filter(frame=>frame.at>=start&&frame.at<end).map(frame=>frame.duration)),
          longTasks:tasks.filter(task=>task.at>=start&&task.at<end).map(task=>Math.round(task.duration))})),renderer:styk.performance().renderer};
    });
    assert.equal(measured.correct,true);assert.deepEqual(errors,[]);
    await page.screenshot({path:`artifacts/animation-mode-performance/browser-${config.name}.png`});
    results.push({config,...measured,errors});console.log(JSON.stringify({config,phases:measured.phases,timingsMs:measured.timingsMs}));
    await writeFile('artifacts/animation-mode-performance/browser.json',JSON.stringify({measuredAt:new Date().toISOString(),results},null,2));
    await page.close();
  }
} finally {await browser.close();}
