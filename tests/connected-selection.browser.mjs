import {chromium} from 'playwright';
import assert from 'node:assert/strict';

const browser = await chromium.launch({channel:'chrome', headless:true});
const page = await browser.newPage({viewport:{width:1560,height:1000}});
const errors=[]; page.on('pageerror', error=>errors.push(error.message));
try {
  await page.goto(process.env.STYK_URL || 'http://127.0.0.1:47831');
  await page.waitForFunction(()=>window.styk?.ready);
  await page.evaluate(async()=>{
    const {emptyDocument,defaultFigure,createObject,createFrame}=await import('/src/demo.mjs');
    const report=emptyDocument(), figure=defaultFigure();
    report.figure_types=[figure];
    report.keyframes=[createFrame([createObject(figure,101,300,260),createObject(figure,707,500,260),createObject(figure,909,700,260)])];
    report.keyframes[0].objects[1].join={target_object_slot:0,target_unique_id:101,target_handle_id:3};
    styk.editor.load(report); styk.state.view={x:50,y:50,scale:1};
    styk.state.tool='select'; styk.state.onion=false;
    styk.editor.select(101);
  });
  const point = joint => page.evaluate(joint=>{
    const {editor,state}=styk, g=editor.geometry.objects.get(0), p=joint<0?g.root:g.segments[joint].end;
    const rect=document.getElementById('overlay').getBoundingClientRect();
    return {x:rect.x+state.view.x+p.x*state.view.scale,y:rect.y+state.view.y+p.y*state.view.scale};
  },joint);
  let p=await point(-1); await page.mouse.dblclick(p.x,p.y);
  assert.deepEqual(await page.evaluate(()=>[...styk.editor.selectedUids]),[101,707]);
  assert.equal(await page.evaluate(()=>styk.editor.canUndo),false);
  await page.keyboard.press('Control+c'); await page.keyboard.press('Control+v');
  assert.equal(await page.evaluate(()=>styk.editor.frame.objects.length),5);
  assert.equal(await page.evaluate(()=>{const objects=styk.editor.selectedObjects;return objects[1].join.target_unique_id===objects[0].unique_id}),true);
  await page.keyboard.press('Control+z');
  p=await point(2); await page.mouse.dblclick(p.x,p.y);
  assert.equal(await page.evaluate(()=>styk.editor.branchSelected),true);
  assert.equal(await page.evaluate(()=>styk.editor.selectedJoint),2);
  assert.deepEqual(await page.evaluate(()=>[...styk.editor.selectedUids]),[101,707]);
  await page.locator('#builder-branch').waitFor();
  assert.equal(await page.locator('#builder-branch').isChecked(),true);
  await page.locator('[data-field="thickness"]').fill('17');
  await page.locator('[data-field="thickness"]').press('Tab');
  assert.deepEqual(await page.evaluate(async()=>{
    const {resolveInstanceFigure}=await import('/src/animation-style.mjs');
    return resolveInstanceFigure(styk.editor.figure,styk.editor.object).segments.map(s=>s.thickness);
  }),[11,8,17,17,9,8,11,10,11,10]);
  assert.deepEqual(await page.evaluate(()=>styk.editor.figure.segments.map(s=>s.thickness)),[11,8,9,8,9,8,11,10,11,10]);
  await page.keyboard.press('Control+z');
  assert.equal(await page.evaluate(()=>styk.editor.branchSelected),true);
  await page.locator('#viewport').focus();
  await page.screenshot({path:'artifacts/connected-branch-selection.png'});
  await page.keyboard.press('Control+c'); await page.keyboard.press('Control+v');
  assert.deepEqual(await page.evaluate(()=>styk.editor.report.figure_types.find(f=>f.figure_type_id===styk.editor.selectedObjects[0].figure_type_id).segments.map(s=>s.segment_id)),[3,4]);
  await page.keyboard.press('Control+z');
  // A new single selection clears branch semantics; another node double-click
  // works without enabling a drawing tool or creating a history entry.
  p=await point(6); await page.mouse.click(p.x,p.y);
  assert.equal(await page.evaluate(()=>styk.editor.branchSelected),false);
  await page.mouse.dblclick(p.x,p.y);
  assert.equal(await page.evaluate(()=>styk.editor.selectedJoint),6);
  assert.equal(await page.evaluate(()=>styk.editor.branchSelected),true);
  assert.deepEqual(errors,[]);
  console.log('PASS: real double-clicks, connected and branch copy/paste, joins, single-click reset, and no browser errors');
} finally { await browser.close(); }
