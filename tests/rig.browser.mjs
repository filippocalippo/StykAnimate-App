/** Actual canvas Rig tool gestures and native exports. Requires local STYK_URL. */
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const appRoot = fileURLToPath(new URL('..', import.meta.url)), out = path.join(appRoot, 'artifacts');
await mkdir(out, {recursive: true});
const browser = await chromium.launch({channel: 'chrome', headless: true});
const context = await browser.newContext({viewport: {width: 1500, height: 940}, acceptDownloads: true});
const page = await context.newPage(), checks = [], errors = [];
page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.stack || error.message));
const check = (name, value = true) => { assert.ok(value, name); checks.push({name, passed: true}); console.log('PASS', name); };
const near = (a, b, tolerance = 0.2) => Math.abs(a - b) < tolerance;
const samePoint = (a, b) => near(a.x, b.x) && near(a.y, b.y);
const snapshot = () => page.evaluate(() => {
  const e = styk.editor, geometry = e.geometry.objects.get(e.selectedSlot);
  return {joints: Object.fromEntries(geometry.joints), angles: [...e.object.angles], lengths: e.object.len_flag ? [...e.object.lengths] : e.figure.segments.map(s => s.length),
    defaults: e.figure.segments.map(s => ({angle: s.angle_rad, length: s.length})), uid: e.selectedUid, joint: e.selectedJoint, history: e._undo.length,
    name: e.figure.name, dirty: e.dirty, drag: styk.state.drag?.kind ?? null};
});
async function screen(point) {
  return page.evaluate(point => {
    const rect = document.querySelector('#viewport').getBoundingClientRect(), view = styk.state.view;
    return {x: rect.left + view.x + point.x * view.scale, y: rect.top + view.y + point.y * view.scale};
  }, point);
}
async function drag(from, to, {control = false, cancel = false} = {}) {
  const a = await screen(from), b = await screen(to);
  await page.mouse.move(a.x, a.y); if (control) await page.keyboard.down('Control');
  await page.mouse.down(); await page.mouse.move(b.x, b.y, {steps: 10});
  const preview = await snapshot();
  if (cancel) await page.keyboard.press('Escape');
  await page.mouse.up(); if (control) await page.keyboard.up('Control');
  await page.waitForFunction(() => !styk.state.drag); return preview;
}
async function undo() { await page.evaluate(() => document.activeElement?.blur()); await page.keyboard.press('Control+z'); }
async function saveExport(kind, filename) {
  await page.locator('[data-action="export"]').first().click();
  const pending = page.waitForEvent('download'); pending.catch(() => {});
  await page.locator(`[data-action="export-${kind}"]`).click();
  const download = await pending, target = path.join(out, filename); await download.saveAs(target);
  await page.waitForFunction(() => !document.querySelector('#dialog').open); return target;
}

