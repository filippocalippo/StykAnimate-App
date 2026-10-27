import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';

const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[],output='artifacts/rig-insertion';
page.on('pageerror',error=>errors.push(error.message));await mkdir(output,{recursive:true});
const settle=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
const saved=()=>page.evaluate(()=>JSON.stringify(styk.editor.serialize()));
const gallery=async()=>{await page.evaluate(()=>styk.actions['rig-examples']());await settle();};
const load=async()=>{await page.evaluate(async()=>{styk.builder.leave();const {rigExampleDocument}=await import('/src/rig-examples.mjs');styk.editor.load(rigExampleDocument('sliding-carriage'));styk.editor.select(1,0);});await settle();};
try{
  await page.goto(process.env.STYK_URL??'http://127.0.0.1:47851');await page.waitForFunction(()=>window.styk?.ready);
  const ids=await page.evaluate(async()=>{const {RIG_EXAMPLES}=await import('/src/rig-examples.mjs');return RIG_EXAMPLES.map(r=>r.id);});
  const additions=[];
  for(const id of ids){
    await load();const before=await saved();await gallery();
    assert.equal(await page.locator('[data-rig-insert]').count(),ids.length);
    if(id===ids[0])await page.screenshot({path:`${output}/gallery.png`});
    await page.locator(`[data-rig-insert="${id}"]`).click();await settle();
    const result=await page.evaluate(()=>{const e=styk.editor,g=e.geometry.objects.get(e.selectedSlot);return {id:e.figure._styk.rigExample.id,count:e.selectionFrame.objects.length,active:styk.builder.active,selected:e.figure.segments[e.selectedJoint].segment_id,control:e.figure._styk.rigExample.control,finite:g.segments.every(s=>Number.isFinite(s.end.x)&&Number.isFinite(s.end.y))};});
    assert.deepEqual(result,{id,count:2,active:false,selected:result.control,control:result.control,finite:true});
    assert.equal(await page.locator('#dialog').evaluate(d=>d.open),false);
    assert.equal(await page.locator('#properties-tab').getAttribute('aria-selected'),'true');
    assert.equal(await page.locator('.workspace').getAttribute('data-mode'),'animate');
    await page.screenshot({path:`${output}/${id}-canvas.png`});
    await page.keyboard.press('Control+z');await settle();assert.equal(await saved(),before);additions.push(result);
  }
  // Keep an existing construction, and insert the exact pose from its preview.
  await load();await page.locator('[data-workspace-mode="rig"]').click();
  await page.evaluate(()=>{styk.editor.select(1,0);styk.editor.updateSegment({thickness:9});});await settle();
  const construction=await saved();await gallery();
  assert.equal(await page.locator('[data-rig-insert="glass-cube-3d"]').isEnabled(),true);
  await page.locator('[data-rig-preview="glass-cube-3d"]').click();await settle();
  await page.locator('#rig-test-angle').fill('60');await page.locator('#rig-test-angle').press('Tab');await settle();
  await page.locator('#rig-test-joint').selectOption({label:'Diagonal bead · slide'});
  await settle();const slider=Number(await page.locator('#rig-test-joint').inputValue());
  await page.locator('#rig-test-value').fill('62');await page.locator('#rig-test-value').press('Tab');await settle();
  await page.screenshot({path:`${output}/posed-example.png`});
  await page.locator('#rig-test-add').click();await settle();
  const posed=await page.evaluate(slider=>{const e=styk.editor;return {angle:e.object.angles[0],slide:e.object.lengths[e.figure.segments.findIndex(s=>s.segment_id===slider)],active:styk.builder.active,originalWidth:e.report.figure_types.find(f=>f.name==='Sliding carriage').segments[0].thickness};},slider);
  assert.ok(Math.abs(posed.angle-Math.PI/3)<1e-6);assert.equal(posed.slide,.62);assert.equal(posed.active,false);assert.equal(posed.originalWidth,9);
  await page.keyboard.press('Control+z');await settle();assert.equal(await saved(),construction);
  // A new construction also survives adding a different rig from the gallery.
  await load();await page.evaluate(()=>{styk.editor.select(null);styk.builder.enter();styk.editor.addSegment({length:45});});await settle();
  const created=await saved();await gallery();await page.locator('[data-rig-insert="wire-globe-3d"]').click();await settle();
  assert.equal(await page.evaluate(()=>styk.builder.active),false);await page.keyboard.press('Control+z');await settle();assert.equal(await saved(),created);
  // A locked destination leaves both the construction and the dialog intact.
  await load();await page.evaluate(()=>{styk.builder.enter();styk.editor.setLayerLocked(styk.editor.activeLayerId,true);});await settle();
  const locked=await saved();await gallery();await page.locator('[data-rig-insert="turbine-3d"]').click();await settle();
  assert.match(await page.locator('#rig-example-status').textContent(),/Unlock/);assert.equal(await saved(),locked);assert.equal(await page.evaluate(()=>styk.builder.active),true);
  await page.locator('#dialog [data-action="close-dialog"]').first().click();
  assert.deepEqual(errors,[]);await writeFile(`${output}/report.json`,JSON.stringify({additions,posed,builderEditsPreserved:true,newConstructionPreserved:true,lockedDestinationPreserved:true,errors},null,2));
  console.log('PASS: all rigs add to Animate, preview poses survive, existing/new builder work is retained, undo restores exact documents, locked layers remain protected.');
}finally{await browser.close();}
