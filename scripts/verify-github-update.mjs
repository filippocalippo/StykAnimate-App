// Checks the real public feed and downloads its installer through electron-updater.
// Only this test process reports an older version; nothing is installed.
import { _electron as electron } from 'playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const root = process.cwd();
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const output = path.join(root, 'artifacts', 'updates');
await mkdir(output, { recursive: true });
const application = await electron.launch({
  executablePath: process.env.STYK_PACKAGED_EXECUTABLE || path.join(root, 'release', version, 'win-unpacked', 'StykAnimate.exe'),
  args: [], cwd: root, timeout: 45000,
  env: { ...process.env, STYK_USER_DATA_DIR: path.join(output, `github-profile-${Date.now()}`) },
});
try {
  const page = await application.firstWindow();
  await page.waitForFunction(() => window.styk?.ready, undefined, { timeout: 30000 });
  const evidence = await application.evaluate(async ({ app }) => {
    const require = process.getBuiltinModule('module').createRequire(`${app.getAppPath()}/package.json`);
    const { autoUpdater } = require('electron-updater');
    const { UpdateService } = require('./desktop/updates.cjs');
    const semver = require('semver');
    const realVersion = autoUpdater.currentVersion;
    autoUpdater.currentVersion = new semver.SemVer('0.4.0');
    autoUpdater.disableDifferentialDownload = true;
    // Keep downloaded fixtures separate from the normal updater cache.
    Object.defineProperty(autoUpdater.app, 'baseCachePath', { value: app.getPath('userData') });
    const states = [];
    const service = new UpdateService({ updater: autoUpdater, currentVersion: '0.4.0', onState: value => states.push(value) });
    const downloaded = await service.check();
    if (downloaded.status !== 'ready') throw new Error(downloaded.message || `Unexpected update state: ${downloaded.status}`);
    autoUpdater.currentVersion = realVersion;
    const current = await autoUpdater.checkForUpdates();
    return { publicRepository: 'filippocalippo/styk-animate-releases', downloadedVersion: downloaded.version,
      downloadVerifiedByElectronUpdater: true, observedProgress: states.some(state => state.status === 'downloading' && state.transferred > 0),
      installedVersion: realVersion.version, currentVersionCheck: current?.updateInfo?.version,
      installerLaunched: false };
  });
  assert.equal(evidence.downloadedVersion, evidence.installedVersion);
  assert.equal(evidence.currentVersionCheck, evidence.installedVersion);
  await writeFile(path.join(output, 'github-smoke.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
} finally { await application.evaluate(({ app }) => app.exit(0)).catch(() => {}); }
