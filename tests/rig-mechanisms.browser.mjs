import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
const output='artifacts/rig-mechanisms';await mkdir(output,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[],results=[];
page.on('pageerror',e=>errors.push(e.message));
const settle=()=>page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
const saved=()=>page.evaluate(()=>JSON.stringify(styk.editor.serialize()));
const gallery=async()=>{await page.evaluate(()=>styk.actions['rig-examples']());await settle();};
try{
  await page.goto(process.env.STYK_URL??'http://127.0.0.1:47851');await page.waitForFunction(()=>window.styk?.ready);
  assert.ok(await page.locator('#viewport').isVisible());assert.deepEqual(errors,[]);
  const examples=await page.evaluate(async()=>{const {MECHANISM_RIG_EXAMPLES}=await import('/src/rig-mechanism-examples.mjs');return MECHANISM_RIG_EXAMPLES.map(r=>({id:r.id,controls:r.build().controls}));});
  for(const [n,r] of examples.entries()){
    await page.evaluate(async()=>{const {rigExampleDocument}=await import('/src/rig-examples.mjs');styk.editor.load(rigExampleDocument('sliding-carriage'));styk.editor.select(1,0);});await settle();
    const before=await saved();await gallery();
    if(n===0){await page.waitForFunction(()=>[...document.querySelectorAll('[data-rig-thumbnail]')].slice(0,5).every(c=>c.dataset.ready));await page.screenshot({path:`${output}/gallery.png`});}
    await page.locator(`[data-rig-preview="${r.id}"]`).click();await settle();
    assert.equal(await page.locator('#rig-test-asset,#rig-test-solid').count(),0);
    assert.equal(await page.locator('#rig-test-status').isVisible(),false);
    await page.screenshot({path:`${output}/${r.id}-preview.png`});
    const primary=r.controls[0],field=page.locator(primary.channel==='angle'?'#rig-test-angle':'#rig-test-value'),initial=await field.inputValue();
    for(const c of r.controls){await page.locator('#rig-test-joint').selectOption(String(c.handle));const input=page.locator(c.channel==='angle'?'#rig-test-angle':'#rig-test-value');await input.fill(String((c.offset+c.max*c.scale)*(c.channel==='angle'?180/Math.PI:c.channel==='slide'?100:1)));await input.press('Tab');await settle();}
    assert.equal(await saved(),before);assert.equal(await page.locator('#rig-test-status').textContent(),'');
    await page.locator('#rig-test-fit').click();await settle();await page.screenshot({path:`${output}/${r.id}-posed.png`});
    await page.locator('#rig-test-reset').click();await settle();assert.equal(await field.inputValue(),initial);
    await field.fill(String((primary.offset+(primary.min+(primary.max-primary.min)*.65)*primary.scale)*(primary.channel==='angle'?180/Math.PI:primary.channel==='slide'?100:1)));await field.press('Tab');await settle();
    const posed=Number(await field.inputValue());await page.locator('#rig-test-add').click();await settle();
    const inserted=await page.evaluate(c=>{const e=styk.editor,i=e.figure.segments.findIndex(s=>s.segment_id===c.handle);return {id:e.figure._styk.rigExample.id,value:c.channel==='angle'?e.object.angles[i]*180/Math.PI:(e.object.len_flag?e.object.lengths[i]:e.figure.segments[i].length)*(c.channel==='slide'?100:1),builder:styk.builder.active};},primary);
    assert.equal(inserted.id,r.id);assert.equal(inserted.builder,false);assert.ok(Math.abs(inserted.value-posed)<.001,`${r.id} keeps its tested ${primary.label}`);
    assert.equal(await page.locator('#inspector [data-rig-asset], #inspector [data-rig-pose], #inspector [data-rig-color]').count(),0);
    await page.screenshot({path:`${output}/${r.id}-native-properties.png`});
    const beforeEdit=await saved(),history=await page.evaluate(()=>styk.editor._undo.length),native=page.locator(primary.channel==='slide'?'#rig-position':`#inspector [data-field="joint_${primary.channel==='angle'?'angle':'length'}"]`);
    const nativeValue=Number(await native.inputValue());await native.fill(String(nativeValue+5));await native.press('Tab');await settle();
    assert.notEqual(await saved(),beforeEdit,'Ordinary joint properties pose the imported asset');assert.equal(await page.evaluate(()=>styk.editor._undo.length),history+1);
    await page.locator('[aria-label="Edit history"] [data-action="undo"]').click();await settle();assert.ok(await saved()===beforeEdit,'One Undo restores the native pose edit');
    await page.evaluate(()=>styk.actions['rig-test']());await settle();
    assert.equal(await page.locator('#rig-test-asset, #rig-test-solid, #rig-test-add').count(),0);assert.equal(await page.locator('#rig-test-joint').count(),1);
    await page.locator('#dialog [data-action="close-dialog"]').last().click();await settle();assert.equal(await saved(),beforeEdit);
    await page.locator('[aria-label="Edit history"] [data-action="undo"]').click();await settle();assert.ok(await saved()===before,'Second Undo restores the scene before insertion');
    results.push({id:r.id,previewControls:r.controls.length,previewIsolated:true,posedInsert:true,nativeProperties:true,genericRigTest:true,editUndo:true});
  }
  await gallery();await page.setViewportSize({width:1100,height:760});await page.evaluate(()=>document.documentElement.dataset.theme='dark');await settle();await page.screenshot({path:`${output}/gallery-dark.png`});
  await page.locator('[data-rig-preview="accordion-screen-3d"]').click();await settle();assert.equal(await page.locator('#dialog-content').evaluate(el=>el.scrollWidth>el.clientWidth+1),false);await page.screenshot({path:`${output}/compact-dark.png`});
  assert.deepEqual(errors,[]);await writeFile(`${output}/report.json`,JSON.stringify({results,errors},null,2));console.log('PASS: five assets, ordinary joint previews and imported properties, posed insertion, exact undo and compact/dark layouts.');
}finally{await browser.close();}
