import assert from 'node:assert/strict';
import {chromium} from './support/playwright.mjs';
import {readFile,writeFile} from 'node:fs/promises';
const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1440,height:960}}),errors=[];
page.on('pageerror',e=>errors.push(e.message));
const settle=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
try{
  await page.goto(process.env.STYK_URL??'http://127.0.0.1:47831');await page.waitForFunction(()=>window.styk?.ready);
  await page.evaluate(async()=>{
    const {emptyDocument,createFrame,createObject}=await import('/src/demo.mjs'),r=emptyDocument();r.keyframes=[0,60].map(x=>createFrame([createObject(r.figure_types[0],1,200+x,250)],12));
    styk.settingsUI.commit({timelineMode:'advanced'});styk.editor.load(r);styk.editor.createLayer('Effects');styk.editor.select(1);styk.fit();
  });
  const field=page.getByLabel('Figure layer',{exact:true}),grid=page.getByRole('grid',{name:'Layer frames'});
  assert.equal(await field.inputValue(),'layer-1');
  await field.selectOption('layer-2');await settle();assert.equal(await page.evaluate(()=>styk.editor.layerForUid(1)),'layer-2');
  await page.keyboard.press('Control+z');await settle();assert.equal(await field.inputValue(),'layer-1');
  const cell=(tick,row=1)=>page.evaluate(async({tick,row})=>{const t=styk.timeline,b=t.scroll.getBoundingClientRect();return {x:b.x+(tick+.5)*t.pxPerTick-t._offsetX(),y:b.y+t.rowY(row+2)+t.rowSize(row+2)/2};},{tick,row});
  const click=async(tick,row=1)=>page.mouse.click(...Object.values(await cell(tick,row)));
  await click(4);await settle();await page.keyboard.press('a');
  assert.ok(await page.evaluate(()=>styk.editor.layerFrameKeys('layer-1').some(k=>k.tick===4)));
  const p=await cell(7);await page.mouse.dblclick(p.x,p.y);await settle();assert.ok(await page.evaluate(()=>styk.editor.layerFrameKeys('layer-1').some(k=>k.tick===7)));
  await page.mouse.dblclick(p.x,p.y);await settle();assert.ok(await page.getByRole('dialog',{name:'Keyframe easing'}).isVisible());await page.getByRole('button',{name:'Close easing'}).click();const spanEnd=await cell(11);await page.keyboard.down('Shift');await page.mouse.click(spanEnd.x,spanEnd.y);await page.keyboard.up('Shift');await settle();assert.deepEqual(await page.evaluate(()=>[styk.timeline.start,styk.timeline.end]),[7,11]);
  // Resize the right edge of an exposure; following keys move in one undo.
  const edge=await page.evaluate(async()=>{const t=styk.timeline,b=t.scroll.getBoundingClientRect();return {x:b.x+12*t.pxPerTick-1,y:b.y+t.rowY(3)+t.rowSize(3)/2,step:t.pxPerTick};});
  const before=await page.evaluate(()=>JSON.stringify(styk.editor.serialize()));await page.mouse.move(edge.x,edge.y);await page.mouse.down();await page.mouse.move(edge.x+3*edge.step,edge.y,{steps:5});await page.mouse.up();
  assert.deepEqual(await page.evaluate(()=>styk.editor.layerFrameKeys('layer-1').map(k=>k.tick)),[0,4,7,15]);await grid.press('Control+z');assert.equal(await page.evaluate(()=>JSON.stringify(styk.editor.serialize())),before);
  // An unselected occupied key selects a range without editing the document.
  await click(1);const selectionBefore=await page.evaluate(()=>JSON.stringify(styk.editor.serialize()));
  const start=await cell(4),end=await cell(7);await page.mouse.move(start.x,start.y);await page.mouse.down();await page.mouse.move(end.x,end.y,{steps:4});await page.mouse.up();await settle();
  assert.deepEqual(await page.evaluate(()=>[styk.timeline.start,styk.timeline.end]),[4,7]);
  assert.equal(await page.evaluate(()=>JSON.stringify(styk.editor.serialize())),selectionBefore);
  // A subsequent drag moves every selected key, with exact undo.
  const destination=await cell(6);await page.mouse.move(start.x,start.y);await page.mouse.down();await page.mouse.move(destination.x,destination.y,{steps:4});await page.mouse.up();await settle();
  assert.deepEqual(await page.evaluate(()=>styk.editor.layerFrameKeys('layer-1').map(k=>k.tick)),[0,6,9,12]);
  assert.deepEqual(await page.evaluate(()=>[styk.timeline.start,styk.timeline.end]),[6,9]);
  await grid.press('Control+z');assert.equal(await page.evaluate(()=>JSON.stringify(styk.editor.serialize())),selectionBefore);
  // Dropping a selected key on another replaces it, with one-step undo/redo.
  await click(4);await settle();
  const replaceBefore=await page.evaluate(()=>JSON.stringify(styk.editor.serialize()));
  await page.evaluate(()=>styk.settingsUI.open('animation'));
  const replacement=page.getByRole('switch',{name:'Replace keyframes on drop',exact:true});
  assert.equal(await replacement.isChecked(),true);await replacement.uncheck();
  await page.evaluate(async()=>{await styk.settingsUI.flush();styk.settingsUI.close();});
  assert.equal(await page.evaluate(async()=>{const {EDITOR_SETTINGS_KEY,normalizeEditorSettings}=await import('/src/settings.mjs');return normalizeEditorSettings(JSON.parse(localStorage.getItem(EDITOR_SETTINGS_KEY))).replaceKeyframesOnDrop;}),false);
  await page.mouse.move(start.x,start.y);await page.mouse.down();await page.mouse.move(end.x,end.y,{steps:4});await page.mouse.up();await settle();
  assert.equal(await page.evaluate(()=>JSON.stringify(styk.editor.serialize())),replaceBefore);
  await page.evaluate(()=>styk.settingsUI.open('animation'));await replacement.check();
  await page.screenshot({path:'artifacts/keyframe-replacement-setting.png'});
  await page.evaluate(async()=>{await styk.settingsUI.flush();styk.settingsUI.close();});
  await page.mouse.move(start.x,start.y);await page.mouse.down();await page.mouse.move(end.x,end.y,{steps:4});await page.mouse.up();await settle();
  assert.deepEqual(await page.evaluate(()=>styk.editor.layerFrameKeys('layer-1').map(k=>k.tick)),[0,7,12]);
  const replaceAfter=await page.evaluate(()=>JSON.stringify(styk.editor.serialize()));
  await page.screenshot({path:'artifacts/layer-key-replacement.png'});
  await grid.press('Control+z');assert.equal(await page.evaluate(()=>JSON.stringify(styk.editor.serialize())),replaceBefore);
  await grid.press('Control+Shift+z');assert.equal(await page.evaluate(()=>JSON.stringify(styk.editor.serialize())),replaceAfter);
  await grid.press('Control+z');
  await click(7);const menuPoint=await cell(7);await page.mouse.click(menuPoint.x,menuPoint.y,{button:'right'});assert.equal(await page.getByRole('menuitem',{name:/Create tween|layer/i}).count(),0);assert.equal(await page.getByRole('menuitem',{name:/Add frame/i}).count(),1);await page.getByRole('menuitem',{name:'Change easing…',exact:true}).click();await page.getByRole('radio',{name:'Ease in',exact:true}).click();await grid.press('Control+z');
  // High-polling pointers may report hundreds of positions between displays.
  // Only the latest position should evaluate, and layer DOM must stay intact.
  const fixture=await readFile(new URL('../artifacts/timeline-source.json',import.meta.url),'utf8').then(JSON.parse).catch(async error=>{
    if(error.code!=='ENOENT')throw error;const {emptyDocument,createFrame,createObject}=await import('../src/demo.mjs'),r=emptyDocument();
    r.keyframes=Array.from({length:100},(_,tick)=>createFrame(Array.from({length:80},(_,i)=>createObject(r.figure_types[0],i+1,100+i*5+tick,250)),1));return r;
  });
  await page.evaluate(report=>{styk.editor.load(report);styk.editor.selectSheetLayer('layer-1');styk.timeline.selectTrack('layer-1');},fixture);await settle();
  const ruler=await grid.boundingBox();await page.mouse.move(ruler.x+7,ruler.y+14);await page.mouse.down();await settle();
  const performance=await page.evaluate(async()=>{
    const e=styk.editor,t=styk.timeline,b=t.scroll.getBoundingClientRect(),oldSeek=e.seek,oldPaint=t._paint;let seeks=0,paints=0,mutations=0;
    e.seek=function(...args){seeks++;return oldSeek.apply(this,args);};t._paint=function(...args){paints++;return oldPaint.apply(this,args);};
    const observer=new MutationObserver(records=>mutations+=records.length);observer.observe(t.labelViewport,{subtree:true,attributes:true,childList:true,characterData:true});
    const started=performance.now();
    for(let i=0;i<240;i++)t.scroll.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerId:1,buttons:1,clientX:b.x+((i%60)+.5)*t.pxPerTick,clientY:b.y+14}));
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    const result={events:240,seeks,paints,layerMutations:mutations,tick:e.tick,elapsedMs:performance.now()-started};observer.disconnect();e.seek=oldSeek;t._paint=oldPaint;return result;
  });
  await page.mouse.up();assert.equal(performance.tick,59);assert.ok(performance.seeks<=2,JSON.stringify(performance));assert.equal(performance.layerMutations,0,JSON.stringify(performance));assert.ok(performance.paints<=1,JSON.stringify(performance));
  await writeFile('artifacts/layer-modern-scrub.json',JSON.stringify(performance,null,2));
  await page.evaluate(()=>{styk.timeline.setPaused(true);styk.editor.seek(17);styk.timeline.setPaused(false);});await settle();
  assert.deepEqual(await page.evaluate(()=>[styk.timeline.start,styk.timeline.end]),[17,17]);
  await page.evaluate(()=>{styk.editor.seek(10);styk.editor.select(styk.editor.evaluatedFrame.objects[0]?.unique_id);styk.editor.markSaved();styk.fit();});await settle();
  await page.screenshot({path:'artifacts/layer-modern-verified.png'});
  assert.deepEqual(errors,[]);console.log('PASS layer assignment, inline/double-click keys, span selection/resize, selection-first range dragging, menus, and coalesced scrubbing',performance);
}catch(error){await page.screenshot({path:'artifacts/layer-modern-failure.png'});throw error;}finally{await browser.close();}
