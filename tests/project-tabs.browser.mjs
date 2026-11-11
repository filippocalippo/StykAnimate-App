// Project tabs in the real editor (docs/PROJECT-TABS.md): several projects stay open, one is live.
// Needs the development server: node scripts/serve.mjs, then STYK_URL=<its origin> node tests/project-tabs.browser.mjs
import {installProjectSavePicker} from './support/project-save-picker.mjs';
import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';

const out = path.resolve('artifacts/project-tabs'), url = process.env.STYK_URL || 'http://127.0.0.1:47831';
await mkdir(out, {recursive: true});
const browser = await chromium.launch({channel: 'chrome', headless: true});
const page = await browser.newPage({viewport: {width: 1440, height: 900}, acceptDownloads: true});
const errors = [], checks = [];
page.on('pageerror', error => errors.push(error.stack));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
const value = (fn, arg) => page.evaluate(fn, arg);
const check = (name, result = true) => { assert.ok(result, name); checks.push(name); console.log('PASS', name); };
const wait = (ms = 150) => page.waitForTimeout(ms);
const tab = name => page.locator('.project-tab', {has: page.locator('.project-tab-name', {hasText: new RegExp(`^${name}$`)})});
const names = () => value(() => styk.projects.tabs.items.map(item => item.name));
const front = () => value(() => styk.editor.name);
const state = name => tab(name).getAttribute('data-state');
// A project file as the importer hands it over, without the file service.
const open = name => value(async name => {
  const {createDemo} = await import('/src/demo.mjs');
  return styk.acceptImport({document: createDemo(), kind: 'piv'}, name);
}, name);
const edit = (fps = 18) => value(fps => { styk.editor.setFPS(fps); }, fps);
// Recovery copies are written in the background: wait for what is expected, for a bounded time.
const until = async (read, expected, timeout = 15000) => {
  const deadline = Date.now() + timeout;
  for (;;) { const got = await read(); if (got === expected || Date.now() > deadline) return got; await page.waitForTimeout(150); }
};
await installProjectSavePicker(page);
try {
  await page.goto(url); await page.waitForFunction(() => window.styk?.ready, null, {timeout: 120000});

  // ---- the band
  check('The editor starts with one project, in front', (await names()).length === 1 && await page.locator('.project-tab[aria-selected="true"]').count() === 1);
  check('The menus live in the mark\'s menu', !await page.locator('.app-menubar').isVisible());
  await page.locator('.titlebar .brand').click();
  check('The mark lists File, Edit, View, Joint, Animation and Help', await page.locator('#menu [role="menuitem"]').filter({hasText: /^(File|Edit|View|Joint|Animation|Help)$/}).count() === 6);
  await page.keyboard.press('Escape');

  // ---- opening
  check('A project opens in place of the untouched empty animation', await open('First') === true && (await names()).join() === 'First');
  await edit(); await wait(300);
  check('An edit shows the tab\'s dot', await state('First') === 'edited');
  const firstReport = await value(() => { window.__first = styk.editor.report; return styk.editor.report.fps; });
  await value(() => styk.actions['zoom-in']()); await wait();
  const zoomed = await value(() => styk.state.view.scale);
  check('The next project opens beside it', await open('Second') === true && (await names()).join() === 'First,Second' && await front() === 'Second');
  check('The project that left the front keeps its dot', await state('First') === 'edited' && await state('Second') === null);
  check('A new animation is a tab too', (await value(() => styk.actions.new()), (await names()).length === 3));
  await wait(900);
  await page.screenshot({path: path.join(out, 'three-projects.png')});

  // ---- one live project
  check('Only the project in front is in the editor', await value(() => styk.editor.report !== window.__first && styk.projects.tabs.items.filter(item => item.session).length === 2));

  // ---- switching
  await tab('First').click(); await wait(400);
  check('A click brings a project to the front as it was left', await front() === 'First' && await value(fps => styk.editor.report === window.__first && styk.editor.report.fps === fps && styk.editor.dirty && styk.editor.canUndo, firstReport));
  check('Its zoom comes back', Math.abs(await value(() => styk.state.view.scale) - zoomed) < 1e-9);
  await page.locator('#viewport').click({position: {x: 20, y: 20}});
  await page.keyboard.press('Control+z'); await wait(300);
  check('Undo reaches the project\'s own history', await value(() => !styk.editor.dirty && styk.editor.canRedo) && await state('First') === null);
  await page.keyboard.press('Control+Shift+z'); await wait(300);
  check('Redo too', await state('First') === 'edited');
  await tab('Second').click(); await wait(400);
  check('A view left fitted is fitted again', await value(() => { const fitted = styk.state.view; styk.fit(); return Math.abs(fitted.scale - styk.state.view.scale) < 1e-9; }));

  // ---- the clipboard crosses projects
  await value(() => { const editor = styk.editor; editor.select(editor.selectionFrame.objects[0].unique_id); editor.copySelection(); });
  await tab('First').click(); await wait(400);
  const figures = await value(() => styk.editor.selectionFrame.objects.length);
  await value(() => styk.editor.pasteSelection()); await wait();
  check('A figure copied in one project pastes into another', await value(() => styk.editor.selectionFrame.objects.length) === figures + 1);

  // ---- the keyboard
  await tab('First').focus();
  await page.keyboard.press('ArrowRight');
  check('An arrow moves focus without switching', await front() === 'First' && await value(() => document.activeElement?.querySelector('.project-tab-name')?.textContent) === 'Second');
  await page.keyboard.press('Enter'); await wait(400);
  check('Enter brings the focused project forward', await front() === 'Second');

  // ---- closing
  await tab('First').hover();
  await tab('First').locator('.project-tab-close').click(); await wait(400);
  check('Closing a resting project with changes brings it forward and asks', await front() === 'First' && await page.locator('dialog[open] #save-changes').count() === 1);
  await page.locator('#keep-editing').click(); await wait();
  check('Cancel keeps it open', (await names()).length === 3);
  await tab('First').locator('.project-tab-close').click({force: true}); await wait(300);
  await page.locator('#discard-changes').click(); await wait(500);
  check('Don\'t save closes it and the project used before it comes forward', (await names()).join() === 'Second,Untitled animation' && await front() === 'Second');
  await tab('Untitled animation').click({button: 'middle'}); await wait(400);
  check('The middle button closes a project with nothing unsaved', (await names()).join() === 'Second');
  await value(() => styk.actions['close-project']()); await wait(500);
  check('The last project closes into a new, empty one', (await names()).join() === 'Untitled animation' && await value(() => !styk.editor.dirty && !styk.editor.canUndo));

  // ---- saving
  await open('Saved'); await edit(20); await wait(300);
  const download = page.waitForEvent('download');
  await page.locator('.titlebar [data-action="save"]').click();
  await download; await page.waitForFunction(() => !styk.editor.dirty);
  await wait(200);
  check('A save says so on the tab for a moment', await state('Saved') === 'saved');
  await wait(2600);
  check('Then the tab is quiet', await state('Saved') === null);

  // ---- recovery copies, one per project
  await value(() => { styk.state.settings.autosaveSeconds = 0.2; });
  const copies = () => value(async () => (await (await import('/src/browser-recovery.mjs')).listBrowserRecovery()).map(record => record.name).sort().join());
  await edit(21); await wait(100);
  await open('Other'); // "Saved" rests before its own timer ran
  check('A project that rests with unsaved changes gets its recovery copy', await until(copies, 'Saved') === 'Saved');
  await edit(22);
  check('Each project has its own copy', await until(copies, 'Other,Saved') === 'Other,Saved');
  check('The page is not offered its own live copies', await value(async () => (await styk.recovery.list()).length) === 0);
  await tab('Saved').hover(); await tab('Saved').locator('.project-tab-close').click({force: true}); await wait(300);
  await page.locator('#discard-changes').click();
  check('Closing a project removes only its copy', await until(copies, 'Other') === 'Other');
  await value(() => { styk.state.settings.autosaveSeconds = 0; styk.editor.markSaved(); });

  // ---- many projects: the band's other controls never move and nothing overflows
  const place = () => value(() => { const box = document.querySelector('.workspace-switch').getBoundingClientRect(); return `${Math.round(box.left)}:${Math.round(box.width)}:${document.querySelector('.titlebar').dataset.band ?? ''}`; });
  const before = await place();
  for (let index = (await names()).length; index < 12; index++) await open(`Project ${index + 1}`);
  await wait(900);
  check('Twelve projects are open', (await names()).length === 12);
  check('The band\'s other controls did not move and nothing folded', await place() === before);
  check('The tabs fit the band', await value(() => { const band = document.querySelector('.titlebar'), strip = document.getElementById('project-tabs').getBoundingClientRect(), last = [...document.querySelectorAll('.project-tab')].at(-1).getBoundingClientRect(); return band.scrollWidth <= band.clientWidth && last.right <= strip.right + 1; }));
  check('The project in front keeps its name', await value(() => document.querySelector('.project-tab[aria-selected="true"] .project-tab-name').getBoundingClientRect().width > 30));
  await page.screenshot({path: path.join(out, 'twelve-projects.png')});
  check('A thirteenth is refused and says why', await open('One too many') === false && (await names()).length === 12 && await page.locator('#toast').innerText().then(text => /Close a project/.test(text)));

  // ---- Ctrl+Tab
  const previous = await value(() => styk.projects.tabs.recency[1].name);
  await value(() => styk.projectSwitcher.open()); await wait(500);
  check('Ctrl+Tab goes to the project used before this one', await front() === previous);
  await value(() => styk.projectSwitcher.open({ctrlKey: true})); await wait(300);
  check('Held, it shows every open project with its picture', await page.locator('.project-switcher:popover-open .project-switcher-card').count() === 12 && await page.locator('.project-switcher-card canvas').count() >= 10);
  await page.screenshot({path: path.join(out, 'switcher.png')});
  await page.keyboard.press('Tab');
  const chosen = await page.locator('.project-switcher-card[aria-selected="true"] .project-switcher-name').textContent();
  await value(() => window.dispatchEvent(new KeyboardEvent('keyup', {key: 'Control'}))); await wait(500);
  check('Releasing the modifier switches to the chosen project', await front() === chosen && await page.locator('.project-switcher:popover-open').count() === 0);
  await value(() => styk.projectSwitcher.open({ctrlKey: true})); await wait(200);
  const kept = await front();
  await page.keyboard.press('Escape'); await wait(300);
  check('Escape stays', await front() === kept && await page.locator('.project-switcher:popover-open').count() === 0);

  // ---- reordering
  const order = await names();
  await value(() => styk.projects.tabs.move(styk.projects.tabs.items.at(-1).id, 0)); await wait();
  check('A moved tab moves in the band', await page.locator('.project-tab .project-tab-name').first().textContent() === order.at(-1));

  // ---- the mark lists the open projects where the band has no room for them
  await page.locator('.titlebar .brand').click();
  check('The mark\'s menu lists the open projects', await page.locator('#menu [role="menuitem"]', {hasText: 'Open projects'}).count() === 1);
  await page.keyboard.press('Escape');

  assert.deepEqual(errors, []); check('No browser errors');
  await writeFile(path.join(out, 'verification.json'), JSON.stringify({checks, errors, timestamp: new Date().toISOString()}, null, 2));
} catch (error) {
  await page.screenshot({path: path.join(out, 'failure.png')}).catch(() => {});
  await writeFile(path.join(out, 'verification.json'), JSON.stringify({checks, errors, failure: error.stack}, null, 2));
  throw error;
} finally { await browser.close(); }
