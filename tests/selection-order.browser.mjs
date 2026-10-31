/** Actual joint double-clicks and toolbar ordering. Optional external regression:
 * node tests/selection-order.browser.mjs "path/to/Firing Range Bren MKII.piv"
 * The supplied project is read only; exports stay in memory.
 */
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from './support/playwright.mjs';
import backendTools from '../desktop/web-host.cjs';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const external = process.argv[2], output = path.join(appRoot, 'artifacts/selection-order', external ? 'reported' : 'synthetic');
await mkdir(output, {recursive: true});
const backend = await backendTools.startDesktopHost({appRoot});
let browser, page;
const checks = [], errors = [];
const toolbar = action => page.locator(['undo', 'redo'].includes(action) ? `.band-history [data-action="${action}"]` : `.ui-quick [data-action="${action}"]`);
const order = () => page.evaluate(() => styk.editor.evaluatedFrame.object_draw_order_unique_ids);
const selection = () => page.evaluate(() => styk.editor._selectionState());
const partition = (before, selected, front) => {
  const own = before.filter(uid => selected.includes(uid)), others = before.filter(uid => !selected.includes(uid));
  return front ? [...others, ...own] : [...own, ...others];
};
async function rendered(expected) {
  assert.deepEqual(await order(), expected);
  // The geometry the engine answers for the frame draws in the same order.
  assert.deepEqual(await page.evaluate(() => styk.editor.geometry.orderedObjects.map(g => g.obj.unique_id)), expected);
}
try {
  browser = await chromium.launch({channel: 'chrome', headless: true});
  page = await browser.newPage({viewport: {width: 1440, height: 960}});
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(backend.origin);
  await page.waitForFunction(() => window.styk?.ready);
  if (external) {
    await page.locator('#file-input').setInputFiles(path.resolve(external));
    await page.waitForFunction(() => styk.editor.report.figure_types.some(f => f.name === 'Bren MK2 LMG'));
  } else await page.evaluate(async () => {
    const {emptyDocument, createFrame, createObject} = await import('/src/demo.mjs');
    const report = emptyDocument(), figure = report.figure_types[0];
    figure.segments = [{...figure.segments[0], segment_id: 1, parent_id: 0, length: 110, angle_rad: 0, thickness: 30}];
    figure.segment_count = 1;
    report.keyframes = [0, 1, 2].map(() => {
      const frame = createFrame([1, 2, 3, 4].map(uid => createObject(figure, uid, 220, 220)), 10);
      frame.objects[1].join = {target_object_slot: 0, target_handle_id: 1, target_unique_id: 1};
      frame.objects[1].angles = [Math.PI / 4];
      frame.objects[2].join = {target_object_slot: 1, target_handle_id: 1, target_unique_id: 2};
      frame.objects[2].angles = [-Math.PI / 4];
      frame.objects[3].angles = [.2];
      frame.object_draw_order = [2, 0, 3, 1]; frame.object_draw_order_unique_ids = [3, 1, 4, 2];
      return frame;
    });
    styk.editor.load(report); styk.fit();
  });
  await page.evaluate(() => { window.orderSource = structuredClone(styk.editor.serialize()); });
  for (const mode of ['advanced', 'simple']) for (const tick of external ? [0, 15, 31] : [0, 10]) {
    const point = await page.evaluate(({mode, tick, external}) => {
      styk.editor.load(structuredClone(window.orderSource));
      styk.settingsUI.commit({timelineMode: mode}); styk.editor.seek(tick); styk.fit();
      const e = styk.editor, frame = e.evaluatedFrame;
      const figure = external ? e.report.figure_types.find(f => f.name === 'armery') : e.report.figure_types[0];
      const object = frame.objects.find(o => o.figure_type_id === figure.figure_type_id);
      const slot = frame.objects.indexOf(object), g = e.geometry.objects.get(slot), p = g.segments[0].end;
      const view = styk.state.view, box = document.querySelector('#overlay').getBoundingClientRect();
      window.orderPose = JSON.stringify([...e.geometry.objects.values()].map(g => [g.obj.unique_id, g.root,
        g.segments.map(s => [s.start, s.end]), g.obj.join?.target_unique_id ?? null]).sort((a,b) => a[0]-b[0]));
      return {x: box.x + view.x + p.x * view.scale, y: box.y + view.y + p.y * view.scale, uid: object.unique_id};
    }, {mode, tick, external: Boolean(external)});
    const initial = await order();
    await page.mouse.click(point.x, point.y);
    assert.deepEqual(await page.evaluate(() => [...styk.editor.selectedUids]), [point.uid]);
    await toolbar('selection-front').click(); await rendered(partition(initial, [point.uid], true));
    await toolbar('undo').click(); await rendered(initial);
    await page.mouse.dblclick(point.x, point.y);
    const selected = await selection();
    assert.equal(selected.uid, point.uid);
    assert.equal(await page.evaluate(() => styk.editor.branchSelected), true);
    const uids = await page.evaluate(() => [...styk.editor.selectedUids]);
    assert.ok(uids.length > 1);
    const before = await order(), front = partition(before, uids, true), back = partition(before, uids, false);
    await page.screenshot({path: path.join(output, `${mode}-${tick}-before.png`)});
    const history = await page.evaluate(() => styk.editor._undo.length);
    await toolbar('selection-front').click(); await rendered(front);
    assert.deepEqual(await selection(), selected);
    assert.equal(await page.evaluate(() => styk.editor._undo.length), history + 1);
    await page.screenshot({path: path.join(output, `${mode}-${tick}-front.png`)});
    await toolbar('undo').click(); await rendered(before);
    await toolbar('redo').click(); await rendered(front);
    await toolbar('selection-back').click({modifiers: ['Shift']});
    const own = front.slice(-uids.length), others = front.slice(0, -uids.length);
    await rendered([...others.slice(0, -1), ...own, others.at(-1)]);
    await toolbar('selection-front').click({modifiers: ['Shift']}); await rendered(front);
    await toolbar('selection-back').click(); await rendered(back);
    await page.screenshot({path: path.join(output, `${mode}-${tick}-back.png`)});
    assert.deepEqual(await selection(), selected);
    assert.equal(await page.evaluate(() => {
      const e = styk.editor;
      return window.orderPose === JSON.stringify([...e.geometry.objects.values()].map(g => [g.obj.unique_id, g.root,
        g.segments.map(s => [s.start, s.end]), g.obj.join?.target_unique_id ?? null]).sort((a,b) => a[0]-b[0]));
    }), true, 'Ordering changed a pose or attachment');
    checks.push({mode, tick, selectedFigures: uids.length, checks: ['single-segment joint click', 'joint double-click', 'front', 'back',
      'Shift forward/back', 'renderer order', 'relative order', 'selection', 'pose/joins', 'undo/redo']});
  }
  // Save/reopen the edited displayed pose, committing any Simple working pose.
  const roundtrip = await page.evaluate(async () => {
    if (styk.editor.frameDraft?.dirty) styk.editor.commitFrameDraft({mode: 'update'});
    const {DocumentExporter} = await import('/src/document-export.mjs');
    const {ImportClient} = await import('/src/import-client.mjs');
    const { pageEditor } = await import('/tests/support/page-editor.mjs');
    const exporter = new DocumentExporter(), importer = new ImportClient(), e = styk.editor;
    const expected = e.evaluatedFrame.object_draw_order_unique_ids, tick = e.tick, result = [];
    try {
      for (const format of ['styk', 'piv']) {
        const blob = await exporter.export(e.report, {sourceId: styk.state.sourceId, format, name: 'selection-order', revision: e.revision});
        const imported = await importer.importFile(new File([blob], `selection-order.${format}`));
        const reopened = pageEditor({demo: false, layerTimeline: true}).load(imported.document); reopened.seek(tick);
        if (JSON.stringify(reopened.evaluatedFrame.object_draw_order_unique_ids) !== JSON.stringify(expected))
          throw new Error(`${format} changed the edited draw order`);
        result.push(format);
      }
      return result;
    } finally { exporter.dispose(); importer.dispose(); }
  });
  // Keep explicit partial-segment/branch ordering covered independently of the
  // older combined onion-skin browser harness and its timeline controls.
  await page.evaluate(async () => {
    const {emptyDocument, createObject, createFrame} = await import('/src/demo.mjs');
    const report = emptyDocument(), figure = report.figure_types[0];
    figure.segments = figure.segments.slice(0, 4).map((s, i) => ({...s, segment_id: i + 1,
      parent_id: [0, 1, 0, 0][i], z_order: i + 1, angle_rad: [.3, -.3, .6, -.6][i], length: 140, thickness: 26,
      color_rgb: [[225, 65, 65], [60, 180, 90], [60, 120, 230], [165, 75, 195]][i]}));
    figure.segment_count = 4;
    report.keyframes = [createFrame([createObject(figure, 1, 360, 270), createObject(figure, 2, 630, 270)], 1)];
    styk.editor.load(report); styk.editor.select(1, 0); styk.fit();
  });
  const internal = () => page.evaluate(() => styk.editor.geometry.objects.get(styk.editor.selectedSlot).drawables
    .filter(d => d.seg).map(d => d.seg.segment_id));
  await toolbar('selection-front').click(); assert.deepEqual(await internal(), [2, 3, 4, 1]);
  await toolbar('selection-back').click({modifiers: ['Shift']}); assert.deepEqual(await internal(), [2, 3, 1, 4]);
  await toolbar('undo').click(); assert.deepEqual(await internal(), [2, 3, 4, 1]);
  await toolbar('undo').click(); assert.deepEqual(await internal(), [1, 2, 3, 4]);
  await page.evaluate(() => styk.editor.selectBranch(1, 0));
  await toolbar('selection-front').click(); assert.deepEqual(await internal(), [3, 4, 1, 2]);
  await rendered([1, 2]);
  await page.screenshot({path: path.join(output, 'internal-branch-front.png')});
  checks.push({checks: ['partial segment order', 'partial branch order', 'internal undo', 'unchanged figure order']});
  assert.deepEqual(errors, []);
  await writeFile(path.join(output, 'report.json'), JSON.stringify({checks, roundtrip, errors}, null, 2));
  console.log(JSON.stringify({checks, roundtrip, errors}, null, 2));
} catch (error) {
  await page?.screenshot({path: path.join(output, 'failure.png')});
  throw error;
} finally { await browser?.close(); backend.stop(); }
