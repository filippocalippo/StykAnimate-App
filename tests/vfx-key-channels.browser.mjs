import {chromium} from './support/playwright.mjs';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
page.on('pageerror',e=>errors.push(e.message));
try{
 await page.goto(process.env.STYK_URL||'http://127.0.0.1:47831');await page.waitForFunction(()=>window.styk?.ready);
 await page.evaluate(async()=>{
  const {emptyDocument,createObject,createFrame}=await import('/src/demo.mjs'),{initializeLayerSheet}=await import('/src/editor-layer-sheet.mjs'),{vfxProperty}=await import('/src/vfx.mjs');
  const e=styk.editor,doc=emptyDocument();doc.keyframes=[createFrame([createObject(doc.figure_types[0],1,320,340)],80)];e.load(doc);initializeLayerSheet(e.report);e._invalidate({timing:true});e.select(1);
  const id=e.addVfxClip({kind:'figure',uid:1},'glow',{start:5,duration:60}),fx=e.getVfxClips()[0].effects[0],second=e.addVfxGroupEffect(id,'glow');e.setVfxClip(id,{name:'Power up',fadeIn:5,fadeOut:8});
  for(const tick of [5,20,45]){e.setVfxClipParameter(id,fx.id,'radius',12,{key:true,tick});e.setVfxClipParameter(id,fx.id,'intensity',.8,{key:true,tick});e.setVfxClipParameter(id,second,'radius',18,{key:true,tick});}
  e.setVfxClipParameter(id,fx.id,'intensity',.7,{key:true,tick:22});
  window.radius=vfxProperty('glow',fx.id,'radius');window.intensity=vfxProperty('glow',fx.id,'intensity');window.clipId=id;
  e.seek(20);styk.vfx.setVisible(true);e._selectedVfxClip=id;e._emit('vfx-selection');e.markSaved();window.before=JSON.stringify(e.report._styk.vfxClips);window.beforeTracks=styk.timeline.tracks;
  const onError=styk.vfx.onError;styk.vfx.onError=error=>{errorsInApp.push(error.message);onError(error);};window.errorsInApp=[];
 });
 await page.getByRole('tab',{name:'VFX',exact:true}).click();
 const inspector=page.locator('#vfx-panel'),trigger=inspector.getByRole('button',{name:'Visible effect keys',exact:true}),dialog=page.getByRole('dialog',{name:'Visible effect keys',exact:true});
 await trigger.click();await dialog.waitFor({state:'visible'});
 await page.evaluate(()=>window.beforeTracks=styk.timeline.tracks);
 assert.equal(await dialog.getByRole('checkbox').count(),5);
 await dialog.getByRole('button',{name:'None',exact:true}).click();assert.equal(await trigger.innerText(),'No keys');
 assert.equal(await page.evaluate(()=>styk.editor.dirty),false);assert.equal(await page.evaluate(()=>JSON.stringify(styk.editor.report._styk.vfxClips)),await page.evaluate(()=>before));
 await dialog.locator('.vfx-channel-option').first().hover();await dialog.getByRole('button',{name:'Only Glow 1 Radius',exact:true}).click();
 await dialog.waitFor({state:'hidden'});assert.match(await trigger.innerText(),/Glow 1 · Radius/);
 assert.equal(await page.evaluate(()=>styk.timeline.tracks===beforeTracks),true);
 const hidden=await page.evaluate(()=>JSON.stringify(styk.editor.getVfxClips()[0].keys[intensity]));
 const point=await page.evaluate(()=>{const t=styk.timeline,row=t.tracks.findIndex(r=>r.kind==='vfx'),r=t.scroll.getBoundingClientRect();return {x:r.left+20.5*t.pxPerTick-t._offsetX(),y:r.top+t.rowY(row)+t.rowSize(row)-9,dx:2*t.pxPerTick};});
 await page.mouse.move(point.x,point.y);await page.mouse.down();await page.mouse.move(point.x+point.dx,point.y,{steps:8});await page.mouse.up();
 assert.deepEqual(await page.evaluate(()=>styk.editor.getVfxClips()[0].keys[radius].map(k=>k.tick)),[0,17,40]);assert.equal(await page.evaluate(()=>JSON.stringify(styk.editor.getVfxClips()[0].keys[intensity])),hidden);
 await page.keyboard.press('Delete');assert.deepEqual(await page.evaluate(()=>styk.editor.getVfxClips()[0].keys[radius].map(k=>k.tick)),[0,40]);assert.equal(await page.evaluate(()=>JSON.stringify(styk.editor.getVfxClips()[0].keys[intensity])),hidden);
 await page.keyboard.press('Control+z');await page.keyboard.press('Control+z');assert.equal(await page.evaluate(()=>JSON.stringify(styk.editor.report._styk.vfxClips)),await page.evaluate(()=>before));
 await page.locator('.sheet-layer[data-kind=vfx]').getByRole('button',{name:'Visible effect keys',exact:true}).click();await dialog.getByRole('button',{name:'All',exact:true}).click();
 await dialog.getByRole('checkbox',{name:'Glow 2',exact:true}).uncheck();assert.equal(await trigger.innerText(),'Glow 1');
 await page.keyboard.press('Escape');assert.equal(await dialog.count(),0);
 await inspector.locator('.vfx-clip-effect>summary').first().click();await page.mouse.move(500,100);await fs.mkdir('artifacts/vfx',{recursive:true});
 await page.screenshot({path:'artifacts/vfx/channels-light.png'});
 await page.evaluate(()=>{document.documentElement.dataset.theme='dark';window.dispatchEvent(new Event('styk-theme-change'));});
 await trigger.click();await dialog.waitFor({state:'visible'});await page.screenshot({path:'artifacts/vfx/channels-menu-dark.png'});
 await page.evaluate(()=>styk.editor.select(null));await dialog.waitFor({state:'hidden'});
 errors.push(...await page.evaluate(()=>errorsInApp));assert.deepEqual(errors,[]);console.log(JSON.stringify({errors,filteredDrag:true,hiddenKeysPreserved:true,undo:true,sharedFilter:true,viewOnly:true}));
}catch(error){await page.screenshot({path:'artifacts/vfx/channels-failure.png'});throw error;}finally{await browser.close();}
