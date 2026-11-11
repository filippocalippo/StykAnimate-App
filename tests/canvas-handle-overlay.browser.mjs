// The joint overlay's pixels in a real browser canvas: local damage and pans against a full repaint (tests/canvas-handle-overlay-fixture.mjs).
// Needs the development server (npm run serve) or STYK_URL.
import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';

const browser = await chromium.launch({channel: 'chrome', headless: true});
try {
  const page = await browser.newPage();
  await page.goto(process.env.STYK_URL || 'http://127.0.0.1:47831');
  const result = await page.evaluate(async () => {
    const {verifyCanvasHandleOverlay} = await import('/tests/canvas-handle-overlay-fixture.mjs');
    try { return {checks: verifyCanvasHandleOverlay().checks.length}; } catch (error) { return {error: error.message}; }
  });
  assert.equal(result.error, undefined, result.error);
  console.log(`PASS joint overlay pixels (${result.checks} pictures compared)`);
} finally { await browser.close(); }
