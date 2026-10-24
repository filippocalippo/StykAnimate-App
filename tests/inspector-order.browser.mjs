/** Properties quick actions on nodes and branches, including attached figures. */
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {chromium} from './support/playwright.mjs';
import backendTools from '../desktop/web-host.cjs';

const backend = await backendTools.startDesktopHost({appRoot: process.cwd()});
const out = 'artifacts/inspector-order';
await mkdir(out, {recursive: true});
let browser, page;
const errors = [];
const quick = action => page.locator(`.ui-quick [data-action="${action}"]`);
const order = () => page.evaluate(() => styk.editor.evaluatedFrame.object_draw_order_unique_ids);
const internal = () => page.evaluate(() => styk.editor.geometry.objects.get(styk.editor.selectedSlot).drawables.filter(d => d.seg).map(d => d.seg.segment_id));
const undo = () => page.evaluate(() => styk.editor.undo());
const redo = () => page.evaluate(() => styk.editor.redo());
async function jointClick(double = false) {
  const p = await page.evaluate(() => {
    const p = [...styk.editor.geometry.objects.values()].find(g => g.obj.unique_id === 1).segments[0].end;
    const box = document.querySelector('#overlay').getBoundingClientRect(), v = styk.state.view;
    return {x: box.x + v.x + p.x * v.scale, y: box.y + v.y + p.y * v.scale};
  });
  await page.mouse[double ? 'dblclick' : 'click'](p.x, p.y);
}
try {
  browser = await chromium.launch({channel: 'chrome', headless: true});
  page = await browser.newPage({viewport: {width: 1440, height: 960}});
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(backend.origin); await page.waitForFunction(() => styk?.ready);
  for (const mode of ['advanced', 'simple']) {
    await page.evaluate(async mode => {
      const {emptyDocument, createObject, createFrame} = await import('/src/demo.mjs');
      const report = emptyDocument(), figure = report.figure_types[0];
      figure.segments = figure.segments.slice(0, 4).map((s, i) => ({...s, segment_id: i + 1,
        parent_id: [0, 1, 0, 0][i], z_order: i + 1, angle_rad: [.3, -.3, .6, -.6][i], length: 140, thickness: 26,
        color_rgb: [[225, 65, 65], [60, 180, 90], [60, 120, 230], [165, 75, 195]][i]}));
      figure.segment_count = 4;
      report.keyframes = [createFrame([createObject(figure, 1, 300, 270), createObject(figure, 2, 630, 270)], 10)];
      styk.editor.load(report); styk.settingsUI.commit({timelineMode: mode}); styk.fit();
    }, mode);
    await jointClick();
    assert.equal(await page.locator('.ui-quick [data-action="toggle-isolate"], .ui-quick [data-action="segment-values"], .ui-quick [data-action="locate-previous"], .ui-quick [data-action="locate-next"]').count(), 0);
    await quick('selection-front').click(); assert.deepEqual(await internal(), [2, 3, 4, 1]);
    await quick('selection-back').click(); assert.deepEqual(await internal(), [1, 2, 3, 4]);
    await quick('selection-front').click({modifiers: ['Shift']}); assert.deepEqual(await internal(), [2, 1, 3, 4]);
    await quick('selection-back').click({modifiers: ['Shift']}); assert.deepEqual(await internal(), [1, 2, 3, 4]);
    const history = await page.evaluate(() => styk.editor._undo.length);
    await quick('selection-back').click({modifiers: ['Shift']}); assert.deepEqual(await internal(), [1, 2, 3, 4]);
    assert.equal(await page.evaluate(() => styk.editor._undo.length), history);
    await jointClick(true);
    assert.equal(await page.evaluate(() => styk.editor.branchSelected), true);
    await quick('selection-front').click(); assert.deepEqual(await internal(), [3, 4, 1, 2]);
    await quick('selection-back').click(); assert.deepEqual(await internal(), [1, 2, 3, 4]);
    await quick('selection-front').click({modifiers: ['Shift']}); assert.deepEqual(await internal(), [3, 1, 2, 4]);
    await undo(); assert.deepEqual(await internal(), [1, 2, 3, 4]);
    await redo(); assert.deepEqual(await internal(), [3, 1, 2, 4]);
    await quick('selection-back').click({modifiers: ['Shift']}); assert.deepEqual(await internal(), [1, 2, 3, 4]);
    assert.deepEqual(await order(), [1, 2], 'partial branches retain figure stacking');
    await page.screenshot({path: `${out}/${mode}-branch.png`});
    await page.evaluate(async () => {
      const {emptyDocument, createObject, createFrame} = await import('/src/demo.mjs');
      const report = emptyDocument(), figure = report.figure_types[0];
      figure.segments = [{...figure.segments[0], segment_id: 1, parent_id: 0, length: 110, angle_rad: 0, thickness: 30}];
      figure.segment_count = 1;
      const frame = createFrame([1, 2, 3, 4].map(uid => createObject(figure, uid, 220, 220)), 10);
      frame.objects[1].join = {target_object_slot: 0, target_handle_id: 1, target_unique_id: 1}; frame.objects[1].angles = [Math.PI / 4];
      frame.objects[2].join = {target_object_slot: 1, target_handle_id: 1, target_unique_id: 2}; frame.objects[2].angles = [-Math.PI / 4];
      frame.objects[3].angles = [.2]; frame.object_draw_order = [2, 0, 3, 1]; frame.object_draw_order_unique_ids = [3, 1, 4, 2];
      report.keyframes = [frame]; styk.editor.load(report); styk.fit();
      window.originalPose = JSON.stringify([...styk.editor.geometry.objects.values()].map(g => [g.obj.unique_id, g.root, g.segments.map(s => [s.start, s.end]), g.obj.join?.target_unique_id ?? null]).sort((a, b) => a[0] - b[0]));
    });
    await page.evaluate(() => styk.editor.select(1));
    await quick('layer-front').click(); assert.deepEqual(await order(), [3, 4, 2, 1]);
    await quick('layer-back').click({modifiers: ['Shift']}); assert.deepEqual(await order(), [3, 4, 1, 2]);
    await quick('layer-front').click({modifiers: ['Shift']}); assert.deepEqual(await order(), [3, 4, 2, 1]);
    await quick('layer-back').click(); assert.deepEqual(await order(), [1, 3, 4, 2]);
    for (let i = 0; i < 4; i++) await undo();
    assert.deepEqual(await order(), [3, 1, 4, 2]);
    await jointClick();
    await quick('selection-front').click(); assert.deepEqual(await order(), [3, 4, 2, 1]);
    await quick('selection-back').click(); assert.deepEqual(await order(), [1, 3, 4, 2]);
    await undo(); await undo(); assert.deepEqual(await order(), [3, 1, 4, 2]);
    await quick('selection-front').click({modifiers: ['Shift']}); assert.deepEqual(await order(), [3, 4, 1, 2]);
    await quick('selection-back').click({modifiers: ['Shift']}); assert.deepEqual(await order(), [3, 1, 4, 2]);
    await jointClick(true);
    assert.equal(await page.evaluate(() => styk.editor.selectedUids.size), 3);
    await quick('selection-front').click(); assert.deepEqual(await order(), [4, 3, 1, 2]);
    await quick('selection-back').click(); assert.deepEqual(await order(), [3, 1, 2, 4]);
    await quick('selection-front').click({modifiers: ['Shift']}); assert.deepEqual(await order(), [4, 3, 1, 2]);
    await quick('selection-back').click({modifiers: ['Shift']}); assert.deepEqual(await order(), [3, 1, 2, 4]);
    await undo(); assert.deepEqual(await order(), [4, 3, 1, 2]);
    await redo(); assert.deepEqual(await order(), [3, 1, 2, 4]);
    assert.equal(await page.evaluate(() => originalPose === JSON.stringify([...styk.editor.geometry.objects.values()].map(g => [g.obj.unique_id, g.root, g.segments.map(s => [s.start, s.end]), g.obj.join?.target_unique_id ?? null]).sort((a, b) => a[0] - b[0]))), true);
    await page.waitForFunction(() => JSON.stringify(styk.state.renderer.last.frame.object_draw_order_unique_ids) === JSON.stringify(styk.editor.evaluatedFrame.object_draw_order_unique_ids));
    await page.screenshot({path: `${out}/${mode}-attached-branch.png`});
    console.log(`PASS ${mode}: figure, node and branch clicks to front/back; Shift-clicks one step; boundary, undo/redo, rendered order and unchanged pose/joins`);
  }
  assert.deepEqual(errors, []);
} catch (error) {
  await page?.screenshot({path: `${out}/failure.png`}); throw error;
} finally {await browser?.close(); backend.stop();}
