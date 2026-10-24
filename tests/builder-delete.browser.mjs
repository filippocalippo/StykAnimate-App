import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import {builderFixture} from '../scripts/builder-benchmark-fixture.mjs';
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
page.on('pageerror',e=>errors.push(e.message));
const settle=()=>page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
const fixture=builderFixture(6);
fixture.figure_types[0].segments.forEach((s,i)=>{s.parent_id=i%2?i:0;s.angle_rad=Math.floor(i/2)*2;s.length=i%2?40:60;s.thickness=8;});
fixture.keyframes[0].objects[0].angles=fixture.figure_types[0].segments.map(s=>s.angle_rad);
const point=index=>page.evaluate(async index=>{
 const {worldToScreen}=await import('/src/renderer-geometry.mjs'),{editor,state}=styk;
 const world=index<0?editor.geometry.objects.get(editor.selectedSlot).root:editor.geometry.objects.get(editor.selectedSlot).segments[index].end;
 const p=worldToScreen(world,{report:editor.report,frame:editor.frame,view:state.view});const r=document.querySelector('#viewport').getBoundingClientRect();return {x:r.x+p.x,y:r.y+p.y};
},index);
try {
 await page.goto(process.env.STYK_URL||'http://127.0.0.1:47841');await page.waitForFunction(()=>window.styk?.ready);
 for(const mode of ['single-select','toggle-select','selection-select','shift-select','toggle-rig']) {
  await page.evaluate(f=>{styk.builder?.leave();styk.editor.load(f);styk.editor.select(1,-1);styk.builder.enter();styk.state.builderBranch=false;},fixture);
  await page.locator('.rail-quick [data-action=zoom-selection]').click();await page.locator('[data-tool=select]').click();await settle();
  // A real Select-tool pose gesture must survive deleting another limb.
  const beforePose=await point(5);await page.mouse.move(beforePose.x,beforePose.y);await page.mouse.down();await page.mouse.move(beforePose.x+24,beforePose.y-20,{steps:5});await page.mouse.up();await settle();
  const posed=await page.evaluate(()=>{const {editor:e}=styk;const s=e.geometry.objects.get(e.selectedSlot).segments[5];return {uid:e.selectedUid,end:s.end};});
  const branch=mode!=='single-select';
  await page.evaluate(branch=>styk.editor.select(1,branch?2:3),branch);
  if(mode.startsWith('toggle')){await settle();await page.locator('.rail-quick [data-action="toggle-builder-branch"]').click();}
  if(mode==='selection-select')await page.evaluate(()=>styk.editor.selectBranch(1,2));
  if(mode.endsWith('rig'))await page.locator('[data-tool=rig]').click();
  await page.locator('#viewport').focus();await settle();
  const before=await page.evaluate(()=>JSON.stringify(styk.editor.serialize())),history=await page.evaluate(()=>styk.editor._undo.length);
  await page.keyboard.press(mode==='shift-select'?'Shift+Delete':'Delete');await settle();
  const result=await page.evaluate(()=>{const e=styk.editor,g=e.geometry.objects.get(e.selectedSlot);return {uid:e.selectedUid,count:e.figure.segments.length,end:g.segments.find(s=>s.seg.segment_id===6)?.end,history:e._undo.length};});
  assert.equal(result.count,branch?4:5,mode);assert.equal(result.uid,posed.uid,`${mode}: instance replaced`);assert.deepEqual(result.end,posed.end,`${mode}: pose reset`);assert.equal(result.history,history+1);
  const after=await page.evaluate(()=>JSON.stringify(styk.editor.serialize()));await page.keyboard.press('Control+z');await settle();assert.equal(await page.evaluate(()=>JSON.stringify(styk.editor.serialize())),before);
  await page.keyboard.press('Control+Shift+z');await settle();assert.equal(await page.evaluate(()=>JSON.stringify(styk.editor.serialize())),after);
 }
 await page.locator('[data-tool=select]').click();await page.evaluate(()=>styk.editor.select(1,-1));await page.locator('#viewport').focus();await settle();
 const rootBefore=await page.evaluate(()=>JSON.stringify(styk.editor.serialize()));await page.keyboard.press('Delete');await settle();assert.equal(await page.evaluate(()=>JSON.stringify(styk.editor.serialize())),rootBefore);
 assert.deepEqual(errors,[]);console.log('PASS: Delete under Select/Joints; branch toggle, branch selection, Shift+Delete; posed limb retained; single history entry; undo/redo; root guard.');
}finally{await browser.close();}
