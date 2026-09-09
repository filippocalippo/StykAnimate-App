/** Real-pointer gesture measurements. All scene edits stay in the isolated test document. */
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {scaleBenchmarkScene} from './dense-scene-scale.mjs';

const quantiles=values=>{const a=[...values].sort((a,b)=>a-b);return {n:a.length,mean:a.length?a.reduce((a,b)=>a+b,0)/a.length:null,p50:a[Math.floor(a.length*.5)]??null,p95:a[Math.floor(a.length*.95)]??null,max:a.at(-1)??null};};
const cases=[
  {id:'figure-selected',kind:'root',selected:true},
  {id:'figure-unselected',kind:'root',selected:false},
  {id:'joint-leaf',kind:'leaf'},
  {id:'joint-branch',kind:'branch'},
  {id:'joint-stretch',kind:'branch',modifier:'Control'},
  {id:'joint-bend',kind:'branch',button:'right',expected:'bend'},
  {id:'figure-transform',kind:'branch',modifier:'Alt',expected:'figure-transform'},
  {id:'group-10',kind:'root',group:10},
  {id:'group-60',kind:'root',group:60},
  {id:'joint-branch-200pct',kind:'branch',scale:2},
  {id:'figure-200pct',kind:'root',scale:2},
  {id:'joint-onion',kind:'branch',onion:true},
  {id:'rig-static',kind:'static',tool:'rig',expected:'rig',steps:12},
  {id:'rig-selected-handles',kind:'static',tool:'rig',expected:'rig',steps:12,selectedOnly:true},
  {id:'rig-overlay-off',kind:'static',tool:'rig',expected:'rig',steps:12,disableOverlayDuringDrag:true},
  {id:'joint-fast-input',kind:'branch',pace:0,steps:48},
  {id:'figure-after-frame',kind:'root',frameChange:true},
  {id:'joint-after-frame',kind:'branch',frameChange:true},
];

async function install(page){
  await page.evaluate(()=>{
    const b=window.__dragBench={active:false,part:'idle',serial:0,inputs:[],frames:[],calls:[],raf:[],longTasks:[],lastInput:null};
    const canvas=document.querySelector('#overlay');
    for(const type of ['pointermove','pointerdown','pointerup','pointercancel','keydown','keyup','wheel']){
      const surface=type.startsWith('key')?window:type==='wheel'?document.querySelector('#viewport'):canvas;
      surface.addEventListener(type,e=>{if(!b.active)return;const row={id:++b.serial,type,part:b.part,at:performance.now(),eventAt:e.timeStamp,trusted:e.isTrusted,x:e.clientX,y:e.clientY,key:e.key};b.inputs.push(row);b.lastInput=row;},true);
      surface.addEventListener(type,e=>{if(!b.active)return;const row=b.lastInput;if(row?.type===type){row.handlerMs=performance.now()-row.at;row.dragKind=styk.state.drag?.kind;row.uid=styk.editor.selectedUid;row.joint=styk.editor.selectedJoint;} });
    }
    const e=styk.editor,r=styk.state.renderer;
    for(const name of ['select','selectMarquee','beginDrag','beginTranslationDrag','moveSelection','poseJoint','bendJoint','beginFigureHandleDrag','transformFigureHandle','beginRigDrag','editRigJoint','commitRigDrag','commitDrag','cancelDrag','touch','_record','undo','redo']){
      if(typeof e[name]!=='function')continue;const fn=e[name];
      e[name]=function(...args){const start=performance.now();try{return fn.apply(this,args);}finally{if(b.active)b.calls.push({name:`editor.${name}`,part:b.part,start,ms:performance.now()-start,affected:e._drag?.before?.length});}};
    }
    const getter=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(e),'geometry').get;
    Object.defineProperty(e,'geometry',{configurable:true,get(){const start=performance.now(),cached=Boolean(e._geometry);try{return getter.call(e);}finally{if(b.active&&!cached)b.calls.push({name:'editor.geometry-build',part:b.part,start,ms:performance.now()-start});}}});
    for(const name of ['render','prepare','updateGeometry','rasterObject']){
      const fn=r[name];if(typeof fn!=='function')continue;
      r[name]=function(...args){const start=performance.now();try{return fn.apply(this,args);}finally{if(b.active)b.calls.push({name:`renderer.${name}`,part:b.part,start,ms:performance.now()-start});}};
    }
    const samples=styk.state.renderSamples,push=samples.push;
    samples.push=function(...args){if(b.active)b.frames.push({at:performance.now(),part:b.part,cpuMs:args[0],inputId:b.lastInput?.id,dragKind:styk.state.drag?.kind,
      preparation:r.stats.preparation,updatedObjects:r.stats.updatedObjects,rasterizedObjects:r.stats.rasterizedObjects,uploadBytes:r.stats.uploadBytes,drawCalls:r.stats.drawCalls});return push.apply(this,args);};
    new PerformanceObserver(list=>{if(b.active)for(const e of list.getEntries())b.longTasks.push({at:e.startTime,ms:e.duration});}).observe({entryTypes:['longtask']});
    let last=performance.now();function tick(now){if(b.active)b.raf.push({at:now,ms:now-last,part:b.part});last=now;requestAnimationFrame(tick);}requestAnimationFrame(tick);
  });
}

