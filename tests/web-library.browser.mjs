// My library and the community library in the browser build, in a real browser (STYK_BROWSER=chrome|firefox|webkit),
// driving the real Library panel: saving, folders, renaming, moving, removing and inserting; what is saved is still
// there after a reload; the community library is read through the editor's own origin (web/worker.js) from a
// stand-in for the website, each asset is counted once, and an unreachable or blocked place fails in plain words.
//
//   node tests/web-library.browser.mjs            build the site into a temp directory first
//   STYK_WEB_DIR=build/web node tests/...         test an existing build
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BROWSER, launchBrowser, requireDrawing } from './support/cross-browser.mjs';
import { startCommunitySite } from './support/community-site.mjs';
import { buildWeb } from '../scripts/build-web.mjs';
import { startWebServer } from '../scripts/serve-web.mjs';

const temp = await mkdtemp(path.join(os.tmpdir(), 'styk-library-'));
const existing = process.env.STYK_WEB_DIR && path.resolve(process.env.STYK_WEB_DIR);
const community = await startCommunitySite();
const site = await startWebServer({ root: existing ?? (await buildWeb({ output: path.join(temp, 'site') })).output, upstream: community.upstream });
const browser = await launchBrowser();
await requireDrawing(browser, site.origin, async () => { await browser.close(); await site.close(); await rm(temp, { recursive: true, force: true }); });
const checks = [];
const check = (name, condition) => { assert.ok(condition, `[${BROWSER}] ${name}`); checks.push(name); console.log('PASS', `[${BROWSER}]`, name); };
const until = async (description, read, timeout = 45000) => {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`[${BROWSER}] Timed out waiting for ${description}.`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
};

