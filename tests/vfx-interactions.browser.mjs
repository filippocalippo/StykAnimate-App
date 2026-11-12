import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1440,height:1050}}),errors=[];
page.on('pageerror',error=>errors.push(error.message));
const snapshot=()=>page.evaluate(()=>JSON.stringify(styk.editor.report._styk.vfxClips));
const history=()=>page.evaluate(()=>styk.editor._undo.length);
const drag=async(locator,dx,{cancel=false}={})=>{await locator.scrollIntoViewIfNeeded();const b=await locator.boundingBox();await page.mouse.move(b.x+b.width/2,b.y+b.height/2);await page.mouse.down();await page.mouse.move(b.x+b.width/2+dx,b.y+b.height/2,{steps:8});if(cancel)await page.keyboard.press('Escape');await page.mouse.up();};
try{
 await page.goto(process.env.STYK_URL??'http://127.0.0.1:47831');await page.waitForFunction(()=>window.styk?.ready);
 await page.evaluate(async()=>{
  const {emptyDocument,createObject,createFrame}=await import('/src/demo.mjs'),{initializeLayerSheet}=await import('/src/editor-layer-sheet.mjs');
  const e=styk.editor,doc=emptyDocument();doc.keyframes=[createFrame([createObject(doc.figure_types[0],1,300,320)],80)];e.load(doc);initializeLayerSheet(e.report);e._invalidate({timing:true});e.select(1);
  window.clipId=e.addVfxClip({kind:'figure',uid:1},'glow',{start:0,duration:60});window.glow=e.getVfxClips()[0].effects[0].id;window.shadow=e.addVfxGroupEffect(clipId,'shadow');
  e.setVfxClip(clipId,{name:'Power up',fadeIn:4,fadeOut:8});for(const tick of [5,20])e.setVfxClipParameter(clipId,glow,'radius',12+tick,{key:true,tick});e.seek(5);e._selectedVfxClip=clipId;e._emit('vfx-selection');
  window.appErrors=[];styk.vfx.onError=error=>appErrors.push(error.message);styk.vfxGizmos.onError=error=>appErrors.push(error.message);
 });
 await page.getByRole('tab',{name:'VFX',exact:true}).click();
 const panel=page.locator('#vfx-panel'),glowRow=panel.locator('[data-group-effect]').filter({has:page.getByRole('button',{name:'Reorder Glow',exact:true})}),shadowRow=panel.locator('[data-group-effect]').filter({has:page.getByRole('button',{name:'Reorder Shadow',exact:true})});
 await glowRow.locator(':scope > summary').evaluate(n=>{if(!n.parentElement.open)n.click();});const radius=page.getByRole('spinbutton',{name:'Glow Radius',exact:true});await radius.click();
 assert.match(await panel.getByRole('button',{name:'Visible effect keys',exact:true}).innerText(),/Glow · Radius/);
 let before=await snapshot(),n=await history();await drag(radius,15);let after=await snapshot();assert.notEqual(after,before);assert.equal(await history(),n+1);
 await page.keyboard.press('Control+z');assert.equal(await snapshot(),before);await page.keyboard.press('Control+Shift+z');assert.equal(await snapshot(),after);await page.keyboard.press('Control+z');
 // Undo must commit a typed preview before undoing it, while focus is in the input.
 await radius.fill('39');await radius.press('Control+z');assert.equal(await snapshot(),before);
 n=await history();await drag(radius,12,{cancel:true});assert.equal(await snapshot(),before);assert.equal(await history(),n);
 await drag(panel.getByRole('spinbutton',{name:'Strength',exact:true}),-25);assert.equal(await page.evaluate(()=>styk.editor.getVfxClips()[0].strength),.75);await page.keyboard.press('Control+z');assert.equal(await snapshot(),before);
 await drag(panel.getByRole('spinbutton',{name:'Duration',exact:true}),5);assert.equal(await page.evaluate(()=>styk.editor.getVfxClips()[0].duration),65);await page.keyboard.press('Control+z');assert.equal(await snapshot(),before);
 // Both buttons and drag handles operate on group members without changing keys.
 await glowRow.hover();await glowRow.getByRole('button',{name:'Effect actions',exact:true}).click();await page.getByRole('menuitem',{name:'Move down',exact:true}).click();assert.deepEqual(await page.evaluate(()=>styk.editor.getVfxClips()[0].effects.map(e=>e.type)),['shadow','glow']);await page.keyboard.press('Control+z');assert.equal(await snapshot(),before);
 await glowRow.getByRole('button',{name:'Reorder Glow',exact:true}).dragTo(shadowRow.locator(':scope > summary'));assert.deepEqual(await page.evaluate(()=>styk.editor.getVfxClips()[0].effects.map(e=>e.type)),['shadow','glow']);await page.keyboard.press('Control+z');assert.equal(await snapshot(),before);
 await glowRow.getByRole('button',{name:'Reorder Glow',exact:true}).focus();await page.keyboard.press('Alt+ArrowDown');assert.deepEqual(await page.evaluate(()=>styk.editor.getVfxClips()[0].effects.map(e=>e.type)),['shadow','glow']);await page.keyboard.press('Control+z');assert.equal(await snapshot(),before);
 // Selecting a group member restores its on-canvas handles.
 await shadowRow.locator(':scope > summary').click();await page.waitForFunction(()=>styk.vfxGizmos.handles.some(h=>h.kind==='offset'));
 const handle=await page.evaluate(()=>{const h=styk.vfxGizmos.handles.find(h=>h.kind==='offset'),r=styk.vfxGizmos.canvas.getBoundingClientRect();return {x:h.screen.x+r.left,y:h.screen.y+r.top};});
 n=await history();await page.mouse.move(handle.x,handle.y);await page.mouse.down();await page.mouse.move(handle.x+30,handle.y+15,{steps:8});await page.mouse.up();assert.notEqual(await snapshot(),before);assert.equal(await history(),n+1);await page.keyboard.press('Control+z');assert.equal(await snapshot(),before);
 await page.mouse.move(handle.x,handle.y);await page.mouse.down();await page.mouse.move(handle.x+25,handle.y,{steps:6});await page.keyboard.press('Escape');await page.mouse.up();assert.equal(await snapshot(),before);
 // An unkeyed value can be selected and keyed from the compact navigation strip.
 const opacity=page.getByRole('spinbutton',{name:'Shadow Opacity',exact:true});await opacity.click();assert.match(await panel.getByRole('button',{name:'Visible effect keys',exact:true}).innerText(),/Opacity/);
 await panel.getByRole('button',{name:'Add selected value key',exact:true}).click();assert.equal(await page.evaluate(()=>Object.keys(styk.editor.getVfxClips()[0].keys).length),2);await page.keyboard.press('Control+z');assert.equal(await snapshot(),before);
 await glowRow.locator(':scope > summary').evaluate(n=>{if(!n.parentElement.open)n.click();});await radius.click();await radius.press('Enter');
 const key=await page.evaluate(()=>{const t=styk.timeline,row=t.tracks.findIndex(r=>r.kind==='vfx'),r=t.scroll.getBoundingClientRect();return {x:r.left+20.5*t.pxPerTick-t._offsetX(),y:r.top+t.rowY(row)+t.rowSize(row)-9};});
 await page.mouse.click(key.x,key.y);assert.equal(await page.evaluate(()=>styk.editor.tick),20);assert.equal(await snapshot(),before);
 await page.keyboard.press('ArrowRight');assert.equal(await page.evaluate(()=>styk.editor.tick),21);assert.equal(await page.evaluate(()=>Object.values(styk.editor.getVfxClips()[0].keys)[0][1].tick),21);await page.keyboard.press('Control+z');assert.equal(await snapshot(),before);
 await page.mouse.move(600,100);await fs.mkdir('artifacts/vfx',{recursive:true});await page.screenshot({path:'artifacts/vfx/interactions-light.png'});await page.evaluate(()=>{document.documentElement.dataset.theme='dark';window.dispatchEvent(new Event('styk-theme-change'));});await page.screenshot({path:'artifacts/vfx/interactions-dark.png'});
 const contrast=await page.locator('.vfx-key-field.is-channel-selected').evaluate(row=>{const luminance=color=>{const c=color.match(/[\d.]+/g).slice(0,3).map(n=>{const v=Number(n)/255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;});return .2126*c[0]+.7152*c[1]+.0722*c[2];},a=luminance(getComputedStyle(row).backgroundColor),b=luminance(getComputedStyle(row.querySelector('label')).color);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);});assert.ok(contrast>=4.5,`Dark selection contrast ${contrast}`);
 assert.equal(await panel.locator('.vfx-clip-effect[open]').count(),1);
 errors.push(...await page.evaluate(()=>appErrors));assert.deepEqual(errors,[]);console.log(JSON.stringify({errors,numericUndo:true,typedUndo:true,cancel:true,groupReorder:true,canvasControls:true,valueSelection:true,keyNavigation:true}));
}catch(error){await fs.mkdir('artifacts/vfx',{recursive:true});await page.screenshot({path:'artifacts/vfx/interactions-failure.png'});throw error;}finally{await browser.close();}
