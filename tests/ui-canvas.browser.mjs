// Drives the canvas in a real browser against the fake CLI: no tokens are spent.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../labs/ui-canvas/server.mjs';
import { chromium } from './support/playwright.mjs';

const fake = fileURLToPath(new URL('../labs/ui-canvas/test/fake-claude.mjs', import.meta.url));
const shots = fileURLToPath(new URL('../artifacts/ui-canvas/shots/', import.meta.url));
await mkdir(shots, { recursive: true });
const directory = await mkdtemp(path.join(os.tmpdir(), 'ui-canvas-browser-'));
const server = await startServer({ port: 0, dataDirectory: directory, command: [process.execPath, fake] });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: server.origin });
const page = await context.newPage();
const problems = [];
page.on('pageerror', (error) => problems.push(`page: ${error.message}`));
page.on('console', (message) => { if (message.type() === 'error') problems.push(`console: ${message.text()}`); });

const board = () => page.evaluate(() => window.uiCanvas.board);
const frames = async () => Object.values((await board()).frames).filter((frame) => !frame.deleted);
const waitFor = (test, label) => page.waitForFunction(test, undefined, { timeout: 15000 }).catch(() => { throw new Error(`Timed out: ${label}`); });
const screen = (index = 0) => page.frameLocator('.fr iframe').nth(index);
const runsDone = () => waitFor(() => Object.values(window.uiCanvas.board.runs).every((run) => run.state !== 'running'), 'runs to finish');
// Playwright ignores the world's scale inside an iframe, so aim from the real screen position.
const clickInside = async (frame, target) => {
  const outer = await frame.boundingBox();
  const inner = await target.evaluate((node) => { const r = node.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, width: innerWidth }; });
  const scale = outer.width / inner.width;
  await page.mouse.click(outer.x + inner.x * scale, outer.y + inner.y * scale);
};
const click = async (id) => {
  const box = await page.locator(`.fr[data-id="${id}"] .fr-shield`).boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
};

