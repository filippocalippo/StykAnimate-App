// What the app is launched with reaches the page: a document file, and a stykanimate://privacy link (which the native side turns into a menu action).
// The native side sends both as soon as the page has loaded, and the page's listeners come on a little later (shell/pushes.rs).
//
//   node scripts/smoke-launch-link.mjs                 the development build (STYK_BUNDLE_DIR=build/app serves it with the bundle)
//   node scripts/smoke-launch-link.mjs --packaged      the release build, a developer one (or STYK_PACKAGED_EXECUTABLE)
//
// Dialogs are answered through the test hooks (engine/crates/styk-desktop/src/shell/test_hooks.rs).
//
// Each is launched three times, because the failure this guards against depended on timing.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tauri, tauriExecutable } from '../tests/support/tauri-app.mjs';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packaged = process.argv.includes('--packaged');
const executablePath = tauriExecutable({ packaged });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const work = await mkdtemp(path.join(os.tmpdir(), 'styk-launch-link-'));
const failures = [];
const expect = (name, condition, detail = '') => { if (!condition) failures.push(name); console.log(`${condition ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };

async function launch(args, answers = {}) {
  const profile = await mkdtemp(path.join(work, 'profile-'));
  const hooks = await mkdtemp(path.join(work, 'hooks-'));
  await writeFile(path.join(profile, 'telemetry-state.json'), JSON.stringify({ decided: true, consent: { analytics: false, diagnostics: false, policyVersion: '2026-09-10', updatedAt: Date.now() } }));
  // Unsaved work is discarded on close, as the Electron smoke's dialog stub answered.
  await writeFile(path.join(hooks, 'answers.json'), JSON.stringify({ message: ['discard', 'discard'], ...answers }));
  const env = { ...process.env, STYK_USER_DATA_DIR: profile, STYK_BACKGROUND_WINDOW: '1', STYK_TEST_HOOKS: hooks };
  delete env.STYK_STARTUP_VIEW;
  // An empty STYK_STARTUP_VIEW lets the launch decide (a file or link opens the editor).
  const app = await tauri.launch({ executablePath, args, cwd: appRoot, timeout: 60000, env: { ...env, STYK_STARTUP_VIEW: '' } });
  const page = await app.firstWindow();
  const close = async () => { await app.close(); await sleep(300); };
  return { app, page, close };
}

try {
  // A project file made by the app itself.
  const file = path.join(work, 'Launch project.styk');
  {
    const seed = await launch([], { save: [file] });
    try {
      await seed.page.waitForFunction(() => window.styk?.ready === true, undefined, { timeout: 60000 });
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