async function locate(page,scenario,prior){
  return page.evaluate(async({scenario,prior})=>{
    const e=styk.editor,g=e.geometry,r=document.querySelector('#viewport').getBoundingClientRect();
    const {getPivotHandles,pickCanvasHandle}=await import('/src/canvas-interactions.mjs');
    const project=p=>({x:p.x*styk.state.view.scale+styk.state.view.x,y:p.y*styk.state.view.scale+styk.state.view.y});
    const options={frame:e.frame,selectedUid:e.selectedUid,selectedUids:e.selectedUids,showUnselected:styk.state.settings.showUnselectedHandles,showStatic:scenario.kind==='static',allowStaticManipulation:scenario.kind==='static',viewScale:styk.state.view.scale,autoSize:true,maxDiameter:10};
    const handles=getPivotHandles(g,options);
    const definitions=new Map();
    const descendants=h=>{
      let info=definitions.get(h.g.fig);
      if(!info){info={children:new Map(),counts:new Map()};for(const s of h.g.fig.segments){const parent=Number(s.parent_id),list=info.children.get(parent)||[];list.push(Number(s.segment_id));info.children.set(parent,list);}definitions.set(h.g.fig,info);}
      if(info.counts.has(h.id))return info.counts.get(h.id);
      const queue=[h.id],seen=new Set(queue);
      for(let i=0;i<queue.length;i++)for(const id of info.children.get(queue[i])||[])if(!seen.has(id)){seen.add(id);queue.push(id);}
      info.counts.set(h.id,seen.size-1);return seen.size-1;
    };
    let candidates=handles.filter(h=>scenario.kind==='root'?h.joint<0:scenario.kind==='static'?h.static:h.joint>=0&&!h.static);
    candidates=candidates.filter(h=>{
      const p=project(h.point);return p.x>=80&&p.y>=65&&p.x<=r.width-90&&p.y<=r.height-100;
    });
    if(!candidates.length)throw new Error('No exposed '+scenario.kind+' handle in the measured viewport.');
    const ranked=candidates.map(h=>({h,descendants:h.joint<0?0:descendants(h)}));
    ranked.sort((a,b)=>scenario.kind==='leaf'?a.descendants-b.descendants:scenario.kind==='root'?b.h.uid-a.h.uid:b.descendants-a.descendants);
    if(prior){const index=ranked.findIndex(({h})=>h.uid===prior.uid&&h.joint===prior.joint);if(index>0)ranked.unshift(...ranked.splice(index,1));}
    // Probe ranked candidates until one is exposed; scanning every candidate
    // against every handle makes the benchmark's setup quadratic at 5x size.
    const chosen=ranked.find(({h})=>{const hit=pickCanvasHandle(g,h.point,{...options,handles,project});return hit?.uid===h.uid&&hit.joint===h.joint;});
    if(!chosen)throw new Error('No exposed '+scenario.kind+' handle in the measured viewport.');
    const {h,descendants:count}=chosen,p=project(h.point);
    return {uid:h.uid,joint:h.joint,id:h.id,descendants:count,static:h.static,handleCount:handles.length,world:{...h.point},x:r.left+p.x,y:r.top+p.y,figureSegments:h.g.segments.length};
  },{scenario,prior});
}

