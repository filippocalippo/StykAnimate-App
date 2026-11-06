import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[];
page.on('pageerror',e=>errors.push(e.message));
const setting=key=>page.evaluate(key=>styk.state.settings[key],key);
async function scrub(selector,dx,{key,scale=1,modifier,cancel=false}={}) {
 const input=page.locator(selector),original=await setting(key),r=await input.boundingBox();
 if(modifier)await page.keyboard.down(modifier);
 await page.mouse.move(r.x+r.width/2,r.y+r.height/2);await page.mouse.down();await page.mouse.move(r.x+r.width/2+dx,r.y+r.height/2,{steps:8});
 const preview=Number(await input.inputValue());assert.ok(Math.abs(preview-original*scale)>0.01,'drag previews value');
 assert.equal(await setting(key),original,'preview does not persist');
 if(cancel)await page.keyboard.press('Escape');
 await page.mouse.up();if(modifier)await page.keyboard.up(modifier);
 assert.ok(Math.abs(await setting(key)-(cancel?original:preview/scale))<1e-8,'release commits / Escape rolls back');
 return preview-original*scale;
}
try {
 await page.goto(process.env.STYK_URL||'http://127.0.0.1:47831');await page.waitForFunction(()=>window.styk?.ready);await page.locator('#guides-options-button').click();
 for(const [selector,key,scale] of [['[data-position="X"]','canvasGuideX',960],['[data-position="Y"]','canvasGuideY',540],['[data-setting="canvasGridSpacing"]','canvasGridSpacing',1]]) {
  const delta=await scrub(selector,20,{key,scale});assert.ok(Math.abs(delta-20)<.01);console.log('PASS live drag and release',key);
 }
 const fine=await scrub('[data-position="X"]',20,{key:'canvasGuideX',scale:960,modifier:'Shift'});assert.ok(fine>0&&fine<20);console.log('PASS Shift fine adjustment');
 const extra=await scrub('[data-position="X"]',20,{key:'canvasGuideX',scale:960,modifier:'Alt'});assert.ok(extra>0&&extra<fine);console.log('PASS Alt extra-fine adjustment');
 await scrub('[data-setting="canvasGridSpacing"]',25,{key:'canvasGridSpacing',cancel:true});assert.ok(await page.locator('#canvas-guides-panel').isVisible());console.log('PASS Escape reverts without closing panel');
 const input=page.locator('[data-position="X"]');await input.click();await page.keyboard.type('123.5');await page.keyboard.press('Enter');assert.ok(Math.abs((await setting('canvasGuideX'))*960-123.5)<1e-8);console.log('PASS click-to-type fractional position');
 await page.locator('[data-setting="canvasGuidesLocked"]').check();assert.ok(await input.isDisabled());console.log('PASS locked values disabled');
 assert.deepEqual(errors,[]);console.log('PASS no browser errors');
 await page.screenshot({path:'artifacts/canvas-guides/slidable-values.png'});
}finally{await browser.close();}
