import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
const output='artifacts/rig-smart-stretch';await mkdir(output,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
page.on('pageerror',error=>errors.push(error.message));
const settle=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
const openRig=async()=>{const toggle=page.locator('[data-section-toggle="rig-controls"]');if(await toggle.getAttribute('aria-expanded')==='false')await toggle.click();};
const select=async id=>{await page.evaluate(id=>styk.editor.select(1,styk.editor.figure.segments.findIndex(s=>s.segment_id===id)),id);await settle();};
const value=async(id,v)=>{await page.locator(`#${id}`).fill(String(v));await page.locator(`#${id}`).press('Tab');await settle();};
try{
  await page.goto(process.env.STYK_URL??'http://127.0.0.1:47851');await page.waitForFunction(()=>window.styk?.ready);
  await page.evaluate(async()=>{
    const {rigExampleDocument}=await import('/src/rig-examples.mjs'),e=styk.editor;
    e.load(rigExampleDocument('telescoping-panels'));e.select(1,0);e.setRigBehavior({stretch:null});styk.builder.enter();e.select(1,0);
  });await settle();
  await openRig();await page.locator('#rig-stretch-enabled').check();await settle();
  await select(2);await value('rig-multiplier',-1);await page.locator('#rig-reset-impulse').check();await settle();
  assert.equal(await page.evaluate(()=>styk.editor.figure.segments[1]._stykRig.response.multiplier),-1);
  await page.locator('#rig-response').selectOption('stop');await settle();
  assert.equal(await page.evaluate(async()=>{const {rigConstraintPlan}=await import('/src/rig-constraints.mjs');return rigConstraintPlan(styk.editor.figure).inputs[3]===undefined;}),true);
  await page.locator('#rig-response').selectOption('stretch');await settle();
  await page.locator('#rig-angle-lock').selectOption('parent');await settle();await value('rig-lock-multiplier',-1);
  assert.equal(await page.evaluate(()=>styk.editor.figure.segments[1]._stykRig.angleLock.reference),1);
  await page.evaluate(()=>styk.actions['zoom-selection']());await settle();
  for(const [theme,width,height] of [['light',1440,1000],['dark',1100,760],['light',1100,760]]){
    await page.setViewportSize({width,height});await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);await settle();
    assert.equal(await page.locator('[data-section="rig-controls"] p').count(),0);
    const overflow=await page.locator('[data-section="rig-controls"] > .ui-section-body').evaluate(root=>root.scrollWidth>root.clientWidth+1);assert.equal(overflow,false);
    await page.screenshot({path:`${output}/response-${theme}-${width}.png`});
  }
  await page.setViewportSize({width:1440,height:1000});
  await page.locator('.titlebar [data-action="rig-test"]').click();await page.locator('#rig-test-canvas').waitFor();
  await page.locator('#rig-test-joint').selectOption('2');await settle();assert.equal(await page.locator('#rig-test-angle').isDisabled(),true);
  await page.screenshot({path:`${output}/test-rig.png`});
  await page.locator('#dialog [data-action="close-dialog"]').last().click();await settle();
  await page.evaluate(()=>{const e=styk.editor;const c=e.addConnector(1,7);e.select(1,e.figure.segments.findIndex(s=>s.segment_id===c.segment_id));});await settle();
  // A connector opens on its Slider; Smart stretch belongs to its Segment.
  await page.locator('[data-connector-part="segment"]').click();await settle();await openRig();
  await page.locator('#rig-stretch-enabled').check();await settle();await page.locator('#rig-source').selectOption('combined');await settle();
  await value('rig-rest-position',50);
  assert.equal(await page.evaluate(()=>styk.editor.figure.segments[styk.editor.selectedJoint]._stykRig.stretch.source),'combined');
  await page.screenshot({path:`${output}/connector-source.png`});
  assert.deepEqual(errors,[]);await writeFile(`${output}/browser-report.json`,JSON.stringify({errors,multiplier:true,reset:true,stopBranch:true,parentLock:true,connectorSource:true,layouts:3},null,2));
  console.log('Rig multiplier, reset, stop, angle lock, connector source and compact/theme flows passed.');
}finally{await browser.close();}