async function state(page){
  return page.evaluate(()=>({revision:styk.editor.revision,frameIndex:styk.editor.frameIndex,selected:[...styk.editor.selectedUids],historyBytes:styk.editor.historySize,
    objects:styk.editor.frame.objects.map(o=>({uid:o.unique_id,root:[o.root_x,o.root_y],scale:o.scale,angles:[...o.angles||[]],lengths:[...o.lengths||[]],bends:[...o.bends||[]]})),
    definitions:styk.editor.report.figure_types.map(f=>({id:f.figure_type_id,segments:f.segments.map(s=>[s.length,s.angle_rad,s.bend_rad])}))}));
}

function changes(before,after){
  const a=new Map(before.objects.map(o=>[o.uid,o]));
  return {objects:after.objects.filter(o=>JSON.stringify(o)!==JSON.stringify(a.get(o.uid))).length,
    roots:after.objects.filter(o=>JSON.stringify(o.root)!==JSON.stringify(a.get(o.uid)?.root)).length,
    angles:after.objects.reduce((n,o)=>n+o.angles.filter((v,i)=>v!==a.get(o.uid)?.angles[i]).length,0),
    definitions:after.definitions.filter((f,i)=>JSON.stringify(f)!==JSON.stringify(before.definitions[i])).length};
}

function summary(data){
  const inputs=new Map(data.inputs.map(i=>[i.id,i])),seen=new Set(),latencies=[];
  for(const f of data.frames)if(!seen.has(f.inputId)&&inputs.has(f.inputId)){
    seen.add(f.inputId);const input=inputs.get(f.inputId);latencies.push({type:input.type,part:input.part,ms:f.at-input.at,fromEventMs:f.at-input.eventAt});
  }
  const parts={};
  for(const part of ['hover','down','first-move','motion','up','settle','undo','redo','cancel']){
    const ii=data.inputs.filter(i=>i.part===part),ff=data.frames.filter(f=>f.part===part),ll=latencies.filter(i=>i.part===part);
    parts[part]={inputs:ii.length,renderedInputs:ll.length,handlerMs:quantiles(ii.map(i=>i.handlerMs).filter(Number.isFinite)),dispatchDelayMs:quantiles(ii.map(i=>i.at-i.eventAt).filter(v=>v>=0&&v<10000)),
      eventToRenderMs:quantiles(ll.map(i=>i.ms)),dispatchToRenderMs:quantiles(ll.map(i=>i.fromEventMs)),frameCpuMs:quantiles(ff.map(f=>f.cpuMs)),renderCount:ff.length,
      rafMs:quantiles(data.raf.filter(v=>v.part===part).map(v=>v.ms))};
  }
  const methods={};for(const c of data.calls)(methods[c.name]??=[]).push(c.ms);
  const moveInputs=data.inputs.filter(i=>['motion','first-move'].includes(i.part));
  const insideTask=v=>v.at>=data.start&&v.at<data.end;
  return {parts,methods:Object.fromEntries(Object.entries(methods).map(([k,v])=>[k,quantiles(v)])),longTasks:quantiles(data.longTasks.filter(insideTask).map(v=>v.ms)),
    excludedLongTasks:data.longTasks.filter(v=>!insideTask(v)),
    motionInputRate:moveInputs.length>1?1000*(moveInputs.length-1)/(moveInputs.at(-1).at-moveInputs[0].at):null,
    maxRasterizedObjects:Math.max(0,...data.frames.map(f=>f.rasterizedObjects||0)),maxUpdatedObjects:Math.max(0,...data.frames.map(f=>f.updatedObjects||0)),
    trustedInputs:data.inputs.every(i=>i.trusted),latencies};
}

