// Draws the type matrix in Chromium with today's stylesheets, for `cargo xtask fonts` (docs/native/typography.md).
//
//   node fonts-chromium.mjs <matrix.tsv> <out-dir> <theme> <scale> [--grayscale]
//
// The matrix is written by `styk-text-check matrix`: `#theme <name> <background> <text>` lines, then one row per item:
// id, family (ui | display), weight, size, line height, tracking (thousandths of an em), features (comma list or -),
// text. Each page of PAGE_ROWS rows is one screenshot, `chromium-<theme>-<scale>-p<N>.png`; the per-row measurements go
// to `chromium-<theme>-<scale>.tsv`: id, width of the text (Range rectangle), the platform fonts Chromium used
// (`family:glyphs|family:glyphs`). With --grayscale the files are `chromium-gray-...` and Chromium draws grayscale text
// (`--disable-lcd-text`), which separates what subpixel text changes from everything else. The rows sit on a fixed grid so the native sheet can be laid over the same pixels.
//
// Nothing here opens a visible window: Chromium runs headless and nothing is focused.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const { chromium } = createRequire(path.join(root, 'package.json'))('playwright-core');

const ROW_HEIGHT = 40;
const PAGE_ROWS = 22;
const PAGE_WIDTH = 960;
const LEFT = 16;

const [matrixPath, outDir, theme, scaleText, ...flags] = process.argv.slice(2);
const scale = Number(scaleText);
const grayscale = flags.includes('--grayscale');
const prefix = grayscale ? 'chromium-gray' : 'chromium';
if (!matrixPath || !outDir || !theme || !(scale > 0)) {
  console.error('usage: node fonts-chromium.mjs <matrix.tsv> <out-dir> <theme> <scale> [--grayscale]');
  process.exit(2);
}

const lines = fs.readFileSync(matrixPath, 'utf8').split('\n').filter((line) => line.length > 0);
const colours = lines.filter((line) => line.startsWith('#theme\t')).map((line) => line.split('\t')).find((cells) => cells[1] === theme);
if (!colours) throw new Error(`the matrix has no theme ${theme}`);
const [, , background, foreground] = colours;
const items = lines.filter((line) => !line.startsWith('#')).map((line) => {
  const [id, family, weight, size, lineHeight, tracking, features, ...text] = line.split('\t');
  return { id, family, weight: Number(weight), size: Number(size), lineHeight: Number(lineHeight), tracking: Number(tracking), features, text: text.join('\t') };
});

const escapeHtml = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const featureSettings = (features) => {
  const tags = features === '-' ? [] : features.split(',');
  const settings = tags.filter((tag) => tag !== 'tnum').map((tag) => `'${tag}'`).join(', ');
  return [settings ? `font-feature-settings: ${settings};` : '', tags.includes('tnum') ? 'font-variant-numeric: tabular-nums;' : ''].join(' ');
};

const href = (file) => pathToFileURL(path.join(root, file)).href;
const rowHtml = (item, index) => `<div class="row" id="r${index}" style="font-family: var(--font-${item.family === 'display' ? 'display' : 'ui'}); font-weight: ${item.weight}; font-size: ${item.size}px; line-height: ${item.lineHeight}px; letter-spacing: ${item.tracking / 1000}em; ${featureSettings(item.features)}">${escapeHtml(item.text)}</div>`;

fs.mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ args: ['--allow-file-access-from-files', ...(grayscale ? ['--disable-lcd-text'] : [])] });
const measurements = [];
try {
  const context = await browser.newContext({ deviceScaleFactor: scale, viewport: { width: PAGE_WIDTH, height: PAGE_ROWS * ROW_HEIGHT }, colorScheme: theme });
  const page = await context.newPage();
  const session = await context.newCDPSession(page);
  await session.send('DOM.enable');
  await session.send('CSS.enable');
  for (let first = 0, pageNumber = 0; first < items.length; first += PAGE_ROWS, pageNumber += 1) {
    const rows = items.slice(first, first + PAGE_ROWS);
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<link rel="stylesheet" href="${href('src/styles/tokens.css')}"><link rel="stylesheet" href="${href('src/styles/base/fonts.css')}">
<style>html, body { margin: 0; background: ${background}; color: ${foreground}; font-synthesis: none; }
.row { box-sizing: border-box; height: ${ROW_HEIGHT}px; padding-left: ${LEFT}px; white-space: pre; overflow: hidden; }</style></head>
<body>${rows.map((item, index) => rowHtml(item, index)).join('')}</body></html>`;
    const pageFile = path.join(outDir, `${prefix}-page-${theme}-${scale}-p${pageNumber}.html`);
    fs.writeFileSync(pageFile, html);
    await page.goto(pathToFileURL(pageFile).href);
    await page.evaluate(() => document.fonts.ready);
    // Subsets load when a glyph needs them: wait until every face that started loading has finished.
    await page.evaluate(async () => { await Promise.all([...document.fonts].filter((face) => face.status === 'loading').map((face) => face.loaded)); await document.fonts.ready; });
    const widths = await page.evaluate(() => [...document.querySelectorAll('.row')].map((row) => {
      const range = document.createRange();
      range.selectNodeContents(row);
      return range.getBoundingClientRect().width;
    }));
    const { root: documentRoot } = await session.send('DOM.getDocument', { depth: 0 });
    for (let index = 0; index < rows.length; index += 1) {
      const { nodeId } = await session.send('DOM.querySelector', { nodeId: documentRoot.nodeId, selector: `#r${index}` });
      const { fonts } = await session.send('CSS.getPlatformFontsForNode', { nodeId });
      measurements.push([rows[index].id, widths[index], fonts.map((font) => `${font.familyName}:${font.glyphCount}`).join('|')].join('\t'));
    }
    await page.screenshot({ path: path.join(outDir, `${prefix}-${theme}-${scale}-p${pageNumber}.png`), clip: { x: 0, y: 0, width: PAGE_WIDTH, height: rows.length * ROW_HEIGHT } });
    fs.rmSync(pageFile);
  }
} finally {
  await browser.close();
}
fs.writeFileSync(path.join(outDir, `${prefix}-${theme}-${scale}.tsv`), `${measurements.join('\n')}\n`);
console.log(`chromium: ${items.length} rows, ${theme}, scale ${scale}${grayscale ? ', grayscale' : ''}`);
