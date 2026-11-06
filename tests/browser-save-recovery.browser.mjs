// Project save acknowledgements and recovery ownership through the real editor.
// Uses the static browser build by default; STYK_URL can target a source server.
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {launchBrowser} from './support/cross-browser.mjs';
import {buildWeb} from '../scripts/build-web.mjs';
import {startWebServer} from '../scripts/serve-web.mjs';

const temp = await mkdtemp(path.join(os.tmpdir(), 'styk-save-recovery-'));
const site = process.env.STYK_URL ? {origin:process.env.STYK_URL, close:async()=>{}}
  : await startWebServer({root:(await buildWeb({output:path.join(temp,'site')})).output});
const browser = await launchBrowser();
const checks=[], errors=[];
const check=(name,value)=>{assert.ok(value,name);checks.push(name);console.log('PASS',name);};
async function open(context){
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  await page.goto(site.origin);await page.waitForFunction(()=>window.styk?.ready===true);
  await page.evaluate(()=>{document.querySelector('.styk-privacy [data-decline]')?.click();styk.settingsUI.commit({autosaveSeconds:0});});
  return page;
}
const edit=page=>page.evaluate(()=>{const e=styk.editor;e.select(e.frame.objects[0].unique_id,-1);e.beginTranslationDrag();e.moveSelection(20,0,{fromStart:true});e.commitDrag();});
const recovery=page=>page.evaluate(async()=>{const r=await(await import('/src/browser-recovery.mjs')).readBrowserRecovery();return r&&{name:r.name,size:r.blob.size};});
async function picker(page,mode){
  await page.evaluate(mode=>{
    window.__write={mode,parts:[],committed:false,aborted:false};
    window.showSaveFilePicker=async()=>{
      if(mode==='cancel')throw new DOMException('Cancelled','AbortError');
      return {name:'animation.styk',createWritable:async()=>({
        async write(part){__write.parts.push(part);},
        async close(){if(mode==='fail')throw new Error('Disk write failed');__write.committed=true;},
        async abort(){__write.aborted=true;},
      })};
    };
  },mode);
}
async function clickSave(page){
  // Keep the actual input task/user activation, and capture the command result.
  await page.evaluate(()=>{const save=styk.actions.save;styk.actions.save=(...args)=>{window.__saved=save(...args);return __saved;};});
  await page.locator('[data-action="save"]').first().click();
  return page.evaluate(()=>window.__saved);
}

