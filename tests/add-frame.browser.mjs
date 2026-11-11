import assert from 'node:assert/strict';
import {chromium} from './support/playwright.mjs';
import {openAppMenu,closeAppMenus} from './support/app-menu.mjs';
import {mkdir} from 'node:fs/promises';
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:960}}), errors=[];
page.on('pageerror',e=>errors.push(e.message));
const snap=()=>page.evaluate(()=>({tick:styk.editor.tick,duration:styk.editor.totalTicks,keys:styk.editor.layerFrameKeys('layer-1').map(k=>k.tick)}));
const cell=async(tick,layer='layer-1')=>{const box=await page.evaluate(([tick,layer])=>{const t=styk.timeline,r=t.scroll.getBoundingClientRect();const i=t.tracks.findIndex(l=>l.id===layer);return{x:r.x+(tick+.5)*t.pxPerTick,y:r.y+t.rowY(i)+t.rowSize(i)/2};},[tick,layer]);await page.mouse.click(box.x,box.y);};
const ruler=async tick=>{const box=await page.evaluate(tick=>{const t=styk.timeline,r=t.scroll.getBoundingClientRect();return{x:r.x+(tick+.5)*t.pxPerTick,y:r.y+16};},tick);await page.mouse.click(box.x,box.y);};
try {
 await page.goto(process.env.STYK_URL||'http://127.0.0.1:47831');await page.waitForFunction(()=>window.styk?.ready);
 await page.evaluate(async()=>{const {emptyDocument,createFrame,createObject}=await import('/src/demo.mjs');const r=emptyDocument();r.keyframes=[0,40].map(x=>createFrame([createObject(r.figure_types[0],1,200+x,250)],12));styk.editor.load(r);styk.editor.select(1);styk.fit();});
 await cell(5);const original=await snap();await page.keyboard.press('a');
 assert.deepEqual(await snap(),{...original,keys:[0,5,12]});
 // Add Frame on an existing key duplicates the pose into the following cell and shifts later keys.
 await page.keyboard.press('a');assert.deepEqual(await snap(),{tick:6,duration:original.duration+1,keys:[0,5,6,13]});
 await cell(7);await page.locator('.sheet-frame-tools [data-hotkey-command="add-frame"]').click();assert.deepEqual((await snap()).keys,[0,5,6,7,13]);
 // Off a key after non-cell navigation, Add Frame still inserts at the playhead.
 await page.locator('#viewport').focus();await ruler(8);const before=await snap();
 await page.locator('.sheet-frame-tools [data-hotkey-command="add-frame"]').click();assert.deepEqual(await snap(),{tick:8,duration:before.duration,keys:[0,5,6,7,8,13]});
 await page.locator('.sheet-frame-tools [data-hotkey-command="add-frame"]').click();assert.deepEqual(await snap(),{tick:9,duration:before.duration+1,keys:[0,5,6,7,8,9,14]});
 await page.locator('.sheet-frame-tools [data-hotkey-command="add-frame"]').click();assert.equal((await snap()).tick,10);
 await page.keyboard.press('Control+z');assert.equal((await snap()).tick,9);await page.keyboard.press('Control+Shift+z');assert.equal((await snap()).tick,10);
 // A layer with no figures shows its added frames as visible blank cells.
 await page.evaluate(()=>{const l=styk.editor.createLayer('Empty');styk.timeline._selectLayer(l.id);styk.timeline.seek(4);});
 await page.keyboard.press('a');assert.deepEqual(await page.evaluate(()=>styk.editor.layerFrameKeys('layer-2').map(k=>[k.tick,k.empty])),[[4,true]]);
 await cell(20,'layer-2');
 await page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));
 const painted=await page.evaluate(()=>{const t=styk.timeline,c=t.canvas.getContext('2d'),row=t.tracks.findIndex(l=>l.id==='layer-2'),y=Math.round(t.rowY(row)+t.rowSize(row)/2);
   const px=x=>[...c.getImageData(Math.round(x-t._offsetX()),y,1,1).data].slice(0,3),bg=px(15.5*t.pxPerTick);let count=0;
   for(let dx=-5;dx<=5;dx++)if(px(4.5*t.pxPerTick+dx).some((v,i)=>Math.abs(v-bg[i])>24))count++;return count;});
 assert.ok(painted>2);
 await cell(30);await page.keyboard.press('a');assert.equal((await snap()).tick,30);assert.ok((await snap()).keys.includes(30));
 // Placing a keyframe beyond a layer's end carries its last exposure forward instead of padding blank cells.
 assert.deepEqual(await page.evaluate(()=>styk.editor.layerFrameKeys('layer-1').filter(k=>k.empty).map(k=>k.tick)),[]);
 assert.equal(await page.evaluate(()=>{styk.editor.seek(20,{allowBeyondEnd:true});return styk.editor.evaluatedFrame.objects.length;}),1);
 await page.evaluate(()=>styk.editor.setLayerLocked('layer-1',true));const locked=await snap();await page.keyboard.press('a');assert.deepEqual(await snap(),locked);
 await page.evaluate(()=>styk.editor.setLayerLocked('layer-1',false));
 const animationMenu=await openAppMenu(page,'animation');assert.equal(await animationMenu.locator('[data-action="add-frame"]').count(),1);assert.equal(await animationMenu.locator('[data-action="blank-frame"],[data-action="duplicate-frame-after"]').count(),0);await closeAppMenus(page);
 await mkdir('artifacts/add-frame',{recursive:true});await page.screenshot({path:'artifacts/add-frame/advanced.png'});
 await page.evaluate(()=>{styk.settingsUI.commit({timelineMode:'simple'});styk.editor.seek(5);});const simple=await snap();await page.getByRole('button',{name:'Add Frame',exact:true}).click();assert.equal((await snap()).tick,6);assert.equal((await snap()).duration,simple.duration+1);
 await page.screenshot({path:'artifacts/add-frame/simple.png'});
 assert.deepEqual(errors,[]);console.log('PASS selected cells, repeated keys/buttons, canvas focus, undo/redo, beyond-end cells, locked layers, menus and simple mode');
}finally{await browser.close();}

