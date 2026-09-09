import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';

const browser = await chromium.launch({channel: 'chrome', headless: true});
const page = await browser.newPage({viewport: {width: 1440, height: 1000}}), errors = [], checks = [];
page.on('pageerror', error => errors.push(error.message));
const out = 'artifacts/figure-z-index';
const field = key => page.locator(`#inspector [data-property="${key}"]`);
const diamond = key => page.locator(`#inspector [data-property-key="${key}"]`);
const check = (name, value) => { assert.ok(value, name); checks.push(name); console.log('PASS', name); };
const order = () => page.evaluate(() => { const f = styk.editor.evaluatedFrame; return f.object_draw_order.map(slot => f.objects[slot].unique_id); });
async function seek(tick) { await page.evaluate(tick => styk.editor.seek(tick), tick); await page.waitForTimeout(100); }
async function type(key, value) { await field(key).fill(String(value)); await field(key).press('Enter'); await page.waitForTimeout(100); }
try {
  await mkdir(out, {recursive: true});
  await page.goto(process.env.STYK_URL || 'http://127.0.0.1:47831');
  await page.waitForFunction(() => window.styk?.ready);
  await page.evaluate(async () => {
    const {emptyDocument, createFrame, createObject} = await import('/src/demo.mjs');
    const report = emptyDocument(), figure = report.figure_types[0];
    report.keyframes = [0, 50, 0].map(x => createFrame([1, 2, 3].map((uid, i) => {
      const object = createObject(figure, uid, 300 + x + i * 14, 330);
      object.color_override_raw = [0xff3333ee, 0xffdd9944, 0xff77bb33][i]; return object;
    }), 10));
    styk.state.inspectorTab = 'design'; styk.state.inspectorContext = 'figure';
    styk.editor.load(report); styk.editor.select(1, -1); styk.fit();
  });
  await field('figure_z_order').waitFor();
  check('Pose-stored values have no keyframe controls', await diamond('root_x').count() === 0 &&
    await page.locator('[data-property-row="root_x"] .property-key-controls').count() === 0);
  check('Inspector has no explanatory paragraphs or subtitles', await page.locator('#inspector p, #inspector .property-context-heading small').count() === 0);
  await seek(5);
  check('Interpolated pose values also have no diamond', await diamond('root_x').count() === 0);
  await type('figure_z_order', 3);
  check('Editing Z-index creates a visible property key and brings the figure forward',
    (await diamond('figure_z_order').getAttribute('class')).includes('is-keyed') && JSON.stringify(await order()) === '[2,3,1]');
  await seek(4); check('Earlier frames retain their stacking order', JSON.stringify(await order()) === '[1,2,3]');
  await seek(10); await type('figure_z_order', -3);
  await seek(9); check('Stacking holds until the next keyframe', JSON.stringify(await order()) === '[2,3,1]');
  await seek(10); check('Stacking switches on the exact keyframe', JSON.stringify(await order()) === '[1,2,3]');
  await diamond('figure_z_order').hover();
  await page.locator('#inspector [data-property-nav="figure_z_order"][data-direction="-1"]').click();
  check('Property navigation reaches the previous Z-index key', await page.evaluate(() => styk.editor.tick === 5));
  await field('figure_z_order').fill('7'); await field('figure_z_order').press('Escape');
  check('Escape cancels the live depth edit', await field('figure_z_order').inputValue() === '3');
  await page.locator('#inspector [data-action="layer-down"]').click();
  await page.waitForTimeout(100);
  check('Send backward also works with animated numeric depths', JSON.stringify(await order()) === '[2,1,3]');
  await page.evaluate(() => styk.editor.undo()); await page.waitForTimeout(100);
  check('Undo restores depth and draw order together', JSON.stringify(await order()) === '[2,3,1]');
  await page.evaluate(() => styk.editor.addAnimationKey({kind: 'figure', uid: 1}, 'x'));
  await page.waitForTimeout(100);
  check('An inherited value can become an independent property key', (await diamond('root_x').getAttribute('class')).includes('is-keyed'));
  await diamond('root_x').click(); await page.waitForTimeout(100);
  check('Deleting the last scalar key removes its inspector diamond', await diamond('root_x').count() === 0);
  await seek(10);
  await type('root_x', 380);
  check('Editing after deleting the last scalar key changes the pose without reactivating the empty track',
    await page.evaluate(() => styk.editor.animationChannel({kind: 'figure', uid: 1}, 'x').keys.length === 0) &&
    await diamond('root_x').count() === 0);
  await page.screenshot({path: `${out}/inspector.png`});
  const depthPoint = await page.evaluate(() => {
    const t = styk.timeline, row = t.tracks.findIndex(track => track.property === 'zIndex' && track.target?.uid === 1), rect = t.scroll.getBoundingClientRect();
    if (row < 0) throw new Error('Z-index track is missing');
    return {x: rect.left + 12 + 5.5 * t.pxPerTick - t._offsetX(), y: rect.top + 31 + row * 30 + 15 - t._offsetY()};
  });
  await page.mouse.dblclick(depthPoint.x, depthPoint.y);
  await page.getByRole('dialog', {name: 'Keyframe easing'}).waitFor();
  check('Z-index timeline keys expose only Constant easing', await page.getByRole('radio', {name: 'Linear', exact: true}).isDisabled() &&
    await page.getByRole('radio', {name: 'Constant', exact: true}).isEnabled());
  await page.keyboard.press('Escape');
  await page.evaluate(() => { styk.editor.seek(10); styk.editor.select(1, 0); }); await page.waitForTimeout(100);
  check('Joint transforms have no pose markers or key controls', await page.locator('[data-property-row="joint_angle"] .property-key-controls, .property-pose-marker, .is-pose-keyed, .is-pose-animated').count() === 0);
  await page.screenshot({path: `${out}/joint-inspector.png`});
  check('No browser errors', errors.length === 0);
  await writeFile(`${out}/report.json`, JSON.stringify({checks, errors}, null, 2));
} finally { await browser.close(); }