export async function benchmarkDrags(page,result,output,{source,cpu=false}){
  // Other tasks can edit the shared workspace. Pin every imported source module
  // to this run's captured bytes, including modules requested by dedicated workers.
  const sourceModules=new Map();
  for(const name of Object.keys(result.sourceHashes))sourceModules.set(name.replaceAll('\\','/'),await readFile(path.join(output,'sources',name)));
  const serveSource=async route=>{const name=new URL(route.request().url()).pathname.slice('/src/'.length),body=sourceModules.get(name);if(body)await route.fulfill({status:200,contentType:name.endsWith('.css')?'text/css; charset=utf-8':'text/javascript; charset=utf-8',body});else await route.continue();};
  await page.context().route('**/src/**',serveSource);
  const filter=process.env.STYK_DRAG_CASES?.split(','),matrix=cases.filter(c=>!filter||filter.includes(c.id));
  if(!matrix.length&&!filter?.includes('controls'))throw new Error('No matching STYK_DRAG_CASES.');
  const trials=Number(process.env.STYK_DRAG_TRIALS)|| (cpu?1:2),repeats=Number(process.env.STYK_DRAG_REPEATS)||3;
  result.dragMethodology={trials,repeats,cpuSampling:cpu,steps:24,paceMs:16,sourcePolicy:'All src/*.mjs modules are served from the captured source snapshot for this run, across document reloads.',
    firstDrag:'First gesture on a newly reloaded/imported document; renderer and handles are already visible. Later trials reuse the Electron process, not its document/worker caches.',
    timings:'Event capture to CPU-complete scene submission includes pose, render, and overlay. Excludes physical scanout. Pointer dispatch-to-handler is reported separately; automation backpressure limits achievable input rate.',
    warmDrag:'Repeated gesture on the same target immediately after the preceding commit, without undo or document reset.',
    source:'The original PIV is never saved. Default autosave may run only in the isolated benchmark profile.'};
  for(const scenario of matrix)for(let trial=1;trial<=trials;trial++){
    const scenarioErrorStart=result.errors.length;
    console.log('DRAG_SETUP',scenario.id,trial);
    await page.evaluate(()=>styk.editor.markSaved());await page.reload();await page.waitForFunction(()=>window.styk?.ready);
    await page.evaluate(()=>styk.editor.markSaved());await page.locator('#file-input').setInputFiles(source);
    await page.waitForFunction(name=>styk.editor.name===name&&!styk.state.importing,path.basename(source,'.piv'),{timeout:180000});
    await scaleBenchmarkScene(page);
    await page.waitForTimeout(200);
    await page.evaluate(s=>{styk.state.tool=s.tool||'select';styk.state.onion=Boolean(s.onion);if(s.selectedOnly)styk.state.settings.showUnselectedHandles=false;if(s.onion)styk.editor.selectFrame(1);if(s.scale)styk.state.view.scale=s.scale;styk.state.dirtyRender=true;window.dispatchEvent(new Event('resize'));},scenario);
    await page.waitForTimeout(350);
    await install(page);
    let target=await locate(page,scenario);
    await page.evaluate(({s,t})=>{
      const e=styk.editor;if(s.group){e.select(t.uid);for(const o of e.frame.objects.filter(o=>o.unique_id!==t.uid).slice(0,s.group-1))e.select(o.unique_id,-1,{add:true});}
      else if(s.selected===false)e.select(e.frame.objects.find(o=>o.unique_id!==t.uid).unique_id);
      else e.select(t.uid);
    },{s:scenario,t:target});await page.waitForTimeout(200);
    target=await locate(page,scenario,target);
    const client=cpu?await page.context().newCDPSession(page):null;
    if(client){await client.send('Profiler.enable');await client.send('Profiler.setSamplingInterval',{interval:1000});}
    for(let repeat=1;repeat<=repeats;repeat++){
      if(scenario.disableOverlayDuringDrag)await page.evaluate(()=>{styk.state.handles=true;window.dispatchEvent(new Event('resize'));});
      if(repeat>1)target=await locate(page,scenario,target);
      const name=`${scenario.id}-trial-${trial}-${repeat===1?'first':`repeat-${repeat-1}`}`,before=await state(page);
      await page.evaluate(()=>{const b=__dragBench;for(const k of ['inputs','frames','calls','raf','longTasks'])b[k]=[];b.started=performance.now();b.active=true;b.part='hover';b.lastInput=null;});
      if(client)await client.send('Profiler.start');
      const checkpoints={};
      if(scenario.frameChange&&repeat===1)await page.evaluate(()=>styk.editor.selectFrame((styk.editor.frameIndex+1)%4));
      await page.mouse.move(target.x,target.y);await page.waitForTimeout(40);
      await page.evaluate(()=>__dragBench.part='down');
      if(scenario.modifier)await page.keyboard.down(scenario.modifier);
      await page.mouse.down({button:scenario.button||'left'});
      const picked=await page.evaluate(()=>({kind:styk.state.drag?.kind,uid:styk.editor.selectedUid,joint:styk.editor.selectedJoint,selected:[...styk.editor.selectedUids],affected:styk.editor._drag?.before?.length}));
      const expected=scenario.expected||(scenario.kind==='root'?'move':'pose');
      if(picked.kind!==expected||picked.uid!==target.uid||picked.joint!==target.joint){
        await writeFile(path.join(output,`${name}-target-failure.json`),JSON.stringify({picked,target,expected,actual:await page.evaluate(()=>({inputs:__dragBench.inputs,view:styk.state.view,viewport:document.querySelector('#viewport').getBoundingClientRect().toJSON()}))},null,2));
        throw new Error(`Wrong target for ${name}: ${JSON.stringify({picked,target,expected})}`);
      }
      await page.waitForTimeout(40);
      if(scenario.disableOverlayDuringDrag)await page.evaluate(()=>{styk.state.handles=false;});
      const direction=repeat%2?1:-1,steps=scenario.steps||24;
      for(let step=1;step<=steps;step++){
        if(step===1||step===2)await page.evaluate(part=>__dragBench.part=part,step===1?'first-move':'motion');
        await page.mouse.move(target.x+direction*step*1.1,target.y+direction*(step*.6+Math.sin(step/4)*2));
        if(step===1)await page.waitForTimeout(50);else if(scenario.pace!==0)await page.waitForTimeout(scenario.pace||16);
      }
      checkpoints.motionEnd=await page.evaluate(()=>performance.now());
      await page.evaluate(()=>__dragBench.part='up');await page.mouse.up({button:scenario.button||'left'});
      if(scenario.modifier)await page.keyboard.up(scenario.modifier);
      // A rig commit can take longer than a fixed 300 ms observation window.
      // Require its release render so a missing slow sample cannot look faster.
      await page.waitForFunction(()=>{const b=__dragBench,up=b.inputs.findLast(i=>i.type==='pointerup');return up&&b.frames.some(f=>f.at>=up.at);},null,{timeout:5000});
      // Include the first release render in 'up', then separately observe deferred work.
      await page.waitForTimeout(80);await page.evaluate(()=>__dragBench.part='settle');await page.waitForTimeout(220);
      if(client){const {profile}=await client.send('Profiler.stop');await writeFile(path.join(output,`${name}.cpuprofile`),JSON.stringify(profile));}
      const data=await page.evaluate(()=>{const b=__dragBench;b.active=false;return{start:b.started,end:performance.now(),inputs:b.inputs,frames:b.frames,calls:b.calls,raf:b.raf,longTasks:b.longTasks,heapBytes:performance.memory?.usedJSHeapSize,renderer:structuredClone(styk.state.renderer.stats)};});
      const after=await state(page),changed=changes(before,after);
      if(!changed.objects&&!changed.definitions)throw new Error(`${name} did not edit the document.`);
      if(scenario.group&&changed.roots!==scenario.group)throw new Error(`${name} moved ${changed.roots} roots instead of ${scenario.group}.`);
      const row={name,scenario:scenario.id,trial,repeat,frameIndex:after.frameIndex,target,picked,changed,historyBytes:after.historyBytes-before.historyBytes,wallMs:data.end-data.start,
        applicationErrors:[...new Set(result.errors.slice(scenarioErrorStart))],renderingFailed:!data.frames.length,...summary(data)};
      result.phases.push(row);await writeFile(path.join(output,`${name}.json`),JSON.stringify({row,checkpoints,...data},null,2));
      await writeFile(path.join(output,'report.json'),JSON.stringify(result,null,2));
      console.log('DRAG_RESULT',JSON.stringify({name,changed,down:row.parts.down.handlerMs.max,first:row.parts['first-move'].eventToRenderMs.max,motion95:row.parts.motion.eventToRenderMs.p95,frame95:row.parts.motion.frameCpuMs.p95,up:row.parts.up.eventToRenderMs.max,long:row.longTasks.max,rate:row.motionInputRate}));
      if(repeat===1)await page.screenshot({path:path.join(output,`${scenario.id}-trial-${trial}.png`)});
    }
    await client?.detach();
  }
  if(filter?.includes('controls')){
    await page.evaluate(()=>styk.editor.markSaved());await page.reload();await page.waitForFunction(()=>window.styk?.ready);
    await page.evaluate(()=>styk.editor.markSaved());await page.locator('#file-input').setInputFiles(source);
    await page.waitForFunction(name=>styk.editor.name===name&&!styk.state.importing,path.basename(source,'.piv'),{timeout:180000});
    await scaleBenchmarkScene(page);
    await page.waitForTimeout(400);
    await benchmarkControls(page,result,output,{cpu});
  }
  await page.context().unroute('**/src/**',serveSource);
  if(result.errors.length)throw new Error(`${result.errors.length} application errors: ${[...new Set(result.errors)].join('; ')}`);
}

