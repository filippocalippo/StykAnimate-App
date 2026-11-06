import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
const output='artifacts/rig-constraints';await mkdir(output,{recursive:true});
page.on('pageerror',e=>errors.push(e.message));
const settle=()=>page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
// Rig is a titled section: it opens by itself while the part has a rig, else from its title.
const openRig=async()=>{const toggle=page.locator('[data-section-toggle="rig-controls"]');if(await toggle.getAttribute('aria-expanded')==='false')await toggle.click();};
try{
  await page.goto(process.env.STYK_URL??'http://127.0.0.1:47851');await page.waitForFunction(()=>window.styk?.ready);
  const rigs=await page.evaluate(async()=>{const m=await import('/src/rig-examples.mjs');return m.RIG_EXAMPLES.map(r=>({id:r.id,control:r.control}));});
  for(const r of rigs){
    await page.evaluate(async r=>{const {rigExampleDocument}=await import('/src/rig-examples.mjs');styk.editor.load(rigExampleDocument(r.id));styk.editor.select(1,r.control-1);styk.builder.enter();styk.editor.select(1,r.control-1);},r);await settle();
    await page.evaluate(()=>styk.actions['zoom-selection']());await settle();
    if(await page.locator('[data-connector-part="segment"]').count())await page.locator('[data-connector-part="segment"]').click();
    assert.ok(await page.locator('[data-section="rig-controls"] > .ui-section-body').count());
    await page.screenshot({path:`${output}/${r.id}.png`});
    const before=await page.evaluate(()=>JSON.stringify(styk.editor.serialize()));
    await page.locator('.titlebar [data-action="rig-test"]').click();await page.locator('#rig-test-canvas').waitFor();
    assert.equal(await page.locator('#rig-test-asset, #rig-test-solid').count(),0);
    const pose=await page.locator('#rig-test-angle').isEnabled()?page.locator('#rig-test-angle'):page.locator('#rig-test-value');
    await pose.fill('80');await pose.press('Tab');await settle();
    assert.equal(await page.locator('#rig-test-status').textContent(),'');
    await page.screenshot({path:`${output}/${r.id}-test.png`});
    await page.locator('#rig-test-reset').click();await settle();
    await page.locator('#dialog [data-action="close-dialog"]').last().click();await settle();
    assert.equal(await page.evaluate(()=>JSON.stringify(styk.editor.serialize())),before);
    await page.locator('#builder-done').click();await settle();
  }
  // Exercise ordinary and Ctrl drags through the actual canvas event handlers.
  await page.evaluate(async()=>{const {rigExampleDocument}=await import('/src/rig-examples.mjs');const e=styk.editor;e.load(rigExampleDocument('telescoping-panels'));e.select(1,0);e.setRigBehavior({stretch:null});styk.builder.enter();e.select(1,0);});await settle();
  await openRig();await page.locator('#rig-stretch-enabled').check();await settle();
  assert.equal(await page.evaluate(()=>styk.editor.figure.segments.filter(s=>s._stykRig?.follow?.driver===1).length),6);
  await page.screenshot({path:`${output}/smart-stretch-setup.png`});
  await page.locator('#builder-done').click();await page.locator('#builder-exit-update').click();await settle();await page.locator('[data-tool="select"]').click();await page.evaluate(()=>{styk.fit();styk.editor.select(1,0);});await settle();
  assert.equal(await page.locator('[data-section="rig-controls"]').count(),0);
  const screen=async(point)=>page.evaluate(async point=>{const {worldToScreen}=await import('/src/renderer-geometry.mjs'),{editor,state}=styk,q=worldToScreen(point,{report:editor.report,frame:editor.frame,view:state.view}),r=document.querySelector('#viewport').getBoundingClientRect();return {x:r.x+q.x,y:r.y+q.y};},point);
  const joint=()=>page.evaluate(()=>{const s=styk.editor.geometry.objects.get(0).segments[0];return {start:s.start,end:s.end,length:s.length};});
  const dragTo=async(target,ctrl=false)=>{const a=await screen((await joint()).end),b=await screen(target);await page.mouse.move(a.x,a.y);if(ctrl)await page.keyboard.down('Control');await page.mouse.down();await page.mouse.move(b.x,b.y,{steps:8});await page.mouse.up();if(ctrl)await page.keyboard.up('Control');await settle();};
  const first=await joint();await dragTo({x:first.start.x+260,y:first.start.y-100});assert.ok(Math.abs((await joint()).length-180)<.01);
  const beforeCtrl=await page.evaluate(()=>JSON.stringify(styk.editor.serialize())),history=await page.evaluate(()=>styk.editor._undo.length);
  await dragTo({x:first.start.x+220,y:first.start.y+80},true);const stretched=await joint();assert.ok(Math.abs(stretched.length-Math.hypot(220,80))<.1);
  assert.equal(await page.evaluate(()=>styk.editor._undo.length),history+1);
  // Rig overlays use the theme's blue; normal animation handles remain red.
  const blue=await page.locator('#overlay').evaluate(canvas=>{const data=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;let n=0;for(let i=0;i<data.length;i+=4)if(data[i]===13&&data[i+1]===153&&data[i+2]===255&&data[i+3]>0)n++;return n;});
  assert.equal(blue,0);await page.screenshot({path:`${output}/animate-ctrl-stretch.png`});
  await page.keyboard.press('Control+z');await settle();assert.equal(await page.evaluate(()=>JSON.stringify(styk.editor.serialize())),beforeCtrl);
  // The gallery previews use real geometry and open each rig without changing
  // the current construction. Capture the available cards for visual inspection.
  await page.evaluate(()=>styk.actions['rig-examples']());await settle();assert.equal(await page.locator('[data-rig-thumbnail]').count(),rigs.length);
  await page.screenshot({path:`${output}/gallery.png`});
  await page.locator('[data-rig-preview="glass-cube-3d"]').click();await settle();assert.equal(await page.locator('#rig-test-joint option').count(),3);
  await page.locator('#dialog [data-action="close-dialog"]').last().click();await settle();
  const beforeInsert=await page.evaluate(()=>JSON.stringify(styk.editor.serialize()));
  await page.evaluate(()=>styk.actions['rig-examples']());await settle();await page.locator('[data-rig-insert="glass-cube-3d"]').click();await settle();
  assert.equal(await page.evaluate(()=>styk.editor.figure._styk.rigExample.id),'glass-cube-3d');
  await page.keyboard.press('Control+z');await settle();assert.equal(await page.evaluate(()=>JSON.stringify(styk.editor.serialize())),beforeInsert);
  // Create via multi-selection and the real inspector action, then configure.
  await page.evaluate(async()=>{const {rigExampleDocument}=await import('/src/rig-examples.mjs');styk.editor.load(rigExampleDocument('nested-curve-controls'));styk.editor.select(1,0);styk.builder.enter();styk.editor.select(1,0);});await settle();
  await openRig();await page.locator('[data-section="rig-controls"] [data-action="rig-connect"]').click();
  await page.keyboard.press('Escape');
  await page.evaluate(()=>{styk.editor.select(1,0);styk.editor.toggleSegment(1,2);});await settle();
  await openRig();await page.locator('[data-section="rig-controls"] [data-action="rig-connect"]').click();await settle();
  assert.equal(await page.locator('#rig-position').count(),1);
  await page.locator('#rig-position').fill('25');await page.locator('#rig-position').press('Tab');await settle();
  assert.equal(await page.locator('#rig-position').inputValue(),'25');
  await page.locator('[data-connector-part="segment"]').click();await page.locator('#rig-stretch-enabled').check();await settle();assert.equal(await page.locator('#rig-width').count(),1);
  // Smart Stretch's settings show under its switch while it is on.
  await page.locator('#rig-width').selectOption('inverse');await settle();
  await page.setViewportSize({width:1100,height:760});await settle();
  await page.screenshot({path:`${output}/compact.png`});
  await page.evaluate(()=>document.documentElement.dataset.theme='dark');await settle();await page.screenshot({path:`${output}/dark.png`});
  const imports=[];
  for(const filename of ['glass-cube-3d.styk','perspective-tunnel-3d.stkz']){
    const importPage=await browser.newPage();importPage.on('pageerror',e=>errors.push(e.message));
    await importPage.goto(process.env.STYK_URL??'http://127.0.0.1:47851');await importPage.waitForFunction(()=>window.styk?.ready);
    await importPage.locator('#file-input').setInputFiles(path.resolve('artifacts/connector-3d-rigs',filename));
    await importPage.waitForFunction(()=>styk.editor.report.figure_types.some(f=>f.segments.some(s=>s._stykRig?.connector)));
    imports.push({filename,connectors:await importPage.evaluate(()=>styk.editor.report.figure_types.flatMap(f=>f.segments).filter(s=>s._stykRig?.connector).length)});
    await importPage.close();
  }
  assert.deepEqual(errors,[]);await writeFile(`${output}/browser-report.json`,JSON.stringify({rigs:rigs.length,errors,imports,temporaryPoseRestored:true,normalDragLength:180,ctrlDragLength:stretched.length,animateRigOverlayPixels:blue,gestureUndo:true},null,2));
  console.log('Rig browser flows passed for all examples, temporary pose isolation, inspector setup, light/dark and compact layouts.');
}finally{await browser.close();}
