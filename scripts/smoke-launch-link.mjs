// What the app is launched with reaches the page: a document file, and a stykanimate://privacy link (which the main process turns into a menu action).
// The main process sends both as soon as the page has loaded, and the page's listeners come on a little later (desktop/page-pushes.cjs).
//
//   node scripts/smoke-launch-link.mjs                 the source tree (STYK_BUNDLE_DIR=build/app serves it with the bundle)
//   node scripts/smoke-launch-link.mjs --packaged      release/<platform>-unpacked (or STYK_PACKAGED_EXECUTABLE)
//
// Each is launched three times, because the failure this guards against depended on timing.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { _electron as electron } from '../tests/support/playwright.mjs';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packaged = process.argv.includes('--packaged');
const unpacked = process.platform === 'win32' ? ['win-unpacked', 'StykAnimate.exe']
  : process.platform === 'darwin' ? [process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'StykAnimate.app', 'Contents', 'MacOS', 'StykAnimate']
  : [process.arch === 'arm64' ? 'linux-arm64-unpacked' : 'linux-unpacked', 'stykanimate'];
const executablePath = packaged ? process.env.STYK_PACKAGED_EXECUTABLE || path.join(appRoot, 'release', ...unpacked) : undefined;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const work = await mkdtemp(path.join(os.tmpdir(), 'styk-launch-link-'));
const failures = [];
const expect = (name, condition, detail = '') => { if (!condition) failures.push(name); console.log(`${condition ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };

async function launch(args) {
  const profile = await mkdtemp(path.join(work, 'profile-'));
  // Statistics off (docs/STATISTICS.md): a script's runs are not counted and nothing waits to be sent.
await writeFile(path.join(profile, 'stats-state.json'), JSON.stringify({v: 1, enabled: false, noticeSeen: true}));
  const env = { ...process.env, STYK_USER_DATA_DIR: profile, STYK_BACKGROUND_WINDOW: '1' };
  delete env.ELECTRON_RUN_AS_NODE; delete env.STYK_STARTUP_VIEW;
  const app = await electron.launch({ executablePath, args: packaged ? args : [appRoot, ...args], cwd: appRoot, timeout: 60000, env });
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 2, checkboxChecked: false }); });
  const page = await app.firstWindow();
  const close = async () => {
    const pid = app.process().pid;
    const closed = await Promise.race([app.close().then(() => true, () => true), sleep(15000).then(() => false)]);
    if (!closed && pid) { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already gone */ } }
    await sleep(300);
  };
  return { app, page, close };
}

try {
  // A project file made by the app itself.
  const file = path.join(work, 'Launch project.styk');
  {
    const seed = await launch([]);
    try {
      await seed.page.waitForFunction(() => window.styk?.ready === true, undefined, { timeout: 60000 });
      await seed.app.evaluate(({ dialog }, target) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: target }); }, file);
      await seed.page.evaluate(() => window.styk.actions['save-as']());
      for (let i = 0; i < 100 && !existsSync(file); i++) await sleep(100);
    } finally { await seed.close(); }
  }
  expect('The app made a project to launch with', existsSync(file));

  const opened = [], linked = [];
  for (let run = 0; run < 3; run++) {
    const withFile = await launch([file]);
    try {
      opened.push(await withFile.page.waitForFunction(() => window.styk?.editor?.name === 'Launch project', undefined, { timeout: 30000 }).then(() => true, () => false));
    } finally { await withFile.close(); }
    const withLink = await launch(['stykanimate://privacy']);
    try {
      linked.push(await withLink.page.waitForSelector('dialog.styk-privacy[open]', { timeout: 30000 }).then(() => true, () => false));
    } finally { await withLink.close(); }
  }
  expect('A file the app is launched with opens, every launch', opened.every(Boolean), opened.join(', '));
  expect('A stykanimate://privacy link the app is launched with opens the privacy settings, every launch', linked.every(Boolean), linked.join(', '));
} finally {
  await rm(work, { recursive: true, force: true }).catch(() => {});
}
if (failures.length) { console.error(`\n${failures.length} check(s) failed.`); process.exit(1); }
console.log('\nWhat the app is launched with reaches the page.');
process.exit(0);
