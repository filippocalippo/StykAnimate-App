// Joints in dense frames, in the app (docs/SCENE-EDITING.md, "Joints in dense frames"): above the budget a figure not selected
// shows its origin only and a press where its other joints were poses nothing; the selected figure poses as ever; under the
// budget every figure's joints pose; the status line says so once. Needs the development server (npm run serve) or STYK_URL.
import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';

const browser = await chromium.launch({channel: 'chrome', headless: true});
const page = await browser.newPage({viewport: {width: 1440, height: 1000}});
const errors = [];
page.on('pageerror', error => errors.push(error.stack || error.message));
const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const check = (name, value) => { assert.ok(value, name); console.log('PASS', name); };

/** A scene of `count` walkers: figures 1 and 2 side by side in view, the others in a grid far off. */
async function scene(count) {
  await page.evaluate(async count => {
    const {emptyDocument, createFrame, createObject} = await import('/src/demo.mjs');
    const report = emptyDocument(), figure = report.figure_types[0];
    report.keyframes = [createFrame(Array.from({length: count}, (_, i) => i < 2 ? createObject(figure, i + 1, 420 + i * 260, 420)
      : createObject(figure, i + 1, 3000 + (i % 50) * 90, 3000 + Math.floor(i / 50) * 140)), 10)];
    styk.editor.load(report, 'Dense joints');
    styk.state.hidden.clear(); styk.state.locked.clear(); styk.state.handles = true; styk.state.settings.showUnselectedHandles = true;
    styk.editor.select(1);
    Object.assign(styk.state.view, {scale: 1, x: 0, y: 0});
    styk.requestRender();
  }, count);
  await page.keyboard.press('v'); await settle(); await settle();
}
/** The joint of figure `uid` farthest from its origin, in client coordinates, and the figure's angles. */
const farJoint = uid => page.evaluate(async uid => {
  const {worldToScreen} = await import('/src/renderer-geometry.mjs');
  const group = [...styk.editor.geometry.objects.values()].find(item => item.obj.unique_id === uid);
  const ends = group.segments.filter(shape => !shape.static).map(shape => shape.end);
  const end = ends.sort((p, q) => Math.hypot(q.x - group.root.x, q.y - group.root.y) - Math.hypot(p.x - group.root.x, p.y - group.root.y))[0];
  const point = worldToScreen(end, {report: styk.editor.report, frame: styk.editor.evaluatedFrame, view: styk.state.view});
  const rect = document.querySelector('#viewport').getBoundingClientRect();
  return {x: rect.left + point.x, y: rect.top + point.y};
}, uid);
const pose = uid => page.evaluate(uid => ({angles: styk.editor.evaluatedFrame.objects.find(object => object.unique_id === uid).angles.join(), undo: styk.editor._undo.length}), uid);
async function drag(point) {
  await page.mouse.move(point.x, point.y); await page.mouse.down();
  await page.mouse.move(point.x + 30, point.y + 25, {steps: 6}); await page.mouse.up(); await settle();
}

try {
  await page.goto(process.env.STYK_URL || 'http://127.0.0.1:47831');
  await page.waitForFunction(() => window.styk?.ready);
  const perFigure = await page.evaluate(async () => {
    const {definitionHandleCount} = await import('/src/canvas-interactions.mjs');
    const {emptyDocument} = await import('/src/demo.mjs');
    return 1 + definitionHandleCount(emptyDocument().figure_types[0]);
  });
  const {DENSE_HANDLE_BUDGET} = await import('../src/canvas-interactions.mjs');
  const dense = Math.ceil((DENSE_HANDLE_BUDGET + 1) / perFigure), sparse = 3;

  await scene(dense);
  const status = await page.evaluate(() => document.getElementById('status').textContent);
  check(`a dense frame (${dense * perFigure} joints) says so on the status line`, status.includes('origin'));
  let before = await pose(2);
  await drag(await farJoint(2));
  let after = await pose(2);
  check('dense: a press where a joint of a figure not selected was poses nothing', after.angles === before.angles && after.undo === before.undo);
  await page.evaluate(() => styk.editor.select(1)); await settle();
  before = await pose(1);
  await drag(await farJoint(1));
  after = await pose(1);
  check('dense: the selected figure shows its joints and poses', after.angles !== before.angles && after.undo === before.undo + 1);

  await scene(sparse);
  before = await pose(2);
  await drag(await farJoint(2));
  after = await pose(2);
  check('under the budget a figure not selected poses from its joints', after.angles !== before.angles && after.undo === before.undo + 1);
  assert.deepEqual(errors, []);
} finally { await browser.close(); }
