// Input-to-frame latency benchmark for live drawing. Pointer input travels
// through Chrome's real input pipeline (DevTools Input domain), so frame
// alignment and coalescing match ordinary mouse input. After every app render
// the benchmark reads a small canvas region around the oldest unconfirmed
// samples; a sample is visible once its dab centre shows the brush colour.
// Latency is measured from the event timestamp to the render that first shows
// it. Display scanout and physical pen latency are outside this measurement.
import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';

const output=process.env.STYK_LATENCY_ARTIFACTS||'artifacts/drawing-latency',label=process.env.STYK_LATENCY_LABEL||'current';
const url=process.env.STYK_URL||'http://127.0.0.1:47839',software=process.env.STYK_LATENCY_SOFTWARE==='1';
const only=process.env.STYK_LATENCY_SCENARIOS?.split(',');
const hz=Number(process.env.STYK_LATENCY_HZ||240),duration=Number(process.env.STYK_LATENCY_MS||4000);
await mkdir(output,{recursive:true});

export const SCENARIOS=[
  {id:'blank-small',brush:{size:8,hardness:1},stage:[1920,1080],resolution:2},
  {id:'dense-medium',brush:{size:48,hardness:1},stage:[1920,1080],resolution:2,dense:true},
  {id:'dense-large',brush:{size:300,hardness:.5},stage:[1920,1080],resolution:2,dense:true},
  {id:'dense-zoomed-out',brush:{size:48,hardness:1},stage:[3840,2160],resolution:2,dense:true,zoom:.25},
  {id:'scene-500',brush:{size:8,hardness:1},stage:[1920,1080],resolution:2,figures:500},
  // Every preset at its own tip on the dense cel, and again at a large size.
  ...['ink','brushpen','pencil','soft','marker','calligraphy','airbrush','charcoal','chalk','drybrush','sponge','liner','oil'].flatMap(preset=>[
    {id:`preset-${preset}`,preset,brush:{},stage:[1920,1080],resolution:2,dense:true},
    {id:`preset-${preset}-large`,preset,brush:{size:160},stage:[1920,1080],resolution:2,dense:true}]),
  // Extra scenarios as JSON, e.g. STYK_LATENCY_EXTRA='[{"id":"hard-400","brush":{"size":400,"hardness":1},"stage":[1920,1080],"resolution":2,"dense":true}]'
  ...JSON.parse(process.env.STYK_LATENCY_EXTRA||'[]'),
].filter(s=>!only||only.includes(s.id));

const percentile=(values,p)=>{if(!values.length)return null;const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.min(sorted.length-1,Math.floor(p*sorted.length))];};
const summary=values=>({count:values.length,p50:percentile(values,.5),p95:percentile(values,.95),p99:percentile(values,.99),max:values.length?Math.max(...values):null});

