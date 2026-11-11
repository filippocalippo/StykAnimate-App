import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {chromium} from './support/playwright.mjs';

await mkdir('artifacts/figure-palette',{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
page.on('pageerror',error=>errors.push(error.message));
const settle=async()=>{await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));await page.waitForFunction(()=>styk.state.renderer.engineSide?.frameReport===styk.editor.report);};
const choose=async(selector,hex)=>{await page.locator(selector).click();const input=page.locator('.paint-picker [data-hex]');await input.fill(hex);await input.press('Tab');await page.locator('.paint-picker [data-close]').click();await settle();};
/** Opens the figure's Colours section (titled, remembered) unless it is open. */
const openColours=async()=>{const toggle=page.locator('[data-section-toggle="colours"]');if(await toggle.getAttribute('aria-expanded')!=='true')await toggle.click();};
const palette=()=>page.evaluate(()=>styk.editor.figurePalette().map(entry=>[entry.color,entry.segments.length]));
try{
  await page.goto(process.env.STYK_URL??'http://127.0.0.1:47839');await page.waitForFunction(()=>window.styk?.ready);
  const info=await page.evaluate(async path=>{
    let report;
    if(path)report=await (await fetch(path)).json();
    else{
      const {emptyDocument,createFrame,createObject}=await import('/src/demo.mjs');
      report=emptyDocument();report.version=4;report.frame_delay_ms=40;report.figure_types[0].segments.forEach(s=>s.color_rgb=[0,0,0]);
      report.keyframes=[createFrame([createObject(report.figure_types[0],1,320,250,{color_override_raw:196})])];
    }
    styk.editor.load(report);const uid=styk.editor.evaluatedFrame.objects[0].unique_id;styk.editor.select(uid);styk.actions['zoom-selection']();
    return {version:report.version,frames:report.keyframes.length,figures:report.figure_types.length,objects:styk.editor.evaluatedFrame.objects.length,uid,segments:styk.editor.figure.segments.length};
  },process.env.STYK_COLOR_CORPUS_JSON??null);
  await settle();assert.deepEqual(await palette(),[['#c40000',info.segments]]);
  await page.screenshot({path:'artifacts/figure-palette/hands-before.png'});
  await choose('#figure-color','44aacc');assert.deepEqual(await palette(),[['#44aacc',info.segments]]);
  await page.evaluate(uid=>styk.editor.select(uid,0),info.uid);await settle();
  await choose('#segment-color','eecc11');
  assert.deepEqual(await palette(),[['#44aacc',info.segments-1],['#eecc11',1]]);
  await page.evaluate(uid=>styk.editor.select(uid),info.uid);await settle();
  await openColours();
  await choose('[data-palette-color="#44aacc"]','eecc11');assert.deepEqual(await palette(),[['#eecc11',info.segments]]);
  await page.evaluate(()=>styk.editor.undo());await settle();
  // The same open picker keeps editing its original members after a merge.
  await page.locator('[data-palette-color="#44aacc"]').click();
  for(const color of ['eecc11','778899']){await page.locator('.paint-picker [data-hex]').fill(color);await page.locator('.paint-picker [data-hex]').press('Tab');await settle();}
  await page.locator('.paint-picker [data-close]').click();
  assert.deepEqual(await palette(),[['#778899',info.segments-1],['#eecc11',1]]);
  const geometry=await page.evaluate(()=>styk.editor.geometry.objects.get(styk.editor.selectedSlot).segments.map(s=>s.rgb));
  assert.deepEqual(geometry[0],[238,204,17]);assert.ok(geometry.slice(1).every(rgb=>JSON.stringify(rgb)==='[119,136,153]'));
  await page.locator('[data-palette-color]').last().scrollIntoViewIfNeeded();
  await page.screenshot({path:'artifacts/figure-palette/hands-palette.png'});
  await choose('#figure-color','9933ee');assert.deepEqual(await palette(),[['#9933ee',info.segments]]);
  await page.evaluate(()=>styk.editor.undo());await settle();
  assert.deepEqual(await palette(),[['#778899',info.segments-1],['#eecc11',1]]);
  await page.evaluate(async()=>{
    const {emptyDocument,createFrame,createObject}=await import('/src/demo.mjs');
    const report=emptyDocument(),root=report.figure_types[0],child=structuredClone(root);
    root.segments.forEach(s=>s.color_rgb=[200,40,50]);
    child.figure_type_id=2;child.segments.forEach(s=>s.color_rgb=[10,20,30]);
    report.figure_types.push(child);
    report.keyframes=[createFrame([
      createObject(root,1,280,250),
      createObject(child,2,350,250,{join:{target_object_slot:0,target_handle_id:1}}),
      createObject(child,3,420,250,{join:{target_object_slot:1,target_handle_id:1}}),
      createObject(child,4,650,250),
    ])];
    styk.editor.load(report);styk.editor.select(1);styk.actions['zoom-selection']();
  });
  await settle();
  await openColours();
  assert.equal(await page.locator('[data-palette-color="#0a141e"]').count(),1);
  await choose('[data-palette-color="#0a141e"]','44aacc');
  const attached=await page.evaluate(()=>[0,1,2,3].map(slot=>styk.editor.geometry.objects.get(slot).segments[0].rgb));
  assert.deepEqual(attached,[[200,40,50],[68,170,204],[68,170,204],[10,20,30]]);
  await page.locator('[data-section="colours"] .ui-swatch-grid').scrollIntoViewIfNeeded();
  await page.screenshot({path:'artifacts/figure-palette/attached-palette.png'});
  await page.evaluate(()=>styk.editor.undo());await settle();
  assert.equal(await page.locator('[data-palette-color="#0a141e"]').count(),1);
  assert.deepEqual(errors,[]);await writeFile('artifacts/figure-palette/browser-report.json',JSON.stringify({...info,palette:await palette(),attached,errors},null,2));
  console.log('PASS visible figure/node/palette edits, merge, repeated picker edits, undo, and rendered geometry',info);
}finally{await browser.close();}
