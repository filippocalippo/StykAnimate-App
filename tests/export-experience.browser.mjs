import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import backend from '../desktop/web-host.cjs';
const output = path.resolve('artifacts/export-experience');
await mkdir(output, {recursive: true});
const service = await backend.startDesktopHost({appRoot: process.cwd()}); let browser;
const checks = [], errors = [];
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
    styk.editor.load(report, 'Export experience'); styk.fit();
  });
  const open = () => page.locator('[data-action="export"]').first().click();
  // A Project lists its types; the other formats choose theirs in the Type select.
  const choose = async (category, action) => {
    await page.locator(`[data-category="${category}"]`).click();
    if (category === 'editable') await page.locator(`#export-project-type [data-format="${action.slice('export-'.length)}"]`).click();
    else await page.locator('#output-format').selectOption(action);
  };
  await open(); await choose('animated', 'export-apng');
  await page.locator('#export-resolution').selectOption('2160');
  check('the preview and the settings sit side by side', await page.locator('#export-dialog').evaluate(dialog => {
    const form = dialog.querySelector('.ui-dialog-body'), preview = dialog.querySelector('.ui-export-preview').getBoundingClientRect(), body = form.getBoundingClientRect();
    return preview.right <= body.left + 1 && preview.top <= body.top && body.width >= 400 && form.scrollWidth <= form.clientWidth;
  }));
  check('4K preset preserves aspect ratio', await page.locator('#export-width').inputValue() === '3840' && await page.locator('#export-height').inputValue() === '2160');
  const summarySize = await page.locator('#export-summary-size').innerText(), summaryTime = await page.locator('#export-summary-time').innerText();
  check('summary includes dimensions, frame count and frame rate', /3.?840.*2.?160/.test(summarySize) && /3 frames.*fps/.test(summaryTime));
  await page.locator('#export-start').fill('3'); await page.locator('#export-end').fill('1');
  check('invalid range is explained inline and blocks submission', await page.locator('#export-submit').isDisabled() && await page.locator('#export-validation').isVisible());
  await page.locator('#export-all-frames').click();
  check('entire animation restores a valid range', await page.locator('#export-start').inputValue() === '1' && await page.locator('#export-end').inputValue() === '3' && await page.locator('#export-submit').isEnabled());
  await page.locator('#export-resolution').selectOption('custom');
  await page.locator('#export-width').fill('16384');
  check('unsafe allocation is blocked before starting a job', await page.locator('#export-submit').isDisabled());
  await page.locator('#export-resolution').selectOption('2160');
  await page.screenshot({path: path.join(output, 'panel-light.png')});
  await choose('frames', 'export-png');
  check('current frame export hides the animation range', !await page.locator('#export-start').isVisible() && /Current frame/.test(await page.locator('#export-summary-time').innerText()));
  await choose('frames', 'export-svg'); check('vector export hides raster quality', !await page.locator('#export-smoothing').isVisible());
  await choose('editable', 'export-piv'); check('editable exports hide pixel settings', !await page.locator('#export-width').isVisible());
  await choose('animated', 'export-apng');
  for (const viewport of [{width: 1100, height: 680}, {width: 540, height: 700}]) {
    await page.setViewportSize(viewport);
    check(`panel and submit fit ${viewport.width}×${viewport.height}`, await page.locator('#export-dialog').evaluate(dialog => {
      const r = dialog.getBoundingClientRect(), body = dialog.querySelector('.ui-dialog-body'), button = dialog.querySelector('#export-submit').getBoundingClientRect();
      return r.top >= 0 && r.bottom <= innerHeight && body.scrollWidth <= body.clientWidth && button.bottom <= innerHeight;
    }));
    await page.screenshot({path: path.join(output, `panel-${viewport.width}.png`)});
  }
  await page.setViewportSize({width: 1280, height: 900});
  await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
  await page.screenshot({path: path.join(output, 'panel-dark.png')});
  // Delay the real worker's frame requests so each state can be observed without
  // substituting fake rendered frames or encoder completion messages.
  await page.evaluate(() => {
    const original = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function(message, ...rest) {
      if (message.operation === 'render') setTimeout(() => original.call(this, message, ...rest), 250);
      else original.call(this, message, ...rest);
    };
  });
  const download = page.waitForEvent('download'); await page.locator('#export-submit').click();
  await page.waitForFunction(() => document.querySelector('#export-rendered')?.textContent === '1 / 3');
  check('progress counts actual rendered and remaining frames', await page.locator('#export-remaining').innerText() === '2');
  check('progress names the animation frame and total', /frame.*of 3.*Animation frame/.test(await page.locator('#export-frame-detail').innerText()));
  check('progress does not claim completion before saving', Number(await page.locator('#export-progress').getAttribute('value')) < 100);
  await page.screenshot({path: path.join(output, 'progress-dark.png')});
  await (await download).saveAs(path.join(output, '4k-apng.png'));
  check('actual 4K export completed', true);
  await open(); await choose('animated', 'export-gif'); await page.locator('#export-resolution').selectOption('original');
  const gif = page.waitForEvent('download'); await page.locator('#export-submit').click();
  await page.waitForFunction(() => document.querySelector('#export-pass-note')?.textContent.startsWith('Pass 2 of 2'));
  check('GIF exposes its second pass without doubling output frame count', /of 3/.test(await page.locator('#export-frame-detail').innerText()));
  await (await gif).saveAs(path.join(output, 'animation.gif'));
  await open(); await choose('animated', 'export-apng'); await page.locator('#export-submit').click();
  await page.locator('#cancel-export').click(); await page.waitForFunction(() => !document.querySelector('#export-dialog'));
  check('cancellation returns control to the editor', /cancelled/i.test(await page.locator('#status').innerText()));
  check('no uncaught browser errors', errors.length === 0);
  await writeFile(path.join(output, 'report.json'), JSON.stringify({checks, errors}, null, 2));
} finally {await browser?.close(); await service.stop();}
