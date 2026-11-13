/**
 * A gesture writes to the page only what changes (architecture.md §3.2, src/ui/dom-write.mjs). Each write of an
 * attribute, a text or a class makes the browser restyle and sometimes lay out part of the chrome again, so a chrome
 * update that finds nothing changed must write nothing. This steps through frames, scrubs the ruler, drags a joint,
 * plays, drags the Properties panel's divider and resizes the window, and records every write the app makes with the
 * developer tools' own counter (src/devtools/mutations.mjs): none of them may put back the value that was there.
 *
 * One exception has a reason: configuring the stage's graphics surface for a new size writes both of the canvas's
 * dimensions, inside the engine's graphics library, also the one that did not change (`#scene`, once per resize).
 *
 *   STYK_URL=http://127.0.0.1:47831 node tests/interface-writes.browser.mjs
 */
import assert from 'node:assert/strict';
import {chromium} from './support/playwright.mjs';

const URL = process.env.STYK_URL || 'http://127.0.0.1:47831';
const SIZE = {width: 1440, height: 900};
// Written by the graphics library when the surface is configured for a new size (see above).
const ALLOWED = new Set(['#scene']);
const DIVIDER = '.shell-splitter[data-i18n-aria-label="dockHost.resizePropertiesPanel"]';

const browser = await chromium.launch({channel: 'chrome', headless: true});
const page = await browser.newPage({viewport: SIZE});
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const failures = [];

/** Runs `gesture` while the page's writes are recorded; returns the elements that were written their own value. */
async function recorded(name, gesture) {
  await page.waitForTimeout(400);
  await page.evaluate(async () => {
    const {recordWrites} = await import('/src/devtools/mutations.mjs');
    window.__writes = recordWrites();
  });
  await gesture();
  await page.waitForTimeout(400);
  const tally = await page.evaluate(() => window.__writes.stop());
  const unchanged = tally.rows.filter(row => row.unchanged && !ALLOWED.has(row.element));
  const line = `${name}: ${tally.writes} writes, ${tally.unchanged} unchanged`;
  if (unchanged.length) failures.push(`${line}: ${unchanged.map(row => `${row.element} [${row.names.join(', ')}] ${row.unchanged}×`).join('; ')}`);
  else console.log('PASS', line, tally.unchanged ? '(the stage surface sized for the new size)' : '');
  return tally;
}

const drag = async (from, to, steps = 24) => {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(from.x + (to.x - from.x) * i / steps, from.y + (to.y - from.y) * i / steps);
    await page.waitForTimeout(16);
  }
  await page.mouse.up();
};

try {
  await page.goto(URL);
  await page.waitForFunction(() => window.styk?.ready);
  await page.waitForTimeout(1200);
  await page.evaluate(async () => {
    document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
    await window.styk.settingsUI.commit({timelineMode: 'advanced'});
    for (let i = 0; i < 8; i++) await window.styk.actions['add-frame']();
    window.styk.editor.seek(0);
  });
  // A figure selected, as in an edit: the inspector, the quick actions and the handles all show.
  const handle = joint => page.evaluate(async joint => {
    const {getPivotHandles} = await import('/src/canvas-interactions.mjs');
    const {editor, state} = window.styk, uid = editor.frame.objects[0].unique_id;
    const found = getPivotHandles(editor.geometry, {frame: editor.frame, selectedUid: uid}).find(item => item.uid === uid && item.joint === joint);
    const box = document.getElementById('viewport').getBoundingClientRect();
    return {x: box.x + state.view.x + found.point.x * state.view.scale, y: box.y + state.view.y + found.point.y * state.view.scale};
  }, joint);
  const origin = await handle(-1);
  await page.mouse.click(origin.x, origin.y);
  await page.locator('[data-field="root_x"]').waitFor();

  await recorded('stepping through frames', async () => {
    for (let i = 0; i < 6; i++) { await page.keyboard.press('Period'); await page.waitForTimeout(60); }
  });

  await page.locator('.tl-fit').click();
  const ruler = await page.evaluate(() => {
    const timeline = window.styk.timeline, box = timeline.scroll.getBoundingClientRect();
    const x = tick => box.left + (tick + .5) * timeline.pxPerTick - timeline._offsetX();
    return {y: box.top + timeline.layout.header / 2, from: x(0), to: x(window.styk.editor.totalTicks - 1)};
  });
  await recorded('scrubbing the ruler', () => drag({x: ruler.from, y: ruler.y}, {x: ruler.to, y: ruler.y}));

  await page.evaluate(() => window.styk.editor.seek(0));
  const joint = await handle(1);
  await recorded('dragging a joint', () => drag(joint, {x: joint.x + 40, y: joint.y + 25}));

  await recorded('playing', async () => {
    await page.evaluate(() => window.styk.actions.play());
    await page.waitForTimeout(1000);
    await page.evaluate(() => window.styk.actions.play());
  });

  const divider = await page.locator(DIVIDER).boundingBox();
  const middle = {x: divider.x + divider.width / 2, y: divider.y + divider.height / 2};
  const resized = await recorded('dragging the Properties divider', async () => {
    await drag(middle, {x: middle.x - 160, y: middle.y});
    await drag({x: middle.x - 160, y: middle.y}, middle);
  });
  assert.ok(resized.writes > 0, 'the divider drag resized the panels');

  await recorded('resizing the window', async () => {
    for (let i = 1; i <= 6; i++) { await page.setViewportSize({width: SIZE.width - i * 40, height: SIZE.height - i * 20}); await page.waitForTimeout(50); }
    for (let i = 5; i >= 0; i--) { await page.setViewportSize({width: SIZE.width - i * 40, height: SIZE.height - i * 20}); await page.waitForTimeout(50); }
  });

  assert.deepEqual(failures, [], `Writes that put back the value already there:\n${failures.join('\n')}`);
  assert.deepEqual(errors, []);
  console.log('PASS: no gesture writes a value the page already shows.');
} finally { await browser.close(); }
