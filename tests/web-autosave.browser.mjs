// Autosave in the browser build, in a real browser (STYK_BROWSER=chrome|firefox|webkit): the last unsaved work
// is kept a moment after each edit, offered again after a reload, replaced by a save, written the instant the tab
// is hidden, and a browser that blocks storage neither breaks the editor nor floods it with messages.
//
//   node tests/web-autosave.browser.mjs            build the site into a temp directory first
//   STYK_WEB_DIR=build/web node tests/...          test an existing build
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BROWSER, launchBrowser } from './support/cross-browser.mjs';
import { buildWeb } from '../scripts/build-web.mjs';
import { startWebServer } from '../scripts/serve-web.mjs';

const temp = await mkdtemp(path.join(os.tmpdir(), 'styk-autosave-'));
const existing = process.env.STYK_WEB_DIR && path.resolve(process.env.STYK_WEB_DIR);
const site = await startWebServer({ root: existing ?? (await buildWeb({ output: path.join(temp, 'site') })).output });
const browser = await launchBrowser();
const checks = [];
const check = (name, condition) => { assert.ok(condition, `[${BROWSER}] ${name}`); checks.push(name); console.log('PASS', `[${BROWSER}]`, name); };
const until = async (description, read, timeout = 45000) => {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}.`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
};

async function open(context, { blocked = false } = {}) {
  const page = await context.newPage();
  const problems = [];
  page.on('pageerror', (error) => problems.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error' && !/Failed to load resource|Viewport argument key "interactive-widget"/.test(message.text())) problems.push(message.text()); });
  // Patch the prototype: WebKit can recreate the indexedDB wrapper, dropping properties set on it.
  if (blocked) await page.addInitScript(() => { IDBFactory.prototype.open = () => { throw new DOMException('Storage is blocked.', 'SecurityError'); }; });
  await page.goto(site.origin, { waitUntil: 'load' });
  await page.waitForFunction(() => window.styk?.ready === true, undefined, { timeout: 90000 });
  await page.evaluate(() => document.querySelector('.styk-privacy [data-decline]')?.click());
  return { page, problems };
}
const recovery = (page) => page.evaluate(async () => {
  const record = await (await import('/src/browser-recovery.mjs')).readBrowserRecovery();
  return record && { name: record.name, size: record.blob.size, savedAt: record.savedAt };
});
/** Moves the figure with the mouse, like a person, so the project becomes unsaved. */
async function dragFigure(page, dx = 90) {
  const at = await page.evaluate(async () => {
    const { worldToScreen } = await import('/src/renderer-geometry.mjs');
    const { editor, state } = window.styk, rect = document.getElementById('overlay').getBoundingClientRect();
    editor.select(editor.frame.objects[0].unique_id, -1);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const point = worldToScreen(editor.geometry.objects.get(editor.selectedSlot).root, { report: editor.report, frame: editor.frame, view: state.view, cameraEnabled: false });
    return { x: rect.left + point.x, y: rect.top + point.y };
  });
  await page.mouse.move(at.x, at.y); await page.mouse.down();
  for (let step = 1; step <= 12; step++) await page.mouse.move(at.x + step * dx / 12, at.y);
  await page.mouse.up();
  await page.waitForFunction(() => window.styk.editor.dirty === true);
  return page.evaluate(() => window.styk.editor.object.root_x);
}

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });

  // --- The last work survives a reload.
  const first = await open(context);
  check('Nothing is offered on a first visit', !(await recovery(first.page)) && !(await first.page.getByText('Restore unsaved work', { exact: true }).isVisible()));
  const moved = await dragFigure(first.page);
  const written = await until('the recovery copy to be written', () => recovery(first.page));
  check('A moment after an edit the work is copied into the browser', written.size > 100 && Math.abs(written.savedAt - Date.now()) < 30000);
  await first.page.reload({ waitUntil: 'load' });
  await first.page.waitForFunction(() => window.styk?.ready === true, undefined, { timeout: 90000 });
  await first.page.evaluate(() => document.querySelector('.styk-privacy [data-decline]')?.click());
  const offer = first.page.getByText('Restore unsaved work', { exact: true });
  await until('the restore offer', () => offer.isVisible());
  check('After a reload the work is offered back, with when it was kept', /from \d/.test(await first.page.locator('body').innerText()));
  await first.page.getByRole('button', { name: 'Restore', exact: true }).click();
  await first.page.waitForFunction((x) => Math.abs(window.styk.editor.object.root_x - x) < 0.01, moved, { timeout: 60000 });
  check('Restoring brings the project back exactly as it was left', await first.page.evaluate(() => window.styk.editor.dirty === true));

  // --- Saving replaces the copy, so it is not offered again.
  // A picker destination acknowledges close; a download cannot acknowledge saving.
  await first.page.evaluate(() => {
    window.showSaveFilePicker = async () => ({createWritable:async()=>({write:async()=>{},close:async()=>{},abort:async()=>{}})});
    const save = styk.actions.save;
    styk.actions.save = () => window.__saved = save();
  });
  await first.page.locator('[data-action="save"]').first().click();
  assert.equal(await first.page.evaluate(() => window.__saved), true);
  await until('the recovery copy to be cleared by the save', async () => !(await recovery(first.page)));
  check('A saved project leaves no recovery copy behind', true);
  await first.page.reload({ waitUntil: 'load' });
  await first.page.waitForFunction(() => window.styk?.ready === true, undefined, { timeout: 90000 });
  await first.page.waitForTimeout(1500);
  check('and nothing is offered after the next reload', !(await first.page.getByText('Restore unsaved work', { exact: true }).isVisible()));

  // --- Hiding the tab writes the copy at once, whatever the timer says.
  await first.page.evaluate(() => window.styk.settingsUI.commit({ autosaveSeconds: 300 }));
  await dragFigure(first.page, 40);
  await first.page.waitForTimeout(2500);
  check('With a long autosave interval nothing is written yet', !(await recovery(first.page)));
  await first.page.evaluate(() => { styk.state.loop = true; styk.actions.play(); });
  await first.page.waitForFunction(() => styk.state.playing);
  await first.page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  check('Hiding the tab writes the copy immediately', !!(await until('the copy written on hide', () => recovery(first.page), 15000)));
  check('Hiding during playback pauses transport before the recovery write', await first.page.evaluate(() => !styk.state.playing));
  await first.page.close();

  // --- A browser that blocks storage: the editor works, and says so once.
  const blocked = await open(context, { blocked: true });
  // The interval set above is a saved setting; put the default back for this page.
  await blocked.page.evaluate(() => window.styk.settingsUI.commit({ autosaveSeconds: 2.5 }));
  // Count the messages as they appear: a message fades after a few seconds.
  await blocked.page.evaluate(() => {
    window.__warnings = new Set();
    new MutationObserver(() => { for (const toast of document.querySelectorAll('.ui-toast')) if (toast.textContent.includes('Recovery copy could not be written')) window.__warnings.add(toast); })
      .observe(document.body, { childList: true, subtree: true, characterData: true });
  });
  await dragFigure(blocked.page, 40);
  await until('the one warning', () => blocked.page.evaluate(() => window.__warnings.size >= 1), 30000);
  // Keep editing: every autosave fails, and none of them may say so again.
  for (const dx of [-40, 30, -20]) { await dragFigure(blocked.page, dx); await blocked.page.waitForTimeout(4500); }
  const said = await blocked.page.evaluate(() => window.__warnings.size);
  check('Blocked storage does not stop editing', await blocked.page.evaluate(() => window.styk.editor.dirty === true));
  assert.equal(said, 1, `[${BROWSER}] the failure is reported once, not on every edit (saw ${said})`); check('and the failure is reported once, not on every edit', true);
  check('and nothing throws', blocked.problems.length === 0 || (console.error(blocked.problems), false));
  await context.close();
  console.log(`\n[${BROWSER}] ${checks.length} checks passed`);
} finally {
  await browser.close();
  await site.close();
  await rm(temp, { recursive: true, force: true });
}
