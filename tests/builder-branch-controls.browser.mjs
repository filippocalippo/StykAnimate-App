/** Real Builder branch controls, atomic undo, retained poses and native pixels. */
import {chromium} from 'playwright';
import {mkdir, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import backend from '../desktop/backend.cjs';
const appRoot = fileURLToPath(new URL('..', import.meta.url)), output = path.join(appRoot, 'artifacts', 'builder-branch-controls');
await mkdir(output, {recursive: true}); const server = await backend.startBackend({appRoot}); let browser, page;
const checks = [], errors = [], branchIds = [10, 20, 30, 40, 50, 60, 80];
const near = (a, b) => assert.ok(Math.abs(a - b) < .0002, `${a} != ${b}`);
try {
  browser = await chromium.launch({channel: 'chrome', headless: true}); page = await browser.newPage({viewport: {width: 1480, height: 1120}});
  page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message)); await page.goto(server.origin); await page.waitForFunction(() => styk?.ready);
  await page.evaluate(async () => {
    const {emptyDocument, createFrame, createObject} = await import('/src/demo.mjs'), {createImageFigure} = await import('/src/media-authoring.mjs');
    const report = emptyDocument(), figure = report.figure_types[0], base = figure.segments[0], kinds = ['line', 'circle', 'image', 'circleFill', 'circleClear', 'text', 'squareLine'];
    report.canvas_width = 800; report.canvas_height = 500; figure.name = 'Branch control verification';
    const image = createImageFigure({dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHk8AAAAASUVORK5CYII=', width: 1, height: 1, name: 'Pixel'});
    figure.image_assets = image.image_assets;
    figure.segments = [10, 20, 30, 40, 50, 60, 70, 80].map((id, i) => {
      const code = [0, 0, 6, 1, 3, 4, 0, 2][i];
      return {...(code === 2 ? image.segments[0] : base), segment_id: id, parent_id: [0, 10, 10, 20, 40, 50, 0, 10][i],
        primitive_code: code, segment_kind: kinds[code], segment_type: code === 2 ? 'image' : [1, 3, 4].includes(code) ? 'circle' : 'line',
        aux_code: 0, flags: code, is_static: false, thickness: 7 + i, length: [55, 45, 33, 28, 22, 18, 65, 30][i],
        angle_rad: [.2, .9, -.7, .3, .8, -.3, 2.1, -1.4][i], bend_rad: [.3, -.2, .25, 0, 0, 0, .2, 0][i],
        color_rgb: [45 + i * 17, 90, 210], transparency: 10 + i * 13, z_order: i + 1,
        secondary: [20, 40, 70].includes(id) ? {rgb: [220, 40, 80], a: id} : null};
    }); figure.segment_count = figure.segments.length;
    figure.polyfills = [[0, 10, 20, 30], [0, 10, 70], [20, 40, 50]].map((ids, i) => ({polyfill_id: i + 1, segment_ids: ids, color_rgb: [70, 145, 120 + i * 30], alpha_raw: 20 + i * 15, z_order: -.5 + i * .2}));
    report.keyframes = [0, 1].map(i => createFrame([createObject(figure, 1, 170 + i * 35, 240 + i * 10, {scale: 1 + i * .15,
      angles: figure.segments.map(segment => segment.angle_rad + i * .23), len_flag: 1, lengths: figure.segments.map(segment => segment.length * (1 + i * .2)),
      bend_flag: 1, bends: figure.segments.map(segment => segment.bend_rad)})], i ? 1 : 4));
    styk.editor.load(report); styk.editor.beginFrameDraft({mode: 'update'}); styk.editor.captureFrameSource(styk.editor.report.keyframes[1]);
    window.branchFixture = styk.editor.serialize();
  });
  await page.locator('[data-tool="rig"]').click();
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  async function reset(selected = 10, branch = false) {
    await page.evaluate(id => {styk.editor.load(structuredClone(window.branchFixture), 'Branch controls'); styk.editor.select(1, styk.editor.figure.segments.findIndex(segment => segment.segment_id === id)); styk.fit();}, selected);
    await settle(); await page.locator('#builder-branch').setChecked(branch); await settle();
  }
  const snapshot = () => page.evaluate(async () => {
    const {buildGeometry} = await import('/src/pivot/geometry.mjs'), editor = styk.editor;
    return {report: editor.serialize(), history: editor._undo.length,
      points: editor._allSourceFrames().map(frame => Object.fromEntries(buildGeometry(editor.report, frame).objects.get(0).joints))};
  });
  async function undo(before) {
    await page.evaluate(() => document.activeElement?.blur()); await page.keyboard.press('Control+z'); await settle();
    const restored = await snapshot(); assert.deepEqual(restored.report, before.report); assert.equal(restored.history, before.history);
  }
  async function run(name, action, verify, {selected = 10, branch = false, poseChanged = false} = {}) {
    await reset(selected, branch); const before = await snapshot(); await action(); await settle(); const after = await snapshot();
    assert.equal(after.history, before.history + 1, `${name}: one undo command`); verify(after.report.figure_types[0], before.report.figure_types[0], after, before);
    if (!poseChanged) {assert.deepEqual(after.report.keyframes, before.report.keyframes); assert.deepEqual(after.report._styk.frameSources, before.report._styk.frameSources);}
    await undo(before); checks.push(name); console.log('PASS', name);
  }
  async function color(id, value) {await page.locator(`#${id}`).fill(value); await page.locator(`#${id}`).dispatchEvent('change');}
  const unchangedOther = (after, before, ids) => after.segments.forEach((segment, index) => {if (!ids.includes(segment.segment_id)) assert.deepEqual(segment, before.segments[index]);});
  const colorCheck = ids => (after, before) => {
    after.segments.forEach((segment, index) => {assert.deepEqual(segment.color_rgb, ids.includes(segment.segment_id) ? [222, 70, 124] : before.segments[index].color_rgb); assert.equal(segment.transparency, before.segments[index].transparency);});
    after.polyfills.forEach((polygon, index) => {assert.deepEqual(polygon.color_rgb, ids.length > 1 && index !== 1 ? [222, 70, 124] : before.polyfills[index].color_rgb); assert.equal(polygon.alpha_raw, before.polyfills[index].alpha_raw);});
  };
  await run('Single primary color changes only the selected segment', () => color('segment-color', '#de467c'), colorCheck([10]));
  await run('Checkbox branch color includes enclosed polygons and preserves individual opacity', () => color('segment-color', '#de467c'), colorCheck(branchIds), {branch: true});
  await run('Held Shift applies primary color to the branch through change events', async () => {await page.keyboard.down('Shift'); try {await color('segment-color', '#de467c');} finally {await page.keyboard.up('Shift');}}, colorCheck(branchIds));
  const staticCheck = ids => (after, before) => {after.segments.forEach(segment => assert.equal(Boolean(segment.is_static), ids.includes(segment.segment_id))); unchangedOther(after, before, ids);};
  await run('Single Static checkbox preserves descendant flags', () => page.locator('#static-joint').check(), staticCheck([10]));
  await run('Checkbox branch Static sets every descendant from the selected value', () => page.locator('#static-joint').check(), staticCheck(branchIds), {branch: true});
  await run('Shift Static click carries modifier state through change events', () => page.locator('#static-joint').click({modifiers: ['Shift']}), staticCheck(branchIds));
  const caps = ids => (after, before) => {after.segments.forEach((segment, index) => assert.equal(segment.primitive_code, ids.includes(segment.segment_id) ? 6 : before.segments[index].primitive_code)); unchangedOther(after, before, ids);};
  await run('Single cap change does not convert other branch segments', () => page.locator('#segment-shape').selectOption('squareLine'), caps([10]));
  await run('Branch caps target only descendants matching the selected original primitive', () => page.locator('#segment-shape').selectOption('squareLine'), caps([10, 20]), {branch: true});
  await run('Held Shift cap selection applies native branch matching', async () => {await page.keyboard.down('Shift'); try {await page.locator('#segment-shape').selectOption('squareLine');} finally {await page.keyboard.up('Shift');}}, caps([10, 20]));
  const fills = ids => (after, before) => {after.segments.forEach((segment, index) => assert.equal(segment.primitive_code, ids.includes(segment.segment_id) ? 3 : before.segments[index].primitive_code)); unchangedOther(after, before, ids);};
  await run('Single circle fill preserves descendant circle styles', () => page.locator('#segment-shape').selectOption('circleFill'), fills([40]), {selected: 40});
  await run('Branch circle fill applies across white, filled and clear circle descendants', () => page.locator('#segment-shape').selectOption('circleFill'), fills([40, 50, 60]), {selected: 40, branch: true});
  await run('Branch gradient enable preserves each existing end opacity and leaves polygon colors alone', () => page.locator('#segment-gradient-enabled').check(), (after, before) => {
    after.segments.forEach((segment, index) => {if (branchIds.includes(segment.segment_id)) {assert.deepEqual(segment.secondary.rgb, [255, 255, 255]); assert.equal(segment.secondary.a, before.segments[index].secondary?.a ?? 0);}});
    unchangedOther(after, before, branchIds); assert.deepEqual(after.polyfills, before.polyfills);
  }, {branch: true});
  await run('Branch gradient color updates endpoints without changing polygons or primary opacity', () => color('segment-gradient-color', '#189ab4'), (after, before) => {
    const ids = [20, 40, 50, 60]; after.segments.forEach((segment, index) => {if (ids.includes(segment.segment_id)) {assert.deepEqual(segment.secondary.rgb, [24, 154, 180]); assert.equal(segment.secondary.a, before.segments[index].secondary?.a ?? 0); assert.equal(segment.transparency, before.segments[index].transparency);}});
    unchangedOther(after, before, ids); assert.deepEqual(after.polyfills, before.polyfills);
  }, {selected: 20, branch: true});
  await run('Branch gradient disable leaves siblings and ancestors unchanged', () => page.locator('#segment-gradient-enabled').uncheck(), (after, before) => {
    const ids = [20, 40, 50, 60]; after.segments.forEach(segment => {if (ids.includes(segment.segment_id)) assert.equal(segment.secondary, null);}); unchangedOther(after, before, ids);
  }, {selected: 20, branch: true});
  const splitCheck = count => (after, before, snapshot, baseline) => {
    assert.equal(after.segments.length, before.segments.length + count); assert.equal(after.image_assets.length, before.image_assets.length);
    for (let frame = 0; frame < baseline.points.length; frame++) for (const [id, point] of Object.entries(baseline.points[frame])) {near(snapshot.points[frame][id].x, point.x); near(snapshot.points[frame][id].y, point.y);}
  };
  await run('Single Split preserves all original endpoints in native and retained poses', () => page.locator('[data-action="split-segment"]').click(), splitCheck(1), {poseChanged: true});
  await run('Checkbox branch Split includes lines, circles and image segments atomically', () => page.locator('[data-action="split-segment"]').click(), splitCheck(7), {branch: true, poseChanged: true});
  await run('Shift Split uses one branch transaction with the checkbox off', () => page.locator('[data-action="split-segment"]').click({modifiers: ['Shift']}), splitCheck(7), {poseChanged: true});
  await run('Selected image Split is available through the ordinary inspector button', () => page.locator('[data-action="split-segment"]').click(), splitCheck(1), {selected: 80, poseChanged: true});
  // Keep a final branch edit and split, then use the real export/import workers.
  await reset(10, true); await color('segment-color', '#de467c'); await settle(); await page.locator('[data-action="split-segment"]').click(); await settle();
  const saved = await page.evaluate(async () => {
    const [{DocumentExporter}, {ImportClient}, {createRenderer}, {buildGeometry}] = await Promise.all([import('/src/document-export.mjs'), import('/src/import-client.mjs'), import('/src/renderer.mjs'), import('/src/pivot/geometry.mjs')]);
    const source = styk.editor.serialize(), exporter = new DocumentExporter(), importer = new ImportClient(), docs = [];
    for (const format of ['piv', 'stk']) {const blob = await exporter.export(source, {format, name: 'Branch controls', figureTypeId: source.figure_types[0].figure_type_id, figureUid: 1, frameIndex: 0, tick: 0});
      const {document} = await importer.importFile(new File([blob], `branch.${format}`)); docs.push({format, document, bytes: blob.size});}
    const canvas = document.createElement('canvas'); canvas.width = 800; canvas.height = 500; const renderer = await createRenderer(canvas); renderer.resize(800, 500, 1);
    if (renderer.stats.backend !== 'WebGPU') throw new Error('WebGPU required.');
    const copy = document.createElement('canvas'); copy.width = 800; copy.height = 500; const context = copy.getContext('2d', {willReadFrequently: true});
    const render = async (report, frame) => {renderer.render({report, frame, geometry: buildGeometry(report, frame), view: {x: 0, y: 0, scale: 1}}); await renderer.device.queue.onSubmittedWorkDone(); context.clearRect(0, 0, 800, 500); context.drawImage(canvas, 0, 0); return context.getImageData(0, 0, 800, 500).data;};
    const native = docs.find(doc => doc.format === 'piv').document, scores = [];
    for (let index = 0; index < source.keyframes.length; index++) {const a = await render(source, source.keyframes[index]), b = await render(native, native.keyframes[index]); let total = 0, changed = 0, max = 0;
      for (let i = 0; i < a.length; i++) {const delta = Math.abs(a[i] - b[i]); total += delta; if (delta > 8) changed++; max = Math.max(max, delta);}
      const mean = total / a.length, ratio = changed / a.length; if (mean >= .03 || ratio >= .0003) throw new Error(`Native branch pixel mismatch at ${index}: ${mean}/${ratio}`); scores.push({index, mean, ratio, max});}
    const stk = docs.find(doc => doc.format === 'stk').document.figure_types.find(figure => figure.segments.length === 15);
    if (!stk || stk.image_assets.length !== 1 || !stk.segments.some(segment => segment.primitive_code === 2)) throw new Error('Native STK lost split media or segments.');
    if (!stk.polyfills.some(polygon => polygon.color_rgb.join(',') === '222,70,124')) throw new Error('Native STK lost branch polygon color.');
    renderer.destroy(); exporter.dispose(); importer.dispose(); return {exports: docs.map(({format, bytes}) => ({format, bytes})), scores};
  });
  checks.push('Actual native PIV retains edited/split scene pixels at both keys', 'Actual native STK retains split media, primitive count and enclosed polygon color');
  assert.deepEqual(errors, []); await page.screenshot({path: path.join(output, 'app.png')}); await writeFile(path.join(output, 'report.json'), JSON.stringify({checks, ...saved, errors}, null, 2)); console.log(JSON.stringify({checks: checks.length, ...saved, errors}));
} catch (error) {await page?.screenshot({path: path.join(output, 'failure.png')}).catch(() => {}); await writeFile(path.join(output, 'report.json'), JSON.stringify({checks, errors, failure: error.stack}, null, 2)); throw error;}
finally {await browser?.close(); server.stop();}
