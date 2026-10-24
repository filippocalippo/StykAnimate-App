/** Bounded A/B telemetry overhead evidence. Synthetic scene, isolated profile, loopback uploads only. */
import {_electron as electron} from '../tests/support/playwright.mjs';
import {createServer} from 'node:http';
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';

const root=path.resolve(import.meta.dirname,'..'),out=path.join(root,'artifacts/telemetry');await mkdir(out,{recursive:true});
const profile=await mkdtemp(path.join(out,'performance-profile-'));
const files=['src/telemetry-performance.mjs','src/telemetry-performance-schema.mjs','src/engine/engine-stage.mjs','src/engine/engine-playback.mjs','src/app.mjs','src/telemetry-core.mjs','src/telemetry-schema.mjs','src/telemetry-measurements.mjs','src/telemetry-workload.mjs','src/browser-recovery.mjs','desktop/telemetry.cjs','desktop/main.cjs','scripts/build-telemetry-info.cjs','scripts/before-pack.cjs'];
const hashes=async()=>Object.fromEntries(await Promise.all(files.map(async file=>[file,createHash('sha256').update(await readFile(path.join(root,file))).digest('hex')])));
const sourceBefore=await hashes(),uploads=[];
const receiver=createServer(async(req,res)=>{let bytes=0;for await(const chunk of req)bytes+=chunk.length;uploads.push({method:req.method,path:req.url,bytes,at:new Date().toISOString()});res.writeHead(200,{'content-type':'application/json'});res.end('{"accepted":true}');});await new Promise(resolve=>receiver.listen(0,'127.0.0.1',resolve));
const localOrigin=`http://127.0.0.1:${receiver.address().port}`;
const quantiles=values=>{const a=values.filter(Number.isFinite).sort((a,b)=>a-b);return {count:a.length,mean:a.length?a.reduce((a,b)=>a+b,0)/a.length:null,p50:a[Math.floor(a.length*.5)]??null,p95:a[Math.floor(a.length*.95)]??null,p99:a[Math.floor(a.length*.99)]??null,max:a.at(-1)??null};};
const measurementCounts=preview=>{const rows=preview.snapshots||[],sum=read=>rows.reduce((total,row)=>total+read(row),0);return{reports:rows.length,foregroundIntervals:sum(row=>row.counters.playback_observed_intervals||0),foregroundTimingSamples:sum(row=>row.timings.playback_foreground_interval_ms?.count||0),playbackContextSamples:sum(row=>(row.operationContexts||[]).filter(context=>context.operation==='playback').reduce((total,context)=>total+context.timing.count,0)),backgroundIntervals:sum(row=>row.counters.playback_background_intervals||0),discontinuities:sum(row=>row.counters.playback_discontinuities||0),slowInteractions:sum(row=>row.counters.input_observed_interactions||0),droppedContexts:sum(row=>row.counters.dropped_operation_contexts||0),performanceSamples:sum(row=>(row.performance?.rows||[]).reduce((n,r)=>n+r.count,0)),gpuSamples:sum(row=>(row.performance?.rows||[]).filter(r=>r.metric==='gpu').reduce((n,r)=>n+r.count,0)),performanceDrops:sum(row=>row.performance?.coverage?.dropped||0),previewBytes:Buffer.byteLength(JSON.stringify(preview))};};
const result={startedAt:new Date().toISOString(),localOnly:true,scene:{figures:1000,keyframes:24,targetFPS:60},order:[false,true,true,false],rounds:[],errors:[],sourceBefore,environment:{os:os.release(),cpu:os.cpus()[0]?.model,logicalCPUs:os.cpus().length,memoryGB:os.totalmem()/1073741824}};
let app;
try {
  app=await electron.launch({args:[root],cwd:root,timeout:60000,env:{...process.env,STYK_USER_DATA_DIR:profile,STYK_LIBRARY_DIR:path.join(profile,'library'),STYK_SITE_URL:localOrigin}});
  result.launchDiagnostics=[];app.process().stderr?.on('data',chunk=>result.launchDiagnostics.push(String(chunk)));
  const page=await app.firstWindow();page.setDefaultTimeout(30000);page.on('pageerror',error=>result.errors.push(error.message));
  await page.waitForFunction(()=>window.styk?.ready&&window.styk.telemetry?.initialized,undefined,{timeout:45000});
  if(await page.locator('.release-splash[open]').isVisible())await page.getByRole('button',{name:'Close welcome screen'}).click();
  await page.waitForTimeout(450);
  if(await page.locator('.styk-privacy[open]').isVisible())await page.locator('[data-decline]').click();
  const runtime=await app.evaluate(({app,BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.setContentSize(1280,800);w.webContents.setBackgroundThrottling(false);w.setIgnoreMouseEvents(true);w.setFocusable(false);w.showInactive();return{versions:process.versions,gpu:app.getGPUFeatureStatus(),backgroundThrottling:false,nativeInputIsolation:true};});Object.assign(result.environment,runtime);
  const state=await page.evaluate(()=>stykDesktop.getTelemetryState());assert.equal(state.siteUrl,localOrigin,'must never upload to a production endpoint');
  result.renderer=await page.evaluate(async()=>{
    const {defaultFigure,createObject,createFrame,emptyDocument}=await import('/src/demo.mjs');
    const report=emptyDocument(),figure=defaultFigure();report.fps=60;report.figure_types=[figure];
    report.keyframes=Array.from({length:24},(_,frameIndex)=>createFrame(Array.from({length:1000},(_,i)=>{const phase=frameIndex/24*Math.PI*2,selected=i===999;const o=createObject(figure,i+1,selected?480:25+i%40*23,selected?280:18+Math.floor(i/40)*20,{scale:selected?.65:.055});o.root_x+=Math.sin(phase+i*.08)*(selected?14:2);o.angles[6]+=Math.sin(phase)*.2;o.angles[8]-=Math.sin(phase)*.2;return o;})));
    const {editor,state}=styk;editor.load(report,'Synthetic telemetry performance benchmark');editor.select(1000,-1);styk.fit();editor.markSaved();
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    const b=window.__telemetryBench={phase:'idle',renderer:[],drag:[],raf:[],longTasks:[],flushes:[],previousRAF:null,inputAt:0};
    document.querySelector('#overlay').addEventListener('pointermove',()=>b.inputAt=performance.now(),{capture:true,passive:true});
    const renderer=state.renderer;
    for(const name of ['render','renderPrepared']){const original=renderer[name];if(!original)continue;renderer[name]=function(...args){const start=performance.now(),value=original.apply(this,args),at=performance.now();if(b.phase==='playback'&&state.playing&&value!==false)b.renderer.push({ms:at-start,at,tick:editor.tick,method:name});if(b.phase==='drag'&&state.drag?.kind==='move'&&name==='render')b.drag.push({ms:at-start,inputMs:at-b.inputAt,at,uploadBytes:renderer.stats.uploadBytes});return value;};}
    const raf=now=>{if(b.phase==='playback'){if(b.previousRAF!==null)b.raf.push(now-b.previousRAF);b.previousRAF=now;}else b.previousRAF=null;requestAnimationFrame(raf);};requestAnimationFrame(raf);
    const observer=new PerformanceObserver(list=>{if(b.phase==='playback'||b.phase==='drag')for(const entry of list.getEntries())b.longTasks.push({phase:b.phase,ms:entry.duration,at:entry.startTime});});observer.observe({type:'longtask',buffered:false});
    const flush=styk.telemetry.flush.bind(styk.telemetry);styk.telemetry.flush=async function(...args){const start=performance.now();try{return await flush(...args);}finally{if(b.phase!=='idle')b.flushes.push({phase:b.phase,ms:performance.now()-start});}};
    return {backend:renderer.stats.backend,adapter:renderer.stats.adapter};
  });
  // Warm code paths and caches before either measured condition.
  await page.evaluate(async()=>{styk.actions.play();await new Promise(resolve=>setTimeout(resolve,1800));if(styk.state.playing)styk.actions.play();styk.editor.markSaved();});
  for(let index=0;index<result.order.length;index++) {
    const enabled=result.order[index];console.log(`ROUND ${index+1} ${enabled?'enabled':'disabled'}`);
    await page.evaluate(async enabled=>{const status=await stykDesktop.setTelemetryConsent({analytics:enabled,diagnostics:enabled});styk.telemetry.applyStatus(status);styk.telemetry.foreground=()=>true;styk.telemetry.isForeground=true;styk.editor.seek(0);styk.editor.select(1000,-1);styk.fit();await new Promise(resolve=>setTimeout(resolve,400));const b=__telemetryBench;b.phase='idle';for(const key of ['renderer','drag','raf','longTasks','flushes'])b[key]=[];b.previousRAF=null;},enabled);
    const measurementBefore=measurementCounts(await page.evaluate(()=>stykDesktop.previewTelemetry()));
    const target=await page.evaluate(async()=>{const {worldToScreen}=await import('/src/renderer-geometry.mjs');const {editor,state}=styk;const rect=document.querySelector('#viewport').getBoundingClientRect(),point=worldToScreen(editor.geometry.objects.get(999).root,{report:editor.report,frame:editor.frame,view:state.view});return{x:rect.left+point.x,y:rect.top+point.y};});
    await page.evaluate(()=>__telemetryBench.phase='drag');await page.mouse.move(target.x,target.y);await page.mouse.down();await page.waitForFunction(()=>styk.state.drag?.kind==='move');
    for(let step=1;step<=45;step++){const previous=await page.evaluate(()=>__telemetryBench.drag.length);await page.mouse.move(target.x+step,target.y-step*.25);await page.waitForFunction(previous=>__telemetryBench.drag.length>previous,previous);}
    await page.mouse.up();await page.waitForFunction(()=>!styk.state.drag&&!styk.state.dirtyRender);
    const drag=await page.evaluate(()=>({samples:[...__telemetryBench.drag].slice(1),longTasks:[...__telemetryBench.longTasks]}));
    const beforeRequests=uploads.length;
    const data=await page.evaluate(async()=>{
      const b=__telemetryBench;b.phase='idle';styk.editor.seek(0);styk.actions.play();await new Promise(resolve=>setTimeout(resolve,1600));
      b.renderer=[];b.raf=[];b.longTasks=[];b.flushes=[];b.previousRAF=null;b.phase='playback';styk.state.renderSamples.length=0;
      const start=performance.now(),heapBefore=performance.memory?.usedJSHeapSize;let forced;
      const checkpoint=setTimeout(()=>{forced=(async()=>{const at=performance.now();await styk.telemetry.flush();const flushMs=performance.now()-at,uploadStart=performance.now();await stykDesktop.syncTelemetry();return{flushMs,localUploadMs:performance.now()-uploadStart,atMs:at-start};})();},6500);
      await new Promise(resolve=>setTimeout(resolve,16500));clearTimeout(checkpoint);const forcedCheckpoint=await forced;
      b.phase='idle';if(styk.state.playing)styk.actions.play();styk.editor.markSaved();
      return{renderer:[...b.renderer],raf:[...b.raf],longTasks:[...b.longTasks],flushes:[...b.flushes],forcedCheckpoint,elapsedMs:performance.now()-start,editorRenderWork:[...styk.state.renderSamples],heapBefore,heapAfter:performance.memory?.usedJSHeapSize,rendererStats:{backend:styk.state.renderer.stats.backend,warnings:styk.state.renderer.stats.warnings},consent:styk.telemetry.consent};
    });
    const frames=data.renderer.filter((frame,i,list)=>!i||frame.tick!==list[i-1].tick),cadence=frames.slice(1).map((frame,i)=>frame.at-frames[i].at);
    await page.evaluate(()=>styk.telemetry.flush());
    const measurementAfter=measurementCounts(await page.evaluate(()=>stykDesktop.previewTelemetry()));
    const measurementDelta=Object.fromEntries(Object.keys(measurementAfter).filter(key=>!['reports','previewBytes'].includes(key)).map(key=>[key,measurementAfter[key]-measurementBefore[key]]));
    assert.ok(!enabled||measurementDelta.performanceSamples>0,'enabled comparison must exercise v3 diagnostics');
    assert.ok(!enabled||measurementDelta.foregroundIntervals>0,'enabled comparison must exercise foreground playback aggregation');
    assert.equal(measurementDelta.foregroundIntervals,measurementDelta.foregroundTimingSamples,'foreground interval counts and histogram samples must agree');
    assert.equal(measurementDelta.foregroundIntervals,measurementDelta.playbackContextSamples,'playback context must retain all measured intervals in this bounded fixture');
    assert.ok(enabled||measurementAfter.reports===0,'disabled comparison must not retain an active telemetry report');
    const memory=await app.evaluate(({app})=>app.getAppMetrics().reduce((sum,item)=>sum+(item.memory?.workingSetSize||0),0)/1024);
    result.rounds.push({index:index+1,enabled,drag:{rendererCPUms:quantiles(drag.samples.map(x=>x.ms)),pointerReceiptToSubmitMs:quantiles(drag.samples.map(x=>x.inputMs)),geometryUploadBytes:drag.samples.reduce((sum,x)=>sum+x.uploadBytes,0),longTasks:drag.longTasks},playback:{elapsedMs:data.elapsedMs,renderedFrames:frames.length,effectiveFPS:frames.length>1?(frames.length-1)*1000/(frames.at(-1).at-frames[0].at):0,rendererCPUms:quantiles(data.renderer.map(x=>x.ms)),editorRenderWorkMs:quantiles(data.editorRenderWork),frameIntervalsMs:quantiles(cadence),animationFrameIntervalsMs:quantiles(data.raf),longTasks:data.longTasks,flushIPCms:quantiles(data.flushes.map(x=>x.ms)),forcedCheckpoint:data.forcedCheckpoint},measurements:{before:measurementBefore,after:measurementAfter,delta:measurementDelta,foregroundOverride:true},memory:{processWorkingSetMB:memory,rendererHeapBeforeMB:data.heapBefore/1048576,rendererHeapAfterMB:data.heapAfter/1048576},localUploadCount:uploads.length-beforeRequests,consent:data.consent});
    await writeFile(path.join(out,`performance-round-${index+1}.json`),JSON.stringify({enabled,drag,data},null,2));
    console.log(JSON.stringify(result.rounds.at(-1)));
  }
  await page.screenshot({path:path.join(out,'performance-scene.png')});
  result.sourceAfter=await hashes();result.sourceUnchanged=files.every(file=>result.sourceAfter[file]===sourceBefore[file]);result.uploads=uploads;result.endedAt=new Date().toISOString();
  result.limitations=['Single Windows machine; current source Electron build, not a packaged release or universal overhead percentage.','Counterbalanced disabled/enabled/enabled/disabled order, two short rounds per condition; GPU/OS scheduling, cache warming, and GC introduce noise.','Synthetic existing benchmark scene: 1,000 figures,24 keyframes,60fps; not a complete dense-project/import/export corpus.','Renderer and pointer measurements stop at CPU submission, not completed GPU rendering or display scanout.','Each playback measurement runs16.5s after1.6s warmup. Editor render work keeps only the most recent300 samples.','The benchmark window is nonfocusable, shown inactive and ignores native mouse input to avoid disrupting the user. Benchmark-only foreground() and isForeground overrides exercise interaction/presentation diagnostic aggregation in both conditions; production foreground logic is unchanged. Resource sampling that checks actual window/document focus remains outside this comparison. Preview counts prove enabled foreground histogram/context paths ran.','15-second renderer batching remains natural. One explicit flush and sync request per playback exercises IPC; the normal15-minute service throttle remains intact, so only the first eligible enabled sync performs an HTTP upload. An additional final flush outside the timed playback obtains complete per-round preview counts. Actual upload counts are recorded per round.','Local receiver acknowledges uploads without running D1. It measures application overhead, not internet/server latency.','Memory snapshots include GPU/cache/GC variation and do not isolate retained telemetry allocation.','The small benchmark wrappers and rAF/long-task observers run identically in both conditions. Detailed manual CPU traces are not enabled.'];
  assert.ok(result.sourceUnchanged,'app sources changed during comparison');assert.deepEqual(result.errors,[]);assert.ok(result.rounds.every(round=>round.playback.renderedFrames>100),'playback workload did not render');
  result.passed=true;
}catch(error){result.failure=error.stack;throw error;}
finally{await writeFile(path.join(out,'desktop-performance.json'),JSON.stringify(result,null,2));await app?.evaluate(({app})=>app.exit(0)).catch(()=>{});await new Promise(resolve=>receiver.close(resolve));}
