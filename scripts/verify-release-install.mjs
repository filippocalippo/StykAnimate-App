// Installs the previous public release and updates it to the exact candidate
// through the real updater and NSIS installer. Run only on a disposable Windows
// GitHub runner: the application identity/file associations are real.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createReadStream, createWriteStream, existsSync} from 'node:fs';
import {mkdir, mkdtemp, readFile, writeFile, realpath, stat} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createRequire} from 'node:module';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import os from 'node:os';
import path from 'node:path';
import {_electron as electron, electronEnvironment} from '../tests/support/playwright.mjs';
import {verifyReleaseAssets, fileHash} from './release-assets.mjs';
import {readNativeDocument} from './read-native-document.mjs';

if (process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true') throw new Error('Use a disposable Windows GitHub Actions runner for the real installer check.');
const root = process.cwd(), {version} = JSON.parse(await readFile('package.json', 'utf8'));
const directory = path.join(root, 'release', version), evidenceDirectory = path.join(root, 'artifacts', 'release-install');
await mkdir(evidenceDirectory, {recursive: true});
// Windows TEMP can contain an 8.3 alias. WMI reports the executable's long
// path, so use the same canonical directory for installation and observation.
const work = await realpath(await mkdtemp(path.join(os.tmpdir(), 'styk-release-install-')));
const install = path.join(work, 'installed'), executable = path.join(install, 'StykAnimate.exe'), profile = path.join(work, 'profile');
await mkdir(profile);
// Statistics off (docs/STATISTICS.md): a script's runs are not counted and nothing waits to be sent.
await writeFile(path.join(profile, 'stats-state.json'), JSON.stringify({v: 1, enabled: false, noticeSeen: true}));
const env = {...electronEnvironment(), STYK_USER_DATA_DIR: profile, STYK_LIBRARY_DIR: path.join(work, 'library'), STYK_INSTALL_TEST_EXE: executable};
const exec = promisify(execFile);
const run = (file, args) => exec(file, args, {env, windowsHide: true, timeout: 180000, maxBuffer: 5 * 1024 * 1024});
const powershell = command => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command]);
const requests = [], allowed = new Set((await verifyReleaseAssets(directory, version, 'win32')).map(file => path.basename(file)));
const server = createServer(async (request, response) => {
  const name = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname.slice(1));
  if (!allowed.has(name)) { response.writeHead(404).end(); return; }
  try {
    const filename = path.join(directory, name), info = await stat(filename);
    requests.push(name);
    response.writeHead(200, {'content-length': info.size, 'content-type': 'application/octet-stream'});
    createReadStream(filename).on('error', () => response.destroy()).pipe(response);
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const feed = `http://127.0.0.1:${server.address().port}`;
const evidence = {passed: false, candidate: version, commit: process.env.GITHUB_SHA, candidateRun: process.env.STYK_CANDIDATE_RUN || null, loopbackFeed: true, installDirectory: install, checks: []};
const check = name => { evidence.checks.push(name); console.log(`PASS ${name}`); };
const until = async (name, condition) => {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${name}.`);
};
const processIds = async () => {
  const {stdout} = await powershell("ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process -Filter \"Name = 'StykAnimate.exe'\" | Select-Object ProcessId, ExecutablePath)");
  evidence.observedProcesses = JSON.parse(stdout);
  return evidence.observedProcesses.filter(item => item.ExecutablePath?.toLowerCase() === executable.toLowerCase()).map(item => item.ProcessId);
};
let app, installed = false;
try {
  const repository = 'https://github.com/filippocalippo/styk-animate-releases';
  const response = await fetch('https://api.github.com/repos/filippocalippo/styk-animate-releases/releases/latest', {headers: {'User-Agent': 'StykAnimate-release-verification'}, signal: AbortSignal.timeout(30000)});
  assert.ok(response.ok, 'Previous public release metadata is reachable');
  const previous = await response.json(), match = /^v(\d+\.\d+\.\d+)$/.exec(previous.tag_name);
  assert.ok(match && previous.draft === false && previous.prerelease === false);
  const semver = createRequire(import.meta.url)('semver');
  assert.ok(semver.lt(match[1], version), 'The candidate must be newer than the installed baseline');
  evidence.baseline = match[1];
  const name = `StykAnimate-${match[1]}-Setup-x64.exe`, asset = previous.assets.find(item => item.name === name);
  assert.ok(asset?.size > 0 && /^sha256:[a-f0-9]{64}$/.test(asset.digest), 'The public baseline has a verified SHA-256');
  const baseline = path.join(work, name), download = await fetch(`${repository}/releases/download/${previous.tag_name}/${name}`, {signal: AbortSignal.timeout(120000)});
  assert.ok(download.ok && download.body);
  await pipeline(Readable.fromWeb(download.body), createWriteStream(baseline));
  assert.equal((await stat(baseline)).size, asset.size);
  assert.equal(`sha256:${await fileHash(baseline, 'sha256', 'hex')}`, asset.digest);
  evidence.baselineSHA256 = asset.digest.slice(7);
  evidence.candidateArchiveSHA256 = await fileHash(path.join(directory, 'win-unpacked', 'resources', 'app.asar'), 'sha256', 'hex');
  evidence.candidateSHA256 = await fileHash(path.join(directory, `StykAnimate-${version}-Setup-x64.exe`), 'sha256', 'hex');
  await run(baseline, ['/S', '/currentuser', `/D=${install}`]);
  installed = true;
  assert.ok(existsSync(executable));
  check('Previous public Setup installs into the isolated directory');
  app = await electron.launch({executablePath: executable, args: [], cwd: root, env, timeout: 60000});
  let page = await app.firstWindow();
  await page.waitForFunction(() => window.styk?.ready, undefined, {timeout: 60000});
  assert.equal(await app.evaluate(({app}) => app.getVersion()), evidence.baseline);
  const splash = page.locator('.release-splash[open]');
  if (await splash.isVisible()) await page.getByRole('button', {name: 'Close welcome screen'}).click();
  // Capture the existing production service through its public operation. Only
  // the feed/cache destination is substituted, inside this test process.
  await app.evaluate(({app}) => {
    const require = process.getBuiltinModule('module').createRequire(`${app.getAppPath()}/package.json`);
    const {UpdateService} = require('./desktop/updates.cjs'), original = UpdateService.prototype.snapshot;
    UpdateService.prototype.snapshot = function () { globalThis.releaseUpdate = this; UpdateService.prototype.snapshot = original; return original.call(this); };
  });
  await page.evaluate(() => window.stykDesktop.getUpdateState());
  const downloaded = await app.evaluate(async ({app}, url) => {
    const service = globalThis.releaseUpdate;
    service.dispose();
    const updater = service.updater;
    updater.setFeedURL({provider: 'generic', url});
    updater.disableDifferentialDownload = true;
    updater.installDirectory = process.getBuiltinModule('path').dirname(process.execPath);
    Object.defineProperty(updater.app, 'baseCachePath', {value: app.getPath('userData')});
    return service.check();
  }, feed);
  assert.equal(downloaded.status, 'ready');
  assert.equal(downloaded.version, version);
  assert.ok(requests.includes(`StykAnimate-${version}-Setup-x64.exe`));
  check('Installed app downloads and verifies the exact candidate through electron-updater');
  await page.evaluate(() => window.styk.editor.setCanvasSize(961, 540));
  await app.evaluate(({dialog}) => { dialog.showMessageBox = async () => ({response: 1}); });
  await page.getByRole('button', {name: 'Restart to update', exact: true}).click();
  await page.waitForFunction(() => !document.querySelector('.update-notice .primary').disabled);
  assert.equal(await page.evaluate(() => window.styk.editor.dirty), true);
  assert.equal((await page.evaluate(() => window.stykDesktop.getUpdateState())).status, 'ready');
  check('Cancelling an update preserves the unsaved project and running version');
  const project = path.join(work, 'retained-project.styk');
  await app.evaluate(({dialog}, file) => {
    dialog.showMessageBox = async () => ({response: 0});
    dialog.showSaveDialog = async () => ({canceled: false, filePath: file});
  }, project);
  await Promise.all([
    app.waitForEvent('close', {timeout: 120000}),
    page.getByRole('button', {name: 'Restart to update', exact: true}).click(),
  ]);
  app = null;
  assert.equal((await readNativeDocument(project)).canvas_width, 961);
  check('The edited project is saved before the old app closes for installation');
  await until('the installed candidate and its automatic relaunch', async () => {
    try {
      // ASAR readers cache file offsets by path. The installer replaces that
      // archive in place, so compare fresh bytes to the exact packaged payload.
      evidence.installedArchiveSHA256 = await fileHash(path.join(install, 'resources', 'app.asar'), 'sha256', 'hex');
      evidence.relaunchedProcesses = await processIds();
      return evidence.installedArchiveSHA256 === evidence.candidateArchiveSHA256 && evidence.relaunchedProcesses.length > 0;
    } catch (error) { evidence.lastInstallObservation = error.message; return false; }
  });
  check('Real NSIS upgrade replaces the installed version and automatically relaunches it');
  // Reattach to the installed candidate after confirming the real relaunch.
  await powershell('Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $env:STYK_INSTALL_TEST_EXE } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }');
  await until('the automatic relaunch to stop', async () => (await processIds()).length === 0);
  app = await electron.launch({executablePath: executable, args: [], cwd: root, env, timeout: 60000});
  page = await app.firstWindow();
  await page.waitForFunction(() => window.styk?.ready, undefined, {timeout: 60000});
  assert.equal(await app.evaluate(({app}) => app.getVersion()), version);
  await app.evaluate(({dialog}, file) => { dialog.showOpenDialog = async () => ({canceled: false, filePaths: [file]}); }, project);
  await page.evaluate(() => window.styk.actions.open());
  await page.waitForFunction(() => window.styk.editor.report.canvas_width === 961);
  assert.equal((await page.evaluate(() => window.stykDesktop.getUpdateState())).status === 'unavailable', false);
  assert.equal(JSON.parse(await readFile(path.join(profile, 'stats-state.json'), 'utf8')).enabled, false);
  check('Installed candidate reopens the saved project and keeps statistics off as the profile chose');
  evidence.passed = true;
} catch (error) {
  evidence.error = error.stack;
  throw error;
} finally {
  await writeFile(path.join(evidenceDirectory, 'evidence.json'), JSON.stringify({...evidence, requests}, null, 2) + '\n');
  if (app) await app.evaluate(({app}) => app.exit(0)).catch(() => {});
  await powershell('Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $env:STYK_INSTALL_TEST_EXE } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }').catch(() => {});
  if (installed) await run(path.join(install, 'Uninstall StykAnimate.exe'), ['/S']).catch(error => console.warn('Test uninstall:', error.message));
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
console.log(JSON.stringify(evidence, null, 2));
