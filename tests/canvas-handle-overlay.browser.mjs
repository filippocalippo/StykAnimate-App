// The joint overlay's pixels in a real browser canvas (tests/canvas-handle-overlay-fixture.mjs): pose damage and pans against
// a full repaint, and the stamped handles against the paths they are pictures of.
// Needs the development server (npm run serve) or STYK_URL.
import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';

const browser = await chromium.launch({channel: 'chrome', headless: true});
try {
  const page = await browser.newPage();
  await page.goto(process.env.STYK_URL || 'http://127.0.0.1:47831');
  const result = await page.evaluate(async () => {
    const fixture = await import('/tests/canvas-handle-overlay-fixture.mjs');
    try {
      return {damage: fixture.verifyCanvasHandleOverlay().length, pans: fixture.verifyCanvasHandlePans().length, stamps: fixture.verifyCanvasHandleStamps()};
    } catch (error) { return {error: error.message}; }
  });
  assert.equal(result.error, undefined, result.error);
  console.log(JSON.stringify(result.stamps));
  console.log(`PASS joint overlay (${result.damage} pose-damage and ${result.pans} pan pictures compared with a full repaint)`);
} finally { await browser.close(); }
