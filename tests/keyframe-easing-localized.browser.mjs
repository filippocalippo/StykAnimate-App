import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const {startDesktopHost}=createRequire(import.meta.url)('../desktop/web-host.cjs');
const backend=await startDesktopHost({appRoot:fileURLToPath(new URL('..',import.meta.url))});
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1500,height:950}}),errors=[];
page.on('pageerror',error=>errors.push(error.message));
const settle=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
// The easing popover's own wiring must not depend on English copy: translated labels once left its close button unfound.
try {
  await page.goto(backend.origin);await page.waitForFunction(()=>window.styk?.ready);
  await page.evaluate(async()=>{const {emptyDocument,createFrame,createObject}=await import('/src/demo.mjs');const report=emptyDocument();report.keyframes=[0,60].map(x=>createFrame([createObject(report.figure_types[0],1,200+x,250)],12));styk.settingsUI.commit({timelineMode:'advanced'});styk.editor.load(report);styk.fit();styk.localization.setLocale('it');});
  await settle();
  const popover=page.locator('.styk-easing-popover'),keyAt=tick=>page.evaluate(tick=>styk.editor.report._styk.layerSheet.tracks['layer-1'].keys.find(key=>key.tick===tick),tick);
  const grid=page.locator('#timeline [role=grid]').first();
  const cell=async tick=>{const box=await grid.boundingBox(),{y,step,offset}=await page.evaluate(()=>{const t=styk.timeline;return {y:t.rowY(2)+t.rowSize(2)/2,step:t.pxPerTick,offset:t._offsetX()};});return [box.x+(tick+.5)*step-offset,box.y+y];};
  // Advanced layer timeline: double-clicking a key opens the popover, and a preset applies.
  await page.mouse.dblclick(...await cell(0));await popover.waitFor();
  await popover.locator('[role=radio]').nth(2).click();await settle();
  assert.equal(await popover.count(),0);
  assert.notEqual((await keyAt(0)).interpolation??'auto','auto');
  // The translated close button still closes it.
  await page.mouse.dblclick(...await cell(0));await popover.waitFor();
  await popover.locator('.styk-easing-header button').click();await settle();
  assert.equal(await popover.count(),0);
  // Simple filmstrip double-click takes the same path.
  await page.evaluate(()=>styk.settingsUI.commit({timelineMode:'simple'}));await settle();
  const filmstripLabels=()=>page.evaluate(async()=>{
    const {EASING_MODES}=await import('/src/keyframe-easing.mjs');
    return {actual:[...document.querySelector('.sheet-easing-select').options].filter(option=>option.value).map(option=>[option.value,option.textContent]),
      expected:EASING_MODES.map(mode=>[mode.id,styk.localization.t(mode.labelKey)])};
  });
  let captions=await filmstripLabels();assert.deepEqual(captions.actual,captions.expected);
  await page.evaluate(()=>styk.localization.setLocale('en'));await settle();
  captions=await filmstripLabels();assert.deepEqual(captions.actual,captions.expected);
  await page.evaluate(()=>styk.localization.setLocale('it'));await settle();
  captions=await filmstripLabels();assert.deepEqual(captions.actual,captions.expected);
  await page.locator('.sheet-preview').first().dblclick();await popover.waitFor();
  await popover.locator('.styk-easing-header button').click();await settle();
  assert.equal(await popover.count(),0);
  // Joined drawing-bank inspector captions keep their UI translation boundary.
  await page.evaluate(async()=>{
    const {emptyDocument,defaultFigure,createFrame,createObject}=await import('/src/demo.mjs');
    const {movieclipFigure}=await import('/src/movieclips.mjs');
    const ink=defaultFigure(1),inner={...emptyDocument(),figure_types:[ink],keyframes:[createFrame([createObject(ink,1,0,0)]),createFrame([createObject(ink,1,10,0)])]};
    const clip=movieclipFigure(2,'Artist <clip>',inner,{duration:2});
    clip._styk.movieclip.drawingSets=[{name:'Normal <authored>',views:[{name:'Front <authored>',frame:0}]},{name:'Alternate',views:[{name:'Side',frame:1}]}];
    const report={...emptyDocument(),figure_types:[ink,clip],keyframes:[createFrame([createObject(ink,1,200,200),createObject(clip,2,200,200,{join:{target_object_slot:0,target_unique_id:1,target_handle_id:1}})])]};
    styk.editor.load(report);styk.editor.select(1,-1);styk.fit();window.__drawingBankDocument=JSON.stringify(styk.editor.serialize());
  });
  await page.waitForFunction(()=>document.querySelector('[data-drawing-group][data-drawing-uid="2"]'));await settle();
  const drawingLabels=()=>page.evaluate(()=>{
    const bank=document.querySelector('[data-section="drawing-bank-2"]');
    return {actual:[...bank.querySelectorAll('.spatial-choice>span')].map(node=>node.textContent),
      expected:['movieclipDrawings.form','movieclipDrawings.view'].map(key=>styk.localization.t(key)),
      names:[...bank.querySelectorAll('option')].map(node=>node.textContent),selected:[...bank.querySelectorAll('select')].map(node=>node.value),
      unchanged:window.__drawingBankDocument===JSON.stringify(styk.editor.serialize())};
  });
  for(const locale of ['it','en','it']){
    await page.evaluate(locale=>styk.localization.setLocale(locale),locale);await settle();
    const drawing=await drawingLabels();assert.deepEqual(drawing.actual,drawing.expected);
    assert.deepEqual(drawing.names,['Normal <authored>','Alternate','Front <authored>']);
    assert.deepEqual(drawing.selected,['0','0']);assert.equal(drawing.unchanged,true);
  }
  assert.deepEqual(errors,[]);console.log('PASS: easing and drawing-bank labels follow language changes; popover opens, applies and closes in a translated interface');
} finally {await page.evaluate(()=>styk.localization.setLocale('en')).catch(()=>{});await browser.close();backend.stop();}
