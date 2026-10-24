import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
const out=process.env.STYK_DENSE_ARTIFACTS||'artifacts/drawing-dense';await mkdir(out,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
page.on('pageerror',e=>errors.push(e.message));
try{
  await page.goto(process.env.STYK_URL||'http://127.0.0.1:47839');await page.waitForFunction(()=>window.styk?.ready);
  const result=await page.evaluate(async()=>{
    const {DrawingResources}=await import('/src/drawing-resources.mjs'),{createDrawingFigure}=await import('/src/drawing-model.mjs'),{levelStore}=await import('/src/drawing-raster.mjs');
    const figure=createDrawingFigure({celId:'dense-preview'}),owner=new DrawingResources({figure_types:[figure]},{onError:e=>{throw e;}});owner.busy=true;
    const tiles=[];for(let ty=0;ty<34;ty++)for(let tx=0;tx<60;tx++){const pixels=new Uint8ClampedArray(64*64*4);for(let i=0;i<pixels.length;i+=4)pixels.set([tx*4,ty*7,120,255],i);tiles.push({tx,ty,pixels:pixels.buffer});}
    const entry=owner.install(figure,tiles),p=owner.presenter(figure),rect={x:0,y:0,width:3840,height:2176},gaps=[];let last=performance.now();
    const interval=setInterval(()=>{const n=performance.now();gaps.push(n-last);last=n;},5);
    const wait=async predicate=>{const end=performance.now()+20000;while(!predicate()){if(performance.now()>end)throw Error('Dense preview timed out.');await new Promise(r=>setTimeout(r,5));}};
    try{
      const started=performance.now(),first=p.scratch(rect,{level:2}),requestMs=performance.now()-started;
      await wait(()=>owner.previews.cache.size>0&&!owner.previews.active);const readyMs=performance.now()-started,preview=p.scratch(rect,{level:2});
      const canvas=new OffscreenCanvas(preview.width,preview.height),ctx=canvas.getContext('2d');ctx.drawImage(preview.canvas,0,0);
      const pixel=[...ctx.getImageData(17,17,1,1).data];
      const sync=performance.now();levelStore({store:entry.store},2);const referenceMipMs=performance.now()-sync;
      owner.dropScratch(entry);p.scratch(rect,{level:2});entry.store.set(1,1,new Uint8ClampedArray([255,0,0,255]));owner.present(entry,{x:64,y:64,width:64,height:64});
      await wait(()=>{const s=p.scratch(rect,{level:2});return !!s&&[...owner.previews.cache.values()].some(v=>v.version===entry.pixelStamp)&&!owner.previews.active;});
      const current=p.scratch(rect,{level:2});ctx.clearRect(0,0,canvas.width,canvas.height);ctx.drawImage(current.canvas,0,0);const updated=[...ctx.getImageData(17,17,1,1).data];
      const warmStart=performance.now();entry.store.set(2,2,new Uint8ClampedArray([0,255,0,255]));owner.present(entry,{x:128,y:128,width:64,height:64});p.scratch(rect,{level:2});
      await wait(()=>[...owner.previews.cache.values()].some(v=>v.version===entry.pixelStamp)&&!owner.previews.active);
      const warmMs=performance.now()-warmStart,transferredTiles=owner.previews.lastTransferredTiles;
      if(transferredTiles!==1)throw Error('A small edit resent unchanged preview tiles.');
      clearInterval(interval);
      const startFill=performance.now(),fill=await owner.worker.request('fill',{tiles:[],bounds:{x:0,y:0,width:7680,height:4320},options:{x:10,y:10,color:[12,34,56,255],expansion:1,gap:0,maxBytes:owner.hardBudget}}),fillMs=performance.now()-startFill;
      const abort=new AbortController(),pending=owner.worker.request('fill',{tiles:[],bounds:{x:0,y:0,width:7680,height:4320},options:{x:10,y:10,color:[1,2,3,255]}},{signal:abort.signal});abort.abort();let cancelled=false;try{await pending;}catch(e){cancelled=e.name==='AbortError';}
      const restarted=await owner.worker.request('fill',{tiles:[],bounds:{x:0,y:0,width:2,height:2},options:{x:0,y:0,color:[1,2,3,255]}});
      return {firstWasAsync:first===null,pixel,updated,requestMs,readyMs,warmMs,transferredTiles,referenceMipMs,eventLoopTicks:gaps.length,fillMs,fillTiles:fill.tiles.length,fillUniform:fill.tiles.every(t=>t.after?.[0]===12&&t.after?.[3]===255),cancelled,restarted:restarted.tiles.length===1,stats:owner.stats};
    }finally{clearInterval(interval);owner.dispose();}
  });
  assert.ok(result.firstWasAsync);assert.deepEqual(result.pixel,[4,7,120,255]);assert.deepEqual(result.updated,[255,0,0,255]);assert.ok(result.eventLoopTicks>0);assert.ok(result.fillUniform&&result.fillTiles>8000);assert.ok(result.cancelled&&result.restarted);assert.ok(result.diagonalTiles<400);assert.deepEqual(errors,[]);
  await page.locator('[data-workspace-mode="draw"]').click();
  await page.evaluate(async()=>{
    const {emptyDocument}=await import('/src/demo.mjs'),e=styk.editor,d=styk.drawing,report=emptyDocument();report.canvas_width=3840;report.canvas_height=2160;e.load(report);e.createDrawingLayer();
    const target=e.prepareDrawingCel({pixelsPerUnit:1,world:{x:0,y:0}});await d.owner.surface(target.figure);d.owner.busy=true;
    const tiles=[];for(let ty=0;ty<34;ty++)for(let tx=0;tx<60;tx++)tiles.push({tx,ty,before:null,after:new Uint8ClampedArray([tx*4,ty*7,120,255])});e.commitDrawingPixels(target,tiles);styk.fit();
  });
  // The engine's stage draws the cel once its pictures are decoded and uploaded.
  await page.waitForFunction(()=>!styk.state.dirtyRender&&styk.state.renderer.engineSide.stage.pictures_pending()===0);
  await page.screenshot({path:out+'/dense-workspace.png'});
  assert.deepEqual(errors,[]);
  await writeFile(out+'/result.json',JSON.stringify({result,errors,browser:await browser.version()},null,2));console.log(JSON.stringify(result,null,2));
}finally{await browser.close();}