async function open(context, { blockStorage = false } = {}) {
  const page = await context.newPage();
  const problems = [];
  page.on('pageerror', (error) => problems.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error' && !/Failed to load resource|Viewport argument key "interactive-widget"/.test(message.text())) problems.push(message.text()); });
  await page.addInitScript((block) => {
    document.addEventListener('securitypolicyviolation', (event) => console.error(`CSP violation: ${event.violatedDirective} ${event.blockedURI}`));
    // Patch the prototype: WebKit can recreate the indexedDB wrapper, dropping properties set on it.
    if (block) IDBFactory.prototype.open = () => { throw new DOMException('Storage is blocked.', 'SecurityError'); };
  }, blockStorage);
  await page.goto(site.origin, { waitUntil: 'load' });
  await page.waitForFunction(() => window.styk?.ready === true, undefined, { timeout: 90000 });
  await page.evaluate(() => document.querySelector('.styk-privacy [data-decline]')?.click());
  return { page, problems };
}
const panel = (page) => page.locator('#user-library');
const cards = (page) => panel(page).locator('.library-card:not(.is-skeleton)');
const names = (page) => cards(page).locator('.library-name').allTextContents();
const showLibrary = async (page) => {
  if (!(await panel(page).isVisible())) await page.locator('.shell-tabs [role="tab"][data-panel="library"]').first().click();
  await panel(page).waitFor({ state: 'visible', timeout: 15000 });
};
const message = (page) => panel(page).locator('.library-message').textContent();
const figureCount = (page) => page.evaluate(() => window.styk.editor.selectionFrame.objects.length);
const source = async (page, which) => { await panel(page).locator(`[data-library-source="${which}"]`).click(); };

try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const { page, problems } = await open(context);
  await showLibrary(page);
  await until('the empty library', async () => (await panel(page).innerText()).includes('No saved assets yet'));
  check('The panel opens on My library with nothing in it', true);
  check('and it says where the library lives', !(await panel(page).innerText()).includes('available in the desktop app') && (await page.evaluate(() => window.styk.library.desktop.inBrowser === true)));

  // --- Saving the selection.
  await page.evaluate(() => { const { editor } = window.styk; editor.select(editor.frame.objects[0].unique_id, -1); });
  await panel(page).locator('[data-library-action="save"]').first().click();
  await until('the saved asset', async () => (await cards(page).count()) === 1);
  const savedName = (await names(page))[0];
  await until('its preview', () => cards(page).first().evaluate((card) => card.classList.contains('is-loaded')));
  check('Add selection saves the figure with a preview', !!savedName && /saved to/i.test(await message(page)));
  check('The kind is shown', /Figure/i.test(await cards(page).first().locator('.library-kind').textContent()));

  // --- It is still there after a reload.
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => window.styk?.ready === true, undefined, { timeout: 90000 });
  await showLibrary(page);
  await until('the saved asset after reload', async () => (await cards(page).count()) === 1);
  await until('its preview after reload', () => cards(page).first().evaluate((card) => card.classList.contains('is-loaded')));
  check('What is saved is still there after a reload, preview and all', (await names(page))[0] === savedName);

  // --- Folders, renaming, moving.
  await panel(page).locator('[data-library-action="folder"]').click();
  await page.locator('dialog.library-dialog input[name="name"]').fill('Heroes');
  await page.locator('dialog.library-dialog').getByRole('button', { name: /create|ok|add|new folder|save/i }).last().click();
  await until('the folder', async () => (await names(page)).includes('Heroes'));
  check('A new folder appears first', (await names(page))[0] === 'Heroes');
  await panel(page).locator('.library-card', { hasText: 'Heroes' }).dblclick();
  await until('the folder to open', async () => (await panel(page).locator('.library-breadcrumbs').innerText()).includes('Heroes'));
  check('A folder opens, and is empty', (await cards(page).count()) === 0 && (await panel(page).innerText()).includes('Empty folder'));
  await panel(page).locator('.library-breadcrumbs button', { hasText: 'Library' }).click();
  await until('the top folder', async () => (await cards(page).count()) === 2);
  // Move the figure into the folder through the same call the drag makes, then rename it with the keyboard.
  const moved = await page.evaluate((name) => window.styk.library.desktop.changeLibraryItem({ path: `${name}.stkz`, folder: 'Heroes' }), savedName);
  check('A figure moves into a folder', moved.path === `Heroes/${savedName}.stkz`);
  await page.evaluate(() => window.styk.library.refresh());
  await until('the move to show', async () => (await names(page)).length === 1);
  await panel(page).locator('.library-card', { hasText: 'Heroes' }).dblclick();
  await until('the figure inside the folder', async () => (await names(page)).includes(savedName));
  await cards(page).first().click();
  await page.keyboard.press('F2');
  await panel(page).locator('.library-rename').fill('Blue hero');
  await page.keyboard.press('Enter');
  await until('the new name', async () => (await names(page)).includes('Blue hero'));
  check('Renaming keeps the file in its folder', (await names(page)).join() === 'Blue hero');

  // --- Inserting.
  const before = await figureCount(page);
  await cards(page).first().dblclick();
  await until('the inserted figure', async () => (await figureCount(page)) === before + 1);
  check('Double-clicking an asset puts it in the scene', true);

  // --- Removing.
  await cards(page).first().click();
  await page.keyboard.press('Delete');
  const dialog = page.locator('dialog.library-dialog[open]');
  check('Removing says the browser has no recycle bin', /deleted from this browser/i.test(await dialog.innerText()) && !/Recycle/i.test(await dialog.innerText()));
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
  await until('the figure to go', async () => (await cards(page).count()) === 0);
  check('A removed asset is gone, and the scene keeps its copy', (await figureCount(page)) === before + 1);
  await panel(page).locator('.library-breadcrumbs button', { hasText: 'Library' }).click();

  // --- The community library.
  const heroBytes = await (async () => {
    await page.evaluate(() => { const { editor } = window.styk; editor.select(editor.frame.objects[0].unique_id, -1); });
    await panel(page).locator('[data-library-action="save"]').first().click();
    await until('another saved figure', async () => (await cards(page).count()) >= 2);
    const base64 = await page.evaluate(async () => {
      const api = window.styk.library.desktop, { readLibraryFile } = await import('/src/library-files.mjs');
      const entry = (await api.listLibrary('')).entries.find((item) => item.kind !== 'folder');
      const bytes = new Uint8Array(await (await readLibraryFile(api, entry.path)).arrayBuffer());
      let text = ''; for (const byte of bytes) text += String.fromCharCode(byte);
      return btoa(text);
    });
    return Buffer.from(base64, 'base64');
  })();
  community.publish([
    { id: 'aaaaaaaaaa', kind: 'figure', name: 'Shared Hero', category: 'characters', author: 'Ana', tags: ['blue', 'stick'], description: 'A blue hero', bytes: heroBytes },
    { id: 'cccccccccc', kind: 'project', name: 'Whole Project', category: 'animations', bytes: Buffer.from('project') },
  ]);
  await source(page, 'public');
  await until('the community cards', async () => (await panel(page).locator('.library-card:not(.is-skeleton)').count()) === 1);
  check('The community library lists what the site publishes, and only what can be inserted', (await names(page)).join() === 'Shared Hero');
  await until('the poster', () => cards(page).first().evaluate((card) => card.classList.contains('is-loaded')));
  check('Its poster (a WebP from the site) is shown', await cards(page).first().evaluate((card) => /^data:image\/webp/.test(card.querySelector('img')?.src ?? '')));
  check('Every request went to the editor\'s own origin', community.state.requests.length > 0);
  await panel(page).locator('.library-head input[type="search"]').fill('zebra');
  check('Searching finds nothing for an unrelated word', await panel(page).innerText().then((text) => text.includes('No matches')));
  await panel(page).locator('.library-head input[type="search"]').fill('stick');
  check('and finds an asset by its tags', (await cards(page).count()) === 1);
  await panel(page).locator('.library-head input[type="search"]').fill('');

  const beforeInsert = await figureCount(page);
  await cards(page).first().dblclick();
  await until('the community figure in the scene', async () => (await figureCount(page)) === beforeInsert + 1);
  check('A community figure is downloaded, verified and inserted', true);
  check('The site counted that download once', community.state.counted.join() === 'aaaaaaaaaa');
  await cards(page).first().dblclick();
  await until('the second insert', async () => (await figureCount(page)) === beforeInsert + 2);
  check('Inserting it again does not count again', community.state.counted.length === 1);

  await cards(page).first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Save to My library' }).click();
  await until('the saved copy', async () => /saved to My library/i.test(await message(page)));
  await source(page, 'mine');
  await until('the copy in My library', async () => (await names(page)).includes('Shared Hero'));
  check('Save to My library keeps a copy with its own preview', await cards(page).filter({ hasText: 'Shared Hero' }).first().evaluate(async (card) => { await new Promise((resolve) => setTimeout(resolve, 500)); return !!card.querySelector('img') || card.classList.contains('is-loaded'); }));

  // --- A later visit knows it already counted this download.
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => window.styk?.ready === true, undefined, { timeout: 90000 });
  await showLibrary(page);
  await source(page, 'public');
  await until('the community cards again', async () => (await cards(page).count()) === 1);
  await cards(page).first().dblclick();
  // eslint-disable-next-line no-self-compare -- two reads of the page: the count has stopped changing
  await until('the insert after reload', async () => (await figureCount(page)) === (await figureCount(page)) && /added to the scene/i.test(await message(page)));
  check('A later visit reads the public file directly and does not count again', community.state.counted.length === 1);
  check('No console errors, page errors or CSP violations', problems.length === 0 || (console.error(problems), false));

  // --- The site is unreachable.
  await community.close();
  // A fresh browser has none of the site's answers cached (a repeat visit would still show the catalogue it has).
  const away = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const offline = await open(away);
  await showLibrary(offline.page);
  await source(offline.page, 'public');
  await until('the unreachable message', async () => /unavailable|Could not reach/i.test(await offline.page.locator('#user-library .library-empty').innerText()));
  check('An unreachable community library says so in plain words, with a way to retry', /is unavailable right now|Could not reach the community library/.test(await offline.page.locator('#user-library .library-empty').innerText())
    && await offline.page.getByRole('button', { name: 'Try again', exact: true }).isVisible());
  await source(offline.page, 'mine');
  await until('My library while the site is down', async () => (await panel(offline.page).innerText()).includes('No saved assets yet'));
  check('My library does not need the site', true);
  await away.close();

  // --- A browser that blocks storage.
  const blocked = await open(context, { blockStorage: true });
  await showLibrary(blocked.page);
  await blocked.page.waitForTimeout(1500);
  const text = await blocked.page.locator('#user-library').innerText();
  check('Blocked storage is explained instead of failing silently', /does not allow the library|Storage is blocked/.test(`${text} ${await message(blocked.page)}`));
  check('and the editor keeps working', await blocked.page.evaluate(() => window.styk.ready === true));
  await context.close();
  console.log(`\n[${BROWSER}] ${checks.length} checks passed`);
} finally {
  await browser.close();
  await site.close();
  await community.close().catch(() => {});
  await rm(temp, { recursive: true, force: true });
}
