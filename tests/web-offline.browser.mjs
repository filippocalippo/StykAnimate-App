// The installed web build with no network, end to end in a real browser:
//
//   1. a first visit stores the editor and the Pivot codec through the service worker;
//   2. with the server stopped, the app still starts and does real work, Pivot files included;
//   3. a new build installs in the background, downloading only what changed, and is used
//      only after the old version's window is closed.
//
//   node tests/web-offline.browser.mjs            build into a temp directory first
//   STYK_WEB_DIR=build/web node tests/...         test an existing build
import assert from 'node:assert/strict';
import { appendFile, cp, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from './support/playwright.mjs';
import { buildWeb, writeServiceWorker } from '../scripts/build-web.mjs';
import { startWebServer } from '../scripts/serve-web.mjs';

const temp = await mkdtemp(path.join(os.tmpdir(), 'styk-offline-'));
const existing = process.env.STYK_WEB_DIR && path.resolve(process.env.STYK_WEB_DIR);
const first = path.join(temp, 'v1');
await cp(existing ?? (await buildWeb({ output: path.join(temp, 'build') })).output, first, { recursive: true });
let server = await startWebServer({ root: first });
const { port } = server.server.address();
const origin = server.origin;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const checks = [];
const check = (name, condition) => { assert.ok(condition, name); checks.push(name); console.log('PASS', name); };
const until = async (description, read, timeout = 60000) => {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}.`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
};
/** The worker's own account of what it has stored. */
const workerStatus = (page) => page.evaluate(() => new Promise((resolve) => {
  const listener = (event) => { if (event.data?.type === 'status') { navigator.serviceWorker.removeEventListener('message', listener); resolve(event.data); } };
  navigator.serviceWorker.addEventListener('message', listener);
  navigator.serviceWorker.ready.then((registration) => registration.active.postMessage({ type: 'status' }));
}));

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  await context.addInitScript(() => {
    delete window.showSaveFilePicker;
    document.addEventListener('securitypolicyviolation', (event) => console.error(`CSP violation: ${event.violatedDirective} ${event.blockedURI}`));
  });
  const problems = [], workerRequests = [];
  context.on('request', (request) => { if (request.serviceWorker()) workerRequests.push(new URL(request.url()).pathname); });
  const watch = (page) => {
    page.on('pageerror', (error) => problems.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') problems.push(message.text()); });
  };

  // A blank page is not a client of the worker, so it can watch activations without delaying them.
  const observer = await context.newPage();
  const activated = new Set();
  const devtools = await context.newCDPSession(observer);
  devtools.on('ServiceWorker.workerVersionUpdated', ({ versions }) => { for (const version of versions) if (version.status === 'activated') activated.add(version.versionId); });
  await devtools.send('ServiceWorker.enable');

  // --- 1. First visit.
  const page = await context.newPage();
  watch(page);
  await page.goto(origin, { waitUntil: 'load' });
  await page.waitForFunction(() => window.styk?.ready === true, undefined, { timeout: 60000 });
  const manifest = await page.evaluate(() => fetch(document.querySelector('link[rel="manifest"]').href).then((response) => response.json()));
  check('The page links an install manifest with an app window and icons', manifest.display === 'standalone' && manifest.icons.length >= 3 && manifest.start_url === './');
  const stored = await until('the worker to store the editor and the Pivot codec', async () => {
    const state = await workerStatus(page).catch(() => null);
    return state?.core && state?.codec ? state : null;
  });
  const info = JSON.parse(await readFile(path.join(first, 'build-info.json'), 'utf8'));
  check('The worker stores the whole editor and the Pivot codec under this build\'s version', stored.version === info.offline);
  check('One cache holds this version', JSON.stringify(await page.evaluate(() => caches.keys())) === JSON.stringify([`styk-app-${info.offline}`]));
  check('Storing it did not change what the app shows', await page.evaluate(() => ['WebGPU', 'WebGL2'].includes(window.styk.state.renderer.stats.backend)));

  // --- 2. No network: the server is gone.
  await server.close();
  await context.setOffline(true);
  workerRequests.length = 0;
  const failed = [];
  page.on('requestfailed', (request) => failed.push(new URL(request.url()).pathname));
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => window.styk?.ready === true, undefined, { timeout: 60000 });
  check('The app starts with no network', await page.evaluate(() => !navigator.onLine && ['WebGPU', 'WebGL2'].includes(window.styk.state.renderer.stats.backend)));
  check('Every request was answered from the cache', failed.length === 0 && workerRequests.length === 0);

  const download = async (action, name) => {
    const pending = page.waitForEvent('download', { timeout: 120000 });
    await page.evaluate((id) => window.styk.actions[id](), action);
    const file = path.join(temp, name);
    await (await pending).saveAs(file);
    return file;
  };
  const project = await download('save', 'offline.styk');
  check('A native project saves offline', (await stat(project)).size > 100);
  const piv = await download('export-piv', 'offline.piv');
  check('A Pivot file exports offline (the codec comes from the cache)', (await stat(piv)).size > 100);
  await page.locator('#file-input').setInputFiles(piv);
  await page.waitForFunction(() => window.styk.editor.name === 'offline', undefined, { timeout: 120000 });
  check('The Pivot file reopens offline', await page.evaluate(() => window.styk.editor.frame.objects.length >= 1));
  const mp4 = await download('export-mp4', 'offline.mp4');
  check('An MP4 exports offline', (await readFile(mp4)).subarray(4, 8).toString() === 'ftyp');
  check('Nothing went to the network while offline', failed.length === 0 && workerRequests.length === 0);
  check('No console errors, page errors or CSP violations offline', problems.length === 0 || (console.error(problems), false));

  // --- 3. A new version of the site.
  await context.setOffline(false);
  const second = path.join(temp, 'v2');
  await cp(first, second, { recursive: true });
  await appendFile(path.join(second, 'src', 'theme-bootstrap.js'), '\n// second version\n');
  const next = await writeServiceWorker(second);
  check('A changed file gives the new build a new version', next.version !== info.offline);
  server = await startWebServer({ root: second, port });
  workerRequests.length = 0;
  // Notices queue one after another: let the ones from the exports above close first, so the update notice
  // is not still waiting its turn when it is looked for. (Faster exports leave more of them queued here.)
  await until('earlier notices to close', () => page.evaluate(() => !document.querySelector('.ui-toast')), 60000);
  await page.evaluate(() => navigator.serviceWorker.getRegistration().then((registration) => registration.update()));
  await until('the new version to install', () => page.evaluate(() => navigator.serviceWorker.getRegistration().then((registration) => registration.waiting?.state === 'installed')));
  check('The new version downloads only the file that changed', JSON.stringify(workerRequests.filter((name) => name !== '/sw.js')) === JSON.stringify(['/src/theme-bootstrap.js']));
  check('The open app is told a new version is ready', await until('the notice', () => page.evaluate(() => document.body.textContent.includes('A new version of StykAnimate is ready')), 10000));
  check('The open window keeps running the version it started with', (await workerStatus(page)).version === info.offline);
  check('Both versions are stored until the old one is closed', (await page.evaluate(() => caches.keys())).length === 2);

  const before = new Set(activated);
  await page.close();
  await until('the new version to activate', () => [...activated].some((id) => !before.has(id)));
  const reopened = await context.newPage();
  watch(reopened);
  await reopened.goto(origin, { waitUntil: 'load' });
  await reopened.waitForFunction(() => window.styk?.ready === true, undefined, { timeout: 60000 });
  check('After the window is closed, the new version is the one that runs', await reopened.evaluate(() => fetch('./src/theme-bootstrap.js').then((response) => response.text()).then((text) => text.includes('second version'))));
  check('Only the new version remains stored', JSON.stringify(await reopened.evaluate(() => caches.keys())) === JSON.stringify([`styk-app-${next.version}`]));
  check('The Pivot codec was carried over without downloading it again', !workerRequests.some((name) => name.startsWith('/src/engine/pkg/styk_codec')));
  check('No console errors, page errors or CSP violations', problems.length === 0 || (console.error(problems), false));
  await context.close();
  console.log(`\n${checks.length} checks passed`);
} finally {
  await browser.close();
  await server.close();
  await rm(temp, { recursive: true, force: true });
}
