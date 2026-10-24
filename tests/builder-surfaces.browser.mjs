import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
page.on('pageerror',e=>errors.push(e.message));
const settle=()=>page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
const point=id=>page.evaluate(async id=>{const {worldToScreen}=await import('/src/renderer-geometry.mjs'),{editor:e,state}=styk,p=e.geometry.objects.get(e.selectedSlot).joints.get(id),q=worldToScreen(p,{report:e.report,frame:e.frame,view:state.view}),r=document.querySelector('#viewport').getBoundingClientRect();return {x:r.x+q.x,y:r.y+q.y};},id);
const click=async id=>{const p=await point(id);await page.mouse.click(p.x,p.y);await settle();};
try{
  await page.goto(process.env.STYK_URL??'http://127.0.0.1:47851');await page.waitForFunction(()=>window.styk?.ready);
  await page.evaluate(async()=>{const {Editor}=await import('/src/editor.mjs');const e=new Editor({demo:false});e.addSegment({length:180,angle:0,thickness:0});styk.editor.load(e.serialize());styk.editor.select(styk.editor.frame.objects[0].unique_id,-1);styk.builder.enter();styk.fit();});await settle();
  await click(0);await settle();await page.locator('.ui-quick [data-action="rig-connect"]').click();await click(1);
  assert.deepEqual(await page.evaluate(()=>styk.editor.figure.segments.at(-1)._stykRig.connector),{start:0,end:1,restLength:180});
  await page.locator('#rig-position').fill('0');await page.locator('#rig-position').press('Tab');await settle();
  // A line must attach to the selected slider when its point overlaps Origin.
  await page.locator('[data-tool="line"]').click();const start=await point(0);await page.mouse.move(start.x,start.y);await page.mouse.down();await page.mouse.move(start.x+90,start.y+45,{steps:4});await page.mouse.up();await settle();
  assert.equal(await page.evaluate(()=>styk.editor.figure.segments.at(-1).parent_id),2);
  await page.locator('#inspector-name .ui-target-text').dblclick();await page.locator('#builder-joint-name').fill('Attached radius');await page.locator('#builder-joint-name').press('Enter');await settle();assert.equal(await page.evaluate(()=>styk.editor.figure.segments.at(-1).name),'Attached radius');
  await page.evaluate(async()=>{styk.builder.leave();const {Editor}=await import('/src/editor.mjs'),{buildRotatingCube}=await import('/tests/helpers/rotating-cube.mjs');const e=new Editor({demo:false});window.cubeRecipe=buildRotatingCube(e,{faces:false});styk.editor.load(e.serialize());styk.editor.select(styk.editor.frame.objects[0].unique_id,0);styk.builder.enter();styk.fit();});await settle();
  const cycles=await page.evaluate(()=>cubeRecipe.cycles);
  for(const [i,ids] of cycles.entries()){
    await page.locator('[data-tool="polygon"]').click();for(const id of [...ids,ids[0]])await click(id);
    assert.equal(await page.evaluate(()=>styk.editor.figure.polyfills.length),i+1);
    assert.deepEqual(await page.evaluate(()=>styk.editor.figure.polyfills.at(-1).segment_ids),ids);
    await page.evaluate(i=>styk.editor.selectPolygon(styk.editor.selectedUid,i),i);await settle();await page.locator(`[data-polygon-side="${i}"]`).selectOption('front');
    if(i===0){await page.locator('[data-face-axis="1"]').fill('3');await page.locator('[data-face-axis="2"]').fill('4');await page.locator('#fill-reference-form [type="submit"]').click();}
    await settle();
  }
  assert.deepEqual(await page.evaluate(()=>styk.editor.geometry.objects.get(styk.editor.selectedSlot).polys.filter(p=>!p.culled).map(p=>p.index)),[0,2,5]);
  await page.evaluate(()=>styk.editor.selectPolygon(styk.editor.selectedUid,0));await settle();
  await page.locator('[data-polygon-reference="0"]').click();
  await page.getByRole('textbox',{name:'Depth joints',exact:true}).fill('99999');
  await page.locator('#fill-reference-form [type="submit"]').click();
  assert.match(await page.locator('#fill-reference-error').innerText(),/existing reference joints/);
  await page.getByRole('textbox',{name:'Depth joints',exact:true}).fill('1, 2');
  await page.locator('#fill-reference-form [type="submit"]').click();await settle();
  assert.deepEqual(await page.evaluate(()=>styk.editor.figure.polyfills[0]._stykSurface.depth),[1,2]);
  await page.evaluate(()=>styk.editor.undo());await settle();
  assert.equal(await page.evaluate(()=>styk.editor.figure.polyfills[0]._stykSurface.depth),undefined);
  assert.deepEqual(errors,[]);console.log('PASS: connect from Origin, draw on overlapping connector attachment, rename joint and create all six cube faces using canvas clicks and normal Builder controls.');
}finally{await browser.close();}
