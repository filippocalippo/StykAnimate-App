/** Draw exit must settle before Build binds a figure or chooses its tool. */
import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';

const browser = await chromium.launch({channel: 'chrome', headless: true});
const page = await browser.newPage({viewport: {width: 1440, height: 900}});
const errors = [];
page.on('pageerror', error => errors.push(error.message));
await page.addInitScript(() => localStorage.setItem('stykanimate.editor.settings.v1', JSON.stringify({locale: 'en'})));
const mode = async name => {
  await page.locator(`.workspace-switch [data-workspace-mode="${name}"]`).click();
  await page.waitForFunction(name => document.querySelector('.workspace').dataset.mode === name, name);
};
async function drawSegment(x, y, dx = 65, dy = 30) {
  await page.mouse.move(x, y); await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, {steps: 5}); await page.mouse.up();
}
try {
  await page.goto(process.env.STYK_URL || 'http://127.0.0.1:47911');
  await page.waitForFunction(() => window.styk?.ready);
  // This flow authors a new figure. Draw restores the selection it was entered
  // with, so explicitly deselect the starter instead of binding it on return.
  await page.evaluate(() => styk.editor.select(null));
  await mode('draw');
  await page.locator('#open-insert').click();
  const viewport = await page.locator('#viewport').boundingBox();
  const x = viewport.x + viewport.width * .5, y = viewport.y + viewport.height * .5;
  await page.mouse.move(x, y); await page.mouse.down();
  await page.waitForFunction(() => Boolean(styk.drawing.gesture));
  await page.mouse.move(x + 90, y + 40, {steps: 8}); await page.mouse.up();
  await page.evaluate(() => styk.drawing.barrier());
  await page.locator('[data-tool="drawing-transform"]').click();
  await page.evaluate(() => {
    window.drawingLayer = styk.editor.activeLayerId;
    window.drawingBefore = JSON.stringify(styk.editor.drawingTarget().figure);
  });
  await mode('rig');
  assert.deepEqual(await page.evaluate(() => ({active: styk.drawing.active, tool: styk.state.tool,
    bound: styk.builder.session.typeId, drawingLayer: Boolean(styk.editor.getLayer(styk.editor.activeLayerId).drawing)})),
  {active: false, tool: 'line', bound: null, drawingLayer: false});
  let box = await page.locator('#viewport').boundingBox();
  const start = {x: box.x + box.width * .45, y: box.y + box.height * .5};
  await drawSegment(start.x, start.y);
  await page.waitForFunction(() => styk.editor.figure?.segments.length === 1);
  await drawSegment(start.x + 65, start.y + 30, 50, -35);
  await page.waitForFunction(() => styk.editor.figure?.segments.length === 2);
  assert.equal(await page.evaluate(() => JSON.stringify(styk.editor.drawingTarget(drawingLayer).figure) === drawingBefore), true);
  await page.evaluate(() => styk.editor.undo());
  assert.equal(await page.evaluate(() => styk.editor.figure.segments.length), 1);
  await page.evaluate(() => styk.editor.redo());
  assert.equal(await page.evaluate(() => styk.editor.figure.segments.length), 2);
  await page.locator('#builder-done').click(); await page.locator('#builder-exit-import').click();
  console.log('PASS Draw cel stays unchanged; Build selects a figure layer, draws and extends segments, undoes and redoes');

  for (const latest of ['rig', 'draw', 'animate']) {
    await page.evaluate(() => styk.editor.select(null));
    await mode('draw');
    await page.evaluate(() => {
      const original = styk.drawing.settle.bind(styk.drawing);
      const gate = new Promise(resolve => { window.releaseDrawExit = resolve; });
      styk.drawing.settle = options => {
        styk.drawing.settle = original;
        return Promise.resolve(original(options)).then(() => gate);
      };
    });
    await page.locator('.workspace-switch [data-workspace-mode="rig"]').click();
    assert.equal(await page.evaluate(() => styk.builder.active), false, 'Build waits for Draw');
    if (latest !== 'rig') await page.locator(`.workspace-switch [data-workspace-mode="${latest}"]`).click();
    await page.evaluate(() => releaseDrawExit());
    await page.waitForFunction(name => document.querySelector('.workspace').dataset.mode === name, latest);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.evaluate(() => styk.builder.active), latest === 'rig');
    if (latest === 'rig') {
      assert.equal(await page.evaluate(() => styk.state.tool), 'line');
      await page.locator('#builder-done').click();
    }
  }
  assert.deepEqual(errors, []);
  console.log('PASS Pending drawing operations finish before Build; rapid workspace changes keep the latest choice');
} finally { await browser.close(); }
