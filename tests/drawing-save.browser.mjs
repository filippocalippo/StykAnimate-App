import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
const output=path.resolve(process.env.STYK_SAVE_ARTIFACTS||'artifacts/drawing-save'),url=process.env.STYK_URL||'http://127.0.0.1:47839';
await mkdir(output,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[],checks=[],workerScripts=[];
page.on('pageerror',error=>errors.push(error.stack));
page.on('workercreated',worker=>workerScripts.push(worker.url));
const check=(name,value)=>{assert.ok(value,name);checks.push(name);console.log('PASS',name);};
try{
  await page.goto(url);await page.waitForFunction(()=>window.styk?.ready);
  await page.evaluate(()=>{
    styk.state.settings.autosaveSeconds=0;
    window.pix=store=>{const b=store.bounds;return {bounds:b?{...b}:null,pixels:b?[...store.readRect(b.x,b.y,b.width,b.height)]:[]};};
    window.pixEq=(a,b)=>Boolean(a&&b&&a.bounds&&b.bounds&&a.bounds.x===b.bounds.x&&a.bounds.y===b.bounds.y&&a.bounds.width===b.bounds.width&&a.bounds.height===b.bounds.height&&a.pixels.length===b.pixels.length&&a.pixels.every((n,i)=>n===b.pixels[i]));
    window.celSnap=async figure=>{const {decodeTileBlob}=await import('/src/drawing-tile-codec.mjs'),{TileStore}=await import('/src/drawing-tiles.mjs'),store=new TileStore();for(const t of await decodeTileBlob(figure.image_assets[0].styk_tiles))store.set(t.tx,t.ty,t.pixels);return pix(store);};
    window.brush=async(x,y)=>{const {DrawingStroke}=await import('/tests/support/sketch-stroke.mjs'),e=styk.editor,target=e.prepareDrawingCel({pixelsPerUnit:1,world:{x:32,y:32}}),surface=await styk.drawing.owner.surface(target.figure);const s=new DrawingStroke(surface.store,{size:10,pressureSize:false});s.sample({x,y});s.sample({x:x+24,y:y+16});e.commitDrawingPixels(target,s.finish());return target.figure;};
    // Migrated v1 cels leave their original v1 definition in figure_types; only
    // v2 figures carry tile blobs, so snapshots and comparisons are v2-scoped.
    window.snapAll=()=>{const out={};for(const f of styk.editor.report.figure_types.filter(f=>f._styk?.drawing?.version===2)){const e=styk.drawing.owner.entries.get(f._styk.drawing.celId);if(e?.store)out[f._styk.drawing.celId]={snap:pix(e.store),bounds:f._styk.drawing.bounds?{...f._styk.drawing.bounds}:null};}return out;};
    window.compareSaved=async blob=>{const {ImportClient}=await import('/src/import-client.mjs'),{ pageEditor }=await import('/tests/support/page-editor.mjs');const read=await new ImportClient().importFile(new File([blob],'saved.styk'));const restored=pageEditor({demo:false,layerTimeline:true});restored.load(read.document);const figures=restored.report.figure_types.filter(f=>f._styk?.drawing),results=[];
      for(const f of figures){const d=f._styk.drawing;if(d.version!==2){results.push({celId:d.celId,legacy:true,exact:true,bounds:true});continue;}const snap=await celSnap(f);results.push({celId:d.celId,exact:pixEq(snap,window.snaps[d.celId]?.snap),bounds:JSON.stringify(snap.bounds)===JSON.stringify(window.snaps[d.celId]?.bounds)});}
      return {cels:figures.length,v2:results.filter(r=>!r.legacy).length,legacy:results.filter(r=>r.legacy).length,results};};
    window.saveBlob=async()=>{const {DocumentExporter}=await import('/src/document-export.mjs'),{drawingBarrier}=await import('/src/drawing-resources.mjs');const e=styk.editor;await drawingBarrier(e.report);return new DocumentExporter().export(e.report,{format:'styk',getRevision:()=>e.revision});};
  });
  await page.locator('[data-workspace-mode="draw"]').click();
  await page.locator('[data-draw-action="new"]').first().click();
  await page.evaluate(()=>{styk.drawing.settings.resolution=1;});
  // Cel 1: a real pointer stroke.
  const rect=await page.locator('#viewport').boundingBox();
  await page.mouse.move(rect.x+rect.width*.3,rect.y+rect.height*.45);await page.mouse.down();
  await page.waitForFunction(()=>Boolean(styk.drawing.gesture));
  await page.mouse.move(rect.x+rect.width*.3+120,rect.y+rect.height*.45+40,{steps:12});await page.mouse.up();
  await page.waitForFunction(()=>Boolean(styk.editor.drawingTarget().figure));
  // Cel 2: a new blank cel painted entirely at negative pixel coordinates.
  const placed=await page.evaluate(async()=>{
    const e=styk.editor,id=e.drawingTarget().id;
    e.extendDrawing([id],29);e.seek(10);e.drawingKey([id],10,{blank:true});
    window.figB=await brush(-120,-80);
    return {negative:snapBoundsNegative()};
    function snapBoundsNegative(){const e2=styk.drawing.owner.entries.get(figB._styk.drawing.celId),b=e2.store.bounds;return b.x<0||b.y<0;}
  });
  check('a second cel lives at negative pixel coordinates',placed.negative);
  await page.evaluate(()=>styk.drawing.barrier());
  const sampleCheck=await page.evaluate(()=>{
    // 5 pixel-space probes per cel must agree before and after a round trip.
    const out={};for(const f of styk.editor.report.figure_types.filter(f=>f._styk?.drawing?.version===2)){const e=styk.drawing.owner.entries.get(f._styk.drawing.celId),b=e.store.bounds,pts=[[b.x+1,b.y+1],[b.x+b.width>>1,b.y+b.height>>1],[b.x+b.width-1,b.y+b.height-1],[b.x+3,b.y+b.height-2],[b.x+b.width-3,b.y+2]];out[f._styk.drawing.celId]=pts.map(([x,y])=>[...e.store.pixel(x,y)]);}window.probes=out;return Object.keys(out).length;
  });
  check('two cels carry probe samples',sampleCheck===2);
  const first=await page.evaluate(async()=>{window.snaps=snapAll();const blob=await saveBlob();window.savedBlob=blob;return compareSaved(blob);});
  check('save and reload keep every cel byte-identical with matching bounds',first.v2===2&&first.legacy===0&&first.results.every(r=>r.exact&&r.bounds));
  const probesAfter=await page.evaluate(async()=>{
    const {ImportClient}=await import('/src/import-client.mjs'),{ pageEditor }=await import('/tests/support/page-editor.mjs'),{TileStore}=await import('/src/drawing-tiles.mjs'),{decodeTileBlob}=await import('/src/drawing-tile-codec.mjs');
    const read=await new ImportClient().importFile(new File([window.savedBlob],'saved.styk')),restored=pageEditor({demo:false,layerTimeline:true});restored.load(read.document);
    for(const f of restored.report.figure_types.filter(f=>f._styk?.drawing?.version===2)){const store=new TileStore();for(const t of await decodeTileBlob(f.image_assets[0].styk_tiles))store.set(t.tx,t.ty,t.pixels);
      const probes=window.probes[f._styk.drawing.celId];if(!probes)continue;const b=store.bounds,pts=[[b.x+1,b.y+1],[b.x+b.width>>1,b.y+b.height>>1],[b.x+b.width-1,b.y+b.height-1],[b.x+3,b.y+b.height-2],[b.x+b.width-3,b.y+2]];
      for(let i=0;i<5;i++)if(JSON.stringify([...store.pixel(...pts[i])])!==JSON.stringify(probes[i]))return false;}
    return true;
  });
  check('five pixel probes per cel match before and after reload',probesAfter);
  // undo → redo → save → reload must round-trip the same bytes.
  const undoRedo=await page.evaluate(async()=>{styk.editor.undo();styk.editor.redo();await styk.drawing.barrier();window.snaps=snapAll();return compareSaved(await saveBlob());});
  check('undo then redo then save still round-trips every cel',undoRedo.v2===2&&undoRedo.results.every(r=>r.exact&&r.bounds));
  // A save taken mid-stroke sees only the pre-stroke publication.
  await page.evaluate(()=>{window.snaps=snapAll();});
  const rect2=await page.locator('#viewport').boundingBox();
  await page.mouse.move(rect2.x+rect2.width*.5,rect2.y+rect2.height*.5);await page.mouse.down();
  await page.waitForFunction(()=>Boolean(styk.drawing.gesture));
  await page.mouse.move(rect2.x+rect2.width*.5+80,rect2.y+rect2.height*.5+30,{steps:8});
  const inflight=await page.evaluate(async()=>{const busy=styk.drawing.owner.busy;window.midBlob=await saveBlob();return {busy,gesture:Boolean(styk.drawing.gesture)};});
  await page.mouse.up();await page.waitForFunction(()=>!styk.drawing.gesture);
  const midCompare=await page.evaluate(()=>compareSaved(window.midBlob));
  check('a mid-stroke save publishes the pre-stroke revision',inflight.busy===true&&inflight.gesture&&midCompare.v2===2&&midCompare.results.every(r=>r.exact&&r.bounds));
  const intact=await page.evaluate(async()=>{await styk.drawing.barrier();const entry=styk.drawing.owner.entries.get(styk.editor.drawingTarget().figure._styk.drawing.celId),after=pix(entry.store);styk.editor.undo();const undone=pix(entry.store);styk.editor.redo();return pixEq(pix(entry.store),after)&&!pixEq(undone,after);});
  check('the finished stroke committed cleanly after the in-flight save',intact);
  // Recovery: the same drawingBarrier + export + IndexedDB write the autosave
  // path performs, then a real import of the stored record.
  const recovery=await page.evaluate(async()=>{
    const {writeBrowserRecovery,readBrowserRecovery}=await import('/src/browser-recovery.mjs');
    window.snaps=snapAll();const blob=await saveBlob();
    const written=await writeBrowserRecovery(blob,'drawing-recovery',new AbortController().signal);
    const record=await readBrowserRecovery(undefined,{id:'latest'});
    const result=record?.blob?await compareSaved(record.blob):{v2:0,results:[]};
    return {written,stored:Boolean(record?.blob),v2:result.v2,exact:result.results.every(r=>r.exact&&r.bounds)};
  });
  check('a recovery snapshot restores exact sparse tiles',recovery.written&&recovery.stored&&recovery.v2===2&&recovery.exact);
  // Replacing the document disposes the old owner and every drawing worker.
  const disposal=await page.evaluate(async()=>{
    const { pageEditor }=await import('/tests/support/page-editor.mjs'),e=styk.editor,owner=styk.drawingResourcesFor(e.report),workersBefore=owner.stats.workers;
    e.load(pageEditor({demo:false}).report);
    await owner.dispose(); // Joins the already-started disk cleanup/worker close.
    // Draw mode is still open, so a fresh empty owner exists for the new
    // report — it must spawn no workers and hold no entries.
    const fresh=styk.drawingResourcesFor(e.report);
    return {workersBefore,disposed:owner.disposed,workersAfter:owner.stats.workers,freshEntries:fresh?.stats.entries,freshWorkers:fresh?.stats.workers};
  });
  check('document replacement disposes drawing resources and workers',disposal.workersBefore>0&&disposal.disposed&&disposal.workersAfter===0&&disposal.freshWorkers===0&&disposal.freshEntries===0);
  check('no uncaught browser errors',errors.length===0);
  await writeFile(path.join(output,'save.json'),JSON.stringify({checks,errors,workers:workerScripts.filter(u=>u.includes('drawing'))},null,2));
}catch(error){await page.screenshot({path:path.join(output,'failure.png')});await writeFile(path.join(output,'save-failure.json'),JSON.stringify({message:error.message,errors,checks},null,2));throw error;}
finally{await browser.close();}
