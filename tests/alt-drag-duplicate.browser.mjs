import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';

const out = 'artifacts/alt-drag-duplicate';
await mkdir(out, {recursive: true});
const browser = await chromium.launch({channel: 'chrome', headless: true});
const page = await browser.newPage({viewport: {width: 1440, height: 1000}});
const errors = [], checks = [];
page.on('pageerror', error => errors.push(error.stack || error.message));
const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const check = (name, value) => { assert.ok(value, name); checks.push(name); console.log('PASS', name); };
async function setup() {
  await page.evaluate(async () => {
    const {emptyDocument, createFrame, createObject} = await import('/src/demo.mjs');
    const {worldToScreen} = await import('/src/renderer-geometry.mjs');
    const report = emptyDocument(), figure = report.figure_types[0];
    report.keyframes = [0, 1, 2].map(i => createFrame([createObject(figure, 1, 240 + i * 20, 270)], 10));
    styk.editor.load(report, 'Alt-drag acceptance'); styk.editor.select(1);
    styk.state.hidden.clear(); styk.state.locked.clear(); styk.state.handles = true; styk.fit();
    globalThis.__before = JSON.stringify(styk.editor.serialize());
    globalThis.__history = styk.editor._undo.length;
    globalThis.__point = (id = 0) => {
      const g = [...styk.editor.geometry.objects.values()].find(g => g.obj.unique_id === 1);
      const p = worldToScreen(g.joints.get(id), {report: styk.editor.report, frame: styk.editor.evaluatedFrame, view: styk.state.view});
      const r = document.querySelector('#viewport').getBoundingClientRect();
      return {x: r.left + p.x, y: r.top + p.y};
    };
  });
  await page.keyboard.press('v'); await settle();
}
async function press(id = 0) {
  const p = await page.evaluate(id => __point(id), id);
  await page.keyboard.down('Alt'); await page.mouse.move(p.x, p.y); await page.mouse.down();
  return p;
}
async function release() { await page.mouse.up(); await page.keyboard.up('Alt'); await settle(); }
const pristine = () => page.evaluate(() => JSON.stringify(styk.editor.serialize()) === __before && styk.editor._undo.length === __history && !styk.editor.dirty);

try {
  await page.goto(process.env.STYK_URL || 'http://127.0.0.1:47831');
  await page.waitForFunction(() => window.styk?.ready);
  await setup();
  let p = await press(); await page.mouse.move(p.x + 1, p.y); await release();
  check('Alt-click and mouse jitter do not create a duplicate', await pristine());
  for (const mode of ['advanced', 'simple']) {
    await page.locator(`[data-timeline-mode="${mode}"]`).click(); await setup();
    p = await press(); await page.mouse.move(p.x + 75, p.y + 30, {steps: 8}); await settle();
    check(`${mode}: dragging previews one copy with the original still present`, await page.evaluate(() => styk.state.drag?.duplicate && styk.editor.selectionFrame.objects.length === 2));
    // Releasing Alt mid-gesture must not insert more copies or move the original.
    await page.keyboard.up('Alt'); await page.mouse.move(p.x + 110, p.y + 50, {steps: 5}); await release();
    check(`${mode}: root duplication moves only the linked copy`, await page.evaluate(() => {
      const e = styk.editor, original = e.selectionFrame.objects.find(o => o.unique_id === 1);
      return e.selectedUid !== 1 && e.object.root_x > original.root_x && original.root_x === 240 && original.root_y === 270 && e.object.figure_type_id === original.figure_type_id && e._undo.length === __history + 1;
    }));
    if (mode === 'advanced') await page.screenshot({path: `${out}/linked-drag.png`});
    await page.keyboard.press('Control+z'); await settle();
    check(`${mode}: one undo removes the copy and movement`, await pristine());
    await page.keyboard.press('Control+y'); await settle();
    check(`${mode}: redo restores the moved copy`, await page.evaluate(() => styk.editor.selectionFrame.objects.length === 2 && styk.editor.object.root_x > 240));
  }
  await page.locator('[data-timeline-mode="advanced"]').click(); await setup();
  await page.keyboard.press('Control+,'); await page.locator('[data-tab="canvas"]').click();
  await page.locator('[data-setting="altDragDuplicate"]').selectOption('unique');
  await page.screenshot({path: `${out}/settings.png`}); await page.keyboard.press('Escape'); await settle();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('stykanimate.editor.settings.v1')).altDragDuplicate === 'unique');
  await page.reload(); await page.waitForFunction(() => window.styk?.ready); await setup();
  check('Independent copy preference survives reopening', await page.evaluate(() => styk.state.settings.altDragDuplicate === 'unique'));
  p = await press(); await page.mouse.move(p.x + 80, p.y + 20, {steps: 6}); await release();
  check('Independent copies get a separate figure definition', await page.evaluate(() => styk.editor.object.figure_type_id !== styk.editor.selectionFrame.objects.find(o => o.unique_id === 1).figure_type_id));
  for (const cancel of ['Escape', 'pointercancel', 'lostpointercapture', 'blur']) {
    await setup(); p = await press(); await page.mouse.move(p.x + 80, p.y + 20, {steps: 4});
    if (cancel === 'Escape') await page.keyboard.press('Escape');
    else await page.evaluate(kind => {
      const overlay = document.querySelector('#overlay');
      if (kind === 'blur') window.dispatchEvent(new Event('blur'));
      else if (kind === 'lostpointercapture') overlay.releasePointerCapture(1);
      else overlay.dispatchEvent(new PointerEvent(kind, {pointerId: 1, isPrimary: true}));
    }, cancel);
    await release(); check(`${cancel} removes the unfinished independent copy and its definition`, await pristine());
  }
  await setup(); p = await press(); await page.evaluate(() => styk.editor.seek(10)); await release();
  check('Seeking cancels a pending Alt press without copying a stale figure', await page.evaluate(() => !styk.state.drag && styk.editor.selectionFrame.objects.length === 1 && styk.editor._undo.length === __history));
  await setup(); p = await press(1); await page.mouse.move(p.x + 20, p.y + 30, {steps: 4});
  check('Alt-dragging a joint keeps the existing figure transform', await page.evaluate(() => styk.state.drag?.kind === 'figure-transform' && styk.editor.selectionFrame.objects.length === 1));
  await page.keyboard.press('Escape'); await release();
  check('No browser exceptions', errors.length === 0);
  await writeFile(`${out}/report.json`, JSON.stringify({checks, errors}, null, 2));
} finally { await browser.close(); }
