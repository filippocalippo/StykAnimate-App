import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {normalizeEditorSettings} from '../src/settings.mjs';

assert.equal(normalizeEditorSettings().fitViewOnPlayback, true);
assert.equal(normalizeEditorSettings({fitViewOnPlayback:'false'}).fitViewOnPlayback, true);
const browser = await chromium.launch({channel:'chrome', headless:true});
const page = await browser.newPage({viewport:{width:1280,height:900}});
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const customView = {scale:1.7, x:123, y:-87};
const view = () => page.evaluate(() => ({...styk.state.view}));
const start = () => page.evaluate(async custom => {
  styk.state.view = {...custom};
  await styk.actions.play();
  return styk.state.playing;
}, customView);
const stop = () => page.evaluate(async () => { if (styk.state.playing) await styk.actions.play(); });
try {
  await page.goto(process.env.STYK_URL || 'http://127.0.0.1:47831');
  await page.waitForFunction(() => window.styk?.ready);
  const fitted = await page.evaluate(() => { styk.fit(); return {...styk.state.view}; });
  assert.equal(await start(), true);
  assert.deepEqual(await view(), fitted);
  await stop();
  await page.evaluate(() => styk.settingsUI.open('animation'));
  const checkbox = page.getByRole('switch', {name:'Fit view when playback starts', exact:true});
  assert.equal(await checkbox.isChecked(), true);
  await checkbox.uncheck();
  await mkdir('artifacts', {recursive:true});
  await page.screenshot({path:'artifacts/playback-view-settings.png'});
  await page.evaluate(async () => { styk.settingsUI.close(); await styk.settingsUI.flush(); });
  assert.equal(await start(), true);
  assert.deepEqual(await view(), customView);
  await stop();
  assert.deepEqual(await view(), customView);
  await page.reload();
  await page.waitForFunction(() => window.styk?.ready);
  assert.equal(await page.evaluate(() => styk.state.settings.fitViewOnPlayback), false);
  assert.equal(await start(), true);
  assert.deepEqual(await view(), customView);
  await stop();
  await page.evaluate(() => styk.settingsUI.open('animation'));
  assert.equal(await checkbox.isChecked(), false);
  await checkbox.check();
  await page.evaluate(() => styk.settingsUI.close());
  assert.equal(await start(), true);
  assert.deepEqual(await view(), fitted);
  await stop();
  assert.deepEqual(errors, []);
  console.log('PASS: default fit, disabled zoom/pan preservation, pause, reload persistence, re-enabled fit, and no page errors');
} finally {
  await browser.close();
}