try{
  const context=await browser.newContext({acceptDownloads:false});
  await context.addInitScript(()=>{delete window.showSaveFilePicker;});
  const page=await open(context);await edit(page);
  const download=page.waitForEvent('download');
  const saved=await page.evaluate(()=>styk.actions.save());
  const failure=await(await download).failure();
  check('A rejected download never reports a committed save',saved===false&&!!failure);
  check('The rejected download keeps the document edited',await page.evaluate(()=>styk.editor.dirty));
  check('Manual download saves keep recovery even with timed autosave disabled',(await recovery(page))?.size>100);

  await picker(page,'cancel');
  check('Cancelling the destination leaves unsaved work and recovery',await clickSave(page)===false&&await page.evaluate(()=>styk.editor.dirty)&&!!await recovery(page));
  await page.evaluate(()=>{window.showSaveFilePicker=undefined;window.__replacement=styk.actions['close-project']();});
  const refused=page.waitForEvent('download');
  await page.locator('#save-changes').click();
  await refused;await page.locator('#keep-editing').waitFor();
  check('A download cannot silently approve closing unsaved work',await page.locator('#keep-editing').isVisible()&&await page.evaluate(()=>styk.editor.dirty));
  await page.locator('#keep-editing').click();await page.evaluate(()=>window.__replacement);
  await picker(page,'fail');
  await assert.rejects(()=>clickSave(page),/Disk write failed/);
  check('A failed commit aborts its swap file and retains unsaved work',await page.evaluate(()=>__write.aborted&&!__write.committed&&styk.editor.dirty)&&!!await recovery(page));

  await picker(page,'success');
  check('Only an acknowledged file commit reports a saved project',await clickSave(page)===true&&await page.evaluate(()=>__write.committed&&!styk.editor.dirty));
  check('An acknowledged save clears its recovery copy',!await recovery(page));
  const roundTrip=await page.evaluate(async()=>{
    const blob=new Blob(__write.parts),file=new File([blob],'animation.styk');
    const decoded=await styk.importFiles([file]);
    return styk.editor.frame.objects.length>0&&styk.editor.name==='animation';
  });
  check('The committed project reopens through the ordinary import path',roundTrip);

  // Two live pages have independent ownership. Saving A must never delete B.
  const other=await open(context);
  await edit(page);await edit(other);
  await other.evaluate(()=>{styk.editor.name='Second tab';});
  await page.evaluate(()=>{delete window.showSaveFilePicker;return styk.actions.save();});
  await other.evaluate(()=>styk.actions.save());
  const copies=await page.evaluate(async()=> (await import('/src/browser-recovery.mjs')).listBrowserRecovery());
  check('Two tabs retain two independent recovery copies',copies.length===2&&new Set(copies.map(r=>r.id)).size===2);
  // A page owns one copy per open project; neither its own live copies nor another live tab's are offered back.
  check('A live copy is excluded from another tab’s recovery offers',await page.evaluate(async()=> (await styk.recovery.list()).length===0));
  await picker(page,'success');await clickSave(page);
  check('Saving one tab leaves the other tab’s recovery intact',(await recovery(page))?.name==='Second tab');
  check('A live tab’s copy cannot be discarded by another tab',await page.evaluate(async record=>!await styk.recovery.discard(record),copies.find(r=>r.name==='Second tab')));
  await other.close();
  await page.reload();await page.waitForFunction(()=>window.styk?.ready);
  await page.getByRole('button',{name:'Restore',exact:true}).click();
  await page.waitForFunction(()=>styk.editor.name==='Second tab'&&styk.editor.dirty);
  check('An abandoned tab’s project restores through the ordinary importer',true);
  await picker(page,'success');await clickSave(page);
  check('Saving a restored copy clears its adopted key',!await recovery(page));

  // Multiple abandoned copies can be selected and explicitly discarded.
  const third=await open(context),fourth=await open(context);
  for(const [tab,name] of [[third,'Third tab'],[fourth,'Fourth tab']]){
    await edit(tab);await tab.evaluate(name=>{styk.editor.name=name;return styk.actions.save();},name);await tab.close();
  }
  await page.reload();await page.waitForFunction(()=>window.styk?.ready);
  await page.getByRole('button',{name:'Restore',exact:true}).click();
  const chooser=page.getByRole('combobox',{name:'Recovery copy'});
  await chooser.waitFor();
  const thirdKey=await page.evaluate(async()=> (await styk.recovery.list()).find(r=>r.name==='Third tab').id);
  await chooser.selectOption(thirdKey);
  await page.getByRole('button',{name:'Discard copy',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('[aria-label="Recovery copy"]').options.length===1);
  check('Discard removes only the selected abandoned copy',(await recovery(page))?.name==='Fourth tab');
  await page.getByRole('contentinfo').getByRole('button',{name:'Restore',exact:true}).click();
  await page.waitForFunction(()=>styk.editor.name==='Fourth tab'&&styk.editor.dirty);
  check('The remaining selected copy restores independently',true);
  await picker(page,'success');await clickSave(page);

  const storage=await page.evaluate(async()=>{
    const m=await import('/src/browser-recovery.mjs');
    const bytes=new ArrayBuffer(4096);
    await styk.recovery.write(bytes,'old');const stale=(await styk.recovery.list())[0];
    await styk.recovery.write(bytes,'new');const staleProtected=!await styk.recovery.discard(stale);
    await styk.recovery.clear();
    for(let i=0;i<m.MAX_RECOVERY_COPIES;i++)await m.writeBrowserRecovery(bytes,'capacity '+i,undefined,undefined,{id:'capacity-'+i});
    let rejected=false;try{await m.writeBrowserRecovery(bytes,'overflow',undefined,undefined,{id:'overflow'});}catch{rejected=true;}
    const full=await m.listBrowserRecovery();
    const preserved=rejected&&full.length===m.MAX_RECOVERY_COPIES&&!full.some(r=>r.id==='overflow');
    // Updating one's own copy is allowed at the count limit.
    await m.writeBrowserRecovery(bytes,'replacement',undefined,undefined,{id:'capacity-0'});
    const replacement=(await m.readBrowserRecovery(undefined,{id:'capacity-0'})).name==='replacement';
    for(const record of await m.listBrowserRecovery())await m.clearBrowserRecovery(undefined,record);
    return {staleProtected,preserved,replacement};
  });
  check('Stale discard actions cannot erase a newer snapshot',storage.staleProtected);
  check('Recovery capacity rejection preserves every existing copy',storage.preserved&&storage.replacement);
  await context.close();

  const switchedContext=await browser.newContext(),switched=await open(switchedContext);
  await edit(switched);
  await switched.evaluate(()=>{
    window.__stale={writes:0,aborted:false};
    window.showSaveFilePicker=()=>new Promise(resolve=>window.__destination=()=>resolve({createWritable:async()=>({
      write:async()=>{__stale.writes++;},close:async()=>{},abort:async()=>{__stale.aborted=true;},
    })}));
    const save=styk.actions.save;styk.actions.save=()=>window.__saving=save();
  });
  await switched.locator('[data-action="save"]').first().click();
  await switched.waitForFunction(()=>typeof window.__destination==='function');
  await switched.evaluate(()=>{styk.editor.newDocument();__destination();});
  check('Replacing the project during destination selection aborts the obsolete write',await switched.evaluate(async()=>await __saving===false&&__stale.writes===0&&__stale.aborted));
  await switchedContext.close();

  // Migrate the prior singleton's bytes in place, then prove listing does not
  // deserialize projects (important when copies contain large drawings/media).
  const legacyContext=await browser.newContext(),legacy=await legacyContext.newPage();
  legacy.on('pageerror',error=>errors.push(error.message));await legacy.goto(site.origin+'/mark.svg');
  await legacy.evaluate(()=>new Promise((resolve,reject)=>{
    const request=indexedDB.open('stykanimate-recovery',1);
    request.onupgradeneeded=()=>request.result.createObjectStore('documents');
    request.onerror=()=>reject(request.error);
    request.onsuccess=()=>{const db=request.result,tx=db.transaction('documents','readwrite');
      tx.objectStore('documents').put({name:'Legacy project',savedAt:Date.now(),data:new Uint8Array([1,2,3,4]).buffer},'latest');
      tx.oncomplete=()=>{db.close();resolve();};tx.onabort=()=>reject(tx.error);
    };
  }));
  await legacy.goto(site.origin);await legacy.waitForFunction(()=>window.styk?.ready);
  const migration=await legacy.evaluate(async()=>{
    const m=await import('/src/browser-recovery.mjs'),record=await m.readBrowserRecovery();
    const bytes=Array.from(new Uint8Array(await record.blob.arrayBuffer()));
    let reads=0;const original=IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get=function(...args){if(this.name==='documents')reads++;return original.apply(this,args);};
    try{const records=await styk.recovery.list();return {bytes,reads,metadata:records[0]};}
    finally{IDBObjectStore.prototype.get=original;}
  });
  check('The prior recovery format migrates without changing its bytes',migration.bytes.join(',')==='1,2,3,4'&&migration.metadata.name==='Legacy project');
  check('Recovery listing reads metadata without loading project bytes',migration.reads===0&&!('blob' in migration.metadata)&&!('data' in migration.metadata));
  await legacyContext.close();
  check('No uncaught browser errors',errors.length===0);
  console.log(`${checks.length} checks passed`);
}finally{await browser.close();await site.close();await rm(temp,{recursive:true,force:true});}
