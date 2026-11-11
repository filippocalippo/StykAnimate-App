// Two-finger zoom and pan on the canvas, with real touch input in Chromium: the
// artwork stays under the fingers, a second finger cancels the first one's edit,
// and lifting the fingers afterwards selects and moves nothing.
//
//   node tests/canvas-pinch.browser.mjs           serve a fresh build of the site
//   STYK_URL=http://127.0.0.1:47839 node tests/...   test a running app instead
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from './support/playwright.mjs';
import { buildWeb } from '../scripts/build-web.mjs';
import { startWebServer } from '../scripts/serve-web.mjs';

const temp = await mkdtemp(path.join(os.tmpdir(), 'styk-pinch-'));
const remote = process.env.STYK_URL;
const site = remote ? { origin: remote, close: async () => {} } : await startWebServer({ root: (await buildWeb({ output: path.join(temp, 'site') })).output });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const checks = [];
const check = (name, condition) => { assert.ok(condition, name); checks.push(name); console.log('PASS', name); };
const near = (a, b, tolerance) => Math.abs(a - b) <= tolerance;

try {
  const context = await browser.newContext({ viewport: { width: 1180, height: 820 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const problems = [];
  page.on('pageerror', (error) => problems.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') problems.push(message.text()); });
  await page.goto(site.origin, { waitUntil: 'load' });
  await page.waitForFunction(() => window.styk?.ready === true, undefined, { timeout: 60000 });
  await page.evaluate(() => document.querySelector('.styk-privacy [data-decline]')?.click());
  const cdp = await context.newCDPSession(page);
  const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y], id) => ({ x, y, id })) });
  const view = () => page.evaluate(() => ({ ...window.styk.state.view }));
  const area = await page.evaluate(() => { const b = document.getElementById('viewport').getBoundingClientRect(); return { left: b.left, top: b.top, width: b.width, height: b.height }; });
  // A quiet corner of the canvas, away from the figure and the tool bar.
  const corner = { x: area.left + area.width - 220, y: area.top + 150 };
  const pinch = async (from, to, mid = corner, steps = 10) => {
    const at = (spread, offset = [0, 0]) => [[mid.x - spread + offset[0], mid.y + offset[1]], [mid.x + spread + offset[0], mid.y + offset[1]]];
    await touch('touchStart', at(from));
    for (let step = 1; step <= steps; step++) await touch('touchMove', at(from + (to - from) * step / steps));
    await touch('touchEnd', []);
    await page.waitForTimeout(150);
  };
  const artworkUnder = (v, x, y) => ({ x: (x - area.left - v.x) / v.scale, y: (y - area.top - v.y) / v.scale });

  // Spreading two fingers zooms in around their midpoint.
  const before = await view();
  const under = artworkUnder(before, corner.x, corner.y);
  await pinch(20, 100);
  const zoomedIn = await view();
  check('Spreading two fingers zooms in by the change in their distance', near(zoomedIn.scale / before.scale, 5, 0.01));
  const after = artworkUnder(zoomedIn, corner.x, corner.y);
  check('The artwork under the fingers stays under them', near(after.x, under.x, 0.5) && near(after.y, under.y, 0.5));

  await pinch(100, 40);
  const zoomedOut = await view();
  check('Bringing them together zooms out', near(zoomedOut.scale / zoomedIn.scale, 0.4, 0.01));

  // Moving both fingers together pans without zooming.
  await touch('touchStart', [[corner.x - 30, corner.y], [corner.x + 30, corner.y]]);
  for (let step = 1; step <= 10; step++) await touch('touchMove', [[corner.x - 30 + step * 8, corner.y + step * 4], [corner.x + 30 + step * 8, corner.y + step * 4]]);
  await touch('touchEnd', []);
  await page.waitForTimeout(150);
  const panned = await view();
  check('Moving both fingers pans the canvas', near(panned.x - zoomedOut.x, 80, 1) && near(panned.y - zoomedOut.y, 40, 1) && near(panned.scale, zoomedOut.scale, 1e-9));

  // The undo history and the selection are untouched by all of that.
  check('Navigating adds nothing to the undo history', await page.evaluate(() => window.styk.editor.canUndo === false));

  // A second finger during a joint drag cancels the drag instead of finishing it.
  await page.evaluate(() => window.styk.fit());
  await page.waitForTimeout(200);
  const figure = await page.evaluate(async () => {
    const { worldToScreen } = await import('/src/renderer-geometry.mjs');
    const { editor, state } = window.styk, rect = document.getElementById('overlay').getBoundingClientRect();
    editor.select(editor.frame.objects[0].unique_id, -1);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const point = worldToScreen(editor.geometry.objects.get(editor.selectedSlot).root, { report: editor.report, frame: editor.frame, view: state.view, cameraEnabled: false });
    return { x: rect.left + point.x, y: rect.top + point.y, root: { x: editor.object.root_x, y: editor.object.root_y }, selected: [...editor.selectedUids] };
  });
  await touch('touchStart', [[figure.x, figure.y]]);
  for (let step = 1; step <= 6; step++) await touch('touchMove', [[figure.x + step * 6, figure.y + step * 3]]);
  const dragging = await page.evaluate(() => window.styk.state.drag?.kind);
  check('One finger drags the figure', dragging === 'move');
  const scaleBefore = (await view()).scale;
  const held = [figure.x + 36, figure.y + 18];
  await touch('touchStart', [held, [held[0] + 120, held[1] + 40]]);
  for (let step = 1; step <= 8; step++) await touch('touchMove', [held, [held[0] + 120 + step * 15, held[1] + 40]]);
  const during = await page.evaluate(() => ({ drag: window.styk.state.drag?.kind ?? null, root: { x: window.styk.editor.object.root_x, y: window.styk.editor.object.root_y } }));
  check('A second finger cancels the drag and puts the figure back', during.drag === null && during.root.x === figure.root.x && during.root.y === figure.root.y);
  check('and the fingers zoom the canvas instead', (await view()).scale > scaleBefore * 1.5);
  await touch('touchMove', [held]);
  await touch('touchMove', [[held[0] + 50, held[1] + 50]]);
  await touch('touchEnd', []);
  await page.waitForTimeout(200);
  const settled = await page.evaluate(() => ({ canUndo: window.styk.editor.canUndo, drag: window.styk.state.drag?.kind ?? null, selected: [...window.styk.editor.selectedUids], root: { x: window.styk.editor.object.root_x, y: window.styk.editor.object.root_y } }));
  check('Lifting the fingers changes nothing: no edit, no drag, the same selection', !settled.canUndo && settled.drag === null && JSON.stringify(settled.selected) === JSON.stringify(figure.selected) && settled.root.x === figure.root.x);

  // Ordinary one-finger editing still works afterwards.
  await page.evaluate(() => window.styk.fit());
  await page.waitForTimeout(200);
  const again = await page.evaluate(async () => {
    const { worldToScreen } = await import('/src/renderer-geometry.mjs');
    const { editor, state } = window.styk, rect = document.getElementById('overlay').getBoundingClientRect();
    const point = worldToScreen(editor.geometry.objects.get(editor.selectedSlot).root, { report: editor.report, frame: editor.frame, view: state.view, cameraEnabled: false });
    return { x: rect.left + point.x, y: rect.top + point.y };
  });
  await touch('touchStart', [[again.x, again.y]]);
  for (let step = 1; step <= 12; step++) await touch('touchMove', [[again.x + step * 8, again.y]]);
  await touch('touchEnd', []);
  await page.waitForTimeout(200);
  check('A one-finger drag still moves the figure', await page.evaluate((root) => window.styk.editor.canUndo && window.styk.editor.object.root_x > root.x + 20, figure.root));

  check('No console errors or page errors', problems.length === 0 || (console.error(problems), false));
  await context.close();
  console.log(`\n${checks.length} checks passed`);
} finally {
  await browser.close();
  await site.close();
  await rm(temp, { recursive: true, force: true });
}
