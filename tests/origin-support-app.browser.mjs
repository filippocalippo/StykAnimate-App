/** Actual Rig Delete/Unsplit + editable STYK/native PIV save/reopen pixels. */
import {chromium} from 'playwright';
import {mkdir, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import backend from '../desktop/backend.cjs';
const appRoot = fileURLToPath(new URL('..', import.meta.url)), output = path.join(appRoot, 'artifacts', 'origin-support');
await mkdir(output, {recursive: true}); const server = await backend.startBackend({appRoot}); let browser;
try {
  browser = await chromium.launch({channel: 'chrome', headless: true}); const page = await browser.newPage({viewport: {width: 1440, height: 1000}}), errors = [];
  page.on('pageerror', error => errors.push(error.message)); await page.goto(server.origin); await page.waitForFunction(() => styk?.ready);
  await page.evaluate(async () => {
    const {emptyDocument, createObject, createFrame} = await import('/src/demo.mjs'), report = emptyDocument(), figure = report.figure_types[0], base = figure.segments[0];
    report.canvas_width = 400; report.canvas_height = 280;
    figure.segments = [7, 99, 301].map((id, i) => ({...base, segment_id: id, parent_id: i ? 7 : 0, length: [65, 43, 35][i],
      angle_rad: [-1, .3, 1.5][i], bend_rad: [.2, -.3, .1][i], color_rgb: [30 + i * 45, 90, 215], thickness: 8})); figure.segment_count = 3;
    report.keyframes = [0, 1, 2].map(i => createFrame([createObject(figure, 1, 170 + i * 10, 200 - i * 5,
      {angles: [[-1.2, .4, 1.1], [-.6, 1, 2], [-1.8, -.2, 1.6]][i], bend_flag: 1, bends: [[.2, -.3, .1], [-.8, .6, .3], [.7, .2, -.5]][i]})], i === 2 ? 1 : 10));
    styk.editor.load(report, 'Retained animation support'); styk.editor.beginFrameDraft({mode: 'update'});
    styk.editor.addAnimationKeys([['x', [150, 215]], ['y', [210, 185]], ['scale', [.75, 1.15]], ['rotation', [-.2, .4]]]
      .flatMap(([property, values]) => [0, 20].map((tick, i) => ({target: {kind: 'figure', uid: 1}, property, tick, value: values[i]}))));
    styk.editor.select(1); styk.editor.setOrigin(99); styk.fit();
    window.supportBaseline = styk.editor.serialize();
    const reference = styk.editor.figure._styk.animationOrigin.rotationHandleId;
    styk.editor.select(1, styk.editor.figure.segments.findIndex(segment => segment.segment_id === reference));
  });
  await page.locator('[data-tool="rig"]').click(); await page.evaluate(() => document.activeElement?.blur());
  const history = await page.evaluate(() => styk.editor._undo.length); await page.keyboard.press('Delete');
  await page.waitForFunction(() => Boolean(styk.editor.figure._styk.animationOrigin.support));
  assert.equal(await page.evaluate(() => styk.editor.figure.segments.length), 2); assert.equal(await page.evaluate(() => styk.editor._undo.length), history + 1);
  await page.keyboard.press('Control+z'); assert.equal(await page.evaluate(() => JSON.stringify(styk.editor.serialize()) === JSON.stringify(window.supportBaseline)), true);
  await page.keyboard.press('Control+Shift+z'); assert.equal(await page.evaluate(() => styk.editor.figure.segments.length), 2);
  const unsplitBefore = await page.evaluate(() => {
    styk.editor.select(1, styk.editor.figure.segments.findIndex(segment => segment.segment_id === 7));
    return {document: styk.editor.serialize(), points: Object.fromEntries(styk.editor.geometry.objects.get(0).joints), history: styk.editor._undo.length};
  });
  await page.keyboard.press('Control+Delete');
  const unsplitAfter = await page.evaluate(() => ({points: Object.fromEntries(styk.editor.geometry.objects.get(0).joints), count: styk.editor.figure.segments.length, history: styk.editor._undo.length}));
  assert.equal(unsplitAfter.count, 1); assert.equal(unsplitAfter.history, unsplitBefore.history + 1);
  for (const id of [0, 301]) assert.ok(Math.hypot(unsplitBefore.points[id].x - unsplitAfter.points[id].x, unsplitBefore.points[id].y - unsplitAfter.points[id].y) < .0002);
  await page.keyboard.press('Control+z'); assert.deepEqual(await page.evaluate(() => styk.editor.serialize()), unsplitBefore.document);
  const result = await page.evaluate(async () => {
    const [{DocumentExporter}, {ImportClient}, {createRenderer}, {buildGeometry, evaluatedFrame, timeline}] = await Promise.all([
      import('/src/document-export.mjs'), import('/src/import-client.mjs'), import('/src/renderer.mjs'), import('/src/pivot/geometry.mjs')]);
    const source = styk.editor.serialize(), exporter = new DocumentExporter(), importer = new ImportClient(), documents = [];
    for (const format of ['styk', 'piv']) {
      const blob = await exporter.export(source, {format, name: 'Retained animation support'});
      const {document} = await importer.importFile(new File([blob], `support.${format}`)); documents.push({format, document, bytes: blob.size});
    }
    const canvas = document.createElement('canvas'); canvas.width = 400; canvas.height = 280;
    const renderer = await createRenderer(canvas); renderer.resize(400, 280, 1);
    if (renderer.stats.backend !== 'WebGPU') throw new Error('WebGPU is required.');
    const copy = document.createElement('canvas'); copy.width = 400; copy.height = 280; const ctx = copy.getContext('2d', {willReadFrequently: true});
    const render = async (report, tick) => {
      const rows = timeline(report); let index = 0; while (index + 1 < rows.length && rows[index + 1].start <= tick) index++;
      const frame = evaluatedFrame(report, index, rows[index].count ? (tick - rows[index].start) / rows[index].count : 0, tick);
      renderer.render({report, frame, geometry: buildGeometry(report, frame), view: {x: 0, y: 0, scale: 1}}); await renderer.device.queue.onSubmittedWorkDone();
      ctx.clearRect(0, 0, 400, 280); ctx.drawImage(canvas, 0, 0); return ctx.getImageData(0, 0, 400, 280).data;
    };
    const scores = [];
    for (const tick of [0, 2.5, 7, 10, 14.5, 20]) {
      const expected = await render(source, tick);
      for (const entry of documents) {
        if (entry.format === 'piv' && !Number.isInteger(tick)) continue;
        const actual = await render(entry.document, tick); let total = 0, count = 0, max = 0;
        for (let i = 0; i < actual.length; i++) {const difference = Math.abs(actual[i] - expected[i]); total += difference; if (difference > 8) count++; max = Math.max(max, difference);}
        const mean = total / actual.length, ratio = count / actual.length;
        if (mean >= .03 || ratio >= .0003) throw new Error(`${entry.format} tick ${tick}: mean ${mean}, changed ${ratio}`);
        scores.push({format: entry.format, tick, mean, ratio, max});
      }
    }
    const restored = documents.find(entry => entry.format === 'styk').document, native = documents.find(entry => entry.format === 'piv').document;
    if (!restored.figure_types[0]._styk.animationOrigin.support || native.figure_types.some(figure => figure._styk?.animationOrigin)) throw new Error('Authoring/native materialization metadata mismatch.');
    renderer.destroy(); exporter.dispose(); importer.dispose(); return {scores, exports: documents.map(({format, bytes}) => ({format, bytes}))};
  });
  const placementChecks = [];
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  for (const [branch, flip] of [[false, false], [false, true], [true, false], [true, true]]) {
    await page.evaluate(() => {styk.editor.load(structuredClone(window.supportBaseline)); styk.editor.select(1, styk.editor.figure.segments.findIndex(segment => segment.segment_id === 7)); styk.state.builderBranch = false; styk.fit();});
    await settle(); const before = await page.evaluate(() => styk.editor.serialize()), undoCount = await page.evaluate(() => styk.editor._undo.length);
    const button = page.locator('#inspector [data-action="duplicate-segment"]'), modifiers = [...(branch ? ['Shift'] : []), ...(flip ? ['Control'] : [])];
    await button.click({modifiers}); await settle();
    assert.deepEqual(await page.evaluate(() => ({branch: styk.state.duplicatePlacement.branch, flip: styk.state.duplicatePlacement.flip})), {branch, flip});
    assert.equal(await page.evaluate(() => styk.editor._undo.length), undoCount); assert.deepEqual(await page.evaluate(() => styk.editor.serialize()), before);
    const target = await page.evaluate(() => {const point = styk.editor.geometry.objects.get(0).joints.get(301), rect = document.querySelector('#viewport').getBoundingClientRect(), view = styk.state.view; return {x: rect.left + view.x + point.x * view.scale, y: rect.top + view.y + point.y * view.scale};});
    await page.mouse.click(target.x, target.y); await settle();
    assert.equal(await page.evaluate(() => Boolean(styk.state.duplicatePlacement)), false);
    assert.equal(await page.evaluate(() => styk.editor.figure.segments.length), branch ? 6 : 4);
    assert.equal(await page.evaluate(() => styk.editor._undo.length), undoCount + 1);
    await page.keyboard.press('Control+z'); await settle(); assert.deepEqual(await page.evaluate(() => styk.editor.serialize()), before);
    placementChecks.push(`Duplicate ${branch ? 'branch' : 'segment'} at clicked joint, flip=${flip}, one undo`);
  }
  for (const cancel of ['escape', 'toggle']) {
    const before = await page.evaluate(() => styk.editor.serialize());
    const button = page.locator('#inspector [data-action="duplicate-segment"]'); await button.click(); await settle();
    if (cancel === 'escape') await page.keyboard.press('Escape'); else await button.click();
    await settle(); assert.equal(await page.evaluate(() => Boolean(styk.state.duplicatePlacement)), false); assert.deepEqual(await page.evaluate(() => styk.editor.serialize()), before);
    placementChecks.push(`Duplicate ${cancel} cancellation leaves document untouched`);
  }
  assert.deepEqual(errors, []); await page.screenshot({path: path.join(output, 'app.png')});
  const report = {checks: 4 + result.scores.length + placementChecks.length, gestures: ['Rig Delete', 'Undo exact document', 'Redo exact visible segment count', 'Rig Ctrl+Delete after retained-reference deletion preserves surviving endpoints and exact undo', ...placementChecks], ...result, errors};
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} finally {await browser?.close(); server.stop();}