const browser=await chromium.launch({channel:'chrome',headless:true});
const results=[];
try{
  // The first page of a fresh browser process pays one-time startup costs;
  // load and discard one so every scenario measures a warm process.
  {const warm=await browser.newPage({viewport:{width:1440,height:1000}});if(software)await warm.addInitScript(()=>Object.defineProperty(navigator,'gpu',{value:undefined}));await warm.goto(url);await warm.waitForFunction(()=>window.styk?.ready);await warm.close();}
  for(const scenario of SCENARIOS){
    const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
    page.on('pageerror',error=>errors.push(error.message));page.on('console',m=>{if(['error','warning'].includes(m.type()))console.error('console',m.type(),m.text().slice(0,400));});
    if(software)await page.addInitScript(()=>Object.defineProperty(navigator,'gpu',{value:undefined}));
    await page.goto(url);await page.waitForFunction(()=>window.styk?.ready);
    await page.locator('[data-workspace-mode="draw"]').click();
    await page.evaluate(async scenario=>{
      const {emptyDocument,createObject,createFrame}=await import('/src/demo.mjs');
      const e=styk.editor,d=styk.drawing,report=emptyDocument();
      [report.canvas_width,report.canvas_height]=scenario.stage;
      if(scenario.figures)report.keyframes=[createFrame(Array.from({length:scenario.figures},(_,i)=>createObject(report.figure_types[0],i+1,(i%25)*70,Math.floor(i/25)*50,{scale:.3})))];
      e.load(report);d.bind();e.createDrawingLayer();styk.state.settings.autosaveSeconds=0;
      if(scenario.preset){const {BRUSH_PRESETS}=await import('/src/drawing-view.mjs'),{id,name,description,...tip}=BRUSH_PRESETS.find(p=>p.id===scenario.preset);Object.assign(d.settings,tip,{preset:id,resolution:scenario.resolution,color:'#ff00ff',colorRate:1,...scenario.brush});}
      else Object.assign(d.settings,{resolution:scenario.resolution,stabilization:0,opacity:1,flow:1,pressureSize:false,pressureOpacity:false,texture:0,color:'#ff00ff',...scenario.brush});
      if(scenario.dense){
        // A textured opaque cel covering the whole stage: every tile is unique.
        const target=e.prepareDrawingCel({pixelsPerUnit:scenario.resolution,world:{x:0,y:0}});await d.owner.surface(target.figure);
        const columns=Math.ceil(scenario.stage[0]*scenario.resolution/64),rows=Math.ceil(scenario.stage[1]*scenario.resolution/64),tiles=[];
        for(let ty=0;ty<rows;ty++)for(let tx=0;tx<columns;tx++){const after=new Uint8ClampedArray(64*64*4);for(let i=0;i<after.length;i+=4){const n=(i>>2)*2654435761+tx*97+ty*131>>>0;after[i]=40+(tx*5&63)+(n&7);after[i+1]=120+(ty*3&63)+(n>>8&7);after[i+2]=60+(n>>16&7);after[i+3]=255;}tiles.push({tx,ty,before:null,after});}
        e.commitDrawingPixels(target,tiles,'Fixture');
        await styk.drawing.owner.flush();
      }
      styk.fit();
      if(scenario.zoom)Object.assign(styk.state.view,{scale:scenario.zoom,x:40,y:40});
      d.onRender();
    },scenario);
    await page.waitForTimeout(1500);
    const box=await page.locator('#viewport').boundingBox();
    // Warm workers, shaders and caches with a short stroke, then undo it so
    // the measured stroke reflects steady-state drawing.
    await page.mouse.move(box.x+box.width-260,box.y+box.height-200);await page.mouse.down();
    for(let i=1;i<=20;i++)await page.mouse.move(box.x+box.width-260+i*3,box.y+box.height-200+i);
    await page.mouse.up();await page.waitForFunction(()=>!styk.drawing.gesture&&!styk.drawing.operation,null,{timeout:60000});
    await page.evaluate(async()=>{await styk.editor.undo();await styk.drawing.owner.flush();});await page.waitForTimeout(500);
    // Probe the whole stroke region every frame so a sample that never paints
    // its centre cannot delay the detection of later samples.
    const region={left:box.x+200,top:box.y+120,width:Math.min(860,box.width-400),height:Math.min(640,box.height-240)};
    await page.evaluate(({region})=>{
      const scene=document.querySelector('#scene'),probe=new OffscreenCanvas(1,1),ctx=probe.getContext('2d',{willReadFrequently:true});
      const bench=window.latencyBench={samples:[],pending:[],frames:[],longTasks:[],renders:0,probes:0,running:true};
      bench.observer=new PerformanceObserver(list=>{for(const entry of list.getEntries()){bench.longTasks.push(entry.duration);(bench.longTaskStarts??=[]).push(Math.round(entry.startTime-(bench.samples[0]?.time??entry.startTime)));}});bench.observer.observe({entryTypes:['longtask']});
      const record=event=>{if(!bench.running||!(event.buttons&1))return;for(const sample of event.getCoalescedEvents?.().length?event.getCoalescedEvents():[event]){const s={x:sample.clientX,y:sample.clientY,time:sample.timeStamp,latency:null};bench.samples.push(s);bench.pending.push(s);}};
      addEventListener('pointermove',record,{capture:true});bench.stopRecording=()=>removeEventListener('pointermove',record,{capture:true});
      const tick=time=>{if(!bench.running)return;if(bench.lastFrame)bench.frames.push(time-bench.lastFrame);bench.lastFrame=time;requestAnimationFrame(tick);};requestAnimationFrame(tick);
      const renderer=styk.state.renderer,render=renderer.render;
      const inspect=()=>{
        bench.renders++;if(!bench.pending.length)return;
        const now=performance.now(),rect=scene.getBoundingClientRect(),sx=scene.width/rect.width,sy=scene.height/rect.height;
        const x0=Math.max(0,Math.floor((region.left-rect.left)*sx)),y0=Math.max(0,Math.floor((region.top-rect.top)*sy)),w=Math.min(scene.width-x0,Math.ceil(region.width*sx)),h=Math.min(scene.height-y0,Math.ceil(region.height*sy));
        if(probe.width!==w||probe.height!==h){probe.width=w;probe.height=h;}
        ctx.clearRect(0,0,w,h);ctx.drawImage(scene,x0,y0,w,h,0,0,w,h);const bytes=ctx.getImageData(0,0,w,h).data;bench.probes++;
        // Magenta hue test: tolerant of mip filtering and antialiased edges,
        // but never satisfied by the white stage or the green-dominant fixture.
        const magenta=(x,y)=>{if(x<0||y<0||x>=w||y>=h)return false;const i=(y*w+x)*4,r=bytes[i],g=bytes[i+1],b=bytes[i+2];return r>150&&b>150&&g<.6*Math.min(r,b);};
        for(const s of bench.pending){const x=Math.round((s.x-rect.left)*sx)-x0,y=Math.round((s.y-rect.top)*sy)-y0;
          if(magenta(x,y)||magenta(x-1,y)||magenta(x+1,y)||magenta(x,y-1)||magenta(x,y+1))s.latency=now-s.time;}
        bench.pending=bench.pending.filter(s=>s.latency===null&&now-s.time<5000);
      };
      renderer.render=function(...args){const result=render.apply(this,args);if(bench.running)inspect();return result;};
      bench.restore=()=>{renderer.render=render;};
    },{region});
    // A zigzag across the viewport at a fast, steady hand speed.
    const cdp=await page.context().newCDPSession(page),left=box.x+220,top=box.y+140,width=Math.min(820,box.width-440),rows=10,rowHeight=Math.min(60,(box.height-280)/rows);
    const point=t=>{const cycle=(t/duration)*rows,row=Math.min(rows-1,Math.floor(cycle)),u=cycle-row;return{x:left+(row%2?1-u:u)*width,y:top+row*rowHeight+u*rowHeight};};
    const send=(type,p,buttons)=>cdp.send('Input.dispatchMouseEvent',{type,x:p.x,y:p.y,button:'left',buttons,clickCount:type==='mouseMoved'?0:1,pointerType:'mouse'}).catch(()=>{});
    const first=point(0);await send('mouseMoved',first,0);await send('mousePressed',first,1);
    const start=Date.now(),interval=1000/hz;let dispatched=0;
    for(let next=0;next<duration;next+=interval){const wait=start+next-Date.now();if(wait>1)await new Promise(r=>setTimeout(r,wait));send('mouseMoved',point(Math.min(duration,Date.now()-start)),1);dispatched++;}
    await new Promise(r=>setTimeout(r,250));
    const last=point(duration),releaseAt=await page.evaluate(()=>performance.now());await send('mouseReleased',last,0);
    await page.waitForFunction(()=>!styk.drawing.gesture&&!styk.drawing.operation,null,{timeout:60000});
    const measured=await page.evaluate(releaseAt=>{
      const b=window.latencyBench;b.running=false;b.stopRecording();b.restore();b.observer.disconnect();
      const committedMs=performance.now()-releaseAt,latencies=b.samples.map(s=>s.latency).filter(v=>v!==null);
      const r=styk.state.renderer?.stats??{};
      const t0=b.samples[0]?.time??0,timeline=b.samples.filter((s,i)=>i%10===0).map(s=>[Math.round(s.time-t0),s.latency===null?null:Math.round(s.latency)]);
      return{longTaskStarts:b.longTaskStarts??[],timeline,samples:b.samples.length,visible:latencies.length,latencies,frames:b.frames,longTasks:b.longTasks,renders:b.renders,probes:b.probes,committedMs,undo:styk.editor.undoLabel,backend:r.backend,tiles:styk.drawing.owner?.stats.tiles};
    },releaseAt);
    const publishStart=Date.now();await page.evaluate(()=>styk.drawing.owner.flush());const publishedMs=Date.now()-publishStart;
    const result={scenario:scenario.id,label,backend:measured.backend,dispatched,samples:measured.samples,visibleFraction:measured.visible/Math.max(1,measured.samples),
      latencyMs:summary(measured.latencies),withinOneFrame:measured.latencies.filter(v=>v<=1000/60+2).length/Math.max(1,measured.samples),withinTwoFrames:measured.latencies.filter(v=>v<=2000/60+2).length/Math.max(1,measured.samples),
      frameIntervalMs:summary(measured.frames),framesOver25Ms:measured.frames.filter(v=>v>25).length,longTasks:{count:measured.longTasks.length,max:measured.longTasks.length?Math.max(...measured.longTasks):0,durations:measured.longTasks.map(Math.round),startsAfterFirstSampleMs:measured.longTaskStarts},
      releaseToCommitMs:measured.committedMs,timeline:measured.timeline,publishMs:publishedMs,undoLabel:measured.undo,tiles:measured.tiles,renders:measured.renders,errors};
    console.log(JSON.stringify({scenario:result.scenario,backend:result.backend,visible:+result.visibleFraction.toFixed(3),p50:result.latencyMs.p50?.toFixed(1),p95:result.latencyMs.p95?.toFixed(1),p99:result.latencyMs.p99?.toFixed(1),frameP95:result.frameIntervalMs.p95?.toFixed(1),framesOver25:result.framesOver25Ms,longTaskMax:result.longTasks.max,commitMs:Math.round(result.releaseToCommitMs)}));
    results.push(result);
    await page.screenshot({path:`${output}/${label}-${scenario.id}.png`});
    if(process.env.STYK_LATENCY_STRICT!=="0"){    assert.equal(measured.undo,'Brush stroke',`${scenario.id}: the stroke commits as one brush command`);}
    if(process.env.STYK_LATENCY_STRICT!=="0"){    assert.deepEqual(errors,[],`${scenario.id}: no uncaught browser errors`);}
    await cdp.detach();await page.close();
  }
}finally{
  await writeFile(`${output}/${label}${software?'-software':''}.json`,JSON.stringify({label,date:new Date().toISOString(),browser:browser.version(),hz,durationMs:duration,software,method:'Chrome headless at 1440×1000. Mouse input dispatched through the DevTools Input domain at the stated rate follows a 10-row zigzag across the stage. After each app render a small canvas region around the oldest unconfirmed samples is read back; a sample counts as visible when its dab centre shows the opaque brush colour. Latency runs from the event timestamp to that render. Readback costs are included equally for every revision. Scanout, compositor and physical pen latency are excluded.',results},null,2));
  await browser.close();
}
