/** Diagnostic only: actual loaded-scene editing, CPU stacks, long tasks, and autosave. */
import {chromium} from 'playwright';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.resolve(process.argv[2] || path.join(appRoot, '../PIVOT ANIMATOR SCENE TEST/Shroobs_JJK_Pack.piv'));
const name = path.basename(source, '.piv'), suffix = (process.env.STYK_PROFILE_SUFFIX || '').replace(/[^a-z0-9-]/gi, '');
const cpuProfiling = process.env.STYK_NO_CPU_PROFILE !== '1';
const jointUid = Number(process.env.STYK_PROFILE_JOINT_UID) || null;
const cancelAutosave = process.env.STYK_PROFILE_CANCEL_AUTOSAVE === '1';
const phaseFilter = process.env.STYK_PROFILE_PHASES?.split(',');
const scrubHoldMs = Number(process.env.STYK_PROFILE_SCRUB_HOLD_MS) || 120;
const settleBeforeMs = Number(process.env.STYK_PROFILE_SETTLE_BEFORE_MS) || 0;
const numericSettleMs = Number(process.env.STYK_PROFILE_NUMERIC_SETTLE_MS) || 0;
const verifyPreviews = process.env.STYK_PROFILE_VERIFY_PREVIEWS === '1';
const verifyPlayback = process.env.STYK_PROFILE_VERIFY_PLAYBACK === '1';
const playbackStartTick = Number(process.env.STYK_PROFILE_PLAYBACK_START ?? 1824);
const playbackEndTick = Number(process.env.STYK_PROFILE_PLAYBACK_END ?? 1872);
const playbackPhaseName = playbackStartTick === 0 ? 'playback-full' : 'playback-tail';
const output = path.join(appRoot, 'artifacts', `edit-freeze-${name.replace(/[^a-z0-9]/gi, '-').toLowerCase()}${suffix}`);
await mkdir(output, {recursive: true});
const browser = await chromium.launch({channel: 'chrome', headless: true});
const context = await browser.newContext({viewport: {width: 1600, height: 1000}}), page = await context.newPage();
page.setDefaultTimeout(60000);
const client = await context.newCDPSession(page), phases = [], errors = [], consoleErrors=[];
const sourceHashes = {}, sourceReads = [];
page.on('response', response => {
  const url = new URL(response.url());
  if (!['/src/app.mjs','/src/editor.mjs','/src/renderer.mjs','/src/playback.mjs','/src/playback-worker.mjs','/src/prepared-frames.mjs','/src/pivot/geometry.mjs'].includes(url.pathname)) return;
  sourceReads.push(response.body().then(async bytes => {
    sourceHashes[url.pathname.slice(1)] = createHash('sha256').update(bytes).digest('hex');
    await writeFile(path.join(output, `loaded-${path.basename(url.pathname)}`), bytes);
  }).catch(error => errors.push(`Could not record loaded source ${url.pathname}: ${error.message}`)));
});
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => {if(message.type()==='error')consoleErrors.push(message.text());});
const quantiles = values => {const a = values.sort((a,b)=>a-b); return {count:a.length,p50:a[Math.floor(a.length*.5)]||0,p95:a[Math.floor(a.length*.95)]||0,p99:a[Math.floor(a.length*.99)]||0,max:a.at(-1)||0};};
function profileSummary(profile) {
  const nodes = new Map(profile.nodes.map(n => [n.id,n])), parents = new Map(), times = new Map(), inclusive = new Map();
  for (const n of profile.nodes) for (const id of n.children || []) parents.set(id,n.id);
  profile.samples.forEach((id,i) => {const ms=(profile.timeDeltas[i]||0)/1000; times.set(id,(times.get(id)||0)+ms);
    for(let p=id;p;p=parents.get(p))inclusive.set(p,(inclusive.get(p)||0)+ms);});
  const format = id => {const n=nodes.get(id),f=n.callFrame; return {function:f.functionName||'(anonymous)',url:f.url,line:f.lineNumber+1,selfMs:times.get(id)||0,totalMs:inclusive.get(id)||0};};
  return {self:[...times.keys()].sort((a,b)=>times.get(b)-times.get(a)).slice(0,18).map(format),inclusive:[...inclusive.keys()].filter(id=>nodes.get(id).callFrame.url.includes('/src/')).sort((a,b)=>inclusive.get(b)-inclusive.get(a)).slice(0,22).map(format)};
}
async function phase(name, action, settle = 180) {
  if(phaseFilter&&!phaseFilter.includes(name))return;
  await page.evaluate(name => {__freeze.phase=name;__freeze.phases.push({name,start:performance.now()});},name);
  if (cpuProfiling) await client.send('Profiler.start'); const start=Date.now(); const actionResult=await action();
  await page.waitForTimeout(settle); const profile=cpuProfiling ? (await client.send('Profiler.stop')).profile : null;
  const observations=await page.evaluate(() => {const b=__freeze,p=b.phases.at(-1);p.end=performance.now();return {
    interval:p,calls:b.calls.filter(c=>c.start>=p.start&&c.start<=p.end),
    longTasks:b.longTasks.filter(c=>c.start>=p.start&&c.start<=p.end),
    raf:b.raf.filter(c=>c.at>=p.start&&c.at<=p.end).map(c=>c.ms),
    autosaves:b.autosaves.filter(a=>a.completed>=p.start&&a.completed<=p.end),
    exportJobs:b.exports.filter(a=>a.started>=p.start||a.terminated>=p.start),
    seeks:b.seeks.filter(a=>a.at>=p.start&&a.at<=p.end),presented:b.presented.filter(a=>a.at>=p.start&&a.at<=p.end),
    playbackEvents:b.playbackEvents.filter(a=>a.at>=p.start&&a.at<=p.end),
    playback:styk.performance().playback,
    lastExport:styk.state.lastExport,historyBytes:styk.editor.historySize,renderer:{...styk.state.renderer.stats}};});
  const summary={name,wallMs:Date.now()-start,actionResult,...observations,raf:quantiles(observations.raf),cpu:profile ? profileSummary(profile) : {self:[],inclusive:[]}};
  phases.push(summary); if(profile) await writeFile(path.join(output,`${name}.cpuprofile`),JSON.stringify(profile));
  console.log(JSON.stringify({phase:name,wallMs:summary.wallMs,raf:summary.raf,longTasks:summary.longTasks,slowCalls:summary.calls.filter(c=>c.ms>=20).map(c=>({name:c.name,ms:c.ms})),top:summary.cpu.self.slice(0,5)}));
}
try {
  await page.goto(process.env.STYK_URL || 'http://127.0.0.1:47831'); await page.waitForFunction(()=>styk?.ready);
  await page.evaluate(()=>styk.editor.markSaved()); await page.locator('#file-input').setInputFiles(source);
  await page.waitForFunction(name=>styk.editor.name===name&&!styk.state.importing,name,{timeout:180000});
  await page.waitForTimeout(1000);
  const scene = await page.evaluate(async () => {
    const e=styk.editor, counts=new Map(e.report.figure_types.map(f=>[f.figure_type_id,f.segments.length]));
    const frames=e.report.keyframes.map((f,i)=>({i,objects:f.objects.length,segments:f.objects.reduce((n,o)=>n+counts.get(o.figure_type_id),0)}));
    const heaviest=frames.reduce((a,b)=>a.segments>b.segments?a:b); e.selectFrame(heaviest.i);
    const object=[...e.frame.objects].filter(o=>!o.join).sort((a,b)=>counts.get(b.figure_type_id)-counts.get(a.figure_type_id))[0]||e.frame.objects[0];
    e.select(object.unique_id); styk.fit();
    const {worldToScreen}=await import('/src/renderer.mjs'); window.__toScreen=worldToScreen;
    const b=window.__freeze={phase:'setup',phases:[],calls:[],longTasks:[],raf:[],counts:{},autosaves:[],exports:[],seeks:[],presented:[],playbackEvents:[]};
    const {PlaybackCache}=await import('/src/playback.mjs');
    let preparationId=0;
    const cacheState=cache=>({revision:cache.revision,ready:[...cache.cache.keys()],pending:[...cache.pending.keys()],loading:Boolean(cache._loadPromise),protected:cache._protectedTick,bytes:cache.stats.bytes});
    const originalPrepare=PlaybackCache.prototype.prepareRange;
    PlaybackCache.prototype.prepareRange=function(ticks,options){
      const id=++preparationId;
      b.playbackEvents.push({at:performance.now(),event:'prepare-start',id,ticks:[...ticks],...cacheState(this)});
      return originalPrepare.call(this,ticks,options).then(result=>{
        b.playbackEvents.push({at:performance.now(),event:'prepare-complete',id,ticks:[...ticks],...cacheState(this)});return result;
      },error=>{b.playbackEvents.push({at:performance.now(),event:'prepare-error',id,ticks:[...ticks],error:error.message,...cacheState(this)});throw error;});
    };
    const originalReceive=PlaybackCache.prototype._receive;
    PlaybackCache.prototype._receive=function(data){
      const result=originalReceive.call(this,data);
      if(['packet','loaded','error'].includes(data.type))b.playbackEvents.push({at:performance.now(),event:`receive-${data.type}`,tick:data.tick,packetBytes:data.packet?.byteLength,compileMs:data.packet?.compileMs,...cacheState(this)});
      return result;
    };
    const exportWorkers=new WeakMap(),nativePost=Worker.prototype.postMessage,nativeTerminate=Worker.prototype.terminate;
    Worker.prototype.postMessage=function(data,...args){
      if(data?.operation==='start'&&data.options?.format){const job={started:performance.now(),format:data.options.format,chunks:0};b.exports.push(job);exportWorkers.set(this,job);}
      const job=exportWorkers.get(this);if(job&&data?.operation==='chunk')job.chunks++;if(job&&data?.operation==='export')job.submitted=performance.now();
      return nativePost.call(this,data,...args);
    };
    Worker.prototype.terminate=function(...args){const job=exportWorkers.get(this);if(job&&!job.terminated)job.terminated=performance.now();return nativeTerminate.apply(this,args);};
    const nativePut=IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put=function(value,...args){const request=nativePut.call(this,value,...args);
      if(value?.blob instanceof Blob)request.transaction.addEventListener('complete',()=>b.autosaves.push({completed:performance.now(),bytes:value.blob.size,name:value.name}),{once:true});return request;};
    new PerformanceObserver(list=>{for(const entry of list.getEntries())b.longTasks.push({start:entry.startTime,ms:entry.duration});}).observe({entryTypes:['longtask']});
    const track=(name,fn,scope)=>function(...args){const start=performance.now();try{return fn.apply(scope||this,args);}finally{const ms=performance.now()-start;b.counts[name]=(b.counts[name]||0)+1;if(ms>=4)b.calls.push({name,start,ms,stack:ms>=15?new Error().stack:undefined});}};
    for(const name of ['select','selectFrame','seek','beginDrag','poseJoint','commitDrag','updateObject','serialize','_emit','_record','_applyCommand']) if(typeof e[name]==='function')e[name]=track(`editor.${name}`,e[name],e);
    const seek=e.seek;e.seek=function(...args){const result=seek.apply(this,args);b.seeks.push({at:performance.now(),requested:args[0],tick:e.tick,key:e.frameIndex,lazy:args[1]?.evaluate===false});return result;};
    for(const name of ['render','renderPrepared','prepareFrame'])if(typeof styk.state.renderer[name]==='function')styk.state.renderer[name]=track(`renderer.${name}`,styk.state.renderer[name],styk.state.renderer);
    for(const name of ['render','renderPrepared']){const renderer=styk.state.renderer,original=renderer[name];if(!original)continue;renderer[name]=function(...args){const result=original.apply(this,args);b.presented.push({at:performance.now(),mode:name,tick:e.tick,target:styk.state.scrubTarget,packetTick:(styk.state.scrubbing?styk.state.scrubPacket:styk.state.playbackPacket)?.tick,scrubbing:styk.state.scrubbing,playing:styk.state.playing,success:result!==false,preparedBytes:renderer.stats.preparedCache?.bytes,preparedMaxBytes:renderer.stats.preparedCache?.maxBytes});return result;};}
    JSON.stringify=track('JSON.stringify',JSON.stringify,JSON);window.structuredClone=track('structuredClone',structuredClone,window);
    let last=performance.now();const raf=now=>{b.raf.push({at:now,ms:now-last});last=now;requestAnimationFrame(raf);};requestAnimationFrame(raf);
    return {name:e.name,frames:frames.length,totalTicks:e.totalTicks,figureTypes:e.report.figure_types.length,heaviest,
      selectedUid:e.selectedUid,selectedSegments:e.figure.segments.length,staticSegments:e.geometry.objects.get(e.selectedSlot).segments.filter(s=>s.static).length,
      joinedObjects:e.frame.objects.filter(o=>o.join).length,sourceId:styk.state.sourceId,adapter:styk.state.renderer.stats.adapter,canvas:[e.report.canvas_width,e.report.canvas_height],fps:e.report.fps};
  });
  if(cpuProfiling) {await client.send('Profiler.enable'); await client.send('Profiler.setSamplingInterval',{interval:1000});}
  console.log('SCENE',JSON.stringify(scene));
  if(settleBeforeMs)await page.waitForTimeout(settleBeforeMs);
  async function target(kind) {
    return page.evaluate(({kind,jointUid})=>{
      const e=styk.editor;
      if(kind==='joint'&&jointUid&&e.frame.objects.some(o=>o.unique_id===jointUid))e.select(jointUid);
      const g=e.geometry.objects.get(e.selectedSlot),r=document.querySelector('#viewport').getBoundingClientRect();
      const dynamic=g.segments.map((s,i)=>({s,i})).filter(({s})=>!s.static&&Math.hypot(s.end.x-g.root.x,s.end.y-g.root.y)>1);
      const chosen=dynamic[0],p=kind==='joint'&&chosen?chosen.s.end:g.root;
      let screen=__toScreen(p,{report:e.report,frame:e.frame,view:styk.state.view});
      styk.state.view.x+=r.width/2-screen.x;styk.state.view.y+=r.height/2-screen.y;
      window.dispatchEvent(new Event('resize'));styk.state.dirtyRender=true;
      screen=__toScreen(p,{report:e.report,frame:e.frame,view:styk.state.view});
      return{x:r.left+screen.x,y:r.top+screen.y,uid:e.selectedUid,joint:chosen?.i};
    },{kind,jointUid});
  }
  const root=await target('root');
  await phase('body-drag',async()=>{
    const before=await page.evaluate(()=>({x:styk.editor.object.root_x,y:styk.editor.object.root_y}));
    await page.mouse.move(root.x,root.y);await page.mouse.down();const picked=await page.evaluate(()=>({kind:styk.state.drag?.kind,uid:styk.editor.selectedUid}));
    for(let i=1;i<=20;i++)await page.mouse.move(root.x+i*2,root.y-i*.4);
    await page.mouse.up();const after=await page.evaluate(()=>({x:styk.editor.object.root_x,y:styk.editor.object.root_y}));return {picked,before,after};
  });
  await phase('selection',async()=>{for(let i=0;i<5;i++)await page.evaluate(uid=>{styk.editor.select(null);styk.editor.select(uid);},scene.selectedUid);});
  const joint=await target('joint');
  await phase('joint-pose',async()=>{
    const before=await page.evaluate(()=>({angles:styk.editor.frame.objects.flatMap(o=>o.angles),calls:__freeze.counts['editor.poseJoint']||0}));
    await page.mouse.move(joint.x,joint.y);await page.mouse.down();const picked=await page.evaluate(()=>({kind:styk.state.drag?.kind,uid:styk.editor.selectedUid,joint:styk.editor.selectedJoint}));
    for(let i=1;i<=20;i++)await page.mouse.move(joint.x+i*.8,joint.y+i*.5);
    await page.mouse.up();const after=await page.evaluate(()=>({angles:styk.editor.frame.objects.flatMap(o=>o.angles),calls:__freeze.counts['editor.poseJoint']||0}));return {picked,poseCalls:after.calls-before.calls,changedAngleCount:before.angles.filter((a,i)=>a!==after.angles[i]).length};
  });
  await phase('scrub',async()=>{
    const r=await page.locator('.styk-timeline-scroll').boundingBox();
    const before=await page.evaluate(()=>({tick:styk.editor.tick,key:styk.editor.frameIndex,scrollLeft:document.querySelector('.styk-timeline-scroll').scrollLeft}));
    await page.mouse.move(r.x+20,r.y+14);await page.mouse.down();
    for(let i=0;i<20;i++)await page.mouse.move(r.x+20+i*14,r.y+14);
    const motionEnded=await page.evaluate(()=>performance.now());
    await page.waitForTimeout(scrubHoldMs);
    const held=await page.evaluate(()=>({at:performance.now(),tick:styk.editor.tick,packetTick:styk.state.scrubPacket?.tick,presented:__freeze.presented.filter(p=>p.scrubbing&&p.success&&p.mode==='renderPrepared')}));
    if(verifyPreviews)await page.screenshot({path:path.join(output,'scrub-held.png')});
    await page.mouse.up();
    const after=await page.evaluate(()=>({tick:styk.editor.tick,key:styk.editor.frameIndex,scrollLeft:document.querySelector('.styk-timeline-scroll').scrollLeft}));
    return{before,after,motionEnded,held};
  });
  if(verifyPlayback){
    await page.evaluate(({start,end})=>{
      const e=styk.editor;e.setFPS(16);e.markSaved();
      styk.state.loop=false;styk.state.loopRange={startTick:start,endTick:end};e.seek(start);styk.fit();
    },{start:playbackStartTick,end:playbackEndTick});
    await page.waitForTimeout(2500);
    await phase(playbackPhaseName,async()=>{
      await page.locator('#play-button').click();
      const deadline=Date.now()+Math.max(30000,(playbackEndTick-playbackStartTick)*1000/16*2+30000);
      let lastProgress=Date.now();const memorySamples=[];
      while(true){
        const state=await page.evaluate(()=>({playing:styk.state.playing,tick:styk.editor.tick,playback:styk.performance().playback,prepared:styk.state.renderer.stats.preparedCache,jsHeapBytes:performance.memory?.usedJSHeapSize}));
        if(!state.playing)break;
        if(Date.now()>deadline)throw new Error(`Playback did not complete by its deadline; stopped at tick ${state.tick}.`);
        if(Date.now()-lastProgress>15000){const sample={tick:state.tick,of:playbackEndTick,cpuBytes:state.playback.bytes,gpuBytes:state.prepared?.bytes,jsHeapBytes:state.jsHeapBytes};memorySamples.push(sample);console.log('PLAYBACK_PROGRESS',JSON.stringify(sample));lastProgress=Date.now();}
        await page.waitForTimeout(250);
      }
      return{...await page.evaluate(()=>({tick:styk.editor.tick,fps:styk.editor.report.fps,buffering:styk.state.buffering,status:document.querySelector('#status').textContent})),memorySamples};
    });
    await page.screenshot({path:path.join(output,'playback-ended.png')});
  }
  await page.evaluate(({heaviest,selectedUid})=>{styk.editor.selectFrame(heaviest.i);styk.editor.select(selectedUid);},scene);
  if(numericSettleMs)await page.waitForTimeout(numericSettleMs);
  await phase('numeric-edits',async()=>{
    const changes=[];
    for(let i=0;i<3;i++){
      const field=page.locator('[data-field="root_x"]'),x=Number(await field.inputValue());
      await field.fill(String(x+1));await field.press('Tab');
      const actual=await page.evaluate(()=>styk.editor.object.root_x);
      if(Math.abs(actual-(x+1))>.001)throw new Error(`Numeric root edit requested ${x+1} but document has ${actual}.`);
      changes.push({before:x,requested:x+1,actual});
    }
    return{changes};
  });
  if(cancelAutosave)await phase('autosave-cancel-drag',async()=>{
    const deadline=Date.now()+20000;let active;
    do{active=await page.evaluate(()=>__freeze.exports.findLast(job=>!job.terminated&&job.chunks>=3));if(active)break;await page.waitForTimeout(50);}while(Date.now()<deadline);
    if(!active)throw new Error('The dirty document did not start an export worker for recovery.');
    const p=await target('root'),before=await page.evaluate(()=>({x:styk.editor.object.root_x,y:styk.editor.object.root_y}));
    await page.mouse.move(p.x,p.y);await page.mouse.down();
    const during=await page.evaluate(start=>({kind:styk.state.drag?.kind,job:__freeze.exports.find(job=>job.started===start)}),active.started);
    for(let i=1;i<=12;i++)await page.mouse.move(p.x+i,p.y+i*.4);await page.mouse.up();
    const after=await page.evaluate(()=>({x:styk.editor.object.root_x,y:styk.editor.object.root_y}));
    if(!during.job.terminated||during.kind!=='move')throw new Error('Dragging did not cancel the active recovery snapshot before movement.');
    if(before.x===after.x&&before.y===after.y)throw new Error('The interruption drag did not move the selected figure.');
    return{cancelled:true,picked:during.kind,completedChunks:during.job.chunks,before,after};
  });
  await phase('autosave-warmup',async()=>{
    const count=await page.evaluate(()=>__freeze.autosaves.length),deadline=Date.now()+90000;
    while(Date.now()<deadline){await page.waitForTimeout(200);if(await page.evaluate(count=>__freeze.autosaves.length>count,count))return {persisted:true};}
    return {persisted:false,status:await page.locator('#status').textContent()};
  },300);
  await page.screenshot({path:path.join(output,'scene.png')});
  await Promise.all(sourceReads);
  await writeFile(path.join(output,'report.json'),JSON.stringify({scene,phases,errors,consoleErrors,sourceHashes,cpuProfiling,measuredAt:new Date().toISOString(),limitation:'Chrome headless on local GPU. Pointer event to CPU work and rAF intervals, not display latency. Profiling wrappers add small measurement overhead. CDP CPU recording can pause between phases when enabled. Import excluded.'},null,2));
  if(verifyPreviews){
    const scrub=phases.find(p=>p.name==='scrub');assert.ok(scrub,'Scrub phase must run.');
    const duringMotion=scrub.presented.filter(p=>p.mode==='renderPrepared'&&p.scrubbing&&p.success&&p.at<=scrub.actionResult.motionEnded);
    assert.ok(new Set(duringMotion.map(p=>p.packetTick)).size>=3,'At least three distinct previews must actually submit during pointer motion.');
    assert.equal(scrub.actionResult.held.packetTick,scrub.actionResult.after.tick,'Held preview must match the release target.');
    assert.ok(scrub.presented.some(p=>p.scrubbing&&p.packetTick===scrub.actionResult.after.tick&&p.success),'Exact final preview must render before release.');
    assert.deepEqual(scrub.playbackEvents.filter(p=>p.event==='receive-error'),[],'Valid native scrub ticks must not fail preparation.');
  }
  if(verifyPlayback){
    const playback=phases.find(p=>p.name===playbackPhaseName);assert.ok(playback,'Playback phase must run.');
    const presented=playback.presented.filter(p=>p.mode==='renderPrepared'&&p.playing&&p.success),ticks=presented.map(p=>p.packetTick).filter((tick,i,a)=>i===0||tick!==a[i-1]);
    assert.deepEqual(ticks,Array.from({length:playbackEndTick-playbackStartTick},(_,i)=>playbackStartTick+i),'Every native output tick must actually render in exact order.');
    assert.equal(playback.actionResult.tick,playbackEndTick-1);assert.equal(playback.actionResult.fps,16);
    assert.deepEqual(playback.playbackEvents.filter(p=>p.event==='receive-error'),[],'Valid native playback ticks must not fail preparation.');
    assert.ok(playback.longTasks.every(task=>task.ms<500),'Playback must not produce a half-second main-thread freeze.');
    assert.ok(playback.playbackEvents.every(event=>event.bytes<=playback.playback.maxBytes),'CPU prepared packet memory must stay bounded.');
    assert.ok(presented.every(event=>event.preparedBytes<=event.preparedMaxBytes),'GPU prepared packet memory must stay bounded.');
  }
  if(verifyPreviews||verifyPlayback)assert.deepEqual(errors,[],'No unhandled browser errors.');
  if(verifyPreviews||verifyPlayback)assert.deepEqual(consoleErrors,[],'No console errors.');
} catch(error) {await writeFile(path.join(output,'failure.json'),JSON.stringify({error:error.stack,phases,errors},null,2));throw error;}
finally {await browser.close();}
