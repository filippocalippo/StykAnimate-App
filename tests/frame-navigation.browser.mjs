import assert from 'node:assert/strict';
import {chromium} from './support/playwright.mjs';
const browser = await chromium.launch({channel:'chrome',headless:true,ignoreDefaultArgs:['--hide-scrollbars']});
const page = await browser.newPage({viewport:{width:1440,height:960}}), errors=[], checks=[];
page.on('pageerror',e=>errors.push(e.message));
const check = (name, value=true) => {assert.ok(value,name); checks.push(name); console.log('PASS',name);};
const snapshot = () => page.evaluate(()=>({tick:styk.editor.tick,duration:styk.editor.totalTicks,keys:styk.editor.layerFrameKeys('layer-1').map(k=>k.tick)}));
const grid = () => page.getByRole('grid',{name:'Layer frames'});
try {
  await page.goto(process.env.STYK_URL || 'http://127.0.0.1:47831'); await page.waitForFunction(()=>window.styk?.ready);
  await page.evaluate(async()=>{
    const {emptyDocument,createFrame,createObject}=await import('/src/demo.mjs'); const report=emptyDocument();
    report.keyframes=[0,40].map(x=>createFrame([createObject(report.figure_types[0],1,200+x,250)],12));
    styk.editor.load(report);styk.editor.select(1);styk.fit();
  });
  await grid().focus();
  await page.evaluate(() => styk.timeline._selectCell({tick:0,row:styk.timeline.tracks.findIndex(t=>t.id==='layer-1')}));
  await page.keyboard.press('.'); check('Period advances one output frame', (await snapshot()).tick === 1);
  await page.keyboard.press('Shift+Period'); check('Shift period jumps to next layer key', (await snapshot()).tick === 12);
  await page.keyboard.press('Shift+Comma'); check('Shift comma jumps to previous layer key', (await snapshot()).tick === 0);
  await page.keyboard.press(','); check('Previous frame stops at the beginning', (await snapshot()).tick === 0);
  await page.evaluate(() => document.querySelector('#overlay').focus());
  await page.keyboard.press('Shift+Period'); check('Keyframe jump also works from canvas', (await snapshot()).tick === 12);
  await page.keyboard.press(','); check('Comma goes back one output frame from canvas', (await snapshot()).tick === 11);
  await page.keyboard.press('Shift+Comma');
  await grid().focus();

  await page.keyboard.press('Shift+Period');
  await page.keyboard.press('Shift+Period');
  check('Next keyframe stops at the last key', (await snapshot()).tick === 12);
  await page.evaluate(() => styk.settingsUI.commit({timelineMode:'simple'}));
  await page.getByRole('listbox',{name:'Animation frames'}).focus();
  await page.keyboard.press('Shift+Comma'); check('Simple Shift comma visits previous scene frame', (await snapshot()).tick === 0);
  await page.keyboard.press('.'); check('Simple period visits next scene frame', (await snapshot()).tick === 12);
  await page.keyboard.press(','); check('Simple comma visits previous scene frame', (await snapshot()).tick === 0);
  await page.keyboard.press('Shift+Period'); check('Simple Shift period visits next scene frame', (await snapshot()).tick === 12);
  check('Keyframe jumps do not extend the filmstrip selection', await page.evaluate(() => styk.timeline.selected.size === 1));
  await page.evaluate(() => styk.settingsUI.commit({hotkeys:{...styk.hotkeys.bindings,'next-keyframe':['KeyQ']}}));
  await page.getByRole('listbox',{name:'Animation frames'}).focus();
  await page.keyboard.press('Shift+Comma'); await page.keyboard.press('q');
  check('Keyframe jump can be rebound', (await snapshot()).tick === 12);
  assert.deepEqual(errors, []);
} finally { await browser.close(); }
