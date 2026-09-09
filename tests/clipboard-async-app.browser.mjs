/** Actual root UI clipboard responsiveness, cancellation, queue and exact history. */
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import backend from '../desktop/backend.cjs';
import {runtimeFingerprint} from './helpers/runtime-fingerprint.mjs';
const runtimeBefore=runtimeFingerprint();
const output=path.resolve('artifacts/clipboard-async-app');await mkdir(output,{recursive:true});
const source=process.argv[2]??'C:/Users/aleri/Downloads/16 Akane vs Akato Segundo round (3).piv';
const service=await backend.startBackend({appRoot:process.cwd()}),checks=[],errors=[],metrics=[];let browser,page;
const check=(name,value)=>{assert.ok(value,name);checks.push(name);console.log('PASS',name);};
async function setup(indices){await page.evaluate(indices=>{
  const e=styk.editor;e.selectFrame(indices[0]);styk.timeline.setMode('frames');styk.timeline._setSelectedFrames(indices,indices[0]);
},indices);await page.waitForTimeout(250);}
async function start(kind){await page.evaluate(kind=>{
  const e=styk.editor,r=window.__clipboardRun={kind,before:e.report,beforeFrames:e.report.keyframes.slice(),history:e._undo.length,clipboard:e._frameClipboard,revision:e.revision,
    tasks:[],gaps:[],started:performance.now()};let previous=r.started;
  r.observer=new PerformanceObserver(list=>{for(const entry of list.getEntries())r.tasks.push({at:entry.startTime,ms:entry.duration});});r.observer.observe({entryTypes:['longtask']});
  const tick=now=>{r.gaps.push(now-previous);previous=now;if(!r.stop)requestAnimationFrame(tick);};requestAnimationFrame(tick);
  window.__clipboardPromise=styk.timeline[`${kind}Selection`]().then(count=>{r.count=count;r.finished=performance.now();},error=>{r.error={name:error.name,message:error.message};r.finished=performance.now();});
},kind);}
async function finish(){await page.waitForFunction(()=>__clipboardRun.finished,null,{timeout:300000});await page.waitForTimeout(250);
  return page.evaluate(()=>{const r=__clipboardRun;r.stop=true;r.observer.disconnect();return{kind:r.kind,count:r.count,error:r.error,
    elapsedMs:r.finished-r.started,maxFrameGapMs:Math.max(...r.gaps),longTasks:r.tasks.filter(t=>t.at+t.ms>=r.started),timings:styk.editor.lastClipboardTimings,
    historyAdded:styk.editor._undo.length-r.history,sameReport:styk.editor.report===r.before,sameClipboard:styk.editor._frameClipboard===r.clipboard,
    sameFrames:styk.editor.report.keyframes.length===r.beforeFrames.length&&r.beforeFrames.every((frame,i)=>styk.editor.report.keyframes[i]===frame)};});}