try {
  await page.goto(server.origin);
  await page.locator('#empty h1').waitFor();
  await page.screenshot({ path: `${shots}01-empty.png` });

  // Create: three parallel variants that stream into frames.
  await page.locator('#prompt').fill('A home that makes you want to animate');
  await page.keyboard.press('Enter');
  await waitFor(() => document.querySelectorAll('.fr').length === 3, 'three frames');
  await runsDone();
  await screen(0).locator('h1').waitFor();
  await screen(2).locator('x-fig svg').waitFor();
  assert.equal(await page.locator('#stop').isVisible(), false, 'Stop hides when nothing runs');
  assert.match(await page.locator('#meter').textContent(), /tokens/);
  const list = await frames();
  assert.equal(list.length, 3);

  // The sandbox holds: a screen can reach neither the page nor the API.
  const reach = await screen(0).locator('html').evaluate(async () => {
    let touched = false;
    try { touched = Boolean(parent.document); } catch { /* expected */ }
    const response = await fetch('/api/board').then((r) => r.status).catch(() => 'blocked');
    return { touched, response };
  });
  assert.deepEqual(reach, { touched: false, response: 'blocked' });

  // Select, tag with the keyboard, and filter.
  const [first, second] = list;
  await page.mouse.move(700, 450);
  await click(first.id);
  await page.locator('#selbar').waitFor();
  await page.locator('#context').waitFor();
  await page.keyboard.press('1');
  assert.deepEqual((await board()).frames[first.id].tags, ['keep']);
  await page.locator('#tags .tag-chip').first().click();
  assert.equal(await page.locator('.fr.is-dim').count(), 2);
  await page.locator('#tags .tag-chip').first().click();
  assert.equal(await page.locator('.fr.is-dim').count(), 0);
  await page.screenshot({ path: `${shots}02-selected.png` });

  // A custom tag from the menu.
  await page.keyboard.press('t');
  await page.locator('#tagmenu input').fill('Home ideas');
  await page.keyboard.press('Enter');
  assert.deepEqual((await board()).frames[first.id].tags, ['keep', 'home-ideas']);
  await page.keyboard.press('Escape');

  // Move, then undo and redo.
  const before = await page.locator(`.fr[data-id="${first.id}"] .fr-shield`).boundingBox();
  await page.mouse.move(before.x + 60, before.y + 60);
  await page.mouse.down();
  await page.mouse.move(before.x + 160, before.y + 110, { steps: 4 });
  await page.mouse.up();
  const moved = (await board()).frames[first.id];
  assert.notEqual(moved.x, first.x);
  await page.keyboard.press('Control+z');
  assert.equal((await board()).frames[first.id].x, first.x);
  await page.keyboard.press('Control+Shift+z');
  assert.equal((await board()).frames[first.id].x, moved.x);

  // Refine adds a version in place; older versions stay one key away.
  await page.locator('#prompt').fill('Rename the button');
  await page.keyboard.press('Enter');
  await waitFor(() => Object.values(window.uiCanvas.board.frames).some((f) => f.versions.length === 2), 'a second version');
  await screen(0).getByText('Keep going').waitFor();
  await page.locator('#prompt').blur();
  await page.keyboard.press('[');
  await screen(0).getByText('Continue').waitFor();
  await page.keyboard.press(']');
  await screen(0).getByText('Keep going').waitFor();

  // Pick one element: only that element is replaced.
  await page.keyboard.press('e');
  const heading = screen(0).locator('h1');
  await waitFor(() => document.querySelector('.fr.is-live') !== null, 'pick mode');
  await clickInside(page.locator('.fr iframe').first(), heading);
  await page.locator('.ctx-target').getByText('h1').waitFor();
  await page.screenshot({ path: `${shots}03-picked.png` });
  await page.locator('#prompt').fill('Change this heading');
  await page.keyboard.press('Enter');
  await screen(0).getByText('Picked and changed').waitFor();
  await screen(0).getByText('Keep going').waitFor();

  // Critique, then apply one finding.
  await page.locator('#context .seg button', { hasText: 'Critique' }).click();
  await page.keyboard.press('Enter');
  await page.locator('#critique .finding').waitFor();
  await page.screenshot({ path: `${shots}04-critique.png` });

  // Variants of a selected screen land beside it.
  await page.locator('#prompt').blur();
  await click(second.id);
  await page.locator('#context .seg button', { hasText: 'Variants' }).click();
  await page.locator('#prompt').fill('2 more');
  await page.keyboard.press('Enter');
  await waitFor(() => Object.values(window.uiCanvas.board.frames).filter((f) => !f.deleted).length === 5, 'two more frames');
  await runsDone();

  // A flow: linked frames, followed from inside a live screen.
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.locator('#prompt').fill('A first-run flow');
  await page.keyboard.press('Enter');
  await waitFor(() => Object.values(window.uiCanvas.board.frames).filter((f) => f.screenId === 'two').length === 1, 'the second screen');
  await runsDone();
  await waitFor(() => {
    const first = Object.values(window.uiCanvas.board.frames).find((f) => f.screenId === 'one');
    return document.querySelector(`.fr[data-id="${first?.id}"]`)?.classList.contains('has-flow');
  }, 'one card for the flow');
  await page.waitForTimeout(500);
  const flow = (await frames()).find((frame) => frame.screenId === 'one');
  await click(flow.id);
  const box = await page.locator(`.fr[data-id="${flow.id}"] .fr-shield`).boundingBox();
  // Double-click plays the flow full window, and its links work there.
  await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
  const played = page.frameLocator('#present iframe');
  await played.getByRole('heading', { name: 'First' }).waitFor();
  await played.getByText('Continue').dispatchEvent('click'); // the test figure overlaps it at full size
  await played.getByRole('heading', { name: 'Second' }).waitFor();
  await page.keyboard.press('Escape');
  // P plays the selection again, from the screen last shown.
  await page.keyboard.press('p');
  await played.getByRole('heading', { name: 'Second' }).waitFor();
  await page.screenshot({ path: `${shots}05-play.png` });
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#present').isVisible(), false);

  // Delete is undoable, and everything fits on screen.
  await page.mouse.click(40, 500);
  await page.keyboard.press('Control+a');
  const count = (await frames()).length;
  await page.keyboard.press('Delete');
  assert.equal((await frames()).length, 0);
  await page.keyboard.press('Control+z');
  assert.equal((await frames()).length, count);
  await page.keyboard.press('Shift+!');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${shots}06-board.png` });

  // Dark theme and a reload keep the board.
  await page.locator('#theme').click();
  await page.reload();
  await page.locator('.fr iframe').first().waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${shots}07-dark.png` });
  assert.equal((await frames()).length, count);

  // Failures are shown on the frame, not lost.
  await page.locator('#prompt').fill('FAIL');
  await page.keyboard.press('Enter');
  await waitFor(() => Object.values(window.uiCanvas.board.frames).some((f) => f.status === 'error'), 'an error frame');
  await page.locator('.fr-state[data-kind="error"]').first().waitFor();

  // The sandbox check above provokes the CSP on purpose.
  const real = problems.filter((problem) => !problem.includes('Content Security Policy'));
  assert.deepEqual(real, []);
  console.log('UI canvas browser test passed.');
} catch (error) {
  await page.screenshot({ path: `${shots}failure.png` }).catch(() => {});
  console.error('Problems:', problems);
  throw error;
} finally {
  await browser.close();
  await server.close();
  await rm(directory, { recursive: true, force: true });
}
