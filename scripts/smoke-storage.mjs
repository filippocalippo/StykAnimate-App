// What the page keeps in the browser lasts one launch (desktop/main.cjs): this starts the desktop app three times on one
// profile, leaves local storage and an IndexedDB database behind in the first, and checks that neither is there when
// the next starts. It guards the clearing against a Chromium that keeps its storage somewhere new.
//
//   node scripts/smoke-storage.mjs
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from '../tests/support/playwright.mjs';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const profile = await mkdtemp(path.join(os.tmpdir(), 'styk-storage-'));
await writeFile(path.join(profile, 'telemetry-state.json'), JSON.stringify({ decided: true, consent: { analytics: false, diagnostics: false, policyVersion: '2026-09-10', updatedAt: Date.now() } }));
const failures = [];
const expect = (name, condition, detail = '') => { if (!condition) failures.push(`${name}${detail ? ` (${detail})` : ''}`); console.log(`${condition ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };

/** One launch on the profile: what the page finds in its storage, then (the first launch) what it leaves there. */
async function launch(leave) {
  const env = { ...process.env, STYK_USER_DATA_DIR: profile, STYK_LIBRARY_DIR: path.join(profile, 'library'), STYK_BACKGROUND_WINDOW: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [appRoot], cwd: appRoot, env, timeout: 60000 });
  try {
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 2, checkboxChecked: false }); });
    const page = await app.firstWindow({ timeout: 60000 });
    await page.waitForFunction(() => window.styk?.ready === true, undefined, { timeout: 60000 });
    const found = await page.evaluate(async () => ({ marker: localStorage.getItem('storage-smoke'), databases: (await indexedDB.databases()).map(database => database.name) }));
    if (leave) await page.evaluate(() => new Promise((resolve, reject) => {
      localStorage.setItem('storage-smoke', 'left behind');
      const request = indexedDB.open('storage-smoke', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('rows');
      request.onsuccess = () => { request.result.close(); resolve(); };
      request.onerror = () => reject(request.error);
    }));
    return found;
  } finally {
    const closing = app.close().catch(() => {});
    await Promise.race([closing, new Promise(resolve => setTimeout(resolve, 15000))]);
  }
}

try {
  const first = await launch(true);
  expect('A first launch starts with no storage', first.marker === null && !first.databases.includes('storage-smoke'));
  for (const launchNumber of [2, 3]) {
    const found = await launch(launchNumber === 2);
    expect(`Local storage does not survive a restart (launch ${launchNumber})`, found.marker === null, String(found.marker));
    expect(`IndexedDB does not survive a restart (launch ${launchNumber})`, !found.databases.includes('storage-smoke'), found.databases.join(', '));
  }
} finally {
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}
if (failures.length) { console.error(`\n${failures.length} check(s) failed:\n - ${failures.join('\n - ')}`); process.exitCode = 1; }
else console.log('\nBrowser storage lasts one launch.');
