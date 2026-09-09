import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';

const browser = await chromium.launch({channel: 'chrome', headless: true});
const page = await browser.newPage({viewport: {width: 1440, height: 1000}}), errors = [], checks = [];
page.on('pageerror', error => errors.push(error.message));
const out = 'artifacts/figure-order-controls';
const toolbar = action => page.locator(`.canvas-toolbar [data-action="${action}"]`);
const order = () => page.evaluate(() => styk.editor.evaluatedFrame.object_draw_order_unique_ids);
const check = (name, value) => { assert.ok(value, name); checks.push(name); console.log('PASS', name); };
async function reset(selection = [1]) {
  await page.evaluate(async selection => {
    const {emptyDocument, createFrame, createObject} = await import('/src/demo.mjs');
    const report = emptyDocument();
    report.keyframes = [0, 1, 2].map(() => createFrame([1, 2, 3, 4].map((uid, i) => {
      const object = createObject(report.figure_types[0], uid, 285 + i * 18, 330);
      object.color_override_raw = [0xff3333ee, 0xffdd9944, 0xff77bb33, 0xffdd55aa][i]; return object;
    }), 10));
    styk.state.inspectorTab = 'design'; styk.state.inspectorContext = 'figure';
    styk.editor.load(report);
    for (const uid of [1, 2, 3, 4]) styk.editor.adoptNativePoseTrack({kind: 'figure', uid});
    styk.editor.seek(5); styk.editor.selectMany(selection); styk.fit();
  }, selection);
}
try {
  await mkdir(out, {recursive: true});
  await page.goto(process.env.STYK_URL || 'http://127.0.0.1:47831');
  await page.waitForFunction(() => window.styk?.ready);
  for (const [action, selection, expected] of [
    ['layer-up', [1], [2, 1, 3, 4]], ['layer-down', [4], [1, 2, 4, 3]],
    ['layer-front', [1], [2, 3, 4, 1]], ['layer-back', [4], [4, 1, 2, 3]],
  ]) {
    await reset(selection);
    await page.locator(`#inspector [data-action="${action}"]`).click();
    check(`Inspector ${action} reorders independent figure poses`, JSON.stringify(await order()) === JSON.stringify(expected));
  }
  for (const [action, selection, shifted, expected] of [
    ['layer-front', [1], false, [2, 3, 4, 1]], ['layer-back', [4], false, [4, 1, 2, 3]],
    ['layer-front', [1], true, [2, 1, 3, 4]], ['layer-back', [4], true, [1, 2, 4, 3]],
    ['layer-front', [1, 3], false, [2, 4, 1, 3]], ['layer-back', [2, 4], false, [2, 4, 1, 3]],
    ['layer-front', [1, 3], true, [2, 1, 4, 3]], ['layer-back', [2, 4], true, [2, 1, 4, 3]],
  ]) {
    await reset(selection);
    await toolbar(action).click({modifiers: shifted ? ['Shift'] : []});
    check(`Toolbar ${action}, selection ${selection}, Shift=${shifted}`, JSON.stringify(await order()) === JSON.stringify(expected));
  }
  await reset([1, 3]);
  await toolbar('layer-front').click();
  check('Toolbar moves multiple selected figures to front', JSON.stringify(await order()) === '[2,4,1,3]');
  check('Ordering preserves the selection', await page.evaluate(() => JSON.stringify([...styk.editor.selectedUids]) === '[1,3]'));
  await toolbar('undo').click();
  check('Toolbar order changes undo atomically', JSON.stringify(await order()) === '[1,2,3,4]');
  await toolbar('redo').click();
  check('Toolbar order changes redo atomically', JSON.stringify(await order()) === '[2,4,1,3]');
  await page.evaluate(() => styk.editor.seek(4));
  check('Order before the key is preserved', JSON.stringify(await order()) === '[1,2,3,4]');
  await page.evaluate(() => { styk.editor.seek(5); styk.editor.selectMany([]); });
  await page.waitForFunction(() => [...document.querySelectorAll('[data-selection-order]')].every(button => button.disabled));
  check('Both toolbar buttons disable for an empty selection', await toolbar('layer-front').isDisabled() && await toolbar('layer-back').isDisabled());
  await page.evaluate(() => styk.editor.select(1, -1));
  await page.locator('#inspector [data-property="figure_z_order"]').waitFor();
  check('Inspector stays free of explanatory paragraphs and pose markers',
    await page.locator('#inspector p, #inspector .property-context-heading small, #inspector .property-pose-marker').count() === 0);
  await toolbar('layer-front').hover();
  await page.screenshot({path: `${out}/toolbar.png`});
  check('No browser errors', errors.length === 0);
  await writeFile(`${out}/report.json`, JSON.stringify({checks, errors}, null, 2));
} finally { await browser.close(); }
