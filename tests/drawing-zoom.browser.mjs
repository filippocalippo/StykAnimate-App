import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';

const output='artifacts/drawing-zoom',label=process.env.STYK_BENCH_LABEL||'after';
await mkdir(output,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[],results=[];
const figureCount=Number(process.env.STYK_BENCH_FIGURES||0);
if(process.env.STYK_BENCH_BASELINE)for(const name of ['camera-overlay','drawing-controller','drawing-pixels','renderer','vfx-preview']){
  const body=execFileSync('git',['show',`${process.env.STYK_BASELINE_REF||'HEAD'}:src/${name}.mjs`],{encoding:'utf8'});
  await page.route(`**/src/${name}.mjs`,route=>route.fulfill({contentType:'text/javascript',body}));
}
page.on('pageerror',e=>errors.push(e.message));
try{
  await page.goto(process.env.STYK_URL||'http://127.0.0.1:47839');
  await page.waitForFunction(()=>window.styk?.ready);
  assert.ok(await page.locator('#viewport').isVisible());
  await page.locator('[data-workspace-mode="draw"]').click();
  if(process.env.STYK_PROBE_OUTLINE)await page.evaluate(()=>{const ctx=document.querySelector('#overlay').getContext('2d'),stroke=ctx.stroke;ctx.stroke=function(...args){const d=this.getLineDash();if(d.length===2&&d[0]===0&&d[1]===6)return;return stroke.apply(this,args);};});
  for(const zoom of [1,8,32]){
    await page.evaluate(async({zoom,figureCount})=>{
      const {emptyDocument,createObject,createFrame}=await import('/src/demo.mjs');
      const report=emptyDocument();
      if(figureCount)report.keyframes=[createFrame(Array.from({length:figureCount},(_,i)=>createObject(report.figure_types[0],i+1,(i%25)*35,Math.floor(i/25)*25,{scale:.15})))];
      styk.editor.load(report);styk.drawing.bind();styk.editor.createDrawingLayer();
      styk.state.settings.autosaveSeconds=0;
      Object.assign(styk.state.view,{x:0,y:0,scale:zoom,rotation:0});
      Object.assign(styk.drawing.settings,{size:4,stabilization:.95,color:'#d01878'});
      styk.drawing.onRender();
      window.zoomBench={frames:[],renders:[],roundTrips:[],longTasks:[],running:true};
      const b=zoomBench;
      b.observer=new PerformanceObserver(list=>b.longTasks.push(...list.getEntries().map(e=>e.duration)));
      b.observer.observe({entryTypes:['longtask']});
      const tick=t=>{if(!b.running)return;if(b.last)b.frames.push(t-b.last);b.last=t;requestAnimationFrame(tick);};requestAnimationFrame(tick);
      const r=styk.state.renderer;
      if(!r.zoomOriginal){r.zoomOriginal=r.render;r.render=function(...args){const start=performance.now(),result=this.zoomOriginal(...args);if(zoomBench.running)zoomBench.renders.push(performance.now()-start);return result;};}
      const d=styk.drawing;
      const worker=d.owner.strokeWorker,post=worker.post;
      worker.post=function(data,...args){if(data.kind==='begin')zoomBench.brush=data.settings;return post.call(this,data,...args);};
      if(!d.zoomOriginal){d.zoomOriginal=d.strokeMessage;d.strokeMessage=function(data){this.zoomOriginal(data);if(data.kind==='tiles'&&zoomBench.running)zoomBench.roundTrips.push(this.strokeStats.lastRoundTripMs);};}
    },{zoom,figureCount});
    const rect=await page.locator('#viewport').boundingBox();
    await page.mouse.move(rect.x+rect.width*.35,rect.y+rect.height*.4);await page.mouse.down();
    await page.waitForFunction(()=>styk.drawing.gesture?.kind==='stroke');
    await page.mouse.move(rect.x+rect.width*.65,rect.y+rect.height*.6,{steps:180});
    await page.waitForFunction(()=>styk.drawing.gesture.session.outstanding===0&&!styk.drawing.gesture.session.pending.length);
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    const live=await page.evaluate(()=>{
      const r=styk.state.renderer,s=styk.drawing.gesture.surface;
      const matrix=styk.drawing.pixelMatrix(styk.drawing.gesture.target);
      return {backend:r.stats.backend,stamp:s.stamp,smoothingScreenDistance:styk.drawing.gesture.session.settings.pixelsPerUnit*styk.drawing.gesture.session.settings.stabilization*48*Math.hypot(matrix[0],matrix[1])*styk.state.view.scale,
        // The engine's stage draws live ink from the tiles it holds for the cel; its frames carry the stamp they included.
        presented:s.presentedStamp??-1,held:Boolean(r.engineSide?.live.held.includes(styk.drawing.gesture.target.figure._styk.drawing.celId))};
    });
    await page.screenshot({path:`${output}/${label}-${zoom}x-live.png`});
    await page.mouse.up();await page.waitForFunction(()=>!styk.drawing.gesture);
    const metrics=await page.evaluate(async()=>{
      const b=zoomBench;b.running=false;b.observer.disconnect();
      const q=a=>{a.sort((x,y)=>x-y);return {n:a.length,p50:a[Math.floor(a.length*.5)]??0,p95:a[Math.floor(a.length*.95)]??0,max:a.at(-1)??0};};
      const d=styk.drawing,e=styk.editor,target=e.drawingTarget(),store=d.owner.entry(target.figure).store;
      const tiles=[...store].map(t=>({tx:t.tx,ty:t.ty,pixels:Array.from(t.pixels)}));
      e.undo();e.redo();
      const restored=[...d.owner.entry(e.drawingTarget().figure).store].map(t=>({tx:t.tx,ty:t.ty,pixels:Array.from(t.pixels)}));
      await d.barrier();
      return {frames:q(b.frames),renderMs:q(b.renders),workerRoundTripMs:q(b.roundTrips),longTasks:b.longTasks,undoExact:JSON.stringify(tiles)===JSON.stringify(restored),memory:d.owner.stats};
    });
    results.push({zoom,live,...metrics});
    assert.ok(metrics.undoExact,'undo/redo restores zoomed stroke exactly');
    if(!process.env.STYK_BENCH_BASELINE){assert.ok(live.held&&live.presented>=live.stamp,'live ink reaches the stage before pointer release');assert.ok(Math.abs(live.smoothingScreenDistance-45.6)<1e-6,'zoom preserves the smoothing distance on screen');}
  }
  assert.deepEqual(errors,[]);
}finally{
  await writeFile(`${output}/${label}.json`,JSON.stringify({browser:await browser.version(),figureCount,results,errors},null,2));
  console.log(JSON.stringify({results,errors},null,2));await browser.close();
}
