/** Reproducible, isolated desktop diagnostics. Never writes the source scene. */
import {_electron as electron} from 'playwright';
import {mkdir, readFile, readdir, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {scaleBenchmarkScene} from './dense-scene-scale.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.resolve(process.argv[2] || path.join(os.homedir(), 'Desktop/testreallydense.piv'));
const mode = process.env.STYK_DENSE_MODE || 'baseline';
if(!['probe','baseline','diagnostic','micro','stress','fps-ui','interactions','drag','drag-cpu','playback-input','inbetweens','timing'].includes(mode))throw new Error('Unknown STYK_DENSE_MODE.');
const output = path.join(root, 'artifacts', 'dense-scene', `${mode}-${Date.now()}`);
await mkdir(output, {recursive:true});
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceBytes = await readFile(source);
const result = {mode, measuredAt:new Date().toISOString(), source:{path:source, bytes:sourceBytes.length, sha256:digest(sourceBytes)},
  environment:{os:os.release(),cpu:os.cpus()[0].model,logicalCPUs:os.cpus().length,memoryBytes:os.totalmem()}, sourceHashes:{}, phases:[], errors:[]};
for(const name of (await readdir(path.join(root,'src'),{recursive:true})).filter(name=>/\.(mjs|css)$/.test(name)).sort()){
  const bytes=await readFile(path.join(root,'src',name));result.sourceHashes[name]=digest(bytes);
  await mkdir(path.dirname(path.join(output,'sources',name)),{recursive:true});
  await writeFile(path.join(output,'sources',name),bytes);
}
console.log('OUTPUT',output);
const app = await electron.launch({args:[root],cwd:root,timeout:60000,env:{...process.env,STYK_USER_DATA_DIR:path.join(output,'profile')}});
try {
  const page=await app.firstWindow({timeout:60000});
  page.setDefaultTimeout(60000);
  page.on('pageerror',e=>result.errors.push(e.message));
  page.on('response',response=>{if(response.status()>=400)(result.httpErrors??=[]).push({status:response.status(),url:response.url()});});
  page.on('console',message=>{if(message.type()==='error')(result.consoleErrors??=[]).push(message.text());});
  const captured=new Map();
  for(const name of Object.keys(result.sourceHashes))captured.set(name.replaceAll('\\','/'),await readFile(path.join(output,'sources',name)));
  await page.context().route('**/src/**',async route=>{
    const name=new URL(route.request().url()).pathname.slice('/src/'.length),body=captured.get(name);
    if(body)await route.fulfill({status:200,contentType:name.endsWith('.css')?'text/css; charset=utf-8':'text/javascript; charset=utf-8',body});else await route.continue();
  });
  // Background/occluded-window timer throttling is not canvas engine work.
  // Disable it only in this isolated benchmark process, and record the policy.
  await app.evaluate(({BrowserWindow})=>{
    const w=BrowserWindow.getAllWindows()[0];w.webContents.setBackgroundThrottling(false);
    // CDP input still reaches the page, while desktop pointer/keyboard activity
    // cannot accidentally pause a sample or edit its scene in this test window.
    w.setIgnoreMouseEvents(true);w.setFocusable(false);w.showInactive();
  });
  result.environment.backgroundThrottling=false;
  result.environment.nativeInputIsolation='Window ignores native mouse input and cannot take desktop keyboard focus; benchmark input uses CDP.';
  result.environment.sourcePolicy='Captured src modules/styles, including worker requests; isolated benchmark background throttling disabled.';
  try{await page.waitForFunction(()=>window.styk?.ready);}
  catch(error){result.startupText=await page.locator('body').innerText();await page.screenshot({path:path.join(output,'startup-failure.png')});throw error;}
  await page.reload();
  try {await page.waitForFunction(()=>window.styk?.ready);}
  catch(error){result.startupText=await page.locator('body').innerText();await page.screenshot({path:path.join(output,'startup-failure.png')});throw error;}
  await page.evaluate(()=>{
    globalThis.__benchmarkInputs=[];
    for(const type of ['pointerdown','pointerup','keydown'])addEventListener(type,event=>{
      __benchmarkInputs.push({type,time:performance.now(),target:event.target?.id,key:event.key,button:event.button,x:event.clientX,y:event.clientY,playing:styk.state.playing});
      if(__benchmarkInputs.length>200)__benchmarkInputs.shift();
    },true);
  });
  await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.setContentSize(1600,1000);});
  result.environment.runtime=await app.evaluate(()=>process.versions);
  result.environment.gpu=await app.evaluate(({app})=>app.getGPUFeatureStatus());
  await page.evaluate(()=>styk.editor.markSaved());
  const importStart=Date.now();
  await page.locator('#file-input').setInputFiles(source);
  await page.waitForFunction(name=>styk.editor.name===name&&!styk.state.importing,path.basename(source,'.piv'),{timeout:180000});
  result.importWallMs=Date.now()-importStart;
  result.sceneMultiplier=Number(process.env.STYK_DENSE_MULTIPLIER||1);
  await scaleBenchmarkScene(page);
  if(process.env.STYK_BENCHMARK_FPS){
    const fps=Number(process.env.STYK_BENCHMARK_FPS);
    if(!Number.isInteger(fps)||fps<1||fps>1000)throw new Error('STYK_BENCHMARK_FPS must be an integer from 1 to 1000.');
    await page.evaluate(fps=>{styk.editor.setFPS(fps);styk.editor.markSaved();},fps);
    result.fpsOverride=fps;
  }
  await page.waitForTimeout(1500);
  result.scene=await page.evaluate(()=>{
    const e=styk.editor, r=e.report, sizes=new Map(r.figure_types.map(f=>[f.figure_type_id,f.segments.length]));
    const ignored=new Set(['root_x','root_y','unique_id','object_slot','join','record_offset','record_end']);
    const poseKey=o=>JSON.stringify(Object.fromEntries(Object.entries(o).filter(([k])=>!ignored.has(k))));
    const poseGroups=new Map(),localGroups=new Map();
    for(const g of e.geometry.objects.values()){
      if(!g)continue;const pose=poseKey(g.obj);poseGroups.set(pose,(poseGroups.get(pose)||0)+1);
      const local=JSON.stringify(g.segments.map(s=>s.points.map(p=>[p.x-g.root.x,p.y-g.root.y])));
      localGroups.set(pose+'|'+local,(localGroups.get(pose+'|'+local)||0)+1);
    }
    const byUid=new Map(r.keyframes[0].objects.map(o=>[o.unique_id,JSON.stringify(o)]));
    return {name:e.name,reuseAnalysis:{objectKeys:Object.keys(e.frame.objects[0]),poseGroups:poseGroups.size,exactLocalGroups:localGroups.size,largestExactGroup:Math.max(...localGroups.values()),unchangedFullObjects:r.keyframes.map(f=>f.objects.filter(o=>byUid.get(o.unique_id)===JSON.stringify(o)).length)},fps:r.fps,frameDelayMs:r.frame_delay_ms,targetFps:r.frame_delay_ms?1000/r.frame_delay_ms:r.fps,
      totalTicks:e.totalTicks,canvas:[r.canvas_width,r.canvas_height],figureTypes:r.figure_types.map(f=>({id:f.figure_type_id,segments:f.segments.length,segmentTypes:f.segments.reduce((a,s)=>(a[s.segment_type]=(a[s.segment_type]||0)+1,a),{}),polygons:f.polygons?.length,keys:Object.keys(f)})),
      frames:r.keyframes.map((f,i)=>({index:i,objects:f.objects.length,segments:f.objects.reduce((n,o)=>n+(sizes.get(o.figure_type_id)||0),0),joined:f.objects.filter(o=>o.join).length,inbetweens:f.inbetweens,keys:i===0?Object.keys(f):undefined})),
      renderer:structuredClone(styk.state.renderer.stats),settings:structuredClone(styk.state.settings),view:{...styk.state.view},onion:styk.state.onion,handles:styk.state.handles,
      viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio,deviceMemory:navigator.deviceMemory,visibility:document.visibilityState},import:styk.performance().import};
  });
  console.log('SCENE',JSON.stringify(result.scene));
  await page.screenshot({path:path.join(output,'scene.png')});
  if(mode!=='probe') await benchmark(page,app,result,output,mode);
} catch(error) {result.errors.push(error.stack);throw error;}
finally {
  const diagnosticPage=app.windows()[0];
  if(diagnosticPage)try{result.inputTrace=await diagnosticPage.evaluate(()=>({events:globalThis.__benchmarkInputs||[],playing:styk?.state.playing,tick:styk?.editor.tick}));}catch(error){result.inputTraceError=error.message;}
  result.sourceUnchanged=digest(await readFile(source))===result.source.sha256;
  result.changedDuringRun=[];
  for(const [name,hash] of Object.entries(result.sourceHashes)){
    try{if(digest(await readFile(path.join(root,'src',name)))!==hash)result.changedDuringRun.push(name);}
    catch(error){if(error.code==='ENOENT')result.changedDuringRun.push(`${name} (removed)`);else result.errors.push(`Source verification: ${name}: ${error.message}`);}
  }
  await writeFile(path.join(output,'report.json'),JSON.stringify(result,null,2));
  await app.evaluate(({app})=>app.exit(0)).catch(()=>{});
  console.log('REPORT',path.join(output,'report.json'));
}

