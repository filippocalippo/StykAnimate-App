import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const {startDesktopHost}=createRequire(import.meta.url)('../desktop/web-host.cjs');
const backend=await startDesktopHost({appRoot:fileURLToPath(new URL('..',import.meta.url))});
const browser = await chromium.launch({channel:'chrome',headless:true});
const page = await browser.newPage({viewport:{width:1500,height:950}}), errors=[];
page.on('pageerror', error=>errors.push(error.message));
await mkdir('artifacts/easing',{recursive:true});
const settle=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
try {
  await page.goto(backend.origin); await page.waitForFunction(()=>window.styk?.ready);
  await page.evaluate(async()=>{
    const {emptyDocument,createFrame,createObject}=await import('/src/demo.mjs');
    const report=emptyDocument(); report.canvas_width=640;report.canvas_height=400;
    report.keyframes=[100,300,160].map(x=>createFrame([createObject(report.figure_types[0],1,x,200),createObject(report.figure_types[0],2,x+160,200)],20));
    styk.editor.load(report);styk.editor.select(1);styk.timeline.setZoom(14);
  });
  await settle();
  // The Advanced sheet authors easing in the Keyframe easing popover (its context menu's "Change easing…").
  const openEasing=async()=>{await page.evaluate(()=>styk.timeline.showEasingPopover());await page.getByRole('dialog',{name:'Keyframe easing'}).waitFor();};
  const chooseEasing=async label=>{await openEasing();await page.getByRole('radio',{name:label,exact:true}).click();if(label==='Bezier')await page.getByRole('button',{name:'Apply',exact:true}).click();await settle();};
  const selectCell=tick=>page.evaluate(tick=>{
    const t=styk.timeline,row=t.tracks.findIndex(track=>track.id==='layer-1');
    if(row<0)throw new Error('Missing layer row: '+JSON.stringify(t.tracks.map(x=>x.id)));
    t._selectCell({tick,row});
  },tick);
  const keyAt=async tick=>page.evaluate(tick=>styk.editor.report._styk.layerSheet.tracks['layer-1'].keys.find(key=>key.tick===tick),tick);
  // The Advanced exposure sheet authors easing on the whole layer key.
  await selectCell(0);await settle();
  await openEasing();check('The sheet easing popover opens for the selected key',true);await page.keyboard.press('Escape');await settle();
  async function check(label,value){assert.ok(value,label);console.log('PASS',label);}
  await chooseEasing('Bezier');
  assert.equal((await keyAt(0)).interpolation,'bezier');
  let values=await page.evaluate(()=>{styk.editor.seek(5);return styk.editor.evaluatedFrame.objects.map(o=>[o.unique_id,o.root_x]);});
  assert.ok(values.find(([id])=>id===1)[1]>100&&values.find(([id])=>id===1)[1]<150);
  assert.ok(values.find(([id])=>id===2)[1]>260&&values.find(([id])=>id===2)[1]<310);
  await page.evaluate(()=>styk.editor.undo());await settle();
  assert.equal(await page.evaluate(()=>styk.editor.animationChannels.length),0);
  assert.equal((await keyAt(0)).interpolation==='bezier',false);
  await page.evaluate(()=>styk.editor.redo());await settle();
  assert.equal((await keyAt(0)).interpolation,'bezier');
  await chooseEasing('Constant');
  assert.equal(await page.evaluate(()=>{styk.editor.seek(19);return styk.editor.evaluatedFrame.objects.find(o=>o.unique_id===1).root_x;}),100);
  assert.equal(await page.evaluate(()=>{styk.editor.seek(20);return styk.editor.evaluatedFrame.objects.find(o=>o.unique_id===1).root_x;}),300);
  await selectCell(0);await chooseEasing('Linear');
  assert.equal(await page.evaluate(()=>{styk.editor.seek(5);return styk.editor.evaluatedFrame.objects.find(o=>o.unique_id===1).root_x;}),150);
  // The Simple filmstrip keeps the nonmodal Keyframe easing popover.
  await page.evaluate(()=>styk.settingsUI.commit({timelineMode:'simple'}));await settle();
  await page.locator('.sheet-preview').first().dblclick();await page.getByRole('dialog',{name:'Keyframe easing'}).waitFor();
  assert.equal(await page.evaluate(()=>document.querySelector(':modal')),null);
  await page.screenshot({path:'artifacts/easing/simple-popover.png'});
  await page.getByRole('radio',{name:'Ease out',exact:true}).click();
  assert.equal((await keyAt(0)).interpolation,'ease-out');
  await page.locator('.sheet-preview').first().click({button:'right'});
  await page.getByRole('menuitem',{name:'Change easing…',exact:true}).click();
  await page.getByRole('radio',{name:'Auto',exact:true}).click();
  assert.equal((await keyAt(0)).interpolation,'auto');
  await settle();
  await page.locator('.sheet-preview').first().dblclick();
  await page.getByRole('dialog',{name:'Keyframe easing'}).waitFor();
  await settle();
  assert.equal(await page.getByRole('radio',{name:'Auto',exact:true}).getAttribute('aria-checked'),'true');
  await page.screenshot({path:'artifacts/easing/simple-auto-popover.png'});
  const history=await page.evaluate(()=>styk.editor._undo.length);
  await page.keyboard.press('Escape');await settle();
  assert.equal(await page.locator('.styk-easing-popover').count(),0);
  assert.equal(await page.evaluate(()=>styk.editor._undo.length),history);
  assert.equal(await page.locator('#easing').count(),0);
  assert.deepEqual(errors,[]);console.log('PASS: sheet interpolation control, bezier/hold/linear tweens, undo/redo, filmstrip easing popover, simple context menu, removed global toggle');
} finally {await browser.close();backend.stop();}
