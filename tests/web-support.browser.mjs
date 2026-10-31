// A browser that cannot run the editor gets an explanation, and one that can is left alone
// (STYK_BROWSER=chrome|firefox|webkit). The missing feature is removed the way an old browser lacks it.
//
//   node tests/web-support.browser.mjs            build the site into a temp directory first
//   STYK_WEB_DIR=build/web node tests/...         test an existing build
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BROWSER, launchBrowser } from './support/cross-browser.mjs';
import { buildWeb } from '../scripts/build-web.mjs';
import { startWebServer } from '../scripts/serve-web.mjs';

const temp = await mkdtemp(path.join(os.tmpdir(), 'styk-support-'));
const existing = process.env.STYK_WEB_DIR && path.resolve(process.env.STYK_WEB_DIR);
const site = await startWebServer({ root: existing ?? (await buildWeb({ output: path.join(temp, 'site') })).output });
const browser = await launchBrowser();
const checks = [];
const check = (name, condition) => { assert.ok(condition, `[${BROWSER}] ${name}`); checks.push(name); console.log('PASS', `[${BROWSER}]`, name); };

try {
  // The browser under test may itself be the unsupported one (Playwright's WebKit build for Windows has no OffscreenCanvas).
  const probe = await (await browser.newContext()).newPage();
  await probe.goto(site.origin, { waitUntil: 'load' });
  await probe.waitForTimeout(3000);
  const lacks = await probe.evaluate(() => window.stykUnsupported ?? null);
  console.log(`[${BROWSER}] on this browser the editor ${lacks ? `is refused: ${lacks.join('; ')}` : 'starts'}`);
  if (!lacks) check('A capable browser starts the editor with no warning', await probe.evaluate(() => typeof window.styk === 'object') && !(await probe.getByText('needs a newer browser').count()));
  else check('A browser that lacks a feature says so in plain words', await probe.getByText('StykAnimate needs a newer browser').isVisible());
  await probe.context().close();

  for (const [feature, removal] of [['OffscreenCanvas', () => { delete window.OffscreenCanvas; }], ['WebAssembly SIMD', () => { const validate = WebAssembly.validate.bind(WebAssembly); WebAssembly.validate = (bytes) => bytes.includes(253) ? false : validate(bytes); }], ['IndexedDB', () => { Object.defineProperty(window, 'indexedDB', { configurable: true, get: () => undefined }); }]]) {
    const page = await (await browser.newContext()).newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(removal);
    await page.goto(site.origin, { waitUntil: 'load' });
    await page.getByText('StykAnimate needs a newer browser').waitFor({ timeout: 15000 });
    const text = await page.locator('main[role="alert"]').innerText();
    check(`Without ${feature} the person is told, not shown a blank page`, /missing/.test(text) && text.includes(feature) && /Chrome, Edge, Firefox or Safari/.test(text));
    check('and the message points to the desktop app', /desktop app/.test(text));
    check('and the page has the alert role', (await page.locator('main[role="alert"]').count()) === 1);
    await page.context().close();
  }
  console.log(`\n[${BROWSER}] ${checks.length} checks passed`);
} finally {
  await browser.close();
  await site.close();
  await rm(temp, { recursive: true, force: true });
}