async function benchmark(page,app,result,output,mode) {
  if(mode==='drag'||mode==='drag-cpu'){
    const {benchmarkDrags}=await import('./dense-drag-benchmark.mjs');
    await benchmarkDrags(page,result,output,{source,cpu:mode==='drag-cpu'});return;
  }
  const cpu=mode==='diagnostic', client=await page.context().newCDPSession(page);
  if(cpu){await client.send('Profiler.enable');await client.send('Profiler.setSamplingInterval',{interval:1000});}
  await page.evaluate(async()=>{
    const b=window.__dense={active:false,presents:[],raf:[],calls:[],packets:[],longTasks:[],events:[],cache:null,lastRender:null};
    const {PlaybackCache}=await import('/src/playback.mjs');
    const receive=PlaybackCache.prototype._receive, get=PlaybackCache.prototype.get;
    PlaybackCache.prototype.get=function(...args){b.cache=this;return get.apply(this,args);};
    PlaybackCache.prototype._receive=function(data){b.cache=this;if(b.active&&data.type==='packet')b.packets.push({at:performance.now(),tick:data.tick,bytes:data.packet.byteLength,timings:data.packet.timings,compileMs:data.packet.compileMs,clipping:data.packet.clipping,sharing:data.packet.sharing,reusedGeometryObjects:data.packet.reusedGeometryObjects,compatibility:data.packet.compatibility.length});return receive.call(this,data);};
    const r=styk.state.renderer,e=styk.editor;
    const geometry=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(e),'geometry');
    Object.defineProperty(e,'geometry',{configurable:true,get(){const start=performance.now();try{return geometry.get.call(this);}finally{if(b.active)b.calls.push({name:'editor.geometry',start,ms:performance.now()-start});}}});
    for(const name of ['render','renderPrepared','prepareFrame']){
      const original=r[name];if(!original)continue;
      r[name]=function(...args){const start=performance.now();if(name==='render')b.lastRender=args[0];
        try{const value=original.apply(this,args);if(b.active&&name!=='prepareFrame'&&value!==false)b.presents.push({at:performance.now(),mode:name,tick:e.tick,packetTick:(styk.state.scrubPacket||styk.state.playbackPacket)?.tick,playing:styk.state.playing,scrubbing:styk.state.scrubbing,buffering:styk.state.buffering,ms:performance.now()-start,stats:{...r.stats,preparedCache:{...r.stats.preparedCache}}});return value;}
        finally{if(b.active)b.calls.push({name,start,ms:performance.now()-start});}};
    }
    for(const name of ['select','selectFrame','seek','beginTranslationDrag','commitTranslationDrag','beginDrag','poseJoint','commitDrag','updateObject','_emit']){
      const original=e[name];if(!original)continue;
      e[name]=function(...args){const start=performance.now();try{return original.apply(this,args);}finally{if(b.active)b.calls.push({name:'editor.'+name,start,ms:performance.now()-start});}};
    }
    b.longTaskObserver=new PerformanceObserver(list=>{if(b.active)for(const e of list.getEntries())b.longTasks.push({at:e.startTime,ms:e.duration});});b.longTaskObserver.observe({entryTypes:['longtask']});
    try{new PerformanceObserver(list=>{if(b.active)for(const e of list.getEntries())b.events.push({name:e.name,at:e.startTime,duration:e.duration,processing:e.processingEnd-e.processingStart,inputDelay:e.processingStart-e.startTime});}).observe({type:'event',durationThreshold:16});}catch{}
    let previous=performance.now();const raf=now=>{if(b.active)b.raf.push({at:now,ms:now-previous,buffering:styk.state.buffering,playing:styk.state.playing});previous=now;requestAnimationFrame(raf);};requestAnimationFrame(raf);
  });
  const quantiles=values=>{const a=[...values].sort((a,b)=>a-b);return {n:a.length,mean:a.length?a.reduce((a,b)=>a+b,0)/a.length:null,p50:a[Math.floor(a.length*.5)]??null,p95:a[Math.floor(a.length*.95)]??null,max:a.at(-1)??null};};
  async function phase(name,action,settle=200){
    console.log('BEGIN',name);
    await page.evaluate(()=>{const b=__dense;for(const key of ['presents','raf','calls','packets','longTasks','events'])b[key]=[];b.start=performance.now();b.before=structuredClone(styk.performance());b.active=true;});
    if(cpu)await client.send('Profiler.start');
    const actionResult=await action();await page.waitForTimeout(settle);
    if(cpu){const {profile}=await client.send('Profiler.stop');await writeFile(path.join(output,`${name}.cpuprofile`),JSON.stringify(profile));}
    const data=await page.evaluate(()=>{const b=__dense;for(const e of b.longTaskObserver.takeRecords())b.longTasks.push({at:e.startTime,ms:e.duration});b.active=false;const end=performance.now(),footprints=[...(b.cache?._packetFootprints.values()||[])],resources=new Map(footprints.flatMap(f=>f.resources));
      const knownWorkingSet={frames:footprints.length,resources:resources.size,bytes:footprints.reduce((n,f)=>n+f.base,0)+[...resources.values()].reduce((a,b)=>a+b,0)};
      return {start:b.start,end,before:b.before,after:styk.performance(),knownWorkingSet,presents:b.presents,raf:b.raf,calls:b.calls,packets:b.packets,
        longTasks:b.longTasks.filter(e=>e.at>=b.start&&e.at<end),excludedLongTasks:b.longTasks.filter(e=>e.at<b.start||e.at>=end),
        events:b.events.filter(e=>e.at>=b.start&&e.at<end),heap:performance.memory?.usedJSHeapSize,visibility:document.visibilityState};});
    const playing=data.presents.filter(p=>p.playing),distinct=playing.filter((p,i)=>!i||p.packetTick!==playing[i-1].packetTick);
    const gaps=distinct.slice(1).map((p,i)=>p.at-distinct[i].at),grouped={};
    for(const call of data.calls)(grouped[call.name]??=[]).push(call.ms);
    const summary={name,wallMs:data.end-data.start,actionResult,presentations:data.presents.length,playbackFrames:distinct.length,
      achievedFps:gaps.length?1000*gaps.length/(distinct.at(-1).at-distinct[0].at):null,
      firstPresentationMs:playing.length?playing[0].at-data.start:null,
      frameIntervalsMs:quantiles(gaps),rafMs:quantiles(data.raf.map(v=>v.ms)),
      bufferingRaf:data.raf.filter(r=>r.playing&&r.buffering).length,longTasks:quantiles(data.longTasks.map(v=>v.ms)),
      methods:Object.fromEntries(Object.entries(grouped).map(([k,v])=>[k,quantiles(v)])),
      packetCompileMs:quantiles(data.packets.map(p=>p.compileMs)),heapBytes:data.heap,
      before:data.before,after:data.after,knownWorkingSet:data.knownWorkingSet,visibility:data.visibility};
    result.phases.push(summary);await writeFile(path.join(output,`${name}.json`),JSON.stringify(data,null,2));
    console.log('PHASE',JSON.stringify({...summary,before:undefined,after:undefined,methods:summary.methods}));
    await writeFile(path.join(output,'report.json'),JSON.stringify(result,null,2));
  }
  if(mode==='micro'){
    await page.evaluate(()=>{styk.editor.selectFrame(0);styk.fit();});await page.waitForTimeout(1000);
    await diagnostic(page,result,output);return;
  }
  if(mode==='timing'){
    await page.evaluate(()=>{styk.editor.selectFrame(0);styk.state.view.scale=1;window.dispatchEvent(new Event('resize'));});await page.waitForTimeout(700);
    const operation=method=>page.evaluate(method=>{
      const e=styk.editor,g=e.geometry,started=performance.now();
      if(method==='duration')e.setFramesDuration([0,1,2],8);else e[method]();
      const commandMs=performance.now()-started;
      return {commandMs,geometryRetained:e._geometry===g,historyBytes:e._undo.at(-1)?.bytes,totalTicks:e.totalTicks};
    },method);
    for(let repeat=1;repeat<=2;repeat++)for(const method of ['duration','undo','redo','undo'])await phase(`timing-${repeat}-${method}-${result.phases.length}`,()=>operation(method),300);
    return;
  }
  if(mode==='playback-input'||mode==='inbetweens'){
    const pauseTicks=process.env.STYK_BENCHMARK_PAUSE_TICKS?.split(',').map(Number);let pauseIndex=0;
    if(pauseTicks?.some(tick=>!Number.isInteger(tick)||tick<0))throw new Error('Pause ticks must be nonnegative integers.');
    result.pauseTicks=pauseTicks;
    const stopPlayback=async()=>{
      if(!await page.evaluate(()=>styk.state.playing))throw new Error('Playback stopped unexpectedly before the measured pause.');
      if(pauseTicks){
        const target=pauseTicks[Math.min(pauseIndex++,pauseTicks.length-1)];
        const activation=await page.evaluate(target=>new Promise((resolve,reject)=>{
          const r=styk.state.renderer,original=r.renderPrepared;
          if(target>=styk.editor.totalTicks)return reject(new Error('The requested pause tick is outside the timeline.'));
          const restore=()=>{clearTimeout(timer);r.renderPrepared=original;};
          const timer=setTimeout(()=>{restore();reject(new Error('Playback did not present the requested pause tick.'));},60000);
          r.renderPrepared=function(...args){
            const value=original.apply(this,args);
            if(value!==false&&styk.state.playing&&styk.editor.tick===target){
              restore();queueMicrotask(()=>{
                const requestedAt=performance.now();document.querySelector('#play-button').click();
                resolve({tick:target,requestedAt,commandMs:performance.now()-requestedAt,paused:!styk.state.playing,input:'DOM button activation after presentation of the specified tick'});
              });
            }
            return value;
          };
        }),target);
        await page.waitForFunction(()=>!styk.state.editablePreparing);
        return {...activation,preparation:await page.evaluate(()=>styk.state.editablePreparationStats)};
      }
      await page.locator('#play-button').click();
      await page.waitForFunction(()=>!styk.state.playing);
      await page.waitForFunction(()=>!styk.state.editablePreparing);
    };
    const startAndPrepare=async(cold=false)=>{
      if(cold)await page.evaluate(()=>{
        if(!__dense.cache)throw new Error('Cold-start measurement requires the instrumented playback cache.');
        __dense.cache.invalidate();styk.state.renderer.clearPreparedFrames();document.querySelector('#play-button').click();
      });
      else await page.locator('#play-button').click();
      return page.evaluate(async()=>{
        const started=__dense.start,target=Math.min(styk.editor.totalTicks,styk.state.renderer.preparedFrames.maxFrames);
        while(styk.state.renderer.preparedFrames.frames.size<target&&performance.now()-started<60000)await new Promise(r=>setTimeout(r,25));
        return {prepareWallMs:performance.now()-started,target,ready:styk.state.renderer.preparedFrames.frames.size,complete:styk.state.renderer.preparedFrames.frames.size>=target};
      });
    };
    result.playbackScale=Number(process.env.STYK_BENCHMARK_SCALE||1);
    if(!Number.isFinite(result.playbackScale)||result.playbackScale<=0)throw new Error('STYK_BENCHMARK_SCALE must be positive.');
    await page.evaluate(scale=>{styk.state.loop=true;styk.state.loopRange=null;styk.editor.seek(0);styk.state.view.scale=scale;window.dispatchEvent(new Event('resize'));},result.playbackScale);
    if(mode==='inbetweens'){
      const ticks=Number(process.env.STYK_BENCHMARK_INBETWEENS||8);
      await phase('add-inbetween-exposure',()=>page.evaluate(ticks=>{
        const e=styk.editor,start=performance.now();e.setFramesDuration([0,1,2],ticks);const commandMs=performance.now()-start;e.seek(0);
        return {commandMs,historyBytes:e._undo.at(-1)?.bytes,totalTicks:e.totalTicks,frames:e.report.keyframes.length,durations:e.report.keyframes.map(f=>f.duration_raw)};
      },ticks));
    }
    result.coldStart=process.env.STYK_BENCHMARK_COLD==='1';
    if(result.coldStart&&!await page.evaluate(()=>Boolean(__dense.cache))){
      // Capture the existing controller when no idle prefetch has run since
      // instrumentation. The measured phase then discards every warmed cache.
      await page.locator('#play-button').click();await page.waitForFunction(()=>Boolean(__dense.cache));
      await page.locator('#play-button').click();await page.evaluate(()=>styk.editor.seek(0));
    }
    await phase('playback-preparing',()=>startAndPrepare(result.coldStart),0);
    await phase('playback-stationary',()=>page.waitForTimeout(6000),0);
    await phase('playback-mouse-motion',async()=>{
      const r=await page.locator('#viewport').boundingBox(),started=Date.now();let moves=0;
      while(Date.now()-started<6000){
        await page.mouse.move(r.x+r.width*(.2+.6*(moves%19)/18),r.y+r.height*(.25+.5*(moves%13)/12));moves++;
        await page.waitForTimeout(8);
      }
      return {moves,elapsedMs:Date.now()-started};
    },0);
    const mouse=result.phases.at(-1);
    if(mouse.methods['editor.geometry']?.n)throw new Error('Mouse movement materialized editor geometry during playback.');
    await phase('playback-after-mouse',()=>page.waitForTimeout(6000),0);
    await phase('pause-after-mouse',stopPlayback);
    if(mode==='inbetweens'){
      await phase('insert-inbetween-keys',async()=>page.evaluate(async()=>{
        const e=styk.editor;e.seek(0);const inserted=await e.insertInbetweenFramesAsync(.5,[0,1,2]);e.seek(0);
        return {...inserted,totalTicks:e.totalTicks,frames:e.report.keyframes.length,timings:e.lastInbetweenTimings};
      }),500);
      await phase('playback-after-insert-preparing',startAndPrepare,0);
      await phase('playback-after-insert-warm',()=>page.waitForTimeout(6000),0);
      await phase('pause-after-insert',stopPlayback);
    }
    await phase('edit-one-frame',()=>page.evaluate(()=>{
      const e=styk.editor;e.seek(0);e.select(e.frame.objects[0].unique_id);
      const angles=[...e.object.angles];angles[0]+=.03;e.updateObject({angles});
      return {totalTicks:e.totalTicks,frames:e.report.keyframes.length};
    }),200);
    await phase('playback-after-edit-preparing',startAndPrepare,0);
    await phase('playback-after-edit-warm',()=>page.waitForTimeout(6000),0);
    await phase('pause-after-edit',stopPlayback);
    return;
  }
  if(mode==='fps-ui'){
    const checks=[];
    // Do not depend on a performance regression to exercise the red state.
    // An intentionally unattainable scene rate exceeds this display's refresh.
    for(const [scale,fps,health] of [[1,24,'good'],[1,1000,'low']]){
      await page.evaluate(({scale,fps})=>{styk.editor.setFPS(fps);styk.state.view.scale=scale;styk.editor.seek(0);window.dispatchEvent(new Event('resize'));styk.state.loop=true;},{scale,fps});
      await page.waitForTimeout(1000);
      await phase(`fps-ui-${health}`,async()=>{await page.locator('#play-button').click();await page.waitForTimeout(6000);},0);
      const check=await page.evaluate(()=>{
        const badge=document.querySelector('#playback-fps'),r=badge.getBoundingClientRect(),v=document.querySelector('#viewport').getBoundingClientRect();
        return {text:badge.textContent,health:badge.dataset.health,hidden:badge.hidden,color:getComputedStyle(badge).color,rightGap:v.right-r.right,topGap:r.top-v.top,width:r.width,height:r.height,metrics:styk.performance().presentation};
      });
      if(check.health!==health||check.hidden||Math.abs(check.rightGap-14)>1||Math.abs(check.topGap-12)>1)throw new Error(`FPS indicator check failed: ${JSON.stringify(check)}`);
      const phaseResult=result.phases.at(-1),refreshFps=1000/phaseResult.rafMs.p50;
      if(phaseResult.achievedFps>refreshFps*1.1)throw new Error(`Playback submitted multiple ticks per display callback: ${phaseResult.achievedFps} versus ${refreshFps} Hz.`);
      checks.push(check);await page.screenshot({path:path.join(output,`fps-${health}.png`)});
      await page.locator('#play-button').click();
      if(!await page.locator('#playback-fps').isHidden())throw new Error('FPS indicator remained visible after pause.');
      await page.waitForTimeout(500);
    }
    result.fpsChecks=checks;
    if(result.errors.length)throw new Error(result.errors.join('\n'));
    return;
  }
  if(mode==='interactions'){
    await page.evaluate(()=>{styk.editor.selectFrame(0);styk.fit();});await page.waitForTimeout(800);
    for(let run=1;run<=3;run++)await phase(`scrub-${run}`,async()=>{
      const r=await page.locator('.styk-timeline-scroll').boundingBox();
      await page.mouse.move(r.x+21,r.y+14);await page.mouse.down();
      const observations=[];
      for(const tick of [1,2,3,2,1,0,1,2,3]){
        await page.mouse.move(r.x+21+tick*18,r.y+14);await page.waitForTimeout(100);
        observations.push(await page.evaluate(()=>({at:performance.now(),tick:styk.editor.tick,target:styk.state.scrubTarget,packet:styk.state.scrubPacket?.tick,scrubbing:styk.state.scrubbing})));
      }
      await page.waitForTimeout(450);
      const held=await page.evaluate(()=>({tick:styk.editor.tick,packet:styk.state.scrubPacket?.tick,presented:__dense.presents.filter(p=>p.scrubbing).map(p=>({at:p.at,tick:p.packetTick}))}));
      await page.mouse.up();const ended=await page.evaluate(()=>performance.now());
      if(!observations.some(o=>o.scrubbing)||held.tick!==3||held.packet!==3)throw new Error(`Scrub did not reach its target: ${JSON.stringify({observations,held})}`);
      return {observations,held,ended};
    },400);
    result.topology=await page.evaluate(()=>{
      const e=styk.editor,base=e.report.keyframes[0],fields=['figure_type_id','root_x','root_y','scale','angles','lengths','bends','color_override_raw','field28','join','runtime_segments'];
      const signature=o=>JSON.stringify(Object.fromEntries(fields.map(k=>[k,o[k]])));
      return {objectKeys:Object.keys(base.objects[0]),frameDifferences:e.report.keyframes.map(f=>f.objects.filter((o,i)=>signature(o)!==signature(base.objects[i])).length),polygonSizes:[...e.geometry.objects.values()][0].polys.map(p=>p.points.length)};
    });return;
  }
  if(mode==='stress'){
    const scales=(process.env.STYK_BENCHMARK_SCALES||'1,1.01,2,4').split(',').map(Number);
    if(scales.some(scale=>!Number.isFinite(scale)||scale<=0))throw new Error('Invalid STYK_BENCHMARK_SCALES.');
    for(const scale of scales){
      await page.evaluate(scale=>{styk.state.view.scale=scale;styk.state.dirtyRender=true;window.dispatchEvent(new Event('resize'));styk.editor.seek(0);styk.state.loop=true;},scale);
      await page.waitForTimeout(1200);
      for(let i=1;i<=2;i++){
        await phase(`playback-scale-${scale}-run-${i}`,async()=>{
          await page.evaluate(()=>{if(!styk.state.playing)document.querySelector('#play-button').click();});
          await page.waitForTimeout(8000);
          return await page.evaluate(()=>({playing:styk.state.playing,status:document.querySelector('#status').textContent,scale:styk.state.view.scale}));
        },0);
      }
      await page.screenshot({path:path.join(output,`scale-${scale}.png`)});
      await page.evaluate(()=>{if(styk.state.playing)document.querySelector('#play-button').click();});await page.waitForTimeout(500);
    }
    return;
  }
  // CPU packets may already be warm from idle prefetch. Record this separately.
  await page.evaluate(()=>{styk.state.playbackScale=null;styk.state.loop=true;styk.state.loopRange=null;styk.editor.seek(0);});
  await phase('playback-first-gpu-upload',async()=>{await page.locator('#play-button').click();await page.waitForTimeout(6000);},0);
  for(let i=1;i<=(cpu?1:3);i++)await phase(`playback-warm-${i}`,()=>page.waitForTimeout(6000),0);
  await page.screenshot({path:path.join(output,'playback.png')});
  await phase('pause-return',()=>page.locator('#play-button').click(),400);
  await page.evaluate(()=>styk.editor.seek(0));await page.waitForTimeout(700);
  await phase('playback-empty-caches',async()=>{
    await page.evaluate(()=>{__dense.cache.invalidate({retainDocument:true});styk.state.renderer.clearPreparedFrames();document.querySelector('#play-button').click();});
    await page.waitForTimeout(7000);
  },0);
  await page.locator('#play-button').click();
  await page.waitForTimeout(1500);
  async function pan(name){
    const r=await page.locator('#viewport').boundingBox(),x=r.x+r.width*.5,y=r.y+r.height*.5;
    await phase(name,async()=>{
      const before=await page.evaluate(()=>({...styk.state.view}));
      await page.mouse.move(x,y);await page.mouse.down({button:'middle'});
      const picked=await page.evaluate(()=>styk.state.drag?.kind);
      for(let i=1;i<=36;i++){await page.mouse.move(x+i*3,y+Math.sin(i/5)*25);await page.waitForTimeout(16);}
      await page.mouse.up({button:'middle'});const after=await page.evaluate(()=>({...styk.state.view}));
      if(picked!=='pan'||before.x===after.x)throw new Error('Pan did not change the view.');return {picked,before,after};
    });
  }
  await pan('pan-handles-on');
  await page.evaluate(()=>{styk.state.handles=false;styk.fit();});await page.waitForTimeout(400);
  await pan('pan-handles-off');
  await page.evaluate(()=>{styk.state.handles=true;styk.fit();});await page.waitForTimeout(500);
  await phase('zoom',async()=>{
    const r=await page.locator('#viewport').boundingBox(),before=await page.evaluate(()=>styk.state.view.scale);
    await page.mouse.move(r.x+r.width*.5,r.y+r.height*.5);await page.keyboard.down('Control');
    try{for(let i=0;i<12;i++){await page.mouse.wheel(0,i<6?-30:30);await page.waitForTimeout(60);}}finally{await page.keyboard.up('Control');}
    return {before,after:await page.evaluate(()=>styk.state.view.scale)};
  });
  await page.evaluate(()=>styk.fit());await page.waitForTimeout(700);
  await phase('frame-changes',async()=>{
    const latencies=[];
    for(let i=0;i<12;i++)latencies.push(await page.evaluate(async index=>{
      const begin=performance.now(),count=__dense.presents.length;styk.editor.selectFrame(index%4);
      while(__dense.presents.length===count)await new Promise(requestAnimationFrame);
      return {tick:styk.editor.tick,ms:performance.now()-begin};
    },i+1));return {latencies};
  });
  await page.waitForTimeout(1000);
  const target=await page.evaluate(async()=>{
    const e=styk.editor,r=document.querySelector('#viewport').getBoundingClientRect();
    const {worldToScreen}=await import('/src/renderer.mjs');
    const visible=[...e.geometry.objects.values()].map(g=>({g,p:worldToScreen(g.root,{report:e.report,frame:e.frame,view:styk.state.view,cameraEnabled:false})})).filter(({p})=>p.x>80&&p.x<r.width-80&&p.y>70&&p.y<r.height-100);
    const {g,p}=visible.at(-1)||{g:[...e.geometry.objects.values()][0],p:{x:r.width/2,y:r.height/2}};e.select(g.obj.unique_id);
    return{x:r.left+p.x,y:r.top+p.y,uid:g.obj.unique_id};
  });await page.waitForTimeout(300);
  await phase('figure-drag',async()=>{
    const before=await page.evaluate(()=>({uid:styk.editor.selectedUid,x:styk.editor.object.root_x,y:styk.editor.object.root_y}));
    await page.mouse.move(target.x,target.y);await page.mouse.down();const picked=await page.evaluate(()=>({kind:styk.state.drag?.kind,uid:styk.editor.selectedUid}));
    for(let i=1;i<=24;i++){await page.mouse.move(target.x+i*2,target.y-i*.4);await page.waitForTimeout(16);}
    await page.mouse.up();const after=await page.evaluate(()=>({uid:styk.editor.selectedUid,x:styk.editor.object.root_x,y:styk.editor.object.root_y}));
    if(picked.kind!=='move'||(before.x===after.x&&before.y===after.y))throw new Error(`Invalid figure drag: ${JSON.stringify({picked,before,after})}`);
    return {picked,before,after};
  },500);
  await page.waitForTimeout(1200);
  await phase('selection',async()=>{
    for(let i=0;i<6;i++){await page.evaluate(index=>styk.editor.select(styk.editor.frame.objects[index].unique_id),i);await page.waitForTimeout(80);}
  });
  await phase('playback-after-edit',async()=>{await page.locator('#play-button').click();await page.waitForTimeout(5000);},0);
  await page.locator('#play-button').click();await page.waitForTimeout(700);
  if(cpu)await diagnostic(page,result,output);
  result.limitations=['Visible Electron, current workspace sources, isolated default preferences at 1600x1000 CSS pixels.',
    'FPS counts consecutive distinct scene tick submissions; it is not physical display scanout. rAF is recorded separately.',
    'Empty-cache phase clears CPU packets and GPU prepared frames but retains the loaded worker document; import is measured separately.',
    'Light wrappers and a continuous rAF observer add overhead; CPU sampling is enabled only in diagnostic mode.',
    'Pointer phases are paced automation, not a claim about human input-to-display latency. Event Timing is quantized.',
    'Four-frame repetitions do not measure long-timeline memory scaling.'];
}