try{
  browser=await chromium.launch({channel:'chrome',headless:true});page=await browser.newPage({viewport:{width:1480,height:960}});
  page.on('pageerror',error=>errors.push(error.message));await page.goto(service.origin);await page.waitForFunction(()=>window.styk?.ready);
  await page.evaluate(()=>{styk.editor.markSaved();styk.settingsUI.commit({timelineMode:'advanced',autosaveSeconds:0});});
  await setup([0]);await start('copy');const defaultCopy=await finish();metrics.push({case:'default-scene-copy',...defaultCopy});
  check('Tiny default-scene Copy completes through the real UI worker contract without document/history changes',defaultCopy.count===1&&defaultCopy.sameReport&&defaultCopy.historyAdded===0);
  await start('paste');const defaultPaste=await finish();metrics.push({case:'default-scene-paste',...defaultPaste});
  check('Tiny default-scene Paste completes with one history step',defaultPaste.count===1&&defaultPaste.historyAdded===1);
  await page.evaluate(()=>{styk.editor.undo();styk.editor.markSaved();});
  await page.locator('#file-input').setInputFiles(source);
  await page.waitForFunction(name=>!styk.state.importing&&styk.editor.name===name,path.basename(source,'.piv'),{timeout:180000});
  const count=await page.evaluate(()=>styk.editor.report.keyframes.length);assert.equal(count,1479);
  await setup([count-1]);await start('copy');const tiny=await finish();metrics.push({case:'dense-one',...tiny});
  check('Actual single-frame Copy retains Akane report and history with a bounded projected input',tiny.count===1&&tiny.sameReport&&tiny.historyAdded===0&&tiny.timings.inputBytes<8*1024*1024);
  await setup(Array.from({length:count},(_,i)=>i));await start('copy');
  await page.locator('#cancel-clipboard').waitFor({state:'visible',timeout:20000});await page.locator('#cancel-clipboard').click();
  const cancelledCopy=await finish();metrics.push({case:'cancel-all-copy',...cancelledCopy});
  check('Visible Cancel during real large Copy keeps the old clipboard, report and history exact',cancelledCopy.count===0&&cancelledCopy.sameReport&&cancelledCopy.sameFrames&&cancelledCopy.sameClipboard&&cancelledCopy.historyAdded===0);
  const indices=Array.from({length:64},(_,i)=>count-64+i);await setup(indices);await start('copy');const copy=await finish();metrics.push({case:'dense-64-copy',...copy});
  check('Actual 64-frame Copy completes with all selected poses and no document mutation',copy.count===64&&copy.sameReport&&copy.historyAdded===0);
  await page.evaluate(()=>{const e=styk.editor;window.__expectedFrames=e._frameClipboard.map(f=>JSON.stringify({camera:f.camera,background:f.background_id,objects:f.objects,order:f.object_draw_order}));});
  await setup([0]);await start('paste');await page.locator('#cancel-clipboard').waitFor({state:'visible',timeout:20000});await page.locator('#cancel-clipboard').click();
  const cancelledPaste=await finish();metrics.push({case:'cancel-large-paste',...cancelledPaste});
  check('Visible Cancel during real large Paste keeps report identity, clipboard and history exact',cancelledPaste.count===0&&cancelledPaste.sameReport&&cancelledPaste.sameFrames&&cancelledPaste.sameClipboard&&cancelledPaste.historyAdded===0);
  await start('paste');const paste=await finish();metrics.push({case:'dense-64-paste',...paste});
  check('Actual 64-frame Paste publishes one atomic history step and exact selected keys',paste.count===64&&paste.historyAdded===1&&await page.evaluate(()=>styk.timeline.selectedFrameIndices.length===64&&styk.editor.report.keyframes.length===1543));
  const history=await page.evaluate(()=>{
    const e=styk.editor,r=__clipboardRun,first=e.frameIndex,after=e.report;
    const actual=e.report.keyframes.slice(first,first+64).map(f=>JSON.stringify({camera:f.camera,background:f.background_id,objects:f.objects,order:f.object_draw_order}));
    const exact=JSON.stringify(actual)===JSON.stringify(__expectedFrames),u=performance.now();e.undo();const undoMs=performance.now()-u,
      undo=e.report===r.before&&e.report.keyframes.length===r.beforeFrames.length&&r.beforeFrames.every((frame,i)=>e.report.keyframes[i]===frame);
    const d=performance.now();e.redo();const redoMs=performance.now()-d,redo=e.report===after;e.undo();return{exact,undo,redo,undoMs,redoMs};});metrics.push({case:'history',...history});
  check('Pasted native poses, camera, ordering and joins match copied frames exactly; Undo and Redo reuse exact reports',history.exact&&history.undo&&history.redo);
  await setup([count-1]);
  const rapid=await page.evaluate(async()=>{const e=styk.editor,before=e.report.keyframes.length,history=e._undo.length;
    const copy=styk.timeline.copySelection(),paste=styk.timeline.pasteSelection();return{copy:await copy,paste:await paste,added:e.report.keyframes.length-before,history:e._undo.length-history};});
  check('Immediate UI Copy followed by Paste waits for the newest copy without dialog races',rapid.copy===1&&rapid.paste===1&&rapid.added===1&&rapid.history===1);
  await page.screenshot({path:path.join(output,'akane-pasted.png')});
  for(const mode of ['add','update'])for(const dirty of [false,true]){
    await page.evaluate(async({mode,dirty})=>{
      const {emptyDocument,createFrame,createObject}=await import('/src/demo.mjs');
      const report=emptyDocument();report.keyframes=[100,110,120].map(x=>createFrame([createObject(report.figure_types[0],1,x,200)],3));
      styk.settingsUI.commit({timelineMode:'simple'});const e=styk.editor;e.load(report);e.beginFrameDraft({mode,index:2});e.select(1);
      if(dirty)e.updateObject({root_x:999});
      const {materializeSimpleFrameDraftForPivot}=await import('/src/pivot-frame-draft.mjs');
      window.__cutAllExpected={document:JSON.stringify(e.report),working:JSON.stringify(e.frame.objects),roots:materializeSimpleFrameDraftForPivot(e.report).keyframes.map(frame=>frame.objects[0].root_x)};
      styk.timeline.action('select-all');
    },{mode,dirty});
    await start('cut');const cut=await finish();metrics.push({case:`simple-${mode}-${dirty?'dirty':'clean'}-cut-all`,...cut});
    check(`Simple ${mode} ${dirty?'dirty':'clean'} Cut All reaches zero keys while preserving its working pose`,cut.count===3&&cut.historyAdded===1&&await page.evaluate(async()=>{
      const e=styk.editor,w=__cutAllExpected,{materializeSimpleFrameDraftForPivot}=await import('/src/pivot-frame-draft.mjs');
      const exact=e.frameDraft.empty&&e.frameDraft.storedCount===0&&e.totalTicks===0&&materializeSimpleFrameDraftForPivot(e.report).keyframes.length===0&&JSON.stringify(e.frame.objects)===w.working&&
        JSON.stringify(e._frameClipboard.map(frame=>frame.objects[0].root_x))===JSON.stringify(w.roots);
      const after=JSON.stringify(e.report);e.undo();const undo=JSON.stringify(e.report)===w.document;e.redo();return exact&&undo&&JSON.stringify(e.report)===after;
    }));
    await page.waitForFunction(()=>document.getElementById('timeline-summary').textContent.startsWith('0 keys · 0 frames'));
    assert.equal(await page.locator('#timeline [data-frame]').count(),0);
  }
  check('Actual clipboard workflows have no uncaught application errors',errors.length===0);
  await page.screenshot({path:path.join(output,'simple-cut-all.png')});
  const runtimeAfter=runtimeFingerprint(),runtimeStable=JSON.stringify(runtimeBefore)===JSON.stringify(runtimeAfter);assert.ok(runtimeStable,'Runtime source stayed stable during the workflow');
  await writeFile(path.join(output,'report.json'),JSON.stringify({date:new Date().toISOString(),source,checks,errors,metrics,runtimeBefore,runtimeAfter,runtimeStable,scope:'Actual root WebGPU app, worker clipboard, UI progress/Cancel and range methods; main longtasks/rAF include integration publication and rendering. Diagnostic Chrome, not native presentation comparison.'},null,2));
}catch(error){await page?.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});await writeFile(path.join(output,'report.json'),JSON.stringify({checks,errors,metrics,failure:error.stack},null,2));throw error;}
finally{await browser?.close();service.stop();}
