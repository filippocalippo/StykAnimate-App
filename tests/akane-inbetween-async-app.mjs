/** Large native range through the actual app's retained worker planner. */
import {chromium} from 'playwright';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const output=path.resolve('artifacts/akane-inbetween-async-app');await mkdir(output,{recursive:true});
const source=process.argv[2]||'C:/Users/aleri/Downloads/16 Akane vs Akato Segundo round (3).piv';
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1600,height:1000}}),errors=[];
page.on('pageerror',error=>errors.push(error.message));
try{
  await page.goto(process.env.STYK_URL||'http://127.0.0.1:47831');await page.waitForFunction(()=>window.styk?.ready);
  await page.evaluate(()=>{styk.editor.markSaved();styk.state.settings.autosaveSeconds=0;});
  await page.locator('#file-input').setInputFiles(source);
  await page.waitForFunction(name=>!styk.state.importing&&styk.editor.name===name,path.basename(source,'.piv'),{timeout:180000});
  await page.evaluate(async()=>{
    const editor=styk.editor,{planInsertInbetweens}=await import('/src/editor-inbetween.mjs');
    if(typeof editor._inbetweenPlanner!=='function')throw new Error('Actual worker planner is not connected.');
    editor.discardFrameDraft?.();editor.seek(editor.totalTicks-1);
    const indices=Array.from({length:20},(_,i)=>editor.report.keyframes.length-20+i),ratio=.375;
    const pose=frame=>({duration:frame.duration_raw,camera:frame.camera,background:[frame.background_id,frame.background_id_b,frame.background_mix],
      order:frame.object_draw_order,objects:frame.objects.map(object=>({uid:object.unique_id,type:object.figure_type_id,x:object.root_x,y:object.root_y,
        angles:object.angles,lengths:object.lengths,bends:object.bends,len:object.len_flag,bend:object.bend_flag,scale:object.scale,join:object.join,
        color:object.color_override_raw,alpha:object.field28,style:object._stykStyle}))});
    const planned=planInsertInbetweens(editor,ratio,indices);
    window.__inbetween={indices,ratio,pose,expected:planned.entries.map(entry=>JSON.stringify(pose(entry.frame))),original:editor.report.keyframes.slice(),
      before:{revision:editor.revision,history:editor._undo.length,identity:editor._nextFrameIdentity,objects:editor.report.keyframes.reduce((n,frame)=>n+frame.objects.length,0)},
      tasks:[],gaps:[],progress:[]};
  });
  await page.waitForTimeout(500);
  await page.evaluate(()=>{
    const r=__inbetween;r.started=performance.now();let previous=r.started;
    r.observer=new PerformanceObserver(list=>{for(const entry of list.getEntries())r.tasks.push({at:entry.startTime,ms:entry.duration});});r.observer.observe({entryTypes:['longtask']});
    const draw=now=>{r.gaps.push({at:now,ms:now-previous});previous=now;if(!r.stop)requestAnimationFrame(draw);};requestAnimationFrame(draw);
    window.__inbetweenPromise=styk.editor.insertInbetweenFramesAsync(r.ratio,r.indices,{onProgress:value=>r.progress.push({...value,at:performance.now()})})
      .then(result=>{r.result=result;r.committed=performance.now();},error=>{r.error=error.message;r.committed=performance.now();});
  });
  await page.waitForFunction(()=>__inbetween.committed,null,{timeout:180000});await page.waitForTimeout(400);
  const result=await page.evaluate(async()=>{
    const r=__inbetween,e=styk.editor;r.stop=true;r.observer.disconnect();
    const after=r.result?.indices.map(index=>JSON.stringify(r.pose(e.report.keyframes[index])));
    const exact=JSON.stringify(after)===JSON.stringify(r.expected);
    const retained=r.original.every((frame,index)=>e.report.keyframes[index+r.indices.filter(value=>value<=index).length]===frame);
    const history=e._undo.length,report={before:r.before,ratio:r.ratio,indices:r.indices,result:r.result,error:r.error,exact,retained,
      timings:e.lastInbetweenTimings,elapsedMs:r.committed-r.started,historyAdded:history-r.before.history,progressEvents:r.progress.length,
      longTasks:r.tasks.filter(task=>task.at+task.ms>=r.started),maxFrameGapMs:Math.max(0,...r.gaps.map(gap=>gap.ms))};
    const start=performance.now();e.undo();report.undoMs=performance.now()-start;
    report.undoExact=e.report.keyframes.length===r.original.length&&r.original.every((frame,index)=>e.report.keyframes[index]===frame);
    const redoStart=performance.now();e.redo();report.redoMs=performance.now()-redoStart;
    report.redoExact=JSON.stringify(r.result.indices.map(index=>JSON.stringify(r.pose(e.report.keyframes[index]))))===JSON.stringify(r.expected);
    const cancellation=new AbortController(),before=e.report.keyframes,revision=e.revision;
    try{await e.insertInbetweenFramesAsync(.5,[e.frameIndex+1],{signal:cancellation.signal,onProgress:()=>cancellation.abort()});report.cancelled=false;}
    catch(error){report.cancelled=error.name==='AbortError';}
    report.cancelExact=e.report.keyframes===before&&e.revision===revision;
    return report;
  });
  assert.equal(result.error,undefined);assert(result.exact);assert(result.retained);assert.equal(result.historyAdded,1);
  assert(result.undoExact);assert(result.redoExact);assert(result.cancelled);assert(result.cancelExact);assert.deepEqual(errors,[]);
  await writeFile(path.join(output,'report.json'),JSON.stringify({...result,errors},null,2));
  await page.screenshot({path:path.join(output,'inserted-range.png')});console.log(JSON.stringify({...result,errors},null,2));
}catch(error){await writeFile(path.join(output,'failure.json'),JSON.stringify({error:error.stack,errors},null,2));throw error;}
finally{await browser.close();}
