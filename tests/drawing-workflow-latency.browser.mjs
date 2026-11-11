// Animation-workflow latency for drawing layers: frame flips (warm and cold),
// scrubbing at 24 fps, undo/redo of a large stroke and fill. The fixture is a
// 24-frame 1080p line-art animation at 2× resolution. Each cel carries a
// unique marker colour so the benchmark detects when that cel is actually on
// screen: after each app render it reads back one marker pixel. Timings run
// from the command to that render; display scanout is excluded.
import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';

const output=process.env.STYK_WORKFLOW_ARTIFACTS||'artifacts/drawing-workflow',label=process.env.STYK_WORKFLOW_LABEL||'current';
const url=process.env.STYK_URL||'http://127.0.0.1:47839',software=process.env.STYK_WORKFLOW_SOFTWARE==='1',frames=Number(process.env.STYK_WORKFLOW_FRAMES||24);
await mkdir(output,{recursive:true});
const percentile=(values,p)=>{if(!values.length)return null;const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.min(sorted.length-1,Math.floor(p*sorted.length))];};
const summary=values=>({count:values.length,p50:percentile(values,.5),p95:percentile(values,.95),max:values.length?Math.max(...values):null});
const browser=await chromium.launch({channel:'chrome',headless:true});
const errors=[];let result;
try{
  {const warm=await browser.newPage();await warm.goto(url);await warm.waitForFunction(()=>window.styk?.ready);await warm.close();}
  const page=await browser.newPage({viewport:{width:1440,height:1000}});
  page.on('pageerror',error=>errors.push(error.message));
  if(software)await page.addInitScript(()=>Object.defineProperty(navigator,'gpu',{value:undefined}));
  await page.goto(url);await page.waitForFunction(()=>window.styk?.ready);
  await page.locator('[data-workspace-mode="draw"]').click();
  const setup=await page.evaluate(async frames=>{
    const {emptyDocument}=await import('/src/demo.mjs'),{DrawingStroke}=await import('/tests/support/sketch-stroke.mjs'),{TileStore}=await import('/src/drawing-tiles.mjs');
    const e=styk.editor,d=styk.drawing,report=emptyDocument();report.canvas_width=1920;report.canvas_height=1080;
    e.load(report);d.bind();const layer=e.createDrawingLayer();styk.state.settings.autosaveSeconds=0;
    let seed=7;const random=()=>((seed=Math.imul(seed^seed>>>15,2246822519)+0x6D2B79F5>>>0)/4294967296);
    const started=performance.now(),tileCounts=[];
    for(let f=0;f<frames;f++){
      if(f)e.drawingKey([layer.id],f,{blank:true});e.seek(f);
      const target=e.prepareDrawingCel({pixelsPerUnit:2,world:{x:0,y:0}});await d.owner.surface(target.figure);
      const store=new TileStore();
      // Line art: twenty-five pressure strokes across the stage.
      for(let s=0;s<25;s++){
        const stroke=new DrawingStroke(store,{size:4+random()*8,color:[20+f*3,30,40],pressureSize:true,spacingRatio:.1,seed:s});
        let x=random()*3840,y=random()*2160,a=random()*6.3;
        for(let i=0;i<160;i++){a+=(random()-.5)*.5;x+=Math.cos(a)*14;y+=Math.sin(a)*14;stroke.sample({x,y,pressure:.3+.7*Math.abs(Math.sin(i/20)),time:i});}
        stroke.finish();
      }
      // A marker square whose colour identifies the frame.
      const marker=new Uint8ClampedArray([255,f*10,255-f*10,255]);for(let ty=1;ty<3;ty++)for(let tx=1;tx<3;tx++)store.set(tx,ty,marker);
      const tiles=[...store].map(t=>({tx:t.tx,ty:t.ty,before:null,after:t.pixels}));tileCounts.push(tiles.length);
      e.commitDrawingPixels(target,tiles,'Fixture');
      // Publish as editing would, so earlier cels become evictable.
      await d.owner.flush();
    }
    await d.owner.flush();e.seek(0);styk.fit();d.onRender();
    return {setupMs:performance.now()-started,tileCounts,layer:layer.id};
  },frames);
  await page.waitForTimeout(1500);
  // The marker sits at cel pixel 128,128, world 64,64 at 2×.
  await page.evaluate(async()=>{
    const {worldToScreen}=await import('/src/renderer-geometry.mjs');
    const scene=document.querySelector('#scene'),probe=new OffscreenCanvas(1,1),ctx=probe.getContext('2d',{willReadFrequently:true}),renderer=styk.state.renderer;
    const bench=window.workflowBench={waiters:[],renders:0};
    const markerScreen=()=>{const p=worldToScreen({x:64,y:64},{report:styk.editor.report,frame:styk.editor.evaluatedFrame,view:styk.state.view,cameraEnabled:false}),r=scene.getBoundingClientRect(),v=document.querySelector('#viewport').getBoundingClientRect();return{x:Math.round((p.x+v.left-r.left)*scene.width/r.width),y:Math.round((p.y+v.top-r.top)*scene.height/r.height)};};
    const inspect=()=>{bench.renders++;if(!bench.waiters.length)return;const m=markerScreen();ctx.clearRect(0,0,1,1);ctx.drawImage(scene,m.x,m.y,1,1,0,0,1,1);const c=ctx.getImageData(0,0,1,1).data,now=performance.now();
      bench.waiters=bench.waiters.filter(w=>{if(w.test(c)){w.resolve(now);return false;}if(now-w.start>10000){w.resolve(null);return false;}return true;});};
    for(const name of ['render','renderPrepared']){const original=renderer[name];if(!original)continue;renderer[name]=function(...args){const value=original.apply(this,args);inspect();return value;};}
    // Resolve with the render time at which the marker shows frame f.
    bench.until=(f,start=performance.now())=>new Promise(resolve=>{bench.waiters.push({start,test:c=>c[0]>200&&Math.abs(c[1]-f*10)<=3&&Math.abs(c[2]-(255-f*10))<=3,resolve:t=>resolve(t===null?null:t-start)});styk.drawing.onRender();});
  });
  const flip=async order=>page.evaluate(async order=>{const times=[];for(const f of order){const start=performance.now();styk.editor.seek(f);times.push(await workflowBench.until(f,start));}return times;},order);
  const all=[...Array(frames).keys()];
  const firstPass=await flip(all.slice(1));
  const warmPass=await flip(all);
  // Cold: memory pressure evicts every published store before each flip.
  const cold=await page.evaluate(async frames=>{const d=styk.drawing,times=[];await d.owner.flush();
    for(let f=0;f<frames;f++){d.owner.reserve(d.owner.tileBudget);
      const start=performance.now();styk.editor.seek(f);times.push(await workflowBench.until(f,start));}return times;},frames);
  // Scrub at 24 fps for two passes; count frames shown before the next seek.
  const scrub=await page.evaluate(async frames=>{const shown=[];for(let pass=0;pass<2;pass++)for(let f=0;f<frames;f++){const start=performance.now();styk.editor.seek(f);const t=await Promise.race([workflowBench.until(f,start),new Promise(r=>setTimeout(()=>r(null),1000/24))]);shown.push(t);if(t!==null)await new Promise(r=>setTimeout(r,Math.max(0,1000/24-t)));}return shown;},frames);
  // Undo/redo of a 300 px stroke across frame 0.
  await page.evaluate(()=>{styk.editor.seek(0);Object.assign(styk.drawing.settings,{size:300,hardness:.6,opacity:1,flow:1,color:'#10a040',pressureSize:false,stabilization:0});});
  await page.waitForTimeout(300);
  const box=await page.locator('#viewport').boundingBox();
  await page.mouse.move(box.x+250,box.y+250);await page.mouse.down();for(let i=1;i<=60;i++)await page.mouse.move(box.x+250+i*12,box.y+250+Math.sin(i/8)*120);await page.mouse.up();
  await page.waitForFunction(()=>!styk.drawing.gesture&&!styk.drawing.operation,null,{timeout:60000});
  const history=await page.evaluate(async()=>{const d=styk.drawing,times={};for(const direction of ['undo','redo','undo','redo']){const start=performance.now();await d.history(direction);await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));(times[direction]??=[]).push(performance.now()-start);}return times;});
  // Fill the stage background of frame 1 (reaches most of the cel).
  await page.evaluate(()=>{styk.editor.seek(1);styk.drawing.setTool('fill');Object.assign(styk.drawing.settings,{color:'#f0e0a0',tolerance:16,gap:0,expansion:1,sampleAll:false});});
  await page.waitForTimeout(500);
  const fillStart=Date.now();await page.mouse.click(box.x+box.width*.5,box.y+box.height*.55);
  // A build that drops a click released while its cel loads never fills: null.
  const fillMs=await page.waitForFunction(()=>!styk.drawing.gesture&&!styk.drawing.operation&&styk.editor.undoLabel?.toLowerCase().includes('fill'),null,{timeout:20000}).then(()=>Date.now()-fillStart,()=>null);
  // Cold edit: after showing frame 3, memory pressure evicts every published
  // cel; a fill click there must first reopen the cel for editing.
  await page.evaluate(async()=>{await styk.drawing.owner.flush();styk.editor.seek(3);});
  await page.evaluate(()=>workflowBench.until(3));
  const coldCount=await page.evaluate(()=>{styk.drawing.owner.reserve(styk.drawing.owner.tileBudget);return styk.editor._undo.length;});
  const coldEditStart=Date.now();await page.mouse.click(box.x+box.width*.5,box.y+box.height*.55);
  // Builds that drop a click released during loading never commit: null.
  const coldEditMs=await page.waitForFunction(count=>styk.editor._undo.length===count+1&&!styk.drawing.operation,coldCount,{timeout:15000}).then(()=>Date.now()-coldEditStart,()=>null);
  const clean=v=>v.filter(t=>t!==null);
  result={label,backend:await page.evaluate(()=>styk.state.renderer.stats.backend),setup,
    firstFlipMs:summary(clean(firstPass)),warmFlipMs:summary(clean(warmPass)),coldFlipMs:summary(clean(cold)),coldMissing:cold.filter(t=>t===null).length,
    scrub:{frames:scrub.length,shownInTime:clean(scrub).length/scrub.length,shownMs:summary(clean(scrub))},
    undoMs:summary(history.undo),redoMs:summary(history.redo),fillMs,coldEditMs,errors};
  console.log(JSON.stringify({...result,setup:undefined}));
  await page.screenshot({path:`${output}/${label}${software?'-software':''}.png`});
  assert.deepEqual(errors,[]);
}finally{
  if(result)await writeFile(`${output}/${label}${software?'-software':''}.json`,JSON.stringify({date:new Date().toISOString(),browser:browser.version(),software,frames,method:'Chrome headless 1440x1000. 24-frame 1920x1080 drawing layer at 2x, twenty-five pressure strokes per cel plus a per-frame marker colour. After each app render one marker pixel is read back; times run from the command to the first render showing that frame. Cold flips first evict every published CPU store through the memory-pressure path. Scrubbing seeks every 1/24 s and counts frames shown before the next seek. Undo/redo time runs from the command through two animation frames. Fill runs from the click until the fill command commits. Cold edit evicts every published cel through the memory-pressure path, then times a fill click on a frame that was just displayed.',result},null,2));
  await browser.close();
}
