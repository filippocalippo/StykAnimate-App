import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
// A run writes to an ignored folder, so it never rewrites the recorded evidence in artifacts/drawing-ux
// (set STYK_DRAWING_UX_OUT=artifacts/drawing-ux to refresh that on purpose).
const output=path.resolve(process.env.STYK_DRAWING_UX_OUT||'artifacts/drawing-ux-latest'),checks=[],errors=[];
await mkdir(output,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1440,height:1000}});
page.on('pageerror',e=>errors.push(e.stack));
const check=(name,value)=>{assert.ok(value,name);checks.push(name);console.log('PASS',name);};
const stroke=async(x,y,dx=90,dy=35)=>{await page.mouse.move(x,y);await page.mouse.down();await page.waitForFunction(()=>Boolean(styk.drawing.gesture));await page.mouse.move(x+dx,y+dy,{steps:12});await page.mouse.up();await page.waitForFunction(()=>!styk.drawing.gesture);};
try{
  await page.goto(process.env.STYK_URL||'http://127.0.0.1:47839');await page.waitForFunction(()=>window.styk?.ready);
  // pix: snapshot a tile store's occupied bounds + RGBA; pixEq: exact compare.
  await page.evaluate(()=>{window.pix=store=>{const b=store.bounds;return {bounds:b?{...b}:null,pixels:b?store.readRect(b.x,b.y,b.width,b.height):new Uint8ClampedArray(0)};};window.pixEq=(a,b)=>Boolean(a.bounds&&b.bounds&&a.bounds.x===b.bounds.x&&a.bounds.y===b.bounds.y&&a.bounds.width===b.bounds.width&&a.bounds.height===b.bounds.height&&a.pixels.length===b.pixels.length&&a.pixels.every((n,i)=>n===b.pixels[i]));window.visEq=(a,b)=>a.pixels.length===b.pixels.length&&a.pixels.every((n,i)=>i%4===3?n===b.pixels[i]:(a.pixels[i-i%4+3]===0&&b.pixels[i-i%4+3]===0)||n===b.pixels[i]);});
  await page.evaluate(()=>styk.state.settings.autosaveSeconds=0);await page.locator('[data-workspace-mode="draw"]').click();await page.locator('[data-draw-action="new"]').click();
  // Whole-pixel pointer positions: pointer coordinates are single precision, so a fractional start would round the pan delta.
  const rect=await page.locator('#viewport').boundingBox(),x=Math.round(rect.x+rect.width*.4),y=Math.round(rect.y+rect.height*.4);
  await page.evaluate(()=>window.beforePan={revision:styk.editor.revision,view:{...styk.state.view}});
  await page.mouse.move(x,y);await page.mouse.down({button:'middle'});await page.mouse.move(x+96,y+48,{steps:6});await page.mouse.up({button:'middle'});
  check('middle-button pans with Brush and creates no ink or history',await page.evaluate(()=>styk.state.view.x-beforePan.view.x===96&&styk.state.view.y-beforePan.view.y===48&&styk.editor.revision===beforePan.revision&&!styk.drawing.gesture));
  await page.keyboard.down('Space');await page.mouse.down();await page.mouse.move(x+116,y+58);await page.keyboard.up('Space');await page.mouse.move(x+146,y+68);await page.mouse.up();
  check('Space pan continues after Space is released until pointer-up',await page.evaluate(()=>styk.editor.revision===beforePan.revision&&!styk.state.drag&&!styk.drawing.gesture&&styk.state.view.x-beforePan.view.x===146));
  await page.evaluate(()=>Object.assign(styk.state.view,beforePan.view));
  await stroke(x,y);
  check('normal brush drawing defaults to 2x pixels',await page.evaluate(()=>styk.editor.drawingTarget().figure._styk.drawing.pixelsPerUnit===2));
  check('Properties contains no exposure or frame creation controls',await page.locator('#inspector [data-draw-action="blank"],#inspector [data-draw-action="copy-key"],#inspector [data-draw-action^="next-"],#inspector [data-property="draw:length"]').count()===0);
  check('brush preview paints a live stroke sample',await page.locator('canvas.drawing-preview').isVisible()&&await page.evaluate(()=>{const c=document.querySelector('canvas.drawing-preview'),d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let a=0;for(let i=3;i<d.length;i+=4)a+=d[i];return a>0;}));
  check('dynamics toggles render as property switches',await page.locator('.property-toggle input[data-draw-setting="pressureSize"]').count()===1&&await page.locator('.property-toggle input[data-draw-setting="pressureOpacity"]').count()===1);
  check('drawing eyedropper is fully removed',await page.locator('[data-tool="drawing-eyedropper"],[data-draw-action="eyedropper"],[data-icon="pipette"]').count()===0);
  await page.locator('#viewport').focus();await page.keyboard.press('i');
  check('i does not activate a drawing eyedropper',await page.evaluate(()=>styk.drawing.tool==='brush'));
  await page.mouse.move(x,y);
  check('brush ring tracks the pointer',await page.evaluate(()=>Boolean(styk.drawing.cursor)));
  const inspectorBox=await page.locator('#inspector').boundingBox();await page.mouse.move(inspectorBox.x+inspectorBox.width/2,inspectorBox.y+inspectorBox.height/2);
  check('brush ring clears when the pointer leaves the canvas',await page.evaluate(()=>styk.drawing.cursor===null));
  check('copied drawing action is available in the timeline',await page.getByRole('button',{name:'Next copied drawing',exact:true}).isVisible());
  await page.locator('[data-draw-preset="pencil"]').click();await page.waitForSelector('[data-draw-preset="pencil"][aria-pressed="true"]');
  check('the active preset shows its pressed state',await page.locator('[data-draw-preset="pencil"][aria-pressed="true"]').isVisible());
  await page.locator('[data-tool="drawing-eraser"]').click();await page.evaluate(()=>styk.drawing.propertySet('draw:size',42));await page.locator('[data-tool="drawing-brush"]').click();
  check('Brush remembers its preset and size independently of Eraser',await page.evaluate(()=>styk.drawing.settings.size===2&&styk.drawing.settings.preset==='pencil'));
  await page.locator('[data-tool="drawing-eraser"]').click();check('Eraser remembers its own size',await page.evaluate(()=>styk.drawing.settings.size===42));await page.locator('[data-tool="drawing-brush"]').click();await page.locator('[data-draw-preset="ink"]').click();
  await page.evaluate(async()=>{await styk.drawing.barrier();const e=styk.editor,d=styk.drawing,t=e.drawingTarget(),{drawingPixelMatrix}=await import('/src/drawing-model.mjs'),s=await d.owner.surface(t.figure);window.oldDrawing={id:t.figure._styk.drawing.celId,figure:t.figure,object:structuredClone(t.object),snap:pix(s.store),matrix:drawingPixelMatrix(d.geometryItem(t)),revision:e.revision};});
  await page.mouse.move(x,y);await page.mouse.down({button:'middle'});await page.mouse.move(x-600,y,{steps:12});await page.mouse.up({button:'middle'});
  const strokeStart=performance.now();await stroke(x+80,y+80);const strokeMs=performance.now()-strokeStart;
  const growth=await page.evaluate(async()=>{
    const e=styk.editor,d=styk.drawing,{drawingPixelMatrix,transformPoint,inversePoint}=await import('/src/drawing-model.mjs'),t=e.drawingTarget(),s=d.owner.entry(t.figure),matrix=drawingPixelMatrix(d.geometryItem(t));
    const p={x:100,y:80},world=transformPoint(oldDrawing.matrix,p),q=inversePoint(matrix,world),offset={x:Math.round(q.x-p.x),y:Math.round(q.y-p.y)},old=oldDrawing.snap,now=s.store.bounds;
    let exact=true;for(let y=0;y<old.bounds.height&&exact;y++)for(let x=0;x<old.bounds.width;x++){const i=(y*old.bounds.width+x)*4;if(!old.pixels[i+3])continue;const px=s.store.pixel(old.bounds.x+x+offset.x,old.bounds.y+y+offset.y);for(let c=0;c<4;c++)if(px[c]!==old.pixels[i+c])exact=false;}
    window.grownDrawing={id:t.figure._styk.drawing.celId,snap:pix(s.store)};
    const expanded=now.x<old.bounds.x||now.y<old.bounds.y||now.x+now.width>old.bounds.x+old.bounds.width||now.y+now.height>old.bounds.y+old.bounds.height;
    return {expanded,exact,unique:e.evaluatedFrame.objects.filter(o=>o.unique_id===t.object.unique_id).length===1,bytes:d.owner.stats.bytes};
  });
  check('painting beyond the stage edge adds tiles without moving or changing old ink',growth.expanded&&growth.exact&&growth.unique);
  await page.keyboard.press('Control+z');check('stroke undo restores the same cel',await page.evaluate(()=>styk.editor.drawingTarget().figure._styk.drawing.celId===oldDrawing.id));
  await page.keyboard.press('Control+Shift+z');await page.evaluate(()=>styk.drawing.prepareVisible());check('redo restores the painted tiles exactly',await page.evaluate(()=>{const t=styk.editor.drawingTarget(),s=styk.drawing.owner.entry(t.figure);return t.figure._styk.drawing.celId===grownDrawing.id&&pixEq(pix(s.store),grownDrawing.snap);}));
  await page.evaluate(()=>styk.drawing.barrier());
  check('tile cel publishes exact tile pixels',await page.evaluate(async()=>{const {decodeTileBlob}=await import('/src/drawing-tile-codec.mjs'),{TileStore}=await import('/src/drawing-tiles.mjs'),f=styk.editor.drawingTarget().figure,snap=grownDrawing.snap;
    const tiles=await decodeTileBlob(f.image_assets[0].styk_tiles),store=new TileStore();
    for(const t of tiles)store.set(t.tx,t.ty,t.pixels);
    return pixEq(pix(store),snap);}));
  check('pixel paste into a blank cel preserves artwork and its world origin',await page.evaluate(async()=>{
    const e=styk.editor,d=styk.drawing,target=e.drawingTarget(),surface=await d.owner.surface(target.figure),B=surface.store.bounds;
    await d.makeSelection({target,surface,points:[{x:B.x,y:B.y},{x:B.x+B.width,y:B.y},{x:B.x+B.width,y:B.y+B.height},{x:B.x,y:B.y+B.height}]});await d.action('copy-pixels');d.cancelSelection();e.addDrawingFrame();await d.action('paste-pixels');
    const pasted=e.drawingTarget(),entry=await d.owner.surface(pasted.figure),snap=pix(entry.store),clip=e._drawingPixelClipboard;
    const world=pasted.object&&clip?.world&&Math.hypot(pasted.object.root_x-clip.world.x,pasted.object.root_y-clip.world.y)<1e-6;
    const exact=world&&snap.bounds.width===grownDrawing.snap.bounds.width&&snap.bounds.height===grownDrawing.snap.bounds.height&&visEq(snap,grownDrawing.snap)&&pasted.figure._styk.drawing.celId!==target.figure._styk.drawing.celId;
    e.undo();e.undo();e.seek(0);await d.prepareVisible();return exact;
  }));
  await page.locator('[data-tool="drawing-lasso"]').click();
  await page.evaluate(async()=>{const d=styk.drawing,t=styk.editor.drawingTarget(),s=await d.owner.surface(t.figure),B=s.store.bounds;window.deleteBefore=pix(s.store);await d.makeSelection({target:t,surface:s,points:[{x:B.x,y:B.y},{x:B.x+B.width,y:B.y},{x:B.x+B.width,y:B.y+B.height},{x:B.x,y:B.y+B.height}]});d.onUI();});
  // Worker completion queues the inspector update for the next animation frame.
  await page.locator('[data-draw-action="copy-pixels"]').waitFor({state:'visible'});
  check('a pixel selection exposes copy, cut and delete actions',await page.locator('[data-draw-action="copy-pixels"]').isVisible()&&await page.locator('[data-draw-action="cut-pixels"]').isVisible()&&await page.locator('[data-draw-action="delete-pixels"]').isVisible());
  await page.locator('#viewport').focus();await page.keyboard.press('Delete');await page.waitForFunction(()=>!styk.drawing.selection);
  check('Delete removes the selected pixels and consumes the selection',await page.evaluate(()=>{const s=styk.drawing.owner.entry(styk.editor.drawingTarget().figure).store;return !styk.drawing.selection&&s.bounds===null;}));
  await page.keyboard.press('Control+z');
  check('undo restores the deleted pixels',await page.evaluate(()=>pixEq(pix(styk.drawing.owner.entry(styk.editor.drawingTarget().figure).store),deleteBefore)));
  await page.evaluate(()=>{window.deleteProbe={revision:styk.editor.revision,objects:styk.editor.evaluatedFrame.objects.length};styk.editor.select(styk.editor.drawingTarget().object.unique_id);});
  await page.keyboard.press('Delete');
  check('Delete without a pixel selection keeps its global figure delete',await page.evaluate(()=>!styk.drawing.selection&&styk.editor.revision!==deleteProbe.revision&&styk.editor.evaluatedFrame.objects.length<deleteProbe.objects));
  await page.keyboard.press('Control+z');await page.evaluate(()=>styk.drawing.prepareVisible());
  const scaling=await page.evaluate(async()=>{
    const {drawingPixelMatrix,transformPoint}=await import('/src/drawing-model.mjs');
    const e=styk.editor,d=styk.drawing,t=e.drawingTarget(),item=d.geometryItem(t),p={x:400,y:320},before=transformPoint(drawingPixelMatrix(item),p);
    d.settings.resolution=1;await d.action('resample');const after=transformPoint(drawingPixelMatrix(d.geometryItem(e.drawingTarget())),{x:p.x/2,y:p.y/2});e.undo();d.settings.resolution=2;await d.prepareVisible();
    return {pose:Math.hypot(before.x-after.x,before.y-after.y)<1e-6};
  });
  check('resampling a cel preserves its world placement',scaling.pose);
  await page.mouse.move(x,y);await page.mouse.down({button:'middle'});await page.mouse.move(x+500,y+180,{steps:10});await page.mouse.up({button:'middle'});
  await page.evaluate(()=>{window.cancelState={revision:styk.editor.revision,figures:styk.editor.report.figure_types.length,entries:styk.drawing.owner.entries.size};});
  await page.mouse.move(x,y);await page.mouse.down();await page.waitForFunction(()=>Boolean(styk.drawing.gesture));await page.mouse.move(x+40,y+10);await page.keyboard.press('Escape');await page.mouse.up();await page.waitForFunction(()=>!styk.drawing.gesture);
  check('cancelled stroke publishes no cel, history or orphan store entry',await page.evaluate(()=>styk.editor.revision===cancelState.revision&&styk.editor.report.figure_types.length===cancelState.figures&&styk.drawing.owner.entries.size===cancelState.entries));
  await page.evaluate(()=>{const d=styk.drawing,e=styk.editor;d.owner.entry(e.drawingTarget().figure).store=null;window.releaseDecode=null;const request=d.owner.decodeWorker.request.bind(d.owner.decodeWorker);window.decodeRequest=request;d.owner.decodeWorker.request=(kind,...args)=>{const result=request(kind,...args);return kind==='decode-tiles'?result.then(async r=>{await new Promise(resolve=>window.releaseDecode=resolve);return r;}):result;};});
  await page.mouse.move(x,y);await page.mouse.down();await page.waitForFunction(()=>Boolean(window.releaseDecode));
  await page.evaluate(()=>{styk.editor.renameLayer(styk.editor.activeLayerId,'Ink');releaseDecode();});await page.waitForFunction(()=>!styk.drawing.loading);await page.mouse.up();
  // The gate was a one-shot: later decodes (including eviction re-decodes the
  // presenter kicks) must run unimpeded or the decode pump stalls for good.
  await page.evaluate(()=>{styk.drawing.owner.decodeWorker.request=window.decodeRequest;});
  check('a document edit invalidates a pending cel decode and releases input',await page.evaluate(()=>!styk.drawing.gesture&&styk.editor.drawingTarget().figure._styk.drawing.celId===grownDrawing.id&&styk.editor.report.figure_types.length===cancelState.figures));
  await page.evaluate(()=>styk.fit());await page.screenshot({path:path.join(output,'workspace.png')});
  for(const mode of ['advanced','simple']){
    await page.locator(`[data-timeline-mode="${mode}"]`).click();await page.evaluate(()=>{const e=styk.editor;e.seek(0);window.tracksBefore=structuredClone(e.report._styk.layerSheet.tracks);window.activeBefore=e.activeLayerId;});
    await page.locator('#viewport').focus();await page.keyboard.press('a');
    check(`A creates a blank key only on the active drawing layer in ${mode}`,await page.evaluate(()=>{const e=styk.editor;return !e.drawingTarget().figure&&e.activeLayerId===activeBefore&&Object.entries(tracksBefore).every(([id,track])=>id===activeBefore||JSON.stringify(e.report._styk.layerSheet.tracks[id])===JSON.stringify(track));}));
    await page.keyboard.press('Control+z');
  }
  await page.locator('[data-workspace-mode="animate"]').first().click();
  // Animate keeps its own active layer: pick the drawing layer the loop used.
  await page.evaluate(()=>{styk.editor.activeLayerId=activeBefore;});await page.locator('#viewport').focus();await page.keyboard.press('a');
  check('A uses drawing-layer semantics in Animate too',await page.evaluate(()=>!styk.editor.drawingTarget().figure));await page.keyboard.press('Control+z');await page.locator('[data-workspace-mode="draw"]').click();
  await page.locator('[data-timeline-mode="advanced"]').click();await page.setViewportSize({width:1024,height:768});await page.evaluate(()=>styk.fit());await page.screenshot({path:path.join(output,'workspace-compact.png')});
  check('compact quick bar keeps size and opacity visible',await page.locator('.drawing-quickbar [data-draw-slider="size"]').isVisible()&&await page.locator('.drawing-quickbar [data-draw-slider="opacity"]').isVisible());
  check('changing timeline layout keeps figure handles hidden in Draw',await page.evaluate(()=>!styk.state.handles));

  // Budget regressions: a resident-store overflow must evict rebuildable work
  // instead of rejecting the edit, and forked cels share counted tiles.
  const probe=await page.evaluate(async()=>{
    const {DrawingStroke}=await import('/tests/support/sketch-stroke.mjs');
    const e=styk.editor,d=styk.drawing,owner=d.owner,TILE_B=64*64*4,out={};
    const old=owner.tileBudget;owner.tileBudget=4*TILE_B;
    try{
      e.createDrawingLayer('Budget probe');e.selectSheetLayer(e.layers.at(-1).id);
      out.tick0=e.tick;
      const t0=e.prepareDrawingCel({pixelsPerUnit:1,world:{x:32,y:32}}),s0=await owner.surface(t0.figure);
      const dot=new DrawingStroke(s0.store,{size:12,pressureSize:false});dot.sample({x:40,y:40});
      e.commitDrawingPixels(t0,dot.finish());await d.barrier();
      out.fig0=t0.figure;out.tick1=null;
      e.nextDrawing([e.activeLayerId],{blank:true,length:1});out.tick1=e.tick;
      const t1=e.prepareDrawingCel({pixelsPerUnit:1,world:{x:32,y:32}}),s1=await owner.surface(t1.figure);
      const band=new DrawingStroke(s1.store,{size:48,pressureSize:false});
      band.sample({x:32,y:32});band.sample({x:230,y:32});
      try{e.commitDrawingPixels(t1,band.finish());out.evicted=!owner.entry(out.fig0).store;}
      catch(error){out.error=String(error?.message??error);}
      out.fig1=t1.figure;
      const before=owner.stats.bytes;
      e.nextDrawing([e.activeLayerId],{blank:false,length:1});
      out.forkBefore=before;out.forkAfter=owner.stats.bytes;
    }finally{owner.tileBudget=old;}
    return out;
  });
  check('a stroke that would overflow the tile budget evicts clean stores instead',probe.evicted===true&&!probe.error);
  check('a copied cel does not double-count shared tiles',probe.forkAfter===probe.forkBefore);
  // Seeking back to the evicted cel re-decodes it and paints real tiles.
  const redecode=await page.evaluate(async(probe)=>{
    const e=styk.editor,d=styk.drawing,owner=d.owner;
    e.seek(probe.tick0);d.prepareVisible();
    const entry=d.resource(probe.fig0);
    if(!entry)return {entry:false};
    const kicked=!entry.store&&Boolean(entry.loading)||Boolean(entry.store);
    const deadline=performance.now()+5000;
    while(!owner.entry(probe.fig0).store&&performance.now()<deadline)await new Promise(r=>setTimeout(r,30));
    const store=Boolean(owner.entry(probe.fig0).store);
    if(!store)return {entry:true,kicked,store};
    const v=document.querySelector('#viewport'),vr0=v.getBoundingClientRect();
    v.dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,clientX:vr0.left+10,clientY:vr0.top+10}));
    await new Promise(r=>setTimeout(r,150));
    // A framebuffer readback at the dab's world position proves the tile path,
    // not the 1×1 placeholder data_url, drew the cel.
    const {drawingPixelMatrix,transformPoint}=await import('/src/drawing-model.mjs'),{worldToScreen}=await import('/src/renderer-geometry.mjs');
    const p=worldToScreen(transformPoint(drawingPixelMatrix(d.geometryItem(e.drawingTarget())),{x:40,y:40}),{report:e.report,frame:e.evaluatedFrame,view:styk.state.view,cameraEnabled:false});
    const c=document.querySelector('#scene'),image=new Image();image.src=c.toDataURL();await image.decode();
    const o=new OffscreenCanvas(image.naturalWidth,image.naturalHeight),ctx=o.getContext('2d');
    ctx.drawImage(image,0,0);
    const cr=c.getBoundingClientRect(),vr=document.querySelector('#viewport').getBoundingClientRect();
    const px=Math.round(p.x-(cr.left-vr.left)),py=Math.round(p.y-(cr.top-vr.top));
    const pxData=ctx.getImageData(Math.max(0,px-2),Math.max(0,py-2),5,5).data;
    let alpha=0;for(let i=3;i<pxData.length;i+=4)alpha=Math.max(alpha,pxData[i]);
    return {entry:true,kicked,store,alpha,px,py};
  },probe);
  check('an evicted cel re-decodes through resource() and repaints its tiles',redecode.store===true&&redecode.alpha>200);
  // Scratch hysteresis and per-anchor retention.
  const scratchCheck=await page.evaluate(async(probe)=>{
    const {presenterScratch}=await import('/src/drawing-raster.mjs');
    const e=styk.editor,d=styk.drawing;
    e.seek(probe.tick1);d.prepareVisible();
    await new Promise(r=>setTimeout(r,50));
    const entry=d.owner.presenter(e.drawingTarget().figure);
    d.owner.dropScratch(entry);
    const b=entry.store.tileBounds;
    const r1=presenterScratch(entry,{x:b.x,y:b.y,width:32,height:32});
    const s1=entry._scratches.get(r1.anchorKey),blits=s1.blits;
    const inner=presenterScratch(entry,{x:b.x+4,y:b.y+4,width:8,height:8});
    const hysteresis=inner.canvas===r1.canvas&&s1.blits===blits;
    const r2=presenterScratch(entry,{x:b.x+b.width-32,y:b.y,width:32,height:32});
    const s2=entry._scratches.get(r2.anchorKey);
    const distinct=s2&&r2.canvas!==r1.canvas;
    const back=presenterScratch(entry,{x:b.x,y:b.y,width:32,height:32});
    const alternation=back.canvas===r1.canvas&&s1.blits===blits;
    const ctx1=r1.canvas.getContext('2d'),ctx2=r2.canvas.getContext('2d');
    const alphaAt=(ctx,x,y)=>ctx.getImageData(Math.max(0,Math.round(x)),Math.max(0,Math.round(y)),1,1).data[3];
    // Each scratch paints its own anchor's tiles: ink exists inside each cover.
    const ink1=alphaAt(ctx1,40-r1.x,40-r1.y)>0,ink2=alphaAt(ctx2,Math.min(r2.width-1,230-r2.x),40-r2.y)>0;
    return {hysteresis,distinct,alternation,ink1,ink2,covers:[r1.anchorKey,r2.anchorKey]};
  },probe);
  check('a contained rect reuses the painted scratch without repainting',scratchCheck.hysteresis);
  check('alternating rects keep distinct scratch canvases',scratchCheck.distinct&&scratchCheck.alternation&&scratchCheck.ink1&&scratchCheck.ink2);
  check('no uncaught browser errors',errors.length===0);
  await writeFile(path.join(output,'ux.json'),JSON.stringify({checks,errors,growth,strokeMs,browser:await browser.version()},null,2));
}catch(error){await page.screenshot({path:path.join(output,'failure.png')});await writeFile(path.join(output,'failure.json'),JSON.stringify({error:error.stack,checks,errors},null,2));throw error;}
finally{await browser.close();}
