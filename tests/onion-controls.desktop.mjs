// The onion range in the desktop app at each interface scale (Preferences, Interface scale: the window's own zoom).
// A drag is measured in the page's pixels, which the scale changes, so each scale checks both ways of dragging the
// range: the "Before" name in the onion settings (8 pixels a frame) and the marker on the timeline's ruler (one frame
// of the timeline a frame). Then: the settings stay inside the window at 200%, and the range is kept by the desktop.
//   npm run test:onion:desktop
import {_electron as electron} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();
const out = path.join(root, 'artifacts/onion-controls');
await mkdir(out, {recursive: true});
const profile = await mkdtemp(path.join(os.tmpdir(), 'styk-onion-profile-'));
const library = await mkdtemp(path.join(os.tmpdir(), 'styk-onion-library-'));
const app = await electron.launch({args: [root], cwd: root, timeout: 60000,
  env: {...process.env, STYK_USER_DATA_DIR: profile, STYK_LIBRARY_DIR: library, STYK_BACKGROUND_WINDOW: '1'}});
app.process().stderr.on('data', data => process.stderr.write(data));

/** Pixels of the timeline one frame takes while the markers are dragged. */
const ZOOM = 8;
const START = 20;

try {
  const page = await app.firstWindow(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => window.styk?.ready, undefined, {timeout: 60000});
  // Large enough that the page is still 1200 × 700 at 200%: in a smaller one the app folds the timeline away, markers and all.
  await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setSize(2400, 1400));
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const closeDialogs = () => page.evaluate(() => document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close()));
  const span = () => page.evaluate(() => styk.onionController.snapshot().before.span);
  const stored = () => page.evaluate(() => styk.state.settings.onionRangeBefore);

  await closeDialogs();
  await page.evaluate(async start => {
    const {emptyDocument, createFrame, createObject} = await import('/src/demo.mjs');
    const report = emptyDocument();
    report.keyframes = Array.from({length: 60}, (_, i) => createFrame([createObject(report.figure_types[0], 1, 200 + i, 250)], 10));
    styk.editor.load(report);
    styk.editor.seek(200);
    styk.settingsUI.commit({onionRangeBefore: start, onionRangeAfter: start, onionTimelineMarkers: true});
    if (!styk.onionController.getEnabled()) styk.onionController.toggle();
  }, START);
  await settle();

  /** Presses the middle of `locator`, moves by each of `steps` in turn and says the range after each; the pointer stays down. */
  const press = async (locator, steps) => {
    const box = await locator.boundingBox();
    const x = box.x + box.width / 2, y = box.y + box.height / 2, seen = [];
    await page.mouse.move(x, y);
    await page.mouse.down();
    for (const dx of steps) { await page.mouse.move(x + dx, y); await settle(); seen.push(await span()); }
    return seen;
  };

  // The display's own ratio: the page's, less the interface scale already applied (Automatic picks one for the screen).
  const baseDpr = await page.evaluate(() => devicePixelRatio) / await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].webContents.getZoomFactor());
  const settings = page.getByRole('button', {name: 'Onion skin settings', exact: true});
  const panel = page.getByRole('dialog', {name: 'Onion skin settings', exact: true});
  const scrub = panel.getByRole('button', {name: 'Drag frames Before', exact: true});
  const marker = page.getByRole('slider', {name: 'Onion frames Before', exact: true});

  for (const scale of [75, 100, 150, 200]) {
    await page.evaluate(({scale, start}) => styk.settingsUI.commit({uiScale: scale, onionRangeBefore: start}), {scale, start: START});
    await page.waitForFunction(({scale, baseDpr}) => Math.abs(devicePixelRatio - baseDpr * scale / 100) < .01, {scale, baseDpr});
    await settle();
    await closeDialogs();
    await settle();

    // The settings: both sides of the range, and the name that scrubs at 8 pixels a frame.
    if (!await panel.isVisible()) await settings.click();
    await settle();
    assert.ok(await panel.getByRole('spinbutton', {name: 'Frames Before', exact: true}).isVisible(), `${scale}%: the Before field shows`);
    assert.ok(await panel.getByRole('spinbutton', {name: 'Frames After', exact: true}).isVisible(), `${scale}%: the After field shows`);
    assert.deepEqual(await press(scrub, [3, 8]), [START, START + 1], `${scale}%: three pixels on the name change nothing, eight add a frame`);
    await page.mouse.up();
    await settle();
    assert.equal(await stored(), START + 1, `${scale}%: releasing the name keeps the range`);
    await panel.getByRole('button', {name: 'Close onion settings'}).click();

    // The marker on the ruler: under half a frame of travel changes nothing, a frame of travel is a frame of range.
    await page.evaluate(({zoom, start}) => {
      styk.settingsUI.commit({onionRangeBefore: start});
      styk.timeline.setZoom(zoom);
      styk.timeline._scrollToX((styk.editor.tick - start + .5) * zoom - 80);
    }, {zoom: ZOOM, start: START});
    await settle();
    assert.deepEqual(await press(marker, [-3, -ZOOM]), [START, START + 1], `${scale}%: three pixels on the marker change nothing, a frame of travel adds a frame`);
    assert.equal(await stored(), START, `${scale}%: the range is only previewed while the marker is held`);
    await page.mouse.up();
    await settle();
    assert.equal(await stored(), START + 1, `${scale}%: releasing the marker keeps the range`);
    console.log(`PASS ${scale}% interface scale: the name in the settings and the ruler's marker each add one frame, and ignore three pixels of jitter`);
  }

  // Still at 200%: the settings open inside the window.
  await settings.click();
  await settle();
  assert.ok(await page.locator('.onion-popover').evaluate(node => {
    const r = node.getBoundingClientRect();
    return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
  }), 'the onion settings stay inside the window at 200%');
  await writeFile(path.join(out, 'desktop-200.png'), Buffer.from(await app.evaluate(async ({BrowserWindow}) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64')), 'base64'));
  console.log('PASS the onion settings stay inside the window at 200%');

  await page.evaluate(() => styk.settingsUI.flush());
  assert.equal(await page.evaluate(async () => (await stykDesktop.getEditorSettings()).onionRangeBefore), START + 1);
  console.log('PASS the desktop keeps the range');
  assert.deepEqual(errors, [], 'the page raised no errors');
} finally {
  await app.evaluate(({app}) => app.exit(0)).catch(() => {});
  await rm(profile, {recursive: true, force: true, maxRetries: 10, retryDelay: 200}).catch(() => {});
  await rm(library, {recursive: true, force: true, maxRetries: 10, retryDelay: 200}).catch(() => {});
}