try {
  await page.goto(process.env.STYK_URL || 'http://127.0.0.1:47831'); await page.waitForFunction(() => window.styk?.ready);
  check('Rig regression initializes the actual WebGPU editor', await page.evaluate(() => styk.state.renderer.stats.backend === 'WebGPU'));
  await page.evaluate(async () => {
    const {emptyDocument, createObject, createFrame} = await import('/src/demo.mjs');
    const document = emptyDocument(), figure = document.figure_types[0], base = figure.segments[0];
    figure.name = 'Construction rig';
    figure.segments = [
      {...base, segment_id: 11, parent_id: 0, length: 100, angle_rad: 0, aux_code: 1},
      {...base, segment_id: 22, parent_id: 11, length: 70, angle_rad: Math.PI / 2, aux_code: 1},
      {...base, segment_id: 33, parent_id: 22, length: 80, angle_rad: 0, aux_code: 0},
      {...base, segment_id: 44, parent_id: 0, length: 70, angle_rad: Math.PI, aux_code: 0},
    ];
    figure.segment_count = 4;
    document.canvas_width = 800; document.canvas_height = 450;
    document.keyframes = [createFrame([createObject(figure, 1, 280, 250)], 2), createFrame([createObject(figure, 1, 250, 180)], 1)];
    document.keyframes[1].objects[0].angles = figure.segments.map(s => s.angle_rad + 0.3);
    document._styk.name = 'Rig canvas verification';
    styk.editor.load(document); styk.editor.select(1, 0); styk.fit();
  });
  await page.locator('[data-tool="select"]').click(); await page.keyboard.press('r');
  check('R opens Edit rig from the canvas keyboard shortcut', await page.evaluate(() => styk.state.tool === 'rig'));
  await page.locator('[data-tool="rig"]').click();
  check('Edit rig toolbar exposes Move joint as the default mode', await page.locator('#rig-mode').inputValue() === 'move');
  const initial = await snapshot(), target = {x: 410, y: 230};
  const preview = await drag(initial.joints[11], target), moved = await snapshot();
  check('Dragging a static canvas handle enters a rig gesture', preview.drag === 'rig' && preview.joint === 0);
  check('Move joint follows the pointer and preserves every other endpoint', samePoint(moved.joints[11], target) && [0, 22, 33, 44].every(id => samePoint(moved.joints[id], initial.joints[id])));
  check('Pointer release preserves the preview exactly', [0, 11, 22, 33, 44].every(id => samePoint(moved.joints[id], preview.joints[id])));
  check('Rig edit changes the reusable definition in one undo entry', moved.history === initial.history + 1 && !near(moved.defaults[0].length, initial.defaults[0].length));
  check('Existing other-frame angular offsets survive the reusable change', await page.evaluate(() => styk.editor.report.keyframes[1].objects[0].angles.every((angle, i) => Math.abs(angle - styk.editor.figure.segments[i].angle_rad - .3) < 1e-7)));
  await page.screenshot({path: path.join(out, 'rig-move-joint.png')});
  await undo(); const restored = await snapshot();
  check('Keyboard undo restores all construction joints and definition lengths', [0, 11, 22, 33, 44].every(id => samePoint(restored.joints[id], initial.joints[id])) && restored.defaults.every((s, i) => near(s.length, initial.defaults[i].length)));
  await page.keyboard.press('Control+Shift+z');
  check('Keyboard redo restores the same rig edit', samePoint((await snapshot()).joints[11], target));
  await undo();
  await drag(initial.joints[11], {x: 435, y: 220}, {cancel: true}); const cancelled = await snapshot();
  check('Escape cancels an active static rig gesture without adding history', samePoint(cancelled.joints[11], initial.joints[11]) && cancelled.history === initial.history && !cancelled.dirty);
  await page.locator('#rig-mode').selectOption('rotate');
  const rotateTarget = {x: 280, y: 350}; await drag(initial.joints[11], rotateTarget); const rotated = await snapshot();
  check('Rotate branch turns the static segment and descendants together', [0, 1, 2].every(i => near(rotated.angles[i] - initial.angles[i], Math.PI / 2, .005)) && near(rotated.angles[3], initial.angles[3]));
  check('Rotate branch preserves segment lengths', rotated.lengths.every((length, i) => near(length, initial.lengths[i])));
  await undo();
  const stretchTarget = {x: 430, y: 250}; await drag(initial.joints[11], stretchTarget, {control: true}); const stretched = await snapshot();
  check('Ctrl-drag stretches the selected static segment in Rotate branch mode', near(stretched.lengths[0], 150) && near(stretched.defaults[0].length, 150));
  check('Ctrl stretch retains descendant lengths and angles', stretched.lengths.slice(1).every((length, i) => near(length, initial.lengths[i + 1])) && stretched.angles.every((angle, i) => near(angle, initial.angles[i], .005)));
  await undo();
  await page.locator('#rig-mode').selectOption('move');
  await drag(initial.joints[11], target); const authored = await snapshot();
  const pivPath = await saveExport('piv', 'rig-ui-edited.piv');
  check('Pivot export produces a real native file through the export dialog', (await readFile(pivPath)).length > 100);
  const stkPath = await saveExport('stk', 'rig-ui-edited.stk');
  check('STK export produces a real reusable native figure through the dialog', (await readFile(stkPath)).length > 16);
  await page.locator('#file-input').setInputFiles(pivPath);
  await page.locator('#discard-changes').click();
  await page.waitForFunction(() => styk.editor.name === 'rig-ui-edited');
  check('Reopened PIV preserves all keyframes and the edited static joint geometry', await page.evaluate(({x, y}) => {
    const e = styk.editor, endpoint = e.geometry.objects.get(e.selectedSlot).segments[0].end;
    return e.report.keyframes.length === 2 && Math.hypot(endpoint.x - x, endpoint.y - y) < .2 && (e.figure.segments[0].aux_code & 1);
  }, authored.joints[11]));
  const count = await page.evaluate(() => styk.editor.frame.objects.length);
  await page.locator('#file-input').setInputFiles(stkPath); await page.waitForFunction(count => styk.editor.frame.objects.length === count + 1, count);
  check('Reimported STK retains authored default lengths, angles and static flags', await page.evaluate(defaults => {
    const segments = styk.editor.figure.segments;
    return segments.length === 4 && (segments[0].aux_code & 1) && segments.every((s, i) => Math.abs(s.length - defaults[i].length) < .001 && Math.abs(s.angle_rad - defaults[i].angle) < 1e-7);
  }, authored.defaults));
  await page.locator('[data-tool="rig"]').click(); await page.screenshot({path: path.join(out, 'rig-reimported.png')});
  check('Rig gestures and native persistence emit no browser runtime errors', errors.length === 0);
  await writeFile(path.join(out, 'rig-ui-verification.json'), JSON.stringify({checks, errors, exports: [pivPath, stkPath]}, null, 2));
} catch (error) {
  await page.screenshot({path: path.join(out, 'rig-ui-failure.png')});
  await writeFile(path.join(out, 'rig-ui-verification.json'), JSON.stringify({checks, errors, failure: error.stack}, null, 2));
  throw error;
} finally { await browser.close(); }
