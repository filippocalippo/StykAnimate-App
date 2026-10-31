import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
const out=process.env.STYK_HISTORY_ARTIFACTS||'artifacts/drawing-history';await mkdir(out,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[],checks=[];
page.on('pageerror',error=>errors.push(error.message));
const check=(name,value)=>{assert.ok(value,name);checks.push(name);console.log('PASS',name);};
try{
  await page.goto(process.env.STYK_URL||'http://127.0.0.1:47839');await page.waitForFunction(()=>window.styk?.ready);
  const storage=await page.evaluate(async()=>{
    const {DrawingHistoryDatabase}=await import('/src/drawing-history-database.mjs'),{historyCodec:codec,loadDrawingEngine}=await import('/src/engine/engine-drawing.mjs');await loadDrawingEngine();const name='stykanimate-history-test-'+crypto.randomUUID(),a=new DrawingHistoryDatabase({codec,name}),b=new DrawingHistoryDatabase({codec,name}),tiny=new DrawingHistoryDatabase({codec,name,maxBytes:1});
    const tiles=[{tx:-100,ty:200,before:null,after:Uint8ClampedArray.from({length:16384},(_,i)=>(i*17)%256)}];
    try{
      await a.begin(1);await a.append(1,tiles);let unpublished=false;try{await a.info(1);}catch{unpublished=true;}await a.finish(1);
      await b.begin(1);await b.append(1,tiles);await b.finish(1);const isolated=(await a.read(1,0))[0].after.every((n,i)=>n===tiles[0].after[i]);
      await tiny.begin(1);let quota=false;try{await tiny.append(1,tiles);}catch(e){quota=e.name==='QuotaExceededError';}
      await b.close();const survivesOtherClose=(await a.read(1,0))[0].tx===-100;
      const abandoned=new DrawingHistoryDatabase({codec,name,externalLease:true});await abandoned.begin(9);await abandoned.append(9,tiles);await abandoned.finish(9);abandoned.db.close();
      const sweep=new DrawingHistoryDatabase({codec,name});await sweep.open();
      const ids=await new Promise((resolve,reject)=>{const r=sweep.db.transaction('sessions').objectStore('sessions').getAllKeys();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
      const cleaned=!ids.includes(abandoned.session)&&ids.includes(a.session);await sweep.close();
      const interrupted=new DrawingHistoryDatabase({codec,name,externalLease:true});await interrupted.begin(7);await interrupted.append(7,tiles);interrupted.db.close();
      const restarted=new DrawingHistoryDatabase({codec,name,session:interrupted.session,externalLease:true});await restarted.open();
      const leftover=await new Promise((resolve,reject)=>{const r=restarted.db.transaction('chunks').objectStore('chunks').count(IDBKeyRange.bound([interrupted.session],[interrupted.session,[]]));r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
      const partialReclaimed=leftover===0&&restarted.bytes===0;await restarted.close();
      const tx=a.db.transaction('chunks','readwrite'),store=tx.objectStore('chunks'),key=[a.session,1,0],get=store.get(key);
      await new Promise((resolve,reject)=>{get.onsuccess=()=>{const value=get.result;value.checksum[0]^=255;store.put(value,key);};tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});
      let corrupt=false;try{await a.read(1,0);}catch(e){corrupt=e.message.includes('checksum');}
      return {unpublished,isolated,quota,survivesOtherClose,cleaned,partialReclaimed,corrupt};
    }finally{await a.close();await tiny.close();indexedDB.deleteDatabase(name);}
  });
  for(const [name,value] of Object.entries(storage))check('storage: '+name,value);
  await page.locator('[data-workspace-mode="draw"]').click();
  const measured=await page.evaluate(async()=>{
    const {emptyDocument}=await import('/src/demo.mjs'),e=styk.editor,d=styk.drawing;e.load(emptyDocument());e.createDrawingLayer();
    const owner=d.owner,history=owner.history;history.hotBytes=4*1024*1024;owner.busy=true;
    const target=e.prepareDrawingCel({pixelsPerUnit:1,world:{x:0,y:0}}),surface=await owner.surface(target.figure),start=performance.now();
    let rawBytes=0;
    for(let edit=0;edit<24;edit++){
      const tiles=[];for(let ty=0;ty<8;ty++)for(let tx=0;tx<16;tx++){
        const pixels=new Uint8ClampedArray(16384);for(let i=0;i<pixels.length;i+=4)pixels.set([(edit*7+tx+i)&255,(ty*13+i/4)&255,(i/4+edit*11)&255,1+(i/4)%255],i);
        const before=surface.store.get(tx,ty)?.pixels.slice()??null;rawBytes+=pixels.byteLength+(before?.byteLength??0);tiles.push({tx,ty,before,after:pixels});
      }
      e.commitDrawingPixels(edit?e.drawingTarget():target,tiles);
    }
    const commands=e._undo.length,archiveStart=performance.now(),archiveIntervals=[];let last=archiveStart;
    const archiveTimer=setInterval(()=>{const now=performance.now();archiveIntervals.push(now-last);last=now;},5);
    await history.pumping;clearInterval(archiveTimer);const archivedMs=performance.now()-archiveStart,prepareMs=archiveStart-start,stats=history.stats;history.trim(0);
    const cold=[...history.records.values()].filter(r=>!r.command.tiles).length,expected=surface.store.get(0,0).pixels.slice();
    // Restart just the worker. Its editor-owned lease protects the same disk
    // session while a separate cache opens and performs abandoned-session GC.
    history.disk.fail(Error('Test worker restart'));
    const {DrawingHistoryDisk}=await import('/src/drawing-history.mjs'),other=new DrawingHistoryDisk();await other.request('begin',{record:1});await other.close();
    const undoStart=performance.now(),undoLatencies=[],undoIntervals=[];last=undoStart;
    const undoTimer=setInterval(()=>{const now=performance.now();undoIntervals.push(now-last);last=now;},5);
    for(let i=0;i<24;i++){const t=performance.now();await d.history('undo');undoLatencies.push(performance.now()-t);}clearInterval(undoTimer);
    const undoMs=performance.now()-undoStart,blank=!e.drawingTarget().figure;
    for(let i=0;i<24;i++)await d.history('redo');const restored=await owner.surface(e.drawingTarget().figure),exact=restored.store.get(0,0).pixels.every((n,i)=>n===expected[i]);
    owner.busy=false;await d.barrier();history.trim(0);window.historyBeforeShortcut=e.revision;
    window.historyFixture={owner,history,expected,celId:e.drawingTarget().figure._styk.drawing.celId};
    return {rawBytes,commands,cold,prepareMs,archivedMs,archiveTimerMaxMs:Math.max(...archiveIntervals),undoMs,undoLatencies,undoTimerMaxMs:Math.max(...undoIntervals),blank,exact,stats,finalStats:history.stats};
  });
  check('large edits retain a chronological history beyond the old 48 MiB RAM limit',measured.rawBytes>80*1024*1024&&measured.commands>=24&&measured.cold===24);
  check('disk-backed history stays within its configured hot RAM tier',measured.stats.residentBytes<=4*1024*1024&&measured.stats.diskBytes>0);
  check('all cold edits undo and redo exactly after worker restart',measured.blank&&measured.exact);
  await page.locator('#viewport').focus();await page.keyboard.press('Control+z');await page.waitForFunction(()=>styk.editor.revision!==historyBeforeShortcut&&!styk.drawing.operation);
  check('the Undo shortcut waits for cold history to load',await page.evaluate(()=>styk.editor.drawingTarget().figure&&styk.drawing.owner.entry(styk.editor.drawingTarget().figure).store.pixel(0,0)[0]===22*7));
  await page.evaluate(()=>styk.drawing.history('redo'));
  await page.locator('#timeline-audio').click();await page.evaluate(()=>{historyFixture.history.trim(0);window.historyBeforeShortcut=styk.editor.revision;});
  await page.locator('.audio-body').press('Control+z');await page.waitForFunction(()=>styk.editor.revision!==historyBeforeShortcut&&!styk.drawing.operation);
  check('audio-panel Undo shares the drawing transaction gate',await page.evaluate(()=>styk.drawing.owner.entry(styk.editor.drawingTarget().figure).store.pixel(0,0)[0]===22*7));
  await page.locator('.audio-body').press('Control+Shift+z');await page.waitForFunction(()=>styk.drawing.owner.entry(styk.editor.drawingTarget().figure).store?.pixel(0,0)[0]===23*7&&!styk.drawing.operation);
  await page.evaluate(()=>{
    const h=historyFixture.history;h.trim(0);window.historyBeforeCancel=styk.editor.revision;window.historyReadHeld=false;window.historyDiskRequest=h.disk.request.bind(h.disk);
    h.disk.request=async(kind,data)=>{const result=await historyDiskRequest(kind,data);if(kind==='read'){window.historyReadHeld=true;await new Promise(resolve=>window.releaseHistoryRead=resolve);}return result;};
  });
  await page.locator('.audio-body').press('Control+z');await page.waitForFunction(()=>window.historyReadHeld);
  await page.locator('.audio-body').press('Escape');await page.evaluate(()=>releaseHistoryRead());await page.waitForFunction(()=>!styk.drawing.operation);
  check('Escape cancels a cold audio-panel undo without changing the document',await page.evaluate(()=>styk.editor.revision===historyBeforeCancel&&styk.drawing.owner.entry(styk.editor.drawingTarget().figure).store.pixel(0,0)[0]===23*7));
  await page.evaluate(()=>{historyFixture.history.disk.request=historyDiskRequest;});
  const saved=await page.evaluate(async()=>{
    const e=styk.editor,d=styk.drawing,{DocumentExporter}=await import('/src/document-export.mjs'),{ImportClient}=await import('/src/import-client.mjs'),exporter=new DocumentExporter(),old=historyFixture.history;
    try{const blob=await exporter.export(e.report,{format:'styk',getRevision:()=>e.revision}),read=await new ImportClient().importFile(new File([blob],'history.styk'));await old.dispose();e.load(read.document);const store=(await d.owner.surface(e.drawingTarget().figure)).store;return store.get(0,0).pixels.every((n,i)=>n===historyFixture.expected[i])&&old.disk.closed&&!old.disk.worker;}
    finally{exporter.dispose();}
  });
  check('native save remains self-contained after the disk history session closes',saved);
  await page.evaluate(()=>styk.fit());await page.waitForFunction(()=>!styk.state.editablePreparing&&!styk.state.dirtyRender);
  check('the reopened cel appears on the canvas',await page.evaluate(()=>styk.editor.evaluatedFrame.objects.length>0));
  check('no uncaught browser errors',errors.length===0);await page.screenshot({path:out+'/workspace.png'});
  await writeFile(out+'/result.json',JSON.stringify({checks,storage,measured,errors,browser:await browser.version()},null,2));console.log(JSON.stringify(measured,null,2));
}catch(error){
  const state=await page.evaluate(()=>({errors:window.__errors,dirty:styk.state.dirtyRender,renderer:styk.state.renderer.stats,frame:styk.editor.evaluatedFrame.objects.map(o=>({id:o.unique_id,type:o.figure_type_id})),owner:styk.drawing.owner.stats,previews:{active:Boolean(styk.drawing.owner.previews.active),size:styk.drawing.owner.previews.cache.size}})).catch(()=>null);
  console.error(JSON.stringify({message:error.message,errors,state},null,2));await page.screenshot({path:out+'/failure.png'});throw error;
}finally{await browser.close();}
