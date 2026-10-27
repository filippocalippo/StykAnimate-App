import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';

const browser = await chromium.launch({channel: 'chrome', headless: true});
const page = await browser.newPage({viewport: {width: 1440, height: 1000}}), errors = [], checks = [];
page.on('pageerror', error => errors.push(error.message));
const out = 'artifacts/figure-z-index';
const field = key => page.locator(`#inspector [data-property="${key}"]`);
const check = (name, value) => { assert.ok(value, name); checks.push(name); console.log('PASS', name); };
const order = () => page.evaluate(() => { const f = styk.editor.evaluatedFrame; return f.object_draw_order.map(slot => f.objects[slot].unique_id); });
const layerKeys = () => page.evaluate(() => styk.editor.layerFrameKeys(styk.editor.layerForUid(1)).map(key => key.tick));
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
  check('Pose-stored values have no keyframe controls', await page.locator('#inspector [data-property-key], #inspector [data-property-nav], [data-property-row="root_x"] .property-key-controls').count() === 0);
  check('Inspector has no explanatory paragraphs or subtitles', await page.locator('#inspector p, #inspector .property-context-heading small').count() === 0);
  await seek(5);
  await type('figure_z_order', 3);
  check('Editing Z-index writes a layer key and brings the figure forward',
    (await layerKeys()).includes(5) && JSON.stringify(await order()) === '[2,3,1]');
  check('The typed depth is part of the layer pose, not a scalar channel',
    await page.evaluate(() => styk.editor.animationChannels.length === 0));
  await seek(4); check('Earlier frames retain their stacking order', JSON.stringify(await order()) === '[1,2,3]');
  await seek(10); await type('figure_z_order', -3);
  await seek(9); check('Stacking holds until the next keyframe', JSON.stringify(await order()) === '[2,3,1]');
  await seek(10); check('Stacking switches on the exact keyframe', JSON.stringify(await order()) === '[1,2,3]');
  await page.locator('#timeline-menu-button').click(); await page.getByRole('menuitem', {name: 'Previous key', exact: true}).click();
  check('Sheet key navigation reaches the previous layer key', await page.evaluate(() => styk.editor.tick === 5));
  await field('figure_z_order').fill('7'); await field('figure_z_order').press('Escape');
  check('Escape cancels the live depth edit', await field('figure_z_order').inputValue() === '3');
  await page.evaluate(() => styk.actions['layer-down']());
  await page.waitForTimeout(100);
  check('Send backward also works with authored numeric depths', JSON.stringify(await order()) === '[2,1,3]');
  await page.evaluate(() => styk.editor.undo()); await page.waitForTimeout(100);
  check('Undo restores depth and draw order together', JSON.stringify(await order()) === '[2,3,1]');
  // One layer can hold only one key per tick; adding at a held, unkeyed tick
  // cuts a boundary there.
  await seek(15);
  const beforePoseKey = await layerKeys();
  await page.evaluate(() => styk.editor.addAnimationKey({kind: 'figure', uid: 1}, 'x'));
  await page.waitForTimeout(100);
  check('Adding a pose key creates a sheet key at the current tick',
    (await layerKeys()).includes(15) && (await layerKeys()).length === beforePoseKey.length + 1);
  await page.evaluate(() => styk.editor.undo()); await page.waitForTimeout(100);
  check('Undoing the key addition removes it cleanly', JSON.stringify(await layerKeys()) === JSON.stringify(beforePoseKey));
  await seek(10);
  await type('root_x', 380);
  check('Pose edits still write only layer keys',
    await page.evaluate(() => styk.editor.animationChannels.length === 0 && styk.editor.evaluatedFrame.objects[0].root_x === 380));
  await page.screenshot({path: `${out}/inspector.png`});
  // The authored key at tick 10 is selected on the layer sheet; its easing is a
  // whole-pose choice, offered by the timeline interpolation control.
  await page.evaluate(() => { const t = styk.timeline; t._selectCell({tick: 10, row: t.tracks.findIndex(track => track.id === styk.editor.layerForUid(1))}); });
  await page.waitForTimeout(100);
  await page.evaluate(() => styk.timeline.showEasingPopover());
  await page.getByRole('dialog', {name: 'Keyframe easing'}).waitFor();
  check('Sheet keys expose pose interpolation through the easing popover', true);
  await page.getByRole('radio', {name: 'Linear', exact: true}).click();
  await page.waitForTimeout(100);
  check('Changing interpolation retimes the whole layer key',
    await page.evaluate(() => {
      const keys = styk.editor.report._styk.layerSheet.tracks[styk.editor.layerForUid(1)].keys;
      return keys.some(key => key.tick === 10 && key.interpolation === 'linear');
    }));
  await page.evaluate(() => { styk.editor.seek(10); styk.editor.select(1, 0); }); await page.waitForTimeout(100);
  check('Joint transforms have no pose markers or key controls', await page.locator('[data-property-row="joint_angle"] .property-key-controls, .property-pose-marker, .is-pose-keyed, .is-pose-animated').count() === 0);
  await page.screenshot({path: `${out}/joint-inspector.png`});
  check('No browser errors', errors.length === 0);
  await writeFile(`${out}/report.json`, JSON.stringify({checks, errors}, null, 2));
} finally { await browser.close(); }
