/**
 * Arranging the workspace by hand (docs/DOCKING.md): the tools move between
 * the stage's sides; a tab floats, moves and docks with a drop preview; a
 * panel splits a group, joins one as a tab, docks at a window edge; a header
 * collapses its group to a strip whose flyout drags out again; a float docks
 * back; F6 visits every region of a rearranged window in reading order;
 * Escape cancels; the arrangement persists per workspace.
 *
 * Serve the repository and run `node tests/workspace-drag.browser.mjs`;
 * STYK_URL overrides the address.
 */
import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';

const out = 'artifacts/workspace-drag-latest';
await mkdir(out, {recursive: true});
const browser = await chromium.launch({channel: 'chrome', headless: true});
const page = await browser.newPage({viewport: {width: 1440, height: 900}});
const errors = [];
page.on('pageerror', error => errors.push(error.message));
await page.addInitScript(() => localStorage.setItem('stykanimate.editor.settings.v1', JSON.stringify({locale: 'en'})));
const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const box = selector => page.locator(selector).first().boundingBox();
/** Where a panel is: presentation/side of the stage (float, strip, docked, hidden). */
const placement = id => page.evaluate(id => {
  const s = styk.shell.solution, panel = s.panels[id];
  return `${panel.presentation}/${s.groups.find(group => group.tabs.includes(id))?.side ?? 'none'}`;
}, id);
const zoneLabel = () => page.evaluate(() => { const zone = document.querySelector('.shell-drag-zone'); return zone && !zone.hidden ? zone.textContent : null; });
async function drag(selector, target, {cancel = false, label, from} = {}) {
  const source = from ?? await box(selector);
  assert.ok(source, `${selector} has a visible drag handle`);
  await page.mouse.move(source.x + (source.width ?? 0) / 2, source.y + (source.height ?? 0) / 2);
  await page.mouse.down(); await page.mouse.move(target.x, target.y, {steps: 8});
  if (label) assert.equal(await zoneLabel(), label);
  if (cancel) await page.keyboard.press('Escape');
  await page.mouse.up(); await settle();
}
async function centered() {
  const rail = await box('.shell-rail'), viewport = await box('#viewport');
  assert.ok(Math.abs(rail.y + rail.height / 2 - viewport.y - viewport.height / 2) <= 1);
  assert.ok(rail.y >= viewport.y && rail.y + rail.height <= viewport.y + viewport.height);
}
const tree = () => page.evaluate(() => JSON.stringify(styk.workspace.layout));
try {
  await page.goto(process.env.STYK_URL || 'http://127.0.0.1:47911');
  await page.waitForFunction(() => window.styk?.ready); await settle();
  await centered();
  let viewport = await box('#viewport');
  await drag('.shell-rail-handle', {x: viewport.x + viewport.width - 24, y: viewport.y + viewport.height / 2}, {label: 'Move tools right'});
  assert.equal(await page.locator('.workspace').getAttribute('data-rail'), 'right');
  await centered();
  await page.locator('.shell-rail-handle').focus(); await page.keyboard.press('ArrowLeft');
  assert.equal(await page.locator('.workspace').getAttribute('data-rail'), 'left');
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('.workspace').getAttribute('data-rail'), 'right');
  await drag('.shell-rail-handle', {x: viewport.x + 24, y: viewport.y + viewport.height / 2}, {cancel: true});
  assert.equal(await page.locator('.workspace').getAttribute('data-rail'), 'right');

  // Float, move and dock back by hand; the preview shows the exact area; Escape leaves the arrangement byte-equal.
  await drag('#properties-tab', {x: viewport.x + viewport.width * .5, y: viewport.y + 90}, {label: 'Float here'});
  assert.equal(await placement('properties'), 'float/none');
  assert.equal(await page.locator('#properties-panel').isVisible(), true);
  const before = await page.evaluate(() => styk.workspace.floating[0]);
  let handle = await box('#properties-tab');
  await drag('#properties-tab', {x: handle.x + handle.width / 2 + 60, y: handle.y + handle.height / 2});
  const after = await page.evaluate(() => styk.workspace.floating[0]);
  assert.ok(after.x > before.x, 'a float moves by its tab');
  assert.equal(after.w, before.w); assert.equal(after.h, before.h);
  viewport = await box('#viewport');
  const unchanged = await tree();
  await drag('#properties-tab', {x: viewport.x + viewport.width / 2, y: viewport.y + 60}, {cancel: true});
  assert.equal(await tree(), unchanged, 'Escape cancels: the arrangement is byte-equal');
  // The preview is the exact rectangle the release gives the panel.
  handle = await box('#properties-tab');
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down(); await page.mouse.move(viewport.x + viewport.width - 25, viewport.y + viewport.height / 2, {steps: 8});
  assert.equal(await zoneLabel(), 'Dock right');
  await page.waitForTimeout(250);
  const preview = await page.evaluate(() => document.querySelector('.shell-drag-zone').getBoundingClientRect().toJSON());
  await page.mouse.up(); await settle();
  assert.equal(await placement('properties'), 'docked/right');
  const docked = await box('.shell-island:has(#properties-tab)');
  for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(preview[key] - docked[key]) <= 1, `preview ${key} ${preview[key]} is the docked ${docked[key]}`);

  // Split a group, resize the split, merge back as a tab; the arrangement persists across a reload.
  const right = await box('.shell-island:has(#properties-tab)');
  await drag('#library-tab', {x: right.x + right.width / 2, y: right.y + right.height - 25}, {label: 'Split below'});
  assert.equal(await page.locator('#properties-panel').isVisible(), true);
  assert.equal(await page.locator('#user-library').isVisible(), true);
  const stacked = await page.evaluate(() => styk.shell.solution.dividers.find(divider => divider.axis === 'column' && divider.tabs.includes('library') && !divider.tabs.includes('timeline'))?.key);
  assert.ok(stacked, 'a divider between the stacked groups');
  const splitter = page.locator(`[data-splitter="${stacked}"]`);
  const heightBefore = Number(await splitter.getAttribute('aria-valuenow'));
  await splitter.focus(); await page.keyboard.press('ArrowUp');
  assert.notEqual(Number(await splitter.getAttribute('aria-valuenow')), heightBefore);
  const sizesBefore = await tree();
  const bar = await box(`[data-splitter="${stacked}"]`);
  await drag(null, {x: bar.x + bar.width / 2, y: bar.y + 80}, {cancel: true, from: bar});
  assert.equal(await tree(), sizesBefore, 'Escape cancels a divider drag');
  await page.evaluate(() => styk.workspace.flushPreferences());
  await page.screenshot({path: `${out}/stacked.png`});
  await page.reload(); await page.waitForFunction(() => window.styk?.ready); await settle();
  assert.equal(await tree(), sizesBefore, 'the arrangement comes back after a reload');
  assert.equal(await page.locator('.workspace').getAttribute('data-rail'), 'right');
  await centered();
  const tabs = await box('.shell-island:has(#properties-tab) > .shell-tabs');
  await drag('#library-tab', {x: tabs.x + tabs.width - 4, y: tabs.y + tabs.height / 2}, {label: 'Add as a tab'});
  assert.deepEqual(await page.evaluate(() => styk.shell.solution.groups.find(group => group.tabs.includes('properties')).tabs), ['properties', 'library']);

  // A window edge docks across the window; F6 visits every region in reading order.
  viewport = await box('#viewport');
  await drag('#vfx-tab', {x: 6, y: viewport.y + viewport.height / 2}, {label: 'Dock along the left edge'});
  assert.equal(await placement('vfx'), 'docked/left');
  const vfx = await box('.shell-island:has(#vfx-tab)'), timeline = await box('#animation-timeline');
  assert.ok(vfx.y + vfx.height > timeline.y, 'an edge dock runs the whole height, beside the timeline');
  await page.locator('#viewport').focus();
  const regions = [];
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('F6');
    regions.push(await page.evaluate(() => {
      const active = document.activeElement;
      return active.closest('.shell-island')?.dataset.panels ?? active.closest('#animation-timeline, .titlebar, .shell-rail, .stage-head')?.className.split(' ')[0] ?? active.id;
    }));
  }
  assert.deepEqual(regions, ['properties library', 'timeline-panel', 'titlebar', 'studio-rail', 'vfx', 'stage-head'], 'F6 follows the arrangement');
  await page.keyboard.press('Control+F6');
  assert.equal(await page.evaluate(() => document.activeElement.closest('.shell-island')?.dataset.panels), 'vfx', 'Ctrl+F6 goes back');

  // A double press on a header collapses its group to a strip; its icon opens a flyout; the flyout's tab drags the panel out.
  const island = await box('.shell-island:has(#vfx-tab)');
  await page.mouse.dblclick(island.x + island.width - 12, island.y + 20); await settle();
  assert.equal(await placement('vfx'), 'strip/left');
  await page.locator('.shell-strip-button[data-panel="vfx"]').click(); await settle();
  assert.equal(await page.locator('#vfx-panel').isVisible(), true, 'the flyout shows the panel');
  viewport = await box('#viewport');
  await drag('#vfx-tab', {x: viewport.x + viewport.width / 2, y: viewport.y + 100}, {label: 'Float here'});
  assert.equal(await placement('vfx'), 'float/none');
  const float = await box('.shell-island[data-floating]');
  await page.mouse.dblclick(float.x + float.width - 20, float.y + 18); await settle();
  assert.equal(await placement('vfx'), 'strip/left', 'a double press on a float\'s header docks it back where it came from');
  assert.deepEqual(errors, []);
  console.log('PASS the tools move between sides; panels float, move, dock right with an exact preview, split, resize, merge, dock at an edge, collapse, open as a flyout and dock back; F6 follows the arrangement; Escape cancels; the arrangement persists');

  await page.evaluate(() => styk.workspace.reset()); await settle();
  await page.locator('.workspace-switch [data-workspace-mode="rig"]').click(); await settle();
  if (await page.locator('#builder-exit-update').count()) await page.click('#builder-exit-update');
  assert.equal(await page.locator('.workspace').getAttribute('data-rail'), 'left', 'workspace arrangements are independent');
  viewport = await box('#viewport');
  // Build's Structure starts collapsed; its icon opens it as a flyout, and the flyout's tab drags it out.
  assert.equal(await placement('structure'), 'strip/left');
  await page.locator('.shell-strip > [data-panel="structure"]').click(); await settle();
  await drag('#structure-tab', {x: viewport.x + viewport.width / 2, y: viewport.y + 70}, {label: 'Float here'});
  assert.equal(await placement('structure'), 'float/none');
  assert.equal(await page.locator('#builder-outliner').isVisible(), true);
  await page.screenshot({path: `${out}/build-floating.png`});
  await page.locator('#builder-done').click();
  for (const [width, height] of [[1440, 900], [800, 600], [500, 340]]) {
    await page.setViewportSize({width, height}); await settle(); await centered();
    await page.screenshot({path: `${out}/animate-${width}x${height}.png`});
  }
  assert.deepEqual(errors, []);
  console.log('PASS Structure drags out of its flyout and floats; the tool palette stays centered at compact sizes');
} finally { await browser.close(); }
