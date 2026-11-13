// Home in the desktop app (docs/HOME.md), with the real project list: saving lists a project with its picture,
// a listed project that is open comes to the front, a closed one opens, pins, folders, search, the list layout,
// a file that moved, and the startup choice across launches.
import { _electron as electron } from '../tests/support/playwright.mjs';
import { mkdir, rename, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runDirectory = path.join(appRoot, 'artifacts', `home-${Date.now()}`);
const profile = path.join(runDirectory, 'profile');
await mkdir(runDirectory, { recursive: true });
const files = { a: path.join(runDirectory, 'Rooftop.styk'), b: path.join(runDirectory, 'Vertical loop.styk'), moved: path.join(runDirectory, 'Rooftop (moved).styk') };
const launch = (startupView, args = []) => electron.launch({ args: [appRoot, ...args], cwd: appRoot, timeout: 45000,
  env: { ...process.env, STYK_USER_DATA_DIR: profile, STYK_STARTUP_VIEW: startupView } });
const checks = [];
let app;

async function ready() {
  const page = await app.firstWindow();
  page.on('pageerror', (error) => { throw new Error(`Renderer error: ${error.message}`); });
  page.on('console', (message) => { if (message.type() === 'error') console.error('renderer:', message.text()); });
  await page.waitForFunction(() => window.styk?.ready, undefined, { timeout: 30000 });
  // A fresh profile shows What's new over Home.
  for (let quiet = 0, round = 0; quiet < 3 && round < 40; round++) {
    await page.waitForTimeout(400);
    if (await page.evaluate(() => Boolean(document.querySelector('dialog[open]')))) { await page.keyboard.press('Escape'); quiet = 0; }
    else quiet++;
  }
  await app.evaluate(({ dialog }) => {
    globalThis.__saveChoices = [];
    dialog.showSaveDialog = async () => {
      const choice = globalThis.__saveChoices.shift();
      if (choice === undefined) throw new Error('An unexpected Save dialog appeared.');
      return choice ? { canceled: false, filePath: choice } : { canceled: true };
    };
  });
  return page;
}
/** Some work on the animation in front, and its name (a blank animation nobody touched gives its tab to the next one). */
const edit = (page, name) => page.evaluate((name) => {
  const editor = window.styk.editor;
  editor.select(editor.frame.objects[0].unique_id); editor.moveSelection(24, 0);
  editor.name = name;
}, name);
const saveAs = async (page, file) => {
  await app.evaluate((_electron, choice) => { globalThis.__saveChoices.push(choice); }, file);
  assert.equal(await page.evaluate(() => window.styk.actions.save()), true);
  await access(file);
};
const cards = (page) => page.evaluate(() => [...document.querySelectorAll('.home-project')].map((card) => ({
  id: card.dataset.id, name: card.querySelector('.home-project-name').textContent, state: card.dataset.state ?? '',
  pinned: Boolean(card.querySelector('.home-project-pin')), picture: Boolean(card.querySelector('.home-project-image:not([hidden])')),
})));
const showHome = async (page) => {
  await page.evaluate(() => { if (!window.styk.home.shown) window.styk.actions.home(); });
  await page.waitForFunction(() => window.styk.home.shown && !window.styk.home.model.loading);
};
const menuRow = (page, text) => page.locator('.ui-menu-item:visible', { hasText: text }).first();

try {
  // ---- First launch: Home, empty -----------------------------------------------------------------------------------
  app = await launch('home');
  let page = await ready();
  await page.waitForFunction(() => window.styk.home.shown && document.querySelector('.home-projects .ui-empty-title'));
  assert.equal(await page.locator('.home-title').textContent(), 'Welcome to StykAnimate');
  assert.equal(await page.locator('.home-lesson-start').count(), 1);
  assert.equal(await page.locator('.home-lesson-row').count(), 4);
  // Home owns the keyboard: the Hand tool's key does nothing, Escape goes back to the animation.
  await page.keyboard.press('h');
  assert.equal(await page.evaluate(() => window.styk.state.tool), 'select');
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => window.styk.home.shown), false);
  checks.push('The first launch opens on Home with an empty project list and the five tutorials; Escape returns to the animation.');

  // ---- Saving lists a project, with its picture ---------------------------------------------------------------------
  await edit(page, 'Rooftop');
  await saveAs(page, files.a);
  await page.waitForTimeout(3200);
  await showHome(page);
  let listed = await cards(page);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].name, 'Rooftop');
  assert.equal(listed[0].state, 'open');
  await page.waitForFunction(() => document.querySelector('.home-project-image:not([hidden])'), undefined, { timeout: 8000 });
  checks.push('A saved animation is listed on Home, marked open, with the picture of its stage.');

  // ---- A new vertical animation from Start, saved beside the first ---------------------------------------------------
  await page.click('[data-home="new"][data-canvas="portrait"]');
  await page.waitForFunction(() => !window.styk.home.shown && window.styk.projects.tabs.size === 2, undefined, { timeout: 10000 })
    .catch(async (error) => { console.error(await page.evaluate(() => ({ shown: window.styk.home.shown, tabs: window.styk.projects.tabs.size, name: window.styk.editor.name, toast: document.querySelector('#toast')?.textContent }))); throw error; });
  assert.deepEqual(await page.evaluate(() => [window.styk.editor.report.canvas_width, window.styk.editor.report.canvas_height]), [540, 960]);
  await edit(page, 'Vertical loop');
  await saveAs(page, files.b);
  await showHome(page);
  listed = await cards(page);
  assert.deepEqual(listed.map((card) => [card.name, card.state]), [['Vertical loop', 'open'], ['Rooftop', 'open']]);
  checks.push('Start › Vertical opens a 540 × 960 animation beside the open one.');

  // ---- An open project comes to the front; a closed one opens -------------------------------------------------------
  const rooftop = listed.find((card) => card.name === 'Rooftop');
  await page.click(`.home-project[data-id="${rooftop.id}"] .home-project-open`);
  await page.waitForFunction(() => !window.styk.home.shown && window.styk.editor.name === 'Rooftop', undefined, { timeout: 10000 })
    .catch(async (error) => { console.error(await page.evaluate(() => ({ shown: window.styk.home.shown, tabs: window.styk.projects.tabs.items.map((item) => [item.name, item.state?.documentToken ?? null]), token: window.styk.state.documentToken, name: window.styk.editor.name, toast: document.querySelector('#toast')?.textContent, model: window.styk.home.model.projects.map((p) => [p.name, p.open, p.documentToken]) }))); throw error; });
  assert.equal(await page.evaluate(() => window.styk.projects.tabs.size), 2);
  const verticalTab = await page.evaluate(() => window.styk.projects.tabs.items.find((item) => item.name === 'Vertical loop').id);
  assert.equal(await page.evaluate((id) => window.styk.projects.close(id), verticalTab), true);
  await showHome(page);
  const vertical = (await cards(page)).find((card) => card.name === 'Vertical loop');
  assert.equal(vertical.state, '');
  await page.click(`.home-project[data-id="${vertical.id}"] .home-project-open`);
  await page.waitForFunction(() => !window.styk.home.shown && window.styk.editor.name === 'Vertical loop' && window.styk.projects.tabs.size === 2);
  checks.push('An open project comes to the front from Home without loading again; a closed one opens in a tab.');

  // ---- Pins, folders, search and the list layout ---------------------------------------------------------------------
  await showHome(page);
  await page.click(`.home-project[data-id="${rooftop.id}"] .home-project-more`);
  await menuRow(page, 'Pin to the top').click();
  await page.waitForFunction((id) => document.querySelector('.home-project')?.dataset.id === id && document.querySelector('.home-project-pin'), rooftop.id);
  assert.equal(await page.locator('.home-scope', { hasText: 'Pinned' }).count(), 1);
  await page.click('.home-scope-new');
  await page.locator('dialog[open] input').fill('Fights');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('.home-scope[data-folder="Fights"][aria-pressed="true"]'));
  assert.equal(await page.locator('.home-list .ui-empty-title').textContent(), 'Nothing here yet');
  await page.click('.home-scope[data-kind="all"]');
  await page.click(`.home-project[data-id="${vertical.id}"] .home-project-more`);
  await menuRow(page, 'Move to folder').click();
  await menuRow(page, 'Fights').click();
  await page.waitForFunction((id) => window.styk.home.model.projects.find((item) => item.id === id)?.folder === 'Fights', vertical.id);
  await page.click('.home-scope[data-folder="Fights"]');
  assert.deepEqual((await cards(page)).map((card) => card.name), ['Vertical loop']);
  await page.click('.home-scope[data-kind="all"]');
  await page.fill('.home-search input', 'roof');
  assert.deepEqual((await cards(page)).map((card) => card.name), ['Rooftop']);
  await page.fill('.home-search input', 'nothing like this');
  assert.match(await page.locator('.home-list .ui-empty-title').textContent(), /Nothing matches/);
  await page.fill('.home-search input', '');
  await page.click('.home-layout [data-layout="list"]');
  await page.waitForFunction(() => document.querySelector('.home-list[data-layout="list"] .home-list-head'));
  assert.equal(await page.evaluate(() => window.styk.state.settings.homeLayout), 'list');
  checks.push('Pins lead the list, a folder gathers projects, search narrows them and the list layout is remembered.');

  // ---- A file that moved ---------------------------------------------------------------------------------------------
  await page.evaluate(() => window.styk.actions.home());
  const rooftopTab = await page.evaluate(() => window.styk.projects.tabs.items.find((item) => item.name === 'Rooftop').id);
  assert.equal(await page.evaluate((id) => window.styk.projects.close(id), rooftopTab), true);
  await rename(files.a, files.moved);
  await showHome(page);
  assert.equal((await cards(page)).find((card) => card.id === rooftop.id).state, 'missing');
  await page.click(`.home-project[data-id="${rooftop.id}"] .home-project-open`);
  await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('was moved or deleted'));
  assert.equal(await page.evaluate(() => window.styk.home.shown), true);
  await page.click(`.home-project[data-id="${rooftop.id}"] .home-project-more`);
  await menuRow(page, 'Remove from list').click();
  await page.waitForFunction((id) => !document.querySelector(`.home-project[data-id="${id}"]`), rooftop.id);
  await access(files.moved);
  checks.push('A moved file says so and can be removed from the list; the file itself is untouched.');
  await app.close();

  // ---- The list and the arrangement last; Home can be turned off ------------------------------------------------------
  app = await launch('');
  page = await ready();
  await page.waitForFunction(() => window.styk.home.shown && !window.styk.home.model.loading);
  listed = await cards(page);
  assert.deepEqual(listed.map((card) => card.name), ['Vertical loop']);
  assert.equal(await page.locator('.home-scope[data-folder="Fights"]').count(), 1);
  await page.evaluate(async () => { window.styk.settingsUI.commit({ showHomeOnStartup: false }); await window.styk.settingsUI.flush(); });
  await app.close();
  app = await launch('');
  page = await ready();
  assert.equal(await page.evaluate(() => window.styk.home.shown), false);
  await page.evaluate(async () => { window.styk.settingsUI.commit({ showHomeOnStartup: true }); await window.styk.settingsUI.flush(); });
  await app.close();
  checks.push('Projects, folders and the layout last across launches, and Settings › Show Home when the app starts is honoured.');

  // ---- Opening a file at launch goes straight to it -----------------------------------------------------------------
  app = await launch('', [files.b]);
  page = await ready();
  await page.waitForFunction(() => window.styk.editor.name === 'Vertical loop', undefined, { timeout: 30000 });
  assert.equal(await page.evaluate(() => window.styk.home.shown), false);
  checks.push('A file opened with the app goes straight to the editor.');
  await app.close();
  app = null;
  console.log(checks.map((check) => `✓ ${check}`).join('\n'));
} finally {
  await app?.close().catch(() => {});
}
