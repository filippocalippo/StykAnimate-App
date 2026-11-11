import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
const output=process.env.STYK_PIXEL_CLIPBOARD_ARTIFACTS||'artifacts/drawing-clipboard';await mkdir(output,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[],checks=[];
page.on('pageerror',error=>errors.push(error.message));
const check=(name,value)=>{assert.ok(value,name);checks.push(name);console.log('PASS',name);};
try{
  const baseline=process.env.STYK_PIXEL_CLIPBOARD_BASELINE;
  if(baseline)for(const name of ['drawing-png','drawing-tile-codec']){
    const body=execFileSync('git',['show',`${baseline}:src/${name}.mjs`],{encoding:'utf8'});
    await page.context().route(`**/src/${name}.mjs`,route=>route.fulfill({contentType:'text/javascript',body}));
  }
  await page.goto(process.env.STYK_URL||'http://127.0.0.1:47839');await page.waitForFunction(()=>window.styk?.ready);
  await page.locator('[data-workspace-mode="draw"]').click();
  await page.evaluate(async()=>{
    const {emptyDocument}=await import('/src/demo.mjs'),{SharedClipboard}=await import('/src/shared-clipboard.mjs');
    styk.state.settings.autosaveSeconds=0;
    // Exercise the real chunk encoder/decoder and controller in a browser.
    // Desktop IPC uses a separate test; neither fixture alters the OS clipboard.
    window.bus={jobs:new Map(),next:0,id:0,parts:[],maxChunk:0};
    window.bridge={
      beginSharedClipboardWrite:async()=>{const token=++bus.next;bus.jobs.set(token,{parts:[]});return{token};},
      writeSharedClipboardChunk:async(token,bytes)=>{if(bus.failWrite)throw Error('Injected clipboard write failure');if(bytes.byteLength>256*1024)throw Error('Oversized clipboard chunk');bus.maxChunk=Math.max(bus.maxChunk,bytes.byteLength);bus.jobs.get(token).parts.push(bytes.slice(0));if(bus.hold){bus.held=true;await new Promise(resolve=>bus.release=resolve);}},
      finishSharedClipboardWrite:async token=>{bus.parts=bus.jobs.get(token).parts;bus.jobs.delete(token);return{id:++bus.id};},
      beginSharedClipboardRead:async known=>{if(!bus.id)return null;if(known===bus.id)return{unchanged:true,id:bus.id};const token=++bus.next;bus.jobs.set(token,{parts:bus.parts.slice(),index:0});return{token,id:bus.id};},
      readSharedClipboardChunk:async token=>{const job=bus.jobs.get(token),bytes=job.parts[job.index++].slice(0);if(bus.holdRead){bus.readHeld=true;await new Promise(resolve=>bus.releaseRead=resolve);}return{bytes,done:job.index===job.parts.length};},
      cancelSharedClipboardTransfer:async token=>{bus.jobs.delete(token);}
    };
    window.freshClipboard=async()=>{const e=styk.editor,d=styk.drawing;e.load(emptyDocument());e.createDrawingLayer();d.settings.resolution=1;d.settings.filter='nearest';const target=e.prepareDrawingCel({pixelsPerUnit:1,world:{x:0,y:0}}),surface=await d.owner.surface(target.figure);window.shared=new SharedClipboard(e,bridge);d.getClipboard=()=>shared;return {e,d,target,surface};};
    window.box=(x,y,w,h)=>[{x,y},{x:x+w,y},{x:x+w,y:y+h},{x,y:y+h}];
    window.fixture=async()=>{const context=await freshClipboard(),{e,d,target,surface}=context;e.commitDrawingPixels(target,[{tx:0,ty:0,before:null,after:new Uint8ClampedArray([127,5,249,1])}]);await d.makeSelection({target:e.drawingTarget(),surface,points:box(0,0,64,64)});return context;};
  });
  const sparse=await page.evaluate(async()=>{
    const {e,d,target,surface}=await freshClipboard();e.commitDrawingPixels(target,[{tx:-100000,ty:0,before:null,after:new Uint8ClampedArray([127,5,249,1])},{tx:100000,ty:0,before:null,after:new Uint8ClampedArray([20,40,60,255])}]);
    await d.barrier();await d.makeSelection({target:e.drawingTarget(),surface,points:box(-6400000,0,12800064,64)});d.selection.dx=128;await d.action('copy-pixels');
    const packet=e._drawingPixelClipboard,copyBytes=bus.parts.reduce((n,p)=>n+p.byteLength,0),copiedTiles=packet.tiles.length;
    const {emptyDocument}=await import('/src/demo.mjs');d.cancelSelection();e.load(emptyDocument());e.createDrawingLayer();e._drawingPixelClipboard=null;shared.id=null;
    const t=e.prepareDrawingCel({pixelsPerUnit:1,world:{x:0,y:0}}),dest=await d.owner.surface(t.figure);
    e.commitDrawingPixels(t,[{tx:0,ty:0,before:null,after:new Uint8ClampedArray([11,22,33,255])}]);
    let seedCount;const request=d.owner.worker.request.bind(d.owner.worker);d.owner.worker.request=(kind,data,options)=>{if(kind==='paste')seedCount=data.tiles.length;return request(kind,data,options);};
    const history=e._undo.length;await d.action('paste-pixels');d.owner.worker.request=request;
    const exact=dest.store.pixel(-6399872,0).join(',')==='127,5,249,1'&&dest.store.pixel(6400128,0).join(',')==='20,40,60,255'&&dest.store.pixel(0,0).join(',')==='11,22,33,255';
    const oneUndo=e._undo.length===history+1;await d.history('undo');const undo=dest.store.size===1&&dest.store.pixel(0,0).join(',')==='11,22,33,255';await d.history('redo');await d.barrier();
    const {DocumentExporter}=await import('/src/document-export.mjs'),{ImportClient}=await import('/src/import-client.mjs'),exporter=new DocumentExporter();let reopened;
    try{const blob=await exporter.export(e.report,{format:'styk',getRevision:()=>e.revision}),read=await new ImportClient().importFile(new File([blob],'sparse-clipboard.styk'));e.load(read.document);const store=(await d.owner.surface(e.drawingTarget().figure)).store;reopened=store.pixel(-6399872,0).join(',')==='127,5,249,1'&&store.pixel(0,0).join(',')==='11,22,33,255';}finally{exporter.dispose();}
    return {version:packet.version,copiedTiles,copyBytes,seedCount,exact,oneUndo,undo,reopened,maxChunk:bus.maxChunk};
  });
  check('distant sparse copies use two tiles and bounded clipboard chunks',sparse.version===2&&sparse.copiedTiles===2&&sparse.copyBytes<16384&&sparse.maxChunk<=256*1024);
  check('cross-project paste preserves exact pixels and ignores destination tiles in the empty gap',sparse.exact&&sparse.seedCount===0);
  check('sparse clipboard paste has one undo and survives native save/reopen',sparse.oneUndo&&sparse.undo&&sparse.reopened);

  const failed=await page.evaluate(async()=>{
    const {e,d,surface}=await fixture();await d.action('copy-pixels');const id=bus.id,before=surface.store.get(0,0).pixels.slice(),revision=e.revision;bus.failWrite=true;
    let message;try{await d.action('cut-pixels');}catch(error){message=error.message;}finally{bus.failWrite=false;}
    return {message,unchanged:e.revision===revision&&surface.store.get(0,0).pixels.every((n,i)=>n===before[i]),clipboard:bus.id===id,jobs:bus.jobs.size,selected:!!d.selection,busy:!!d.operation};
  });
  check('failed desktop publication leaves cut pixels, undo and the prior clipboard intact',failed.message?.includes('Injected')&&failed.unchanged&&failed.clipboard&&!failed.jobs&&failed.selected&&!failed.busy);

  await page.evaluate(async()=>{const {e,d,surface}=await fixture();window.cutSurface=surface;window.cutRevision=e.revision;window.cutClipboardId=bus.id;bus.hold=true;bus.held=false;window.pendingCut=d.action('cut-pixels').then(()=>false,error=>error.name==='AbortError');});
  await page.waitForFunction(()=>bus.held);
  check('cut leaves artwork intact while native publication is pending',await page.evaluate(()=>cutSurface.store.pixel(0,0)[3]===1&&styk.editor.revision===cutRevision&&!!styk.drawing.operation));
  await page.keyboard.press('Escape');await page.evaluate(()=>{bus.hold=false;bus.release();});
  check('Escape cancels the clipboard transfer before removing pixels',await page.evaluate(async()=>await pendingCut&&cutSurface.store.pixel(0,0)[3]===1&&styk.editor.revision===cutRevision&&bus.id===cutClipboardId&&bus.jobs.size===0&&!styk.drawing.operation));

  const cut=await page.evaluate(async()=>{const {e,d,surface}=await fixture(),before=e._undo.length;await d.action('cut-pixels');const removed=surface.store.pixel(0,0)[3]===0&&e._undo.length===before+1&&!d.selection;await d.history('undo');return removed&&surface.store.pixel(0,0).join(',')==='127,5,249,1';});
  check('successful cut removes pixels only after publication and has exact undo',cut);

  await page.evaluate(async()=>{const {e,d,surface}=await fixture();await d.action('copy-pixels');d.cancelSelection();shared.id=null;bus.holdRead=true;bus.readHeld=false;window.pasteSurface=surface;window.pasteRevision=e.revision;window.pendingPaste=d.action('paste-pixels').then(()=>false,error=>error.name==='AbortError');});
  await page.waitForFunction(()=>bus.readHeld);await page.keyboard.press('Escape');await page.evaluate(()=>{bus.holdRead=false;bus.releaseRead();});
  check('Escape during native clipboard reads prevents paste and releases the transfer',await page.evaluate(async()=>await pendingPaste&&pasteSurface.store.pixel(0,0).join(',')==='127,5,249,1'&&styk.editor.revision===pasteRevision&&bus.jobs.size===0&&!styk.drawing.operation));

  const corrupt=await page.evaluate(async()=>{
    const {e,d,surface}=await fixture();await d.action('copy-pixels');d.cancelSelection();const clip=e._drawingPixelClipboard;
    const {drawingPNGBytes,drawingPNGDataURL}=await import('/src/drawing-png.mjs'),{crc32}=await import('/src/sticknodes/decoder/archive.mjs'),bytes=drawingPNGBytes(clip.tiles[0].png),view=new DataView(bytes.buffer);
    for(let pos=8;pos<bytes.length;){const length=view.getUint32(pos),end=pos+length+12;if(String.fromCharCode(...bytes.subarray(pos+4,pos+8))==='IDAT'){bytes[end-5]^=255;view.setUint32(end-4,crc32(bytes.subarray(pos+4,end-4)));break;}pos=end;}
    // The PNG container and CRC remain valid; its compressed stream must fail
    // and settle both stream endpoints before the worker reports the error.
    await shared.copy('drawing-pixels',()=>{e._drawingPixelClipboard={...clip,bounds:{x:0,y:0,width:128,height:64},tiles:[...clip.tiles,{tx:1,ty:0,png:drawingPNGDataURL(bytes)}]};return true;});
    const revision=e.revision,history=e._undo.length;let message;try{await d.action('paste-pixels');}catch(error){message=error.message;}
    return {message,intact:e.revision===revision&&e._undo.length===history&&surface.store.size===1&&surface.store.pixel(0,0).join(',')==='127,5,249,1',busy:!!d.operation};
  });
  check('a later corrupt compressed tile aborts the whole paste without a partial edit or undo entry',!!corrupt.message&&corrupt.intact&&!corrupt.busy);

  const dense=await page.evaluate(async()=>{
    const {e,d,target,surface}=await freshClipboard(),tiles=[];for(let ty=0;ty<68;ty++)for(let tx=0;tx<120;tx++)tiles.push({tx,ty,before:null,after:new Uint8ClampedArray([tx,ty,127,255])});
    e.commitDrawingPixels(target,tiles);await d.barrier();await d.makeSelection({target:e.drawingTarget(),surface,points:box(0,0,7680,4352)});
    let encodedInputs=0,rawInputs=0;const request=d.owner.worker.request.bind(d.owner.worker);d.owner.worker.request=(kind,data,options)=>{if(kind==='copy-selection')for(const t of data.tiles){if(t.png)encodedInputs++;else rawInputs++;}return request(kind,data,options);};
    let previous=performance.now(),maxGapMs=0,ticks=0;const timer=setInterval(()=>{const now=performance.now();maxGapMs=Math.max(maxGapMs,now-previous);previous=now;ticks++;},5),start=performance.now();
    try{
      await d.action('copy-pixels');const copyMs=performance.now()-start,clip=e._drawingPixelClipboard,bytes=bus.parts.reduce((n,p)=>n+p.byteLength,0);d.owner.worker.request=request;d.cancelSelection();
      const {emptyDocument}=await import('/src/demo.mjs');e.load(emptyDocument());e.createDrawingLayer();e._drawingPixelClipboard=null;shared.id=null;
      const phases={},pasteRequest=d.owner.worker.request.bind(d.owner.worker),commit=e.commitDrawingPixels.bind(e);
      d.owner.worker.request=async(kind,data,options)=>{const time=performance.now();try{return await pasteRequest(kind,data,options);}finally{phases[kind]=(phases[kind]??0)+performance.now()-time;}};
      e.commitDrawingPixels=(...args)=>{const time=performance.now();try{return commit(...args);}finally{phases.commit=performance.now()-time;}};
      const pasteStart=performance.now();try{await d.action('paste-pixels');}finally{d.owner.worker.request=pasteRequest;e.commitDrawingPixels=commit;}
      const pasteMs=performance.now()-pasteStart,store=(await d.owner.surface(e.drawingTarget().figure)).store;
      const exact=store.size===8160&&store.pixel(7679,4351).join(',')==='119,67,127,255'&&store.bounds.width===7680&&store.bounds.height===4352;
      await d.history('undo');const undo=!e.drawingTarget().figure;await d.history('redo');const redo=(await d.owner.surface(e.drawingTarget().figure)).store.pixel(7679,4351).join(',')==='119,67,127,255';
      return {copyMs,pasteMs,phases,encodedInputs,rawInputs,bytes,tileCount:clip.tiles.length,pixels:7680*4352,exact,undo,redo,ticks,maxGapMs};
    }finally{clearInterval(timer);}
  });
  console.log(JSON.stringify({dense}));
  check('an 8K raster copy/paste exceeds 16MP with exact pixels and history',dense.pixels>32*1024*1024-1024*1024&&dense.exact&&dense.undo&&dense.redo);
  check('copy reuses every published tile PNG without raw pixel transfers',dense.encodedInputs===8160&&dense.rawInputs===0);
  check('input tasks continue during large clipboard work',dense.ticks>10);
  await page.evaluate(async()=>{await styk.drawing.barrier();await styk.drawing.prepareVisible();styk.drawing.onRender();});
  // The engine's stage draws the cel once its pictures are decoded and uploaded.
  await page.waitForFunction(()=>styk.editor.geometry.drawables.some(i=>i.type==='image')&&!styk.state.dirtyRender&&styk.state.renderer.engineSide.stage.pictures_pending()===0);
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  check('the pasted raster is visible after redo',await page.evaluate(async()=>{
    const scene=document.querySelector('#scene'),image=new Image();image.src=scene.toDataURL();await image.decode();
    const canvas=new OffscreenCanvas(image.naturalWidth,image.naturalHeight),ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);
    const rgba=ctx.getImageData(0,0,canvas.width,canvas.height).data;let ink=0;
    for(let i=0;i<rgba.length;i+=4)if(rgba[i]<20&&rgba[i+1]<20&&rgba[i+2]>80&&rgba[i+3]>240)ink++;
    return ink>100;
  }));
  await page.screenshot({path:output+'/workspace.png'});check('no uncaught browser errors',errors.length===0);
  await writeFile(output+'/result.json',JSON.stringify({decoderRevision:baseline??'working-tree',checks,sparse,dense,errors},null,2));
}finally{await browser.close();}
