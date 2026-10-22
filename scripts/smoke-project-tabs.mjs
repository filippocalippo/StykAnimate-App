// Project tabs in the desktop app (docs/PROJECT-TABS.md): each open project saves to its own file, closing the
// window asks once for every unsaved project, and each project's recovery copy is its own, across a restart.
//   node scripts/smoke-project-tabs.mjs
import {_electron as electron, closeStartupPrompts} from '../tests/support/playwright.mjs';
import {mkdir, readFile, readdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const run = path.join(appRoot, 'artifacts', `project-tabs-desktop-${Date.now()}`), profile = path.join(run, 'profile');
await mkdir(run, {recursive: true});
await mkdir(profile, {recursive: true});
// The privacy choice is made, so no first-run prompt covers the editor.
await writeFile(path.join(profile, 'telemetry-state.json'), JSON.stringify({decided: true, consent: {analytics: false, diagnostics: false, policyVersion: '2026-09-10', updatedAt: Date.now()}}));
const launch = () => electron.launch({args: [appRoot], cwd: appRoot, timeout: 60000,
  env: {...process.env, STYK_USER_DATA_DIR: profile, STYK_STARTUP_VIEW: 'editor'}});
const checks = [], check = (name, value) => { assert.ok(value, name); checks.push(name); console.log('PASS', name); };
const ready = page => page.waitForFunction(() => window.styk?.ready, null, {timeout: 60000});
let app;
try {
  app = await launch();
  let page = await app.firstWindow(); await ready(page); await closeStartupPrompts(page);
  await app.evaluate(({dialog}) => {
    globalThis.__saveTo = [];
    globalThis.__messages = [];
    dialog.showSaveDialog = async () => ({canceled: false, filePath: globalThis.__saveTo.shift()});
    // The question asked as the window closes: recorded, and answered Cancel.
    dialog.showMessageBox = async (_window, options) => { globalThis.__messages.push({message: options.message, buttons: options.buttons}); return {response: 1}; };
  });
  const target = name => path.join(run, `${name}.styk`);

  // ---- two projects, each saved to its own file
  await page.evaluate(() => { styk.editor.setFPS(18); });
  await app.evaluate((_electron, file) => { globalThis.__saveTo.push(file); }, target('First'));
  check('The first project saves', await page.evaluate(() => styk.actions.save()) === true);
  await page.evaluate(() => styk.actions.new());
  await page.evaluate(() => { styk.editor.setFPS(30); });
  await app.evaluate((_electron, file) => { globalThis.__saveTo.push(file); }, target('Second'));
  check('A second project saves to a file of its own', await page.evaluate(() => styk.actions.save()) === true);
  const firstBytes = await readFile(target('First')), secondBytes = await readFile(target('Second'));
  check('Both files exist and differ', firstBytes.length > 100 && secondBytes.length > 100 && !firstBytes.equals(secondBytes));

  // Back to the first: its next Save writes its own file, without a dialog.
  await page.evaluate(() => styk.projects.activate(styk.projects.tabs.items[0].id));
  await page.evaluate(() => { styk.editor.setFPS(20); });
  check('Saving the first project again needs no dialog', await page.evaluate(() => styk.actions.save()) === true && await app.evaluate(() => globalThis.__saveTo.length) === 0);
  check('It wrote its own file and left the other alone', !(await readFile(target('First'))).equals(firstBytes) && (await readFile(target('Second'))).equals(secondBytes));

  // ---- closing the window asks once for every unsaved project
  await page.evaluate(() => { styk.editor.setFPS(21); });
  await page.evaluate(() => styk.projects.activate(styk.projects.tabs.items[1].id));
  await page.evaluate(() => { styk.editor.setFPS(31); });
  await page.waitForTimeout(400);
  await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].close());
  await page.waitForTimeout(600);
  const asked = await app.evaluate(() => globalThis.__messages.at(-1));
  check('Closing the window names every unsaved project at once', /2 projects/.test(asked?.message ?? '') && asked.buttons.join() === 'Save all,Cancel,Discard all');
  check('Cancel keeps the window and both projects', await page.evaluate(() => styk.projects.tabs.size === 2 && styk.projects.summary().unsaved === 2));

  // ---- each unsaved project has its own recovery copy
  await page.evaluate(() => { styk.state.settings.autosaveSeconds = 0.2; styk.editor.setFPS(32); });
  const copies = () => readdir(profile).then(names => names.filter(name => /^recovery-.+\.styk$/.test(name)));
  for (let attempt = 0; attempt < 60 && (await copies()).length < 2; attempt++) {
    if (attempt === 10) await page.evaluate(() => styk.projects.activate(styk.projects.tabs.items[0].id));
    await page.waitForTimeout(250);
  }
  check('Each unsaved project writes its own recovery copy', (await copies()).length === 2);

  // ---- a crash: the next start offers both copies, and each restores into a tab of its own
  await app.evaluate(({app}) => app.exit(0)); app = null;
  app = await launch();
  page = await app.firstWindow(); await ready(page); await closeStartupPrompts(page);
  const offered = await page.waitForFunction(async () => (await stykDesktop.listRecoveries()).length, null, {timeout: 20000}).then(handle => handle.jsonValue());
  check('The next start offers every project\'s copy', offered === 2);
  await page.locator('#manage-recovery').click();
  const chooser = page.locator('dialog[open]', {has: page.locator('select')});
  await chooser.waitFor();
  // The message with its own Restore stays above the dialog, inside it: the dialog's is in its foot.
  await chooser.locator('.ui-dialog-foot').getByRole('button', {name: 'Restore', exact: true}).click();
  await page.waitForFunction(() => styk.editor.dirty && styk.projects.tabs.size >= 1, null, {timeout: 30000});
  await page.waitForTimeout(800);
  check('A restored copy opens as an unsaved project and is no longer offered', await page.evaluate(async () => (await stykDesktop.listRecoveries()).length) === 1);
  await writeFile(path.join(run, 'report.json'), JSON.stringify({checks, at: new Date().toISOString()}, null, 2));
  console.log(`${checks.length} checks passed`);
} finally {
  await app?.evaluate(({app}) => app.exit(0)).catch(() => {});
}