async function diagnostic(page,result,output) {
  console.log('BEGIN isolated-diagnostics');
  result.diagnostics=await page.evaluate(async()=>{
    const e=styk.editor,r=styk.state.renderer,{buildGeometry,evaluatedFrame}=await import('/src/pivot/geometry.mjs');
    const {requiresCompatibilityTexture}=await import('/src/renderer-geometry.mjs');
    const {getPivotHandles}=await import('/src/canvas-interactions.mjs');
    const g=e.geometry,counts={objects:g.objects.size,segments:0,polygons:0,staticSegments:0,drawables:0,compatibilityObjects:0,transparentObjects:0,globalOutlineObjects:0,bentAlphaOrGradientObjects:0,polygonCompatibilityObjects:0};
    for(const o of g.objects.values()){
      counts.segments+=o.segments.length;counts.polygons+=o.polys.length;counts.staticSegments+=o.segments.filter(s=>s.static).length;
      const items=o.drawables;counts.drawables+=items.length;counts.compatibilityObjects+=Number(requiresCompatibilityTexture(items));
      counts.transparentObjects+=Number(items.some(s=>s.opacity<.999999));counts.globalOutlineObjects+=Number(items.some(s=>s.fig?.segment_decode?.global_style?.u28));
      counts.bentAlphaOrGradientObjects+=Number(items.some(s=>(s.alpha<.999999||s.seg?.secondary?.a>0)&&Math.abs(s.bend)>1e-7));
      counts.polygonCompatibilityObjects+=Number(items.some(s=>s.type==='poly'&&requiresCompatibilityTexture([s])));
    }
    const handles=getPivotHandles(g,{frame:e.frame,selectedUid:e.selectedUid,selectedUids:new Set([e.selectedUid]),showUnselected:true,showStatic:false,viewScale:styk.state.view.scale,autoSize:true,maxDiameter:10});
    const rows=[];
    for(let i=0;i<12;i++){
      const start=performance.now(),f=evaluatedFrame(e.report,i%4,0,i%4),a=performance.now(),geo=buildGeometry(e.report,f),b=performance.now();
      const hs=getPivotHandles(geo,{frame:f,selectedUid:e.selectedUid,selectedUids:new Set([e.selectedUid]),showUnselected:true,showStatic:false,viewScale:styk.state.view.scale,autoSize:true,maxDiameter:10});
      rows.push({tick:i%4,evaluateMs:a-start,geometryMs:b-a,handlesMs:performance.now()-b,handles:hs.length});
      await new Promise(resolve=>setTimeout(resolve,30));
    }
    const serialized=JSON.stringify(e.report),poseSignatures=e.report.keyframes.map(f=>new Set(f.objects.map(o=>JSON.stringify({...o,unique_id:0,root_x:0,root_y:0,_styk:undefined}))).size);
    const gpu=[];
    await r.device.queue.onSubmittedWorkDone();
    for(let i=0;i<12;i++){
      await new Promise(requestAnimationFrame);const start=performance.now();r.render(__dense.lastRender);const submit=performance.now();
      await r.device.queue.onSubmittedWorkDone();gpu.push({submitMs:submit-start,submitToQueueDoneMs:performance.now()-submit});
    }
    const {PlaybackCache}=await import('/src/playback.mjs');
    const packets=[],cache=new PlaybackCache({onReady:p=>packets.push({tick:p.tick,scale:p.scale,resolution:p.resolution,compileMs:p.compileMs,timings:p.timings,bytes:p.byteLength,clipping:p.clipping,compatibility:p.compatibility.length})});
    const workerTrials=[];
    try{
      for(const scale of [styk.state.view.scale,2,4]){
        const start=performance.now(),from=packets.length;cache.load(e.report,{scale});
        let error;
        try{await cache.prepareRange([0,1,2,3]);}catch(e){error={message:e.message,code:e.code};}
        workerTrials.push({scale,wallMs:performance.now()-start,packets:packets.slice(from),stats:{...cache.stats},error});
      }
    }finally{cache.dispose();}
    return{counts,handles:handles.length,expandedJsonBytes:new TextEncoder().encode(serialized).byteLength,poseSignatures,geometryTrials:rows,gpuQueueTrials:gpu,workerTrials};
  });
  await writeFile(path.join(output,'diagnostics.json'),JSON.stringify(result.diagnostics,null,2));
  console.log('DIAGNOSTICS',JSON.stringify(result.diagnostics));
}
