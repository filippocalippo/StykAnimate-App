import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';

const output = 'artifacts/onion-selection-fix';
await mkdir(output, {recursive: true});
const browser = await chromium.launch({channel: 'chrome', headless: true});
const page = await browser.newPage({viewport: {width: 1440, height: 960}}), errors = [], checks = [];
page.on('pageerror', error => errors.push(error.message));
page.setDefaultTimeout(15000);
const toolbar = action => page.locator(`.canvas-toolbar [data-action="${action}"]`);
async function ghosts(expected, name) {
  await page.waitForFunction(expected => JSON.stringify(styk.state.renderer.last?.onionFrames.map(s => s.frame.objects.map(o => o.root_x))) === JSON.stringify(expected), expected);
  checks.push(name);
}
const renderedOrder = () => page.evaluate(() => styk.editor.geometry.objects.get(0).drawables.filter(d => d.seg).map(d => d.seg.segment_id));
try {
  await page.goto(process.env.STYK_URL || 'http://127.0.0.1:47831');
  await page.waitForFunction(() => window.styk?.ready);
  await page.evaluate(async () => {
    const {emptyDocument, createObject, createFrame} = await import('/src/demo.mjs');
    const report = emptyDocument(), figure = report.figure_types[0];
    figure.segments = [{...figure.segments[0], length: 100, thickness: 20, angle_rad: 0}]; figure.segment_count = 1;
    report.keyframes = [createFrame([createObject(figure, 1, 180, 270)], 1)];
    styk.editor.load(report); styk.editor.select(1);
    styk.settingsUI.commit({timelineMode: 'simple', onionBefore: 1, onionAfter: 1, onionMode: 'keyframes', onionOpacity: .6});
    styk.state.onion = false; styk.fit();
  });
  await page.locator('#onion-button').click();
  await ghosts([], 'Enable onion before adding any frames');
  await page.getByRole('button', {name: 'Add frame', exact: true}).click();
  await page.evaluate(() => styk.editor.updateObject({root_x: 400}));
  await ghosts([[180]], 'First added pose shows its predecessor');
  await page.getByRole('button', {name: 'Add frame', exact: true}).click();
  await page.evaluate(() => styk.editor.updateObject({root_x: 620}));
  await ghosts([[400]], 'Second added pose refreshes the enabled onion skin');
  await page.evaluate(() => styk.editor.seek(1));
  await ghosts([[180], [620]], 'Scrubbing shows before and after poses');
  await page.screenshot({path: `${output}/onion-simple.png`});
  await page.evaluate(() => { styk.editor.seek(0); styk.editor.updateObject({root_x: 240}); styk.editor.seek(1); });
  await ghosts([[240], [620]], 'Editing a stored pose refreshes rendered ghosts');
  await toolbar('undo').click(); await page.evaluate(() => styk.editor.seek(1));
  await ghosts([[180], [620]], 'Undo refreshes rendered ghosts');
  await toolbar('redo').click(); await page.evaluate(() => styk.editor.seek(1));
  await ghosts([[240], [620]], 'Redo refreshes rendered ghosts');
  await page.evaluate(() => {
    styk.settingsUI.commit({timelineMode: 'advanced'});
    styk.editor.sheetInsertFrames(['scene', 'camera', 'layer-1'], 2, 8);
    styk.editor.selectSheetLayer('layer-1'); styk.editor.seek(5);
  });
  const grid = page.getByRole('grid', {name: 'Layer frames'});
  await grid.press('F6');
  await page.evaluate(() => { styk.editor.select(1); styk.editor.updateObject({root_x: 500}); styk.editor.seek(1); });
  await ghosts([[240], [500]], 'F6 inserts a new neighboring onion pose in Advanced');
  await page.evaluate(() => styk.editor.sheetMoveFrames(['layer-1'], 5, 5, 7));
  await ghosts([[240], [620]], 'Retiming chooses the new nearest key');
  await page.evaluate(() => styk.editor.sheetInsertKey(['layer-1'], 5, {blank: true}));
  await ghosts([[240], []], 'Blank keys remove their layer artwork');
  await toolbar('undo').click(); await ghosts([[240], [620]], 'Undo restores artwork after a blank key');
  await page.screenshot({path: `${output}/onion-advanced.png`});

  await page.evaluate(async () => {
    const {emptyDocument, createObject, createFrame} = await import('/src/demo.mjs');
    const report = emptyDocument(), figure = report.figure_types[0];
    figure.segments = figure.segments.slice(0, 4).map((s, i) => ({...s, segment_id: i + 1, parent_id: 0,
      z_order: i + 1, angle_rad: [.3, -.3, .6, -.6][i], length: 150, thickness: 26,
      color_rgb: [[225, 65, 65], [60, 180, 90], [60, 120, 230], [165, 75, 195]][i]}));
    figure.segment_count = 4;
    report.keyframes = [createFrame([createObject(figure, 1, 360, 270), createObject(figure, 2, 630, 270)], 1)];
    styk.editor.load(report); styk.state.onion = false; styk.editor.select(1, 0); styk.fit();
  });
  assert.deepEqual(await renderedOrder(), [1, 2, 3, 4]);
  await page.screenshot({path: `${output}/segment-before.png`});
  await toolbar('selection-front').click();
  assert.deepEqual(await renderedOrder(), [2, 3, 4, 1]);
  assert.deepEqual(await page.evaluate(() => styk.editor.evaluatedFrame.object_draw_order_unique_ids), [1, 2]);
  checks.push('Topbar brings the selected internal segment to front without reordering figures');
  await page.screenshot({path: `${output}/segment-front.png`});
  await toolbar('undo').click(); assert.deepEqual(await renderedOrder(), [1, 2, 3, 4]);
  await toolbar('redo').click(); assert.deepEqual(await renderedOrder(), [2, 3, 4, 1]);
  await toolbar('selection-back').click({modifiers: ['Shift']});
  assert.deepEqual(await renderedOrder(), [2, 3, 1, 4]);
  await toolbar('selection-front').click({modifiers: ['Shift']});
  assert.deepEqual(await renderedOrder(), [2, 3, 4, 1]);
  await toolbar('selection-back').click(); assert.deepEqual(await renderedOrder(), [1, 2, 3, 4]);
  checks.push('Topbar segment ordering supports undo, redo, both directions and Shift one-step moves');
  await page.evaluate(() => { styk.editor.figure.segments[1].parent_id = 1; styk.editor.selectBranch(1, 0); });
  await toolbar('selection-front').click(); assert.deepEqual(await renderedOrder(), [3, 4, 1, 2]);
  assert.equal(await page.evaluate(() => styk.editor.branchSelected), true);
  checks.push('Topbar orders the selected branch as a group');
  await page.evaluate(() => styk.editor.select(1));
  await toolbar('selection-front').click();
  assert.deepEqual(await page.evaluate(() => styk.editor.evaluatedFrame.object_draw_order_unique_ids), [2, 1]);
  checks.push('Whole-figure selection still reorders figures');
  await page.evaluate(() => styk.editor.selectMany([]));
  await page.waitForFunction(() => [...document.querySelectorAll('[data-selection-order]')].every(b => b.disabled));
  checks.push('Topbar disables ordering when the selection is empty');
  assert.deepEqual(errors, []);
  await writeFile(`${output}/report.json`, JSON.stringify({checks, errors}, null, 2));
  console.log(JSON.stringify({checks, errors}, null, 2));
} catch (error) {
  console.error({checks, errors, state: await page.evaluate(() => ({tick: styk.editor.tick,
    keys: styk.editor.layerFrameKeys('layer-1').map(k => k.tick),
    ghosts: styk.state.renderer.last?.onionFrames.map(s => s.frame.objects.map(o => o.root_x))}))});
  await page.screenshot({path: `${output}/failure.png`});
  throw error;
} finally { await browser.close(); }
