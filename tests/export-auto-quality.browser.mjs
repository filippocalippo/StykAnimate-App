import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import backend from '../desktop/web-host.cjs';
import {openEncoding} from './helpers/export-dialog.mjs';
const output = path.resolve('artifacts/export-auto-quality'); await mkdir(output, {recursive: true});
const service = await backend.startDesktopHost({appRoot: process.cwd()}); let browser;
const checks = [], errors = [], exports = [];
const check = (name, ok) => {assert.ok(ok, name); checks.push(name); console.log('PASS', name);};
try {
  browser = await chromium.launch({channel: 'chrome', headless: true});
  const page = await browser.newPage({viewport: {width: 1280, height: 900}, acceptDownloads: true});
  page.on('pageerror', error => errors.push(error.message));
  // Headless Chrome aborts showSaveFilePicker, so an export would wait on a picker; without it the export takes the
  // in-memory sink and saves through an anchor download, which runs the whole export flow.
  await page.addInitScript(() => { delete window.showSaveFilePicker; });
  await page.goto(service.origin); await page.waitForFunction(() => window.styk?.ready);
  await page.evaluate(async () => {
    const {samplingFixture} = await import('/tests/export-sampling-fixture.mjs');
    const report = samplingFixture(); report.canvas_width = 160; report.canvas_height = 90;
    styk.editor.load(report, 'Automatic quality'); styk.editor.markSaved();
    const configure = VideoEncoder.prototype.configure;
    window.videoConfigs = [];
    VideoEncoder.prototype.configure = function(config) {videoConfigs.push({...config}); return configure.call(this, config);};
  });
  const open = async () => {await page.locator('[data-action="export"]').first().click(); await page.locator('#output-format').selectOption('export-video');};
  async function save(name) {
    const waiting = page.waitForEvent('download'); await page.locator('#export-submit').click();
    await (await waiting).saveAs(path.join(output, name + '.webm'));
    const config = await page.evaluate(() => videoConfigs.at(-1)); exports.push({name, ...config}); return config;
  }
  await open();
  check('recommended quality is the default and technical controls are collapsed', await page.locator('#export-video-quality').getAttribute('data-value') === 'recommended'
    && !await page.locator('#export-bitrate-mode').isVisible() && !await page.locator('#export-video-bitrate').isVisible());
  await page.locator('#export-resolution').selectOption('1080');
  await page.screenshot({path: path.join(output, 'recommended.png')});
  const fullHD = await save('1080-recommended');
  await open(); await page.locator('#export-resolution').selectOption('2160');
  const uhd = await save('4k-recommended');
  check('actual 4K encoder receives a larger automatic bitrate than 1080p', uhd.width === 3840 && uhd.height === 2160 && uhd.bitrate > fullHD.bitrate);
  await open(); await page.locator('#export-resolution').selectOption('1080'); await page.locator('#export-video-quality [data-value="small"]').click();
  const small = await save('1080-small');
  await open(); await page.locator('#export-resolution').selectOption('1080'); await page.locator('#export-video-quality [data-value="high"]').click();
  const high = await save('1080-high');
  check('actual smaller and higher-quality exports receive ordered bitrate targets', small.bitrate < fullHD.bitrate && fullHD.bitrate < high.bitrate);
  await open(); await openEncoding(page);
  await page.locator('#export-bitrate-mode').selectOption('manual'); await page.locator('#export-video-bitrate').fill('0.25');
  await page.locator('#export-resolution').selectOption('1080');
  check('resizing preserves an explicit manual bitrate', await page.locator('#export-video-bitrate').inputValue() === '0.25');
  check('manual mode hides quality presets it overrides', !await page.locator('#export-video-quality').isVisible());
  const manual = await save('manual'); check('manual target reaches the encoder exactly', manual.bitrate === 250000);
  await open(); await openEncoding(page);
  await page.locator('#export-bitrate-mode').selectOption('manual'); await page.locator('#export-video-bitrate').fill('');
  check('invalid manual bitrate blocks export', await page.locator('#export-submit').isDisabled());
  await page.locator('#export-bitrate-mode').selectOption('auto');
  check('returning to automatic ignores a stale invalid manual field', await page.locator('#export-submit').isEnabled());
  await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
  await page.screenshot({path: path.join(output, 'advanced-dark.png')});
  const reset = await save('auto-reset'); check('return to auto sends a computed target', reset.bitrate > 250000);
  check('no uncaught errors', errors.length === 0);
  await writeFile(path.join(output, 'report.json'), JSON.stringify({checks, exports, errors}, null, 2));
} finally {await browser?.close(); await service.stop();}
