#!/usr/bin/env node
// Renders frames with the real StykAnimate app (its Canvas 2D renderer, same
// as compatibility mode) for visual comparison with the native engine.
//
//   STYK_PYTHON=.venv/bin/python node tools/reference-render.mjs <file> <outdir> <tick,tick,...> [WxH]
//
// Each tick is written as <outdir>/<name>-<tick>.ref.png, framed exactly like
// `styk render` (fit with a 40 px margin, centred).
import {mkdir, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
process.chdir(repo);
const {chromium} = await import(`${repo}/tests/support/playwright.mjs`);
// The app from source; it decodes the file in its own codec worker.
const {startDesktopHost} = createRequire(import.meta.url)(`${repo}/desktop/web-host.cjs`);

const [source, outdir, tickList, size] = process.argv.slice(2);
if (!source || !outdir || !tickList) {
  console.error('usage: node tools/reference-render.mjs <file> <outdir> <tick,...> [WxH]');
  process.exit(2);
}
const ticks = tickList.split(',').map(Number);
const name = path.basename(source, path.extname(source)).replace(/\s+/g, '_');
await mkdir(outdir, {recursive: true});
const backend = await startDesktopHost({appRoot: repo});
let browser;
try {
  browser = await chromium.launch({channel: 'chrome', headless: true});
  const page = await browser.newPage({viewport: {width: 1600, height: 1000}});
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(backend.origin);
  await page.waitForFunction(() => window.styk?.ready, null, {timeout: 120000});
  await page.evaluate(() => {for (const d of document.querySelectorAll('dialog[open]')) d.close(); styk.editor.markSaved();});
  await page.locator('#file-input').setInputFiles(path.resolve(source));
  const stem = path.basename(source, path.extname(source));
  await page.waitForFunction(n => !styk.state.importing && styk.editor.name === n, stem, {timeout: 300000});
  const [w, h] = size ? size.split('x').map(Number) : [0, 0];
  const images = await page.evaluate(async ({ticks, w, h}) => {
    const {createRenderer} = await import('/src/renderer.mjs');
    const editor = styk.editor, report = editor.report;
    const width = w || report.canvas_width + 80, height = h || report.canvas_height + 80;
    const canvas = document.createElement('canvas');
    canvas.style.cssText = `position:fixed;left:0;top:0;width:${width}px;height:${height}px;z-index:99999`;
    document.body.append(canvas);
    const renderer = await createRenderer(canvas, {forceCanvas2D: true, resources: styk.state.renderer?.resources});
    renderer.resize(width, height, 1);
    const zoom = Math.min((width - 40) / report.canvas_width, (height - 40) / report.canvas_height);
    const view = {x: width / 2 - report.canvas_width / 2 * zoom, y: height / 2 - report.canvas_height / 2 * zoom, scale: zoom};
    const out = [];
    const frameWait = () => new Promise(r => requestAnimationFrame(() => r()));
    for (const tick of ticks) {
      editor.seek(tick);
      const frame = editor.evaluatedFrame, geometry = editor.geometry;
      for (let pass = 0; pass < 6; pass++) {
        renderer.render({report, frame, geometry, view});
        await frameWait();
        await new Promise(r => setTimeout(r, pass < 2 ? 150 : 50));
      }
      renderer.render({report, frame, geometry, view});
      out.push({tick, data: canvas.toDataURL('image/png')});
    }
    renderer.destroy?.();
    return out;
  }, {ticks, w, h});
  for (const {tick, data} of images) {
    const file = path.join(outdir, `${name}-${tick}.ref.png`);
    await writeFile(file, Buffer.from(data.split(',')[1], 'base64'));
    console.log(file);
  }
  if (errors.length) console.error('page errors:', errors.slice(0, 5));
} finally {
  await browser?.close();
  backend.stop();
}