async function benchmarkControls(page,result,output,{cpu}){
  await install(page);
  const client=cpu?await page.context().newCDPSession(page):null;
  if(client){await client.send('Profiler.enable');await client.send('Profiler.setSamplingInterval',{interval:1000});}
  const viewport=await page.locator('#viewport').boundingBox();
  async function record(name,action){
    const before=await state(page);
    await page.evaluate(()=>{const b=__dragBench;for(const k of ['inputs','frames','calls','raf','longTasks'])b[k]=[];b.started=performance.now();b.active=true;b.part='motion';b.lastInput=null;});
    if(client)await client.send('Profiler.start');
    const actionResult=await action();await page.waitForTimeout(250);
    if(client){const {profile}=await client.send('Profiler.stop');await writeFile(path.join(output,`${name}.cpuprofile`),JSON.stringify(profile));}
    const data=await page.evaluate(()=>{const b=__dragBench;b.active=false;return{start:b.started,end:performance.now(),inputs:b.inputs,frames:b.frames,calls:b.calls,raf:b.raf,longTasks:b.longTasks};});
    const after=await state(page),row={name,scenario:name,changed:changes(before,after),actionResult,wallMs:data.end-data.start,...summary(data)};
    result.phases.push(row);await writeFile(path.join(output,`${name}.json`),JSON.stringify({row,...data},null,2));await writeFile(path.join(output,'report.json'),JSON.stringify(result,null,2));
    console.log('CONTROL_RESULT',JSON.stringify({name,changed:row.changed,handler:row.parts.motion.handlerMs,event95:row.parts.motion.eventToRenderMs.p95,long:row.longTasks,actionResult}));
    return{before,after,row};
  }
  for(const area of ['empty','dense'])await record(`hover-${area}`,async()=>{
    for(let i=0;i<60;i++)await page.mouse.move(viewport.x+(area==='empty'?25+(i%5)*4:viewport.width*.45+(i%10)*24),viewport.y+(area==='empty'?25+(i%4)*4:viewport.height*.35+Math.floor(i/10)*24));
  });
  for(let repeat=1;repeat<=3;repeat++)await record(`pan-middle-drag-${repeat}`,async()=>{
    const before=await page.evaluate(()=>({...styk.state.view}));
    const x=viewport.x+viewport.width*.5,y=viewport.y+viewport.height*.5;
    await page.mouse.move(x,y);await page.mouse.down({button:'middle'});
    if(await page.evaluate(()=>styk.state.drag?.kind)!=='pan')throw new Error('Middle drag did not start panning.');
    for(let i=1;i<=24;i++){await page.mouse.move(x+i*2,y+i);await page.waitForTimeout(16);}
    await page.mouse.up({button:'middle'});const after=await page.evaluate(()=>({...styk.state.view}));
    if(before.x===after.x&&before.y===after.y)throw new Error('Pan did not move the view.');return{before,after};
  });
  await page.evaluate(()=>styk.fit());await page.waitForTimeout(200);
  for(const zoom of [false,true])await record(zoom?'zoom-wheel-cross-100pct':'pan-wheel',async()=>{
    const before=await page.evaluate(()=>({...styk.state.view}));
    await page.mouse.move(viewport.x+viewport.width*.5,viewport.y+viewport.height*.5);
    if(zoom)await page.keyboard.down('Control');
    for(let i=0;i<12;i++){await page.mouse.wheel(0,zoom?-12:8);await page.waitForTimeout(30);}
    if(zoom)await page.keyboard.up('Control');const after=await page.evaluate(()=>({...styk.state.view}));
    if(zoom?before.scale===after.scale:before.y===after.y)throw new Error('Wheel did not change the view.');return{before,after};
  });
  await page.evaluate(()=>styk.fit());await page.waitForTimeout(200);
  await record('marquee-select-all',async()=>{
    await page.mouse.move(viewport.x+25,viewport.y+45);await page.mouse.down();
    const kind=await page.evaluate(()=>styk.state.drag?.kind);if(kind!=='marquee')throw new Error('Marquee start unexpectedly hit a figure.');
    for(let i=1;i<=24;i++)await page.mouse.move(viewport.x+25+(viewport.width-65)*i/24,viewport.y+45+(viewport.height-90)*i/24);
    await page.mouse.up();const selected=await page.evaluate(()=>styk.editor.selectedUids.size);
    if(selected!==60)throw new Error(`Marquee selected ${selected} figures instead of 60.`);return{selected};
  });
  // Body picking deliberately bypasses visible handle hit-testing. The point is a
  // visible filled polygon, chosen from scene geometry; the actual picked UID is asserted.
  await page.evaluate(()=>{styk.editor.select(null);styk.state.handles=false;styk.fit();});await page.waitForTimeout(200);
  const body=await page.evaluate(()=>{
    const e=styk.editor,v=styk.state.view,r=document.querySelector('#viewport').getBoundingClientRect();
    const objects=[...e.geometry.objects.values()].reverse();
    for(const g of objects){
      const p=g.polys.find(p=>p.points.length===3&&Math.abs((p.points[1].x-p.points[0].x)*(p.points[2].y-p.points[0].y)-(p.points[1].y-p.points[0].y)*(p.points[2].x-p.points[0].x))>40);
      if(!p)continue;const world={x:p.points.reduce((n,q)=>n+q.x,0)/3,y:p.points.reduce((n,q)=>n+q.y,0)/3};
      const point={x:r.left+v.x+world.x*v.scale,y:r.top+v.y+world.y*v.scale};
      if(point.x>r.left+60&&point.x<r.right-60&&point.y>r.top+50&&point.y<r.bottom-80)return{...point,uid:g.obj.unique_id};
    }
    throw new Error('No visible filled triangle for body picking.');
  });
  await record('figure-body-pick-and-drag',async()=>{
    await page.mouse.move(body.x,body.y);await page.mouse.down();const picked=await page.evaluate(()=>({uid:styk.editor.selectedUid,kind:styk.state.drag?.kind}));
    if(picked.kind!=='move')throw new Error(`Body hit was not a translation: ${JSON.stringify(picked)}`);
    for(let i=1;i<=24;i++)await page.mouse.move(body.x+i,body.y-i*.5);
    await page.mouse.up();return{picked,plannedUid:body.uid};
  });
  await page.evaluate(()=>{styk.state.handles=true;styk.fit();});await page.waitForTimeout(200);
  const target=await locate(page,{kind:'branch'});await page.evaluate(uid=>styk.editor.select(uid),target.uid);await page.waitForTimeout(150);
  const cancelled=await record('joint-drag-escape-cancel',async()=>{
    await page.mouse.move(target.x,target.y);await page.mouse.down();
    if(await page.evaluate(()=>styk.state.drag?.kind)!=='pose')throw new Error('Cancellation did not start a pose gesture.');
    for(let i=1;i<=12;i++)await page.mouse.move(target.x+i,target.y+i*.6);
    await page.evaluate(()=>__dragBench.part='cancel');await page.keyboard.press('Escape');await page.mouse.up();
    return{dragCleared:await page.evaluate(()=>!styk.state.drag&&!styk.editor._drag)};
  });
  if(cancelled.row.changed.objects||cancelled.row.changed.definitions||!cancelled.row.actionResult.dragCleared)throw new Error('Escape did not restore the pre-drag document.');
  // A committed body translation above provides an undo/redo pair.
  const expected=await state(page);
  for(let i=1;i<=3;i++){
    await record(`undo-drag-${i}`,async()=>{await page.evaluate(()=>__dragBench.part='undo');await page.keyboard.press('Control+z');});
    await record(`redo-drag-${i}`,async()=>{await page.evaluate(()=>__dragBench.part='redo');await page.keyboard.press('Control+Shift+z');});
    if(changes(expected,await state(page)).objects)throw new Error('Redo did not restore the committed pose.');
  }
  await page.screenshot({path:path.join(output,'controls-final.png')});await client?.detach();
}
