// The update and release-notes flow of the desktop app, end to end through the bridge and the native updater:
// the welcome splash (once per process), the donation links, progress and Restart to update, Cancel and Save before
// restarting, and what a copy that cannot update says.
//
//   node scripts/smoke-updates.mjs          the development build (or STYK_TAURI_EXECUTABLE / STYK_PACKAGED_EXECUTABLE)
//
// The feed, the installer, the dialogs and the browser are the test hooks' stand-ins
// (engine/crates/styk-desktop/src/shell/test_hooks.rs): `update.json` offers a version and "downloads" it, Restart
// records `update-install` instead of running an installer, and opened links are recorded instead of opened.
import { tauri, tauriExecutable } from '../tests/support/tauri-app.mjs';
import { openAppMenu } from '../tests/support/app-menu.mjs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';
const root = process.cwd();
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const executablePath = process.env.STYK_PACKAGED_EXECUTABLE || tauriExecutable();
const output = path.join(root, 'artifacts', 'updates');
await mkdir(output, { recursive: true });
const profile = path.join(output, `profile-${Date.now()}`);
const hooks = path.join(output, `hooks-${Date.now()}`);
await mkdir(profile, { recursive: true });
await mkdir(hooks, { recursive: true });
await writeFile(path.join(profile, 'telemetry-state.json'), JSON.stringify({ decided: true, consent: { analytics: false, diagnostics: false, policyVersion: '2026-09-10', updatedAt: Date.now() } }));
const saved = path.join(output, 'saved-before-update.styk');
await rm(saved, { force: true });
await writeFile(path.join(hooks, 'update.json'), JSON.stringify({ version: '9.9.9', stepMs: 700 }));
await writeFile(path.join(hooks, 'answers.json'), JSON.stringify({ message: ['cancel', 'save'], save: [saved] }));
const events = async () => (await readFile(path.join(hooks, 'events.jsonl'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line));
const opened = async () => (await events()).filter(event => event.kind === 'open-url').map(event => event.value);
const installs = async () => (await events()).filter(event => event.kind === 'update-install');
const launch = () => tauri.launch({ executablePath, cwd: root, timeout: 60000, env: { ...process.env, STYK_USER_DATA_DIR: profile, STYK_TEST_HOOKS: hooks } });
let application = await launch();
const evidence = {};
try {
  let page = await application.firstWindow();
  await page.waitForFunction(() => window.styk?.ready, undefined, { timeout: 60000 });
  const splash = page.locator('.release-splash');
  await splash.waitFor({ state: 'visible' });
  assert.ok((await splash.innerText()).includes(`Version ${version}`));
  assert.equal(await splash.locator('.support-donate').getAttribute('href'), 'https://ko-fi.com/Q5Q41WY7QC');
  await page.screenshot({ path: path.join(output, 'startup.png') });
  evidence.startup = true;
  await splash.locator('.support-donate').click();
  for (let n = 0; n < 50 && !(await opened()).length; n++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual(await opened(), ['https://ko-fi.com/Q5Q41WY7QC']);
  await splash.getByRole('button', { name: 'Close welcome screen' }).click();
  await page.reload();
  await page.waitForFunction(() => window.styk?.ready, undefined, { timeout: 60000 });
  assert.equal(await page.evaluate(() => window.stykDesktop.getReleaseInfo(true)), null);
  assert.equal(await page.locator('.release-splash[open]').count(), 0);
  evidence.oncePerProcess = true;
  await page.locator('.titlebar [data-action="export"]').click();
  await page.locator('#export-dialog #export-submit').waitFor();
  await page.getByRole('combobox', { name: 'Export format', exact: true }).waitFor();
  await page.screenshot({ path: path.join(output, 'export.png') });
  evidence.exportPanel = true;
  await page.keyboard.press('Escape');
  await (await openAppMenu(page, 'help')).locator('[data-action="donate"]').click();
  for (let n = 0; n < 50 && (await opened()).length < 2; n++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal((await opened()).at(-1), 'https://ko-fi.com/Q5Q41WY7QC');
  evidence.helpDonation = true;

  // Help → Check for updates finds the stand-in version and shows its download.
  await (await openAppMenu(page, 'help')).locator('[data-action="check-updates"]').click();
  await page.locator('.update-notice progress').waitFor({ timeout: 20000 });
  assert.equal(await page.getByRole('button', { name: 'Restart to update', exact: true }).count(), 0);
  await page.screenshot({ path: path.join(output, 'downloading.png') });
  await page.getByRole('button', { name: 'Restart to update', exact: true }).waitFor({ timeout: 20000 });
  assert.equal((await page.evaluate(() => window.stykDesktop.getUpdateState())).status, 'ready');
  await page.screenshot({ path: path.join(output, 'ready.png') });
  evidence.progressAndReady = true;

  // Unsaved work: Cancel keeps the app and the edit, and installs nothing.
  await page.evaluate(() => { window.styk.editor.dirty = true; });
  await page.waitForFunction(() => true);
  await page.getByRole('button', { name: 'Restart to update', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.update-notice .primary').disabled);
  assert.deepEqual(await installs(), []);
  assert.equal(await page.evaluate(() => window.styk.editor.dirty), true);
  evidence.unsavedCancel = true;
  // Save and restart: the project is written first, and only then is the update installed.
  await page.getByRole('button', { name: 'Restart to update', exact: true }).click();
  for (let n = 0; n < 150 && !(await installs()).length; n++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual((await installs()).map(event => event.value), ['9.9.9']);
  assert.equal(await page.evaluate(() => window.styk.editor.dirty), false);
  assert.ok((await readFile(saved)).length > 0, 'the project was saved before the update');
  evidence.saveBeforeRestart = true;
  await application.close();

  // The next launch shows the splash again; without a feed, a development copy explains it does not update.
  await rm(path.join(hooks, 'update.json'));
  application = await launch();
  page = await application.firstWindow();
  await page.locator('.release-splash[open]').waitFor({ timeout: 30000 });
  evidence.splashOnNextLaunch = true;
  await page.keyboard.press('Escape');
  await (await openAppMenu(page, 'help')).locator('[data-action="check-updates"]').click();
  await page.getByRole('button', { name: 'Open downloads' }).waitFor();
  evidence.developmentUnavailable = true;
  await writeFile(path.join(output, 'smoke.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
} finally { await application.close().catch(() => {}); }
