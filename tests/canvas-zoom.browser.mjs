import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {normalizeEditorSettings} from '../src/settings.mjs';

assert.equal(normalizeEditorSettings().canvasZoomGesture, 'ctrl-scroll');
assert.equal(normalizeEditorSettings({canvasZoomGesture:'invalid'}).canvasZoomGesture, 'ctrl-scroll');
const browser = await chromium.launch({channel:'chrome', headless:true});
const page = await browser.newPage({viewport:{width:1280,height:900}});
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const view = () => page.evaluate(() => ({...styk.state.view}));
const wheel = modifiers => page.evaluate(modifiers => {
  const viewport = document.querySelector('#viewport'), rect = viewport.getBoundingClientRect();
  viewport.dispatchEvent(new WheelEvent('wheel', {bubbles:true,cancelable:true,
    deltaY:40,clientX:rect.left+250,clientY:rect.top+200,...modifiers}));
}, modifiers);
try {
  await page.goto(process.env.STYK_URL || 'http://127.0.0.1:47831');
  await page.waitForFunction(() => window.styk?.ready);
  let before = await view();
  await wheel({});
  let after = await view();
  assert.equal(after.scale,before.scale);
  assert.equal(after.y,before.y-40);
  before = after;
  await wheel({shiftKey:true});
  after = await view();
  assert.equal(after.scale,before.scale);
  assert.equal(after.x,before.x-40);
  for (const modifiers of [{ctrlKey:true},{metaKey:true}]) {
    before = await view();
    await wheel(modifiers);
    after = await view();
    assert.ok(after.scale < before.scale);
    assert.ok(Math.abs((250-before.x)/before.scale-(250-after.x)/after.scale)<1e-8);
    assert.ok(Math.abs((200-before.y)/before.scale-(200-after.y)/after.scale)<1e-8);
  }
  await page.evaluate(() => styk.settingsUI.open('canvas'));
  const select = page.getByRole('combobox',{name:'Zoom gesture'});
  assert.equal(await select.inputValue(),'ctrl-scroll');
  await select.selectOption('scroll');
  await mkdir('artifacts',{recursive:true});
  await page.screenshot({path:'artifacts/canvas-zoom-settings.png'});
  await page.evaluate(async () => { styk.settingsUI.close(); await styk.settingsUI.flush(); });
  for (const modifiers of [{},{ctrlKey:true},{metaKey:true}]) {
    before = await view();
    await wheel(modifiers);
    assert.ok((await view()).scale < before.scale);
  }
  await page.reload();
  await page.waitForFunction(() => window.styk?.ready);
  assert.equal(await page.evaluate(() => styk.state.settings.canvasZoomGesture),'scroll');
  before = await view();
  await wheel({});
  assert.ok((await view()).scale < before.scale);
  await page.evaluate(() => styk.settingsUI.open('canvas'));
  await select.selectOption('ctrl-scroll');
  await page.evaluate(() => styk.settingsUI.close());
  // Let the previous notch's glide land before sampling the view.
  await page.waitForTimeout(400);
  before = await view();
  await wheel({});
  assert.equal((await view()).scale,before.scale);
  // Smooth zooming: Automatic glides except on the WebGL2 backend; On and Off override it.
  const notch = async () => {
    // A 100 px notch, then the view one frame later: a glide has only started, a step has finished.
    const before = (await view()).scale;
    await wheel({ctrlKey:true,deltaY:-100});
    const first = (await view()).scale;
    await page.waitForTimeout(400);
    return {first:first/before, settled:(await view()).scale/before};
  };
  const backend = await page.evaluate(() => styk.state.renderer.stats.backend);
  await page.evaluate(() => styk.settingsUI.open('canvas'));
  const smooth = page.getByRole('combobox',{name:'Smooth zooming'});
  assert.equal(await smooth.inputValue(),'auto');
  await page.screenshot({path:'artifacts/canvas-zoom-smooth-setting.png'});
  await page.evaluate(() => styk.settingsUI.close());
  const expectedAutomatic = backend !== 'WebGL2';
  for (const [mode, glides] of [['auto', expectedAutomatic], ['on', true], ['off', false]]) {
    await page.evaluate(async mode => { styk.settingsUI.commit({smoothZoom:mode}); await styk.settingsUI.flush(); }, mode);
    const step = await notch();
    assert.ok(Math.abs(step.settled - 1.35) < 0.01, `${mode}: a notch zooms about 1.35x (${step.settled})`);
    if (glides) assert.ok(step.first < step.settled - 0.05, `${mode}: the view glides toward the notch (${step.first})`);
    else assert.ok(Math.abs(step.first - step.settled) < 1e-9, `${mode}: the notch applies at once (${step.first})`);
  }
  await page.reload();
  await page.waitForFunction(() => window.styk?.ready);
  assert.equal(await page.evaluate(() => styk.state.settings.smoothZoom),'off');
  await page.evaluate(async () => { styk.settingsUI.commit({smoothZoom:'auto'}); await styk.settingsUI.flush(); });
  assert.deepEqual(errors,[]);
  console.log(`PASS: zoom modes, pan modifiers, pointer anchor, settings UI, smooth zooming (${backend}), reload persistence, and no page errors`);
} finally {
  await browser.close();
}
