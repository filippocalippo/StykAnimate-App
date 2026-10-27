import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[],out='artifacts/rig-solids';
page.on('pageerror',e=>errors.push(e.message));await mkdir(out,{recursive:true});
const settle=()=>page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
const snapshot=()=>page.evaluate(()=>JSON.stringify(styk.editor.serialize()));
const set=async(selector,value)=>{const field=page.locator(selector);await field.fill(String(value));await field.press('Tab');await settle();};
const gallery=async()=>{await page.evaluate(()=>styk.actions['rig-examples']());await page.locator('[data-rig-thumbnail="solid-gem-3d"]').scrollIntoViewIfNeeded();await page.locator('[data-rig-thumbnail="solid-gem-3d"][data-ready]').waitFor();};
try{
  await page.goto(process.env.STYK_URL??'http://127.0.0.1:47851');await page.waitForFunction(()=>window.styk?.ready);
  await page.evaluate(async()=>{const {rigExampleDocument}=await import('/src/rig-examples.mjs');styk.editor.load(rigExampleDocument('sliding-carriage'));styk.editor.select(1,0);});await settle();
  const before=await snapshot();await gallery();assert.equal(await page.locator('.rig-example-item p').count(),0);await page.screenshot({path:`${out}/gallery.png`});
  for(const id of ['solid-box-3d','solid-cylinder-3d','solid-wedge-3d','solid-pyramid-3d','solid-gem-3d']){
    await page.locator(`[data-rig-preview="${id}"]`).click();await page.locator('#rig-test-joint').waitFor();
    assert.equal(await page.locator('#rig-test-solid,#rig-test-asset,[data-rig-pose],[data-rig-color]').count(),0);
    await set('#rig-test-angle',135);await page.locator('#rig-test-joint').selectOption({label:'Height'});await set('#rig-test-value',140);
    await page.locator('#rig-test-joint').selectOption({label:'Depth'});await set('#rig-test-value',65);assert.equal(await snapshot(),before);
    await page.locator('#rig-test-reset').click();await settle();assert.equal(await page.locator('#rig-test-joint').inputValue(),'1');
    await set('#rig-test-angle',270);await page.screenshot({path:`${out}/${id}-preview.png`});
    await page.locator('#rig-test-add').click();await settle();
    const angle=await page.evaluate(()=>styk.editor.object.angles[0]*180/Math.PI);assert.ok(Math.abs(angle-270)<.001);
    await page.evaluate(()=>styk.editor.undo());await settle();assert.equal(await snapshot(),before);await gallery();
  }
  await page.locator('#dialog [data-action="close-dialog"]').first().click();
  await page.evaluate(async()=>{const { pageEditor }=await import('/tests/support/page-editor.mjs');const {buildRotatingCube}=await import('/tests/helpers/rotating-cube.mjs');const e=pageEditor({demo:false});buildRotatingCube(e);styk.editor.load(e.serialize());styk.editor.select(styk.editor.evaluatedFrame.objects[0].unique_id,0);styk.builder.enter();styk.editor.selectPolygon(styk.editor.selectedUid,0);});await settle();
  const initial=await snapshot(),side=page.locator('[data-polygon-side="0"]');assert.equal(await side.inputValue(),'front');
  await page.locator('[data-polygon-flip="0"]').click();await settle();assert.equal(await page.locator('[data-polygon-flip="0"]').getAttribute('aria-pressed'),'true');
  await page.evaluate(()=>styk.editor.undo());await settle();assert.equal(await snapshot(),initial);
  await page.evaluate(()=>{for(let i=0;i<6;i++)styk.editor.updatePolygon(i,{surface:null});styk.editor.selectPolygon(styk.editor.selectedUid,0);});await settle();
  await side.selectOption('front');await page.locator('#fill-reference-form').waitFor();
  await set('[data-face-axis="1"]',3);await set('[data-face-axis="2"]',3);
  await page.locator('#fill-reference-form [type="submit"]').click();assert.equal(await page.locator('#fill-reference-error').isVisible(),true);
  await set('[data-face-axis="2"]',4);await page.screenshot({path:`${out}/reference-joints.png`});await page.locator('#fill-reference-form [type="submit"]').click();await settle();
  for(let i=1;i<6;i++){await page.evaluate(i=>styk.editor.selectPolygon(styk.editor.selectedUid,i),i);await settle();await page.locator(`[data-polygon-side="${i}"]`).selectOption('front');await settle();assert.equal(await page.locator('#fill-reference-form').isVisible(),false,'Reuse the existing reference');}
  await page.evaluate(()=>{styk.editor.selectPolygon(styk.editor.selectedUid,0);styk.fit();});await settle();await page.screenshot({path:`${out}/builder-cube.png`});
  await page.evaluate(()=>styk.editor.select(styk.editor.selectedUid,0));await settle();await page.locator('#inspector-name .ui-target-text').dblclick();await set('#builder-joint-name','Turn');
  await page.setViewportSize({width:1000,height:740});await page.evaluate(async()=>{const {applyEditorTheme}=await import('/src/theme.mjs');applyEditorTheme('dark');styk.editor.selectPolygon(styk.editor.selectedUid,0);styk.fit();});await settle();
  assert.equal(await page.locator('#inspector').evaluate(el=>el.scrollWidth>el.clientWidth+1),false);await page.screenshot({path:`${out}/compact-dark-builder.png`});
  await page.locator('[data-polygon-reference="0"]').click();await settle();assert.equal(await page.locator('#dialog-content').evaluate(el=>el.scrollWidth>el.clientWidth+1),false);await page.screenshot({path:`${out}/dark-reference.png`});
  await page.locator('#fill-reference-form [data-action="close-dialog"]').click();
  assert.deepEqual(errors,[]);await writeFile(`${out}/browser-report.json`,JSON.stringify({errors,nativePreview:true,insertUndo:true,faceAuthoring:true,invalidReference:true,referenceReuse:true,compactLayout:true},null,2));console.log('PASS: ordinary solid previews, posed insertion/undo, Builder face authoring, invalid references, reuse and compact/dark layout.');
}catch(error){await page.screenshot({path:`${out}/failure.png`}).catch(()=>{});console.error(errors);throw error;}finally{await browser.close();}
