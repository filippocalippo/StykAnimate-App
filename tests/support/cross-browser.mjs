// Which browser a browser test runs in: STYK_BROWSER=chrome (the default), firefox or webkit. Chrome is the
// installed Google Chrome; Firefox and WebKit are the builds `npx playwright install firefox webkit` downloads.
import { chromium, firefox, webkit } from './playwright.mjs';

export const BROWSER = (process.env.STYK_BROWSER || 'chrome').toLowerCase();

export async function launchBrowser() {
  if (BROWSER === 'chrome') return chromium.launch({ channel: 'chrome', headless: true });
  // Firefox turns WebGL off on a machine without a GPU; asking for it lets a software renderer serve where one exists.
  if (BROWSER === 'firefox') return firefox.launch({ headless: true, firefoxUserPrefs: { 'webgl.force-enabled': true } });
  if (BROWSER === 'webkit') return webkit.launch({ headless: true });
  throw new Error(`Unknown STYK_BROWSER "${BROWSER}". Use chrome, firefox or webkit.`);
}

/** Whether the editor can draw in this browser on this machine: the engine needs WebGPU or WebGL 2. */
export async function editorCanDraw(browser, origin) {
  const context = await browser.newContext(), page = await context.newPage();
  try {
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    return await page.evaluate(async () => {
      try { if (await navigator.gpu?.requestAdapter()) return true; } catch { /* no WebGPU here */ }
      try { return Boolean(new OffscreenCanvas(1, 1).getContext('webgl2')); } catch { return false; }
    });
  } finally { await context.close(); }
}

/**
 * For a test that needs the running editor. Chrome must draw everywhere the tests run. Firefox and WebKit on a machine
 * without a GPU may offer neither WebGPU nor WebGL 2 (Firefox on a Linux runner refuses WebGL 2): the test then says
 * so, runs `cleanup` and ends without a result, because there is no editor to test.
 */
export async function requireDrawing(browser, origin, cleanup) {
  if (await editorCanDraw(browser, origin)) return;
  if (BROWSER === 'chrome') throw new Error('Chrome offers neither WebGPU nor WebGL 2 here: the editor cannot start.');
  console.log(`SKIPPED [${BROWSER}] this browser offers neither WebGPU nor WebGL 2 on this machine, so the editor cannot draw: nothing was tested.`);
  await cleanup();
  process.exit(0);
}
