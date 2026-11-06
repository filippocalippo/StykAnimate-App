/** Direct workspace arrangement: center tools, float, stack, dock and persist. */
import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';

const out = 'artifacts/workspace-drag-latest';
await mkdir(out, {recursive: true});
const browser = await chromium.launch({channel: 'chrome', headless: true});
const page = await browser.newPage({viewport: {width: 1440, height: 900}});
const errors = [];
page.on('pageerror', error => errors.push(error.message));
await page.addInitScript(() => localStorage.setItem('stykanimate.editor.settings.v1', JSON.stringify({locale: 'en'})));
const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const box = selector => page.locator(selector).boundingBox();
const placement = id => page.evaluate(id => styk.workspace.layout.modes[document.querySelector('.workspace').dataset.mode].panels.find(panel => panel.id === id), id);
async function drag(selector, target, {cancel = false, label} = {}) {
  const source = await box(selector);
  assert.ok(source, `${selector} has a visible drag handle`);
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down(); await page.mouse.move(target.x, target.y, {steps: 8});
  if (label) assert.equal(await page.locator('.shell-drag-zone').textContent(), label);
  if (cancel) await page.keyboard.press('Escape');
  await page.mouse.up(); await settle();
}
async function centered() {
  const rail = await box('.shell-rail'), viewport = await box('#viewport');
  assert.ok(Math.abs(rail.y + rail.height / 2 - viewport.y - viewport.height / 2) <= 1);
  assert.ok(rail.y >= viewport.y && rail.y + rail.height <= viewport.y + viewport.height);
}
try {
  await page.goto(process.env.STYK_URL || 'http://127.0.0.1:47911');
  await page.waitForFunction(() => window.styk?.ready); await settle();
  await centered();
  let viewport = await box('#viewport');
  await drag('.shell-rail-handle', {x: viewport.x + viewport.width - 24, y: viewport.y + viewport.height / 2}, {label: 'Move tools right'});
  assert.equal(await page.locator('.workspace').getAttribute('data-rail'), 'right');
  await centered();
  await page.locator('.shell-rail-handle').focus(); await page.keyboard.press('ArrowLeft');
  assert.equal(await page.locator('.workspace').getAttribute('data-rail'), 'left');
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('.workspace').getAttribute('data-rail'), 'right');
  await drag('.shell-rail-handle', {x: viewport.x + 24, y: viewport.y + viewport.height / 2}, {cancel: true});
  assert.equal(await page.locator('.workspace').getAttribute('data-rail'), 'right');

  await drag('#properties-tab', {x: viewport.x + viewport.width * .5, y: viewport.y + 90}, {label: 'Float here'});
  assert.equal((await placement('properties')).dock, 'float');
  assert.equal(await page.locator('#properties-panel').isVisible(), true);
  const before = await placement('properties');
  let handle = await box('#properties-tab');
  await drag('#properties-tab', {x: handle.x + handle.width / 2 + 60, y: handle.y + handle.height / 2});
  const after = await placement('properties');
  assert.ok(after.rect.x > before.rect.x);
  assert.equal(after.rect.w, before.rect.w); assert.equal(after.rect.h, before.rect.h);
  viewport = await box('#viewport');
  await drag('#properties-tab', {x: viewport.x + viewport.width / 2, y: viewport.y + 60}, {cancel: true});
  assert.deepEqual(await placement('properties'), after);
  await drag('#properties-tab', {x: viewport.x + viewport.width - 25, y: viewport.y + viewport.height / 2}, {label: 'Dock right'});
  assert.equal((await placement('properties')).dock, 'right');

  const right = await box('.shell-right');
  await drag('#library-tab', {x: right.x + right.width / 2, y: right.y + right.height - 25}, {label: 'Stack below'});
  assert.equal((await placement('library')).group, 1);
  assert.equal(await page.locator('#properties-panel').isVisible(), true);
  assert.equal(await page.locator('#user-library').isVisible(), true);
  const splitter = page.locator('[data-splitter="right-islands"]');
  assert.equal(await splitter.isVisible(), true);
  const heightBefore = Number(await splitter.getAttribute('aria-valuenow'));
  await splitter.focus(); await page.keyboard.press('ArrowUp');
  assert.ok(Number(await splitter.getAttribute('aria-valuenow')) < heightBefore);
  const weightsBefore = await page.evaluate(() => styk.workspace.layout.modes.animate.weights.right);
  await drag('[data-splitter="right-islands"]', {x: right.x + right.width / 2, y: right.y + right.height * .6}, {cancel: true});
  assert.deepEqual(await page.evaluate(() => styk.workspace.layout.modes.animate.weights.right), weightsBefore);
  await page.evaluate(() => styk.workspace.flushPreferences());
  await page.screenshot({path: `${out}/stacked.png`});
  await page.reload(); await page.waitForFunction(() => window.styk?.ready); await settle();
  assert.equal((await placement('library')).group, 1);
  assert.equal(await page.locator('.workspace').getAttribute('data-rail'), 'right');
  await centered();
  const tabs = await box('.shell-right .shell-island:first-child .shell-tabs');
  await drag('#library-tab', {x: tabs.x + tabs.width / 2, y: tabs.y + tabs.height / 2}, {label: 'Add as a tab'});
  assert.equal((await placement('library')).group ?? 0, 0);
  assert.equal(await page.locator('.shell-right > .shell-island:not(.shell-sheet):visible').count(), 1);
  console.log('PASS centered tools move between sides; panels float without modifiers, move, dock, stack, resize, merge and persist; Escape cancels');

  await page.locator('.workspace-switch [data-workspace-mode="rig"]').click(); await settle();
  assert.equal(await page.locator('.workspace').getAttribute('data-rail'), 'left', 'workspace arrangements are independent');
  viewport = await box('#viewport');
  // Build's Structure starts folded to its strip; its button opens it as a sheet, and the sheet's tab drags it out.
  assert.equal((await placement('structure')).dock, 'strip');
  await page.locator('.shell-strip > [data-panel="structure"]').click(); await settle();
  await drag('#structure-tab', {x: viewport.x + viewport.width / 2, y: viewport.y + 70}, {label: 'Float here'});
  assert.equal((await placement('structure')).dock, 'float');
  assert.equal(await page.locator('#builder-outliner').isVisible(), true);
  await page.screenshot({path: `${out}/build-floating.png`});
  await page.locator('#builder-done').click();
  for (const [width, height] of [[1440, 900], [800, 600], [500, 340]]) {
    await page.setViewportSize({width, height}); await settle(); await centered();
    await page.screenshot({path: `${out}/animate-${width}x${height}.png`});
  }
  assert.deepEqual(errors, []);
  console.log('PASS Structure has a visible drag handle and floats; the tool palette stays centered at compact sizes');
} finally { await browser.close(); }
