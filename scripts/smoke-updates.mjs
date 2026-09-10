import { _electron as electron } from 'playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';
const root = process.cwd();
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const executablePath = process.env.STYK_PACKAGED_EXECUTABLE;
const output = path.join(root, 'artifacts', 'updates');
await mkdir(output, { recursive: true });
const profile = path.join(output, `profile-${Date.now()}`);
await mkdir(profile, { recursive: true });
await writeFile(path.join(profile, 'telemetry-state.json'), JSON.stringify({ decided: true, consent: { analytics: false, diagnostics: false, policyVersion: '2026-09-10', updatedAt: Date.now() } }));
const launch = () => electron.launch({ executablePath, args: executablePath ? [] : [root], cwd: root, timeout: 45000, env: { ...process.env, STYK_USER_DATA_DIR: profile } });
let application = await launch();
const evidence = {};
try {
  let page = await application.firstWindow();
  await page.waitForFunction(() => window.styk?.ready, undefined, { timeout: 30000 });
  const splash = page.locator('.release-splash');
  await splash.waitFor({ state: 'visible' });
  assert.ok((await splash.innerText()).includes(`Version ${version}`));
  assert.equal(await splash.locator('.support-donate').getAttribute('href'), 'https://ko-fi.com/Q5Q41WY7QC');
  await page.screenshot({ path: path.join(output, 'startup.png') });
  evidence.startup = true;
  await application.evaluate(({ shell }) => { globalThis.openedLinks = []; shell.openExternal = async url => { globalThis.openedLinks.push(url); }; });
  await splash.locator('.support-donate').click();
  assert.deepEqual(await application.evaluate(() => globalThis.openedLinks), ['https://ko-fi.com/Q5Q41WY7QC']);
  await splash.getByRole('button', { name: 'Close welcome screen' }).click();
  await page.reload();
  await page.waitForFunction(() => window.styk?.ready, undefined, { timeout: 30000 });
  assert.equal(await page.evaluate(() => window.stykDesktop.getReleaseInfo(true)), null);
  assert.equal(await page.locator('.release-splash[open]').count(), 0);
  evidence.oncePerProcess = true;
  await page.locator('.titlebar [data-action="export"]').click();
  await page.locator('.studio-export-dialog .support-donate').waitFor();
  await page.locator('.studio-export-dialog .support-donate').click();
  assert.equal((await application.evaluate(() => globalThis.openedLinks)).at(-1), 'https://ko-fi.com/Q5Q41WY7QC');
  await page.screenshot({ path: path.join(output, 'export.png') });
  evidence.exportDonation = true;
  await page.keyboard.press('Escape');

  // Capture the production service through its public status operation. Only
  // this test process substitutes the installer; no test IPC exists in the app.
  await application.evaluate(({ app }) => {
    const require = process.getBuiltinModule('module').createRequire(`${app.getAppPath()}/package.json`);
    const { UpdateService } = require('./desktop/updates.cjs');
    const original = UpdateService.prototype.snapshot;
    UpdateService.prototype.snapshot = function () { globalThis.updateService = this; UpdateService.prototype.snapshot = original; return original.call(this); };
  });
  await page.evaluate(() => window.stykDesktop.getUpdateState());
  await application.evaluate(() => globalThis.updateService.set({ status: 'downloading', version: '0.6.0', percent: 42, transferred: 42 * 1048576, total: 100 * 1048576 }));
  await page.locator('.update-notice progress').waitFor();
  assert.equal(await page.locator('.update-notice progress').getAttribute('value'), '42');
  assert.equal(await page.getByRole('button', { name: 'Restart to update', exact: true }).count(), 0);
  await page.screenshot({ path: path.join(output, 'downloading.png') });
  await page.locator('.update-dismiss').click();
  await application.evaluate(() => globalThis.updateService.set({ status: 'ready', percent: 100 }));
  await page.getByRole('button', { name: 'Restart to update', exact: true }).waitFor();
  await page.screenshot({ path: path.join(output, 'ready.png') });
  evidence.progressAndReady = true;
  await application.evaluate(({ dialog }) => {
    globalThis.installs = [];
    globalThis.updateService.updater = { quitAndInstall: (...args) => globalThis.installs.push(args) };
    dialog.showMessageBox = async () => ({ response: 1 });
  });
  await page.evaluate(() => { window.styk.editor.dirty = true; });
  await page.getByRole('button', { name: 'Restart to update', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.update-notice .primary').disabled);
  assert.deepEqual(await application.evaluate(() => globalThis.installs), []);
  evidence.unsavedCancel = true;
  // Saving to an actual .styk file must finish before the installer is invoked.
  await application.evaluate(({ dialog }, file) => {
    dialog.showMessageBox = async () => ({ response: 0 });
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
  }, path.join(output, 'saved-before-update.styk'));
  await page.getByRole('button', { name: 'Restart to update', exact: true }).click();
  for (let n = 0; n < 100 && !(await application.evaluate(() => globalThis.installs.length)); n++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual(await application.evaluate(() => globalThis.installs), [[true, true]]);
  assert.equal(await page.evaluate(() => window.styk.editor.dirty), false);
  evidence.saveBeforeRestart = true;
  await application.evaluate(({ app }) => app.exit(0)).catch(() => {});
  application = await launch();
  page = await application.firstWindow();
  await page.locator('.release-splash[open]').waitFor({ timeout: 30000 });
  evidence.splashOnNextLaunch = true;
  await page.keyboard.press('Escape');
  await page.locator('[data-app-menu="help"]').click();
  await page.locator('[data-action="check-updates"]').click();
  await page.getByRole('button', { name: 'Open downloads' }).waitFor();
  evidence.developmentUnavailable = true;
  await writeFile(path.join(output, 'smoke.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
} finally { await application.evaluate(({ app }) => app.exit(0)).catch(() => {}); }
