// Which CSS surfaces get ClearType text in Chromium, for `cargo xtask fonts surfaces` (docs/native/typography.md, section 6).
//
//   node fonts-surfaces.mjs
//
// One row of text per surface pattern the app's stylesheets use (or could): the same sentence in the same font on the
// same opaque page, each wrapped in a different style. The mean colour spread of the row's ink pixels says whether
// Chromium drew subpixel text there (tens) or grayscale (a few, the tint of the background). Headless Chromium from
// Playwright, as the typography check uses; nothing opens on screen.

import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const require = createRequire(path.join(root, 'package.json'));
const { chromium } = require('playwright-core');
const { PNG } = require('playwright-core/lib/utilsBundle');

const SURFACES = [
  ['plain opaque page', ''],
  ['text colour with alpha (rgba .7)', 'color: rgba(12, 13, 18, .7);'],
  ['translucent background on opaque page', 'background: rgba(255, 255, 255, .5);'],
  ['opacity: .99', 'opacity: .99;'],
  ['opacity: .5', 'opacity: .5;'],
  ['will-change: transform', 'will-change: transform;'],
  ['will-change: opacity', 'will-change: opacity;'],
  ['transform: translateZ(0)', 'transform: translateZ(0);'],
  ['transform: translate(.5px, 0)', 'transform: translate(.5px, 0);'],
  ['transform: scale(1.0001)', 'transform: scale(1.0001);'],
  ['transform: rotate(.01deg)', 'transform: rotate(.01deg);'],
  ['backdrop-filter: blur(8px) with translucent background', 'backdrop-filter: blur(8px); background: rgba(255, 255, 255, .6);'],
  ['filter: drop-shadow', 'filter: drop-shadow(0 1px 2px rgba(0, 0, 0, .3));'],
  ['mix-blend-mode: multiply', 'mix-blend-mode: multiply;'],
  ['isolation: isolate', 'isolation: isolate;'],
  ['position: fixed over the page', 'position: fixed; left: 480px; top: 0; width: 460px; background: #fbfcfd;'],
  ['overflow: hidden with border-radius', 'overflow: hidden; border-radius: 8px; background: #fbfcfd;'],
  ['box-shadow on an opaque panel', 'box-shadow: 0 8px 24px rgba(0, 0, 0, .2); background: #fbfcfd;'],
  ['CSS animation on opacity', 'animation: fade 2s infinite alternate;'],
  ['CSS transition-less transform animation', 'animation: slide 2s infinite alternate;'],
];

const html = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="${pathToFileURL(path.join(root, 'src/styles/tokens.css')).href}">
<link rel="stylesheet" href="${pathToFileURL(path.join(root, 'src/styles/base/fonts.css')).href}">
<style>
  html, body { margin: 0; background: #eceff4; color: #0c0d12; font: 500 13px/18px var(--font-ui); }
  .row { height: 24px; padding: 3px 16px; box-sizing: border-box; white-space: pre; position: relative; }
  @keyframes fade { from { opacity: 1 } to { opacity: .6 } }
  @keyframes slide { from { transform: translateX(0) } to { transform: translateX(3px) } }
</style></head><body>
${SURFACES.map(([, style], index) => `<div class="row" id="r${index}"><span style="${style} display: inline-block;">Position  Rotation 45.25°  Zoom 100%  AVATAR To</span></div>`).join('\n')}
<dialog id="modal" style="margin: 0; padding: 3px 16px; border: 0; left: 0; top: ${SURFACES.length * 24 + 8}px; width: 460px; background: #fbfcfd; font: 500 13px/18px var(--font-ui);">top-layer dialog: Position  Rotation 45.25°</dialog>
<div popover id="pop" style="margin: 0; padding: 3px 16px; border: 0; left: 480px; top: ${SURFACES.length * 24 + 8}px; width: 460px; background: #fbfcfd; font: 500 13px/18px var(--font-ui);">popover: Position  Rotation 45.25°</div>
<canvas id="canvas" width="460" height="24" style="position:absolute; left:0; top:${SURFACES.length * 24 + 48}px"></canvas>
<canvas id="opaque" width="460" height="24" style="position:absolute; left:480px; top:${SURFACES.length * 24 + 48}px"></canvas>
</body></html>`;

const browser = await chromium.launch({ args: ['--allow-file-access-from-files'] });
try {
  const page = await browser.newPage({ viewport: { width: 960, height: SURFACES.length * 24 + 96 } });
  await page.setContent(html);
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => {
    document.getElementById('modal').showModal();
    document.getElementById('pop').showPopover();
    for (const [id, options] of [['canvas', {}], ['opaque', { alpha: false }]]) {
      const context = document.getElementById(id).getContext('2d', options);
      context.fillStyle = '#eceff4';
      context.fillRect(0, 0, 460, 24);
      context.fillStyle = '#0c0d12';
      context.font = '500 13px Inter, sans-serif';
      context.fillText(`canvas ${id === 'opaque' ? '(alpha: false)' : '(default)'}: Position  Rotation 45.25°`, 16, 17);
    }
  });
  await page.waitForTimeout(400);
  const shot = PNG.sync.read(await page.screenshot());
  const spread = (x0, y0, x1, y1) => {
    const background = [0xec, 0xef, 0xf4];
    let total = 0, count = 0;
    for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) {
      const at = (y * shot.width + x) * 4;
      const [r, g, b] = [shot.data[at], shot.data[at + 1], shot.data[at + 2]];
      const distance = Math.abs(r - background[0]) + Math.abs(g - background[1]) + Math.abs(b - background[2]);
      if (distance > 60) { total += Math.max(r, g, b) - Math.min(r, g, b); count += 1; }
    }
    return count ? total / count : NaN;
  };
  // The page background is tinted (spread 9); text on it that is subpixel has fringes well above that.
  const rows = SURFACES.map(([name], index) => [name, spread(0, index * 24, SURFACES.length ? 470 : 0, index * 24 + 24)]);
  const below = SURFACES.length * 24;
  rows[15][1] = spread(480, 15 * 24, 940, 15 * 24 + 24);
  rows.push(['top-layer <dialog> (showModal)', spread(0, below + 8, 470, below + 32)]);
  rows.push(['popover (top layer)', spread(480, below + 8, 940, below + 32)]);
  rows.push(['canvas 2D, default (alpha)', spread(0, below + 48, 470, below + 72)]);
  rows.push(['canvas 2D, alpha: false', spread(480, below + 48, 940, below + 72)]);
  for (const [name, value] of rows) console.log(`${(Number.isNaN(value) ? 'no ink' : value.toFixed(1)).padStart(8)}  ${value > 25 ? 'ClearType' : 'grayscale'}  ${name}`);
} finally {
  await browser.close();
}
