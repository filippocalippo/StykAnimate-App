import {_electron as electron} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';

const root=path.resolve('.'),out=path.join(root,'artifacts/drawing-history'),profile=path.join(out,`profile-${Date.now()}`),checks=[];
await mkdir(profile,{recursive:true});
await writeFile(path.join(profile,'telemetry-state.json'),JSON.stringify({decided:true,consent:{analytics:false,diagnostics:false,policyVersion:'2026-09-10',updatedAt:Date.now()}}));
const env={...process.env,STYK_USER_DATA_DIR:profile,STYK_LIBRARY_DIR:path.join(profile,'library')};delete env.ELECTRON_RUN_AS_NODE;
const check=(name,value)=>{assert.ok(value,name);checks.push(name);console.log('PASS',name);};
const applications=[];
const launch=async()=>{const app=await electron.launch({args:[root],cwd:root,env,timeout:45000});applications.push(app);app.process().stderr.on('data',data=>process.stderr.write(data));const page=await app.firstWindow();await page.waitForFunction(()=>window.styk?.ready,undefined,{timeout:30000});return {app,page};};
try{
  const first=await launch();
  const saved=await first.page.evaluate(async()=>{
    const e=styk.editor,d=styk.drawing;e.createDrawingLayer();const owner=e.drawingResources;d.bind();const h=owner.history;h.hotBytes=0;
    const target=e.prepareDrawingCel(),surface=await d.owner.surface(target.figure);
    const tiles=Array.from({length:8},(_,tx)=>({tx,ty:0,before:null,after:Uint8ClampedArray.from({length:16384},(_,i)=>(i+tx)%256)}));e.commitDrawingPixels(target,tiles);await h.pumping;
    const cold=h.stats.residentBytes===0&&h.stats.diskBytes>0;await d.history('undo');const undone=!e.drawingTarget().figure;await d.history('redo');
    const exact=surface.store.get(0,0).pixels.every((n,i)=>n===tiles[0].after[i]);await d.barrier();
    const {DocumentExporter}=await import('/src/document-export.mjs'),exporter=new DocumentExporter();
    try{
      const blob=await exporter.export(e.report,{format:'styk',getRevision:()=>e.revision}),bytes=new Uint8Array(await blob.arrayBuffer());let binary='';
      for(let offset=0;offset<bytes.length;offset+=32768)binary+=String.fromCharCode(...bytes.subarray(offset,offset+32768));
      const data=btoa(binary),recovery=await stykDesktop.saveRecovery({data,name:'Drawing history restart'});
      return {cold,undone,exact,recovery:recovery.saved,data,origin:location.origin,history:h.stats};
    }finally{exporter.dispose();}
  });
  check('desktop workers archive and restore exact cold undo',saved.cold&&saved.undone&&saved.exact&&saved.recovery);
  const cdp=await first.page.context().newCDPSession(first.page),usage=await cdp.send('Storage.getUsageAndQuota',{origin:saved.origin});
  const bytes=usage.usageBreakdown.find(entry=>entry.storageType==='indexeddb')?.usage??0;check('the desktop test actually wrote an IndexedDB cache',bytes>0);
  const closed=first.app.waitForEvent('close');await first.app.evaluate(({app})=>app.exit(0)).catch(()=>{});await closed;
  const second=await launch(),nextCdp=await second.page.context().newCDPSession(second.page),after=await nextCdp.send('Storage.getUsageAndQuota',{origin:saved.origin});
  check('startup reclaims the previous launch\'s cache',after.usageBreakdown.every(entry=>entry.storageType!=='indexeddb'||entry.usage===0));
  const recovered=await second.page.evaluate(async()=>{
    const recovery=await stykDesktop.getRecovery(),{ImportClient}=await import('/src/import-client.mjs');
    const read=await new ImportClient().importFile(new File([Uint8Array.from(atob(recovery.data),c=>c.charCodeAt(0))],'history-recovery.styk'));styk.editor.load(read.document);
    const surface=await styk.drawing.owner.surface(styk.editor.drawingTarget().figure);
    return {data:recovery.data,exact:surface.store.get(0,0).pixels.every((n,i)=>n===i%256)};
  });
  check('native drawing recovery survives cache cleanup and a restart',recovered.data===saved.data&&recovered.exact);
  await writeFile(path.join(out,'desktop-result.json'),JSON.stringify({checks,cacheBytesBefore:bytes,history:saved.history},null,2));
}finally{for(const app of applications)await app.evaluate(({app})=>app.exit(0)).catch(()=>{});}
