/** The on-canvas controls of an effect on a movieclip instance are placed by what the clip paints (its content), not by its handle. */
import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1560,height:1000}}),errors=[];
page.on('pageerror',e=>errors.push(e.stack));
try{
  await page.goto(process.env.STYK_URL??'http://127.0.0.1:47831');await page.waitForFunction(()=>window.styk?.ready);
  await page.evaluate(async()=>{const {createDemo}=await import('/src/demo.mjs');styk.editor.load(createDemo());styk.settingsUI.commit({timelineMode:'advanced'});styk.editor.select(1);styk.movieclips.open('range');});
  await page.locator('.movieclip-dialog').getByRole('textbox',{name:'Movieclip name'}).fill('Walk cycle');
  await page.locator('.movieclip-dialog input[name=start]').fill('1');await page.locator('.movieclip-dialog input[name=end]').fill('20');
  await page.locator('.movieclip-dialog button[type=submit]').click();
  await page.waitForFunction(()=>styk.editor.figure?.name==='Walk cycle');
  await page.evaluate(()=>{const e=styk.editor,uid=e.selectedUid,clip=e.addVfxClip({kind:'figure',uid},'glow',{start:0,duration:60});e._selectedVfxClip=clip;e._emit('vfx-selection');});
  await page.getByRole('tab',{name:'VFX',exact:true}).click();
  await page.waitForFunction(()=>styk.vfxGizmos.handles.some(h=>h.kind==='radius'));
  const clip=await page.evaluate(()=>{const b=styk.vfxGizmos.controlState.bounds,g=[...styk.editor.geometry.objects.values()].find(g=>g.obj.unique_id===styk.editor.selectedUid);return {bounds:b,root:g.root};});
  // The walk cycle stands 100 wide and 262 tall around its root, as the release measured it; its own handle is a point.
  assert.deepEqual(clip.bounds,{x:424,y:163,width:100,height:262});
  assert.ok(clip.bounds.x<clip.root.x&&clip.bounds.x+clip.bounds.width>clip.root.x,'the content surrounds the clip root');
  assert.deepEqual(errors,[]);
  console.log('PASS: the effect controls of a movieclip instance follow what the clip paints');
}finally{await browser.close();}
