import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
const output=path.resolve(process.env.STYK_TIMELINE_ARTIFACTS||'artifacts/drawing-timeline'),url=process.env.STYK_URL||'http://127.0.0.1:47839';
await mkdir(output,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[],checks=[],workerScripts=[];
page.on('pageerror',error=>errors.push(error.stack));
page.on('workercreated',worker=>workerScripts.push(worker.url));
const check=(name,value)=>{assert.ok(value,name);checks.push(name);console.log('PASS',name);};
try{
  await page.goto(url);await page.waitForFunction(()=>window.styk?.ready);
  await page.evaluate(()=>{styk.state.settings.autosaveSeconds=0;});
  // ── Zero overhead: the default document carries no drawings, so playing,
  // scrubbing, exporting and saving must never construct drawing resources.
  const clean=await page.evaluate(()=>({drawings:styk.editor.report.figure_types.some(f=>f._styk?.drawing),owner:styk.drawingResourcesFor(styk.editor.report)}));
  check('the default document has no drawings and no resource owner',!clean.drawings&&clean.owner===undefined);
  // The default document is a single tick; playback still runs the frame loop.
  await page.locator('#play-button').click();
  await page.waitForFunction(()=>styk.state.playing,{timeout:15000});
  await page.waitForTimeout(300);
  await page.locator('#play-button').click();
  await page.waitForFunction(()=>!styk.state.playing);
  const worked=await page.evaluate(async()=>{
    const {pageExporter}=await import('/tests/support/page-export.mjs'),{DocumentExporter}=await import('/src/document-export.mjs'),e=styk.editor;
    e.seek(3);e.seek(7);e.seek(0);
    const renderer=pageExporter({width:e.report.canvas_width,height:e.report.canvas_height,smoothing:'edges',getRevision:()=>e.revision});
    let rendered=false;
    try{await renderer.load(e.report);await renderer.renderTick(0);rendered=renderer.canvas.width>0;}finally{renderer.dispose();}
    const blob=await new DocumentExporter().export(e.report,{format:'styk',getRevision:()=>e.revision});
    return {rendered,bytes:blob.size,owner:styk.drawingResourcesFor(e.report)};
  });
  check('playback, scrubbing, PNG export and save never construct drawing resources',worked.rendered&&worked.bytes>100&&worked.owner===undefined);
  check('no drawing worker scripts were loaded',workerScripts.filter(u=>u.includes('drawing')).length===0);

  // ── Sixty unique cels: scrubbing exercises the bounded decode queue.
  await page.locator('[data-workspace-mode="draw"]').click();
  await page.locator('[data-draw-action="new"]').first().click();
  const built=await page.evaluate(async()=>{
    styk.drawing.settings.resolution=1;
    const e=styk.editor,d=styk.drawing,{DrawingStroke}=await import('/tests/support/sketch-stroke.mjs'),id=e.drawingTarget().id;
    for(let i=1;i<60;i++)e.nextDrawing([id],{blank:true,length:1});
    for(let i=0;i<60;i++){e.seek(i);const target=e.prepareDrawingCel({pixelsPerUnit:1,world:{x:32,y:32}}),surface=await d.owner.surface(target.figure);
      const s=new DrawingStroke(surface.store,{size:8,pressureSize:false});s.sample({x:10+(i%8)*8,y:10+i});e.commitDrawingPixels(target,s.finish());}
    await d.barrier();e.seek(0);
    return {ticks:e.totalTicks,entries:d.owner.stats.entries,workers:d.owner.stats.workers};
  });
  check('sixty unique drawing cels were built and published',built.ticks>=60&&built.entries>=60&&built.workers>0);
  // Force every cel cold so seeks decode through the bounded queue.
  await page.evaluate(()=>{const o=styk.drawing.owner;for(const e of o.entries.values()){e.store=null;e.levels=null;e.decodes=0;}o.decodes=0;});
  const scrub=await page.evaluate(async()=>{
    const e=styk.editor,owner=styk.drawing.owner,longtasks=[];
    const observer=new PerformanceObserver(list=>longtasks.push(...list.getEntries()));observer.observe({entryTypes:['longtask']});
    for(const tick of [...Array(60).keys(),...Array(60).keys()]){e.seek(tick);await new Promise(r=>setTimeout(r));}
    await new Promise(r=>setTimeout(r,400));observer.disconnect();
    const stats=owner.stats;
    return {longtasks:longtasks.length,bytes:stats.bytes,budget:owner.tileBudget,decodes:stats.decodes,redecoded:[...owner.entries.values()].filter(en=>en.decodes>1).length,resident:[...owner.entries.values()].filter(en=>en.store).length};
  });
  check('two end-to-end scrubs keep resident drawing memory inside the tile budget',scrub.bytes<=scrub.budget);
  check('every visited cel decodes at most once per eviction',scrub.redecoded===0&&scrub.decodes>0&&scrub.decodes<=60);
  check('scrubbing decodes every cel it visits',scrub.resident===60);
  check('no long tasks above 50 ms during scrubbing',scrub.longtasks===0);
  // A synchronous seek burst: the queue keeps at most two pending decodes and
  // the final seek's cel is the one that decodes.
  const burst=await page.evaluate(async()=>{
    const e=styk.editor,owner=styk.drawing.owner,{drawingCelPrefetch}=await import('/src/onion-skin.mjs');
    for(const entry of owner.entries.values()){entry.store=null;entry.levels=null;}
    e.seek(0);for(let i=0;i<10;i++)e.seek(Math.min(57,i*3));
    const queued=owner.decodeQueue.length;
    const current=drawingCelPrefetch(e,e.activeLayerId)?.current;
    await owner.surface(current);
    return {queued,decoded:Boolean(owner.entry(current).store)};
  });
  check('a burst of ten seeks leaves at most two decodes queued',burst.queued<=2);
  check('the final seek decodes its cel',burst.decoded);
  // Thumbnails: the pump waits out busy work and a big cel rasterizes from a
  // mip level, not the source tiles.
  const thumb=await page.evaluate(async()=>{
    const e=styk.editor,owner=styk.drawing.owner,{DrawingStroke}=await import('/tests/support/sketch-stroke.mjs');
    e.seek(30);const target=e.drawingTarget(),surface=await owner.surface(target.figure);
    const s=new DrawingStroke(surface.store,{size:16,pressureSize:false});
    for(let x=0;x<=600;x+=40)s.sample({x,y:10});
    e.commitDrawingPixels(target,s.finish());
    const figure=target.figure,sourceWidth=surface.store.bounds.width;
    await new Promise(r=>{const poll=()=>owner.thumbnailActive?setTimeout(poll,20):r();poll();});
    owner.thumbnailQueue.clear();owner.thumbnailCache.clear();
    owner.busy=true;owner.thumbnail(figure,()=>{});
    const paused=owner.thumbnailQueue.size===1&&!owner.thumbnailActive;
    let sourceTiles=0,original=owner.thumbnailWorker.request.bind(owner.thumbnailWorker);
    owner.thumbnailWorker.request=(kind,data,opts)=>{if(kind==='thumbnail')sourceTiles=data.tiles?.length??0;return original(kind,data,opts);};
    owner.busy=false;
    const canvas=await new Promise(resolve=>{const poll=()=>{const hit=owner.thumbnailCache.get(figure._styk.drawing.celId);hit?resolve(hit.canvas):setTimeout(poll,30);};poll();});
    owner.thumbnailWorker.request=original;
    return {paused,sourceWidth,sourceTiles,thumbWidth:canvas.width,ink:canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data.some((n,i)=>i%4===3&&n)};
  });
  check('the thumbnail pump pauses while the owner is busy and resumes after',thumb.paused&&thumb.thumbWidth>0);
  check('the worker downsamples a large tiled cel to a small thumbnail containing ink',thumb.sourceWidth>500&&thumb.sourceTiles>1&&thumb.thumbWidth<=64&&thumb.ink);
  check('no uncaught browser errors',errors.length===0);
  await writeFile(path.join(output,'timeline.json'),JSON.stringify({checks,errors,scrub,burst,thumb,workers:workerScripts.filter(u=>u.includes('drawing'))},null,2));
}catch(error){await page.screenshot({path:path.join(output,'failure.png')});await writeFile(path.join(output,'timeline-failure.json'),JSON.stringify({message:error.message,errors,checks},null,2));throw error;}
finally{await browser.close();}
