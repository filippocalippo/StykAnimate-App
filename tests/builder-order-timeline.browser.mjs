import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';

const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
page.on('pageerror',error=>errors.push(error.message));
const input=()=>page.locator('#inspector input[data-property="segment_z_order"]');
const settled=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
const seek=async tick=>{await page.evaluate(tick=>styk.editor.seek(tick),tick);await settled();};
try {
  await page.goto(process.env.STYK_URL??'http://127.0.0.1:47839');
  await page.waitForFunction(()=>window.styk?.ready);
  await page.evaluate(async()=>{
    const {emptyDocument,createFrame,createObject}=await import('/src/demo.mjs');
    const report=emptyDocument(),figure=report.figure_types[0];
    report.keyframes=[0,1,2].map(()=>createFrame([createObject(figure,1,300,300)],10));
    styk.editor.load(report);styk.editor.select(1,0);styk.fit();
  });
  const max=Number(await input().getAttribute('max'));
  await input().fill(String(max));await input().press('Enter');
  assert.equal(await input().inputValue(),String(max));
  await seek(10);await input().fill('1');await input().press('Enter');
  await seek(0);
  await page.waitForFunction(max=>document.querySelector('[data-property="segment_z_order"]')?.value===String(max),max);
  await seek(10);assert.equal(await input().inputValue(),'1');
  await page.locator('.ui-quick [data-action="selection-front"]').click();await settled();
  assert.equal(await input().inputValue(),String(max));
  await page.evaluate(()=>styk.editor.undo());await settled();assert.equal(await input().inputValue(),'1');
  await seek(0);assert.equal(await input().inputValue(),String(max));
  await page.evaluate(()=>{const e=styk.editor;e.load(structuredClone(e.serialize()));e.select(1,0);e.seek(10);});
  await settled();
  assert.equal(await input().inputValue(),'1');
  await mkdir('artifacts/builder-order-timeline',{recursive:true});
  await page.screenshot({path:'artifacts/builder-order-timeline/frame-10.png'});
  await seek(0);await page.screenshot({path:'artifacts/builder-order-timeline/frame-0.png'});
  assert.deepEqual(errors,[]);
  console.log('PASS: numeric fields, order buttons, frame isolation, undo, and save/reopen in the app; no page errors.');
} finally {await browser.close();}
