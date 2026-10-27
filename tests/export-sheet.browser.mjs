/**
 * Browser test of the export dialog (src/export-sheet.mjs): what it shows at
 * rest, Format and Type from the pointer and the keyboard, the quick presets, Size presets and
 * Custom…, the trim strip and its From and To fields, Quality, Encoding
 * (remembered open), the preview, remembered choices, the Project list,
 * "Stop exporting?" while an export runs, and a
 * palette command that exports today's defaults with its progress in its own
 * dialog. Serve the repository (node scripts/serve.mjs --port 47832) and run
 * `node tests/export-sheet.browser.mjs`; STYK_URL overrides the address.
 */
import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {EXPORT_FIELD_IDS, EXPORT_ELEMENT_IDS} from '../src/export-request.mjs';
import {chooseExport, exportDialogClosed, openEncoding} from './helpers/export-dialog.mjs';

const base = process.env.STYK_URL || 'http://127.0.0.1:47832';
const browser = await chromium.launch({channel: 'chrome', headless: true});
const page = await browser.newPage({viewport: {width: 1440, height: 900}, acceptDownloads: true});
// Headless Chrome aborts showSaveFilePicker, so an export would wait on a picker; without it the export takes the download path.
await page.addInitScript(() => { delete window.showSaveFilePicker; });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.setDefaultTimeout(10000);
const step = async (name, run) => {
  try { await run(); console.log(`ok ${name}`); } catch (error) { console.log(`not ok ${name}`); throw error; }
};
const open = async () => {
  await page.locator('.titlebar [data-action="export"]').click();
  await page.locator('#export-dialog[open]').waitFor();
};
const value = selector => page.locator(selector).inputValue();
const attribute = (selector, name) => page.locator(selector).getAttribute(name);
const checked = selector => page.locator(`${selector} [aria-checked="true"]`).evaluate(item => item.dataset.category ?? item.dataset.value ?? item.dataset.format);

try {
  // Headless Chrome aborts showSaveFilePicker; without it an export saves through a download.
  await page.addInitScript(() => {
    delete window.showSaveFilePicker;
    // This suite explicitly exercises a browser without H.264; Chrome support
    // varies by installation, so preserve the real WebM encoder and control MP4.
    const supported = window.VideoEncoder?.isConfigSupported.bind(window.VideoEncoder);
    if (supported) window.VideoEncoder.isConfigSupported = config => config.codec.startsWith('avc')
      ? Promise.resolve({supported:false,config}) : supported(config);
  });
  await page.goto(base);
  await page.waitForFunction(() => window.styk?.ready, null, {timeout: 60000});
  const total = await page.evaluate(async () => {
    const {createDemo} = await import('/src/demo.mjs');
    styk.editor.load(createDemo(), 'Kick combo'); styk.editor.markSaved(); styk.fit();
    return styk.editor.totalTicks;
  });
  assert.ok(total > 20, `the demo animation has frames (${total})`);

  await step('at rest: Name, Format, Type, Size, Quality and Picture show; Encoding is closed; the primary names the type', async () => {
    await open();
    assert.equal(await page.evaluate(() => document.activeElement.id), 'export-name');
    assert.equal(await value('#export-name'), 'Kick combo');
    assert.equal(await page.locator('.export-extension').textContent(), '.webm');
    assert.equal(await checked('#export-format'), 'video');
    assert.equal(await value('#output-format'), 'export-video');
    assert.equal(await value('#export-resolution'), 'original');
    assert.match(await page.locator('#export-resolution option:checked').textContent(), /^Original · 960 × 540$/);
    assert.equal(await attribute('#export-video-quality', 'data-value'), 'recommended');
    for (const selector of ['#output-format', '#export-resolution', '#export-video-quality', '#export-smoothing', '#export-start', '#export-end'])
      assert.ok(await page.locator(selector).isVisible(), `${selector} is visible`);
    assert.equal(await attribute('#export-encoding-toggle', 'aria-expanded'), 'false');
    assert.equal(await page.locator('#export-bitrate-mode').isVisible(), false);
    assert.equal(await page.locator('#export-width').isVisible(), false, 'Width waits for Custom…');
    assert.equal(await page.locator('#export-submit').textContent(), 'Export WebM');
    assert.ok(await page.locator('#export-submit').isEnabled());
    assert.match(await page.locator(`#${EXPORT_ELEMENT_IDS.summaryTime}`).textContent(), new RegExp(`^${total} frames · `));
    // Every id the tests and the request use is in the dialog (progress and Cancel arrive with an export; Windows codecs on desktop only).
    const ids = [...Object.values(EXPORT_FIELD_IDS), ...Object.values(EXPORT_ELEMENT_IDS)].filter(id => !id.startsWith('export-vfw') && !['export-progress', 'cancel-export'].includes(id));
    assert.deepEqual(await page.evaluate(ids => ids.filter(id => !document.querySelector(`#export-dialog #${id}`)), ids), []);
    // No lime and no second ink button: the primary is the dialog's one filled button.
    assert.equal(await page.locator('#export-dialog [data-variant="primary"]').count(), 1);
  });

  await step('the preview draws the first exported frame and the strip its thumbnails', async () => {
    await page.waitForFunction(() => {
      const canvases = [...document.querySelectorAll('#export-dialog .ui-export-stage canvas, #export-dialog .ui-range-strip canvas')];
      const inked = canvas => { const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data; for (let i = 0; i < data.length; i += 4) if (data[i] < 120) return true; return false; };
      return canvases.length === 9 && canvases.every(inked);
    }, null, {timeout: 20000});
  });

  await step('Format and Type: the pointer and the arrow keys choose them; each type keeps its own settings', async () => {
    await page.locator('#export-format [data-category="animated"]').click();
    assert.deepEqual([await checked('#export-format'), await value('#output-format'), await page.locator('#export-submit').textContent()], ['animated', 'export-gif', 'Export GIF']);
    assert.ok(await page.locator('#export-gif-dither').isVisible(), 'GIF shows Colours › Dither');
    assert.equal(await page.locator('#export-video-quality').isVisible(), false);
    await page.locator('#export-format [data-category="animated"]').focus();
    await page.keyboard.press('ArrowRight');
    assert.deepEqual([await checked('#export-format'), await value('#output-format')], ['frames', 'export-png']);
    assert.match(await page.locator('.export-caption-label').textContent(), /^Current frame · 1$/);
    assert.equal(await page.locator('#export-start').isVisible(), false, 'a single frame has no range');
    await chooseExport(page, 'export-jpeg-sequence');
    assert.ok(await page.locator('#export-quality').isVisible(), 'JPEG sequence shows its quality');
    await page.keyboard.press('ArrowLeft');
    await page.locator('#export-format [data-category="animated"]').click();
    assert.equal(await value('#output-format'), 'export-gif', 'a category remembers the type chosen in it');
  });

  await step('Project lists its four types; arrow keys choose; an unavailable one says why and stays unchosen', async () => {
    await page.evaluate(() => styk.editor.select(1));
    await page.locator('#export-format [data-category="editable"]').click();
    assert.equal(await page.locator('#output-format').isVisible(), false);
    assert.deepEqual(await page.locator('#export-project-type .export-type').evaluateAll(items => items.map(item => item.dataset.format)), ['piv', 'stkz', 'stk', 'stykmov']);
    assert.equal(await checked('#export-project-type'), 'piv');
    await page.locator('#export-project-type [data-format="piv"]').focus();
    await page.keyboard.press('ArrowDown');
    assert.equal(await checked('#export-project-type'), 'stkz');
    const movieclip = page.locator('#export-project-type [data-format="stykmov"]');
    assert.equal(await movieclip.getAttribute('aria-disabled'), 'true');
    assert.equal(await movieclip.getAttribute('data-tooltip'), 'Select a movieclip to export it.');
    await movieclip.click({force: true});
    assert.equal(await checked('#export-project-type'), 'stkz');
    assert.equal(await page.locator('#export-submit').textContent(), 'Export STKZ');
    assert.equal(await page.locator('#export-resolution').isVisible(), false, 'a project has no pixel size');
  });

  await step('Size: presets keep the artboard shape; Custom… shows Width, Lock ratio and Height', async () => {
    await chooseExport(page, 'export-video');
    await page.locator('#export-resolution').selectOption('1080');
    assert.deepEqual([await value('#export-width'), await value('#export-height')], ['1920', '1080']);
    assert.match(await page.locator(`#${EXPORT_ELEMENT_IDS.summarySize}`).textContent(), /1.?920 × 1.?080 px/);
    await page.locator('#export-resolution').selectOption('custom');
    assert.ok(await page.locator('#export-width').isVisible());
    await page.locator('#export-width').fill('480');
    assert.equal(await value('#export-height'), '270', 'Lock ratio keeps the shape');
    await page.locator('#export-aspect').uncheck();
    await page.locator('#export-height').fill('300');
    assert.deepEqual([await value('#export-width'), await value('#export-height')], ['480', '300']);
    await page.locator('#export-width').fill('abc');
    assert.ok(await page.locator('#export-submit').isDisabled());
    assert.equal(await attribute('#export-width', 'aria-invalid'), 'true');
    assert.ok(await page.locator('#export-validation').isVisible());
    await page.locator('#export-resolution').selectOption('original');
    assert.ok(await page.locator('#export-submit').isEnabled());
  });

  await step('Frames: the trim ends and the typed From and To are one range; All restores it', async () => {
    const end = page.locator('.ui-range-handle[data-edge="end"]'), start = page.locator('.ui-range-handle[data-edge="start"]');
    await end.focus();
    await page.keyboard.press('Shift+ArrowLeft');
    assert.equal(await value('#export-end'), String(total - 10));
    assert.equal(await end.getAttribute('aria-valuenow'), String(total - 10));
    await page.locator('#export-start').fill('5');
    assert.equal(await start.getAttribute('aria-valuenow'), '5');
    assert.match(await page.locator(`#${EXPORT_ELEMENT_IDS.summaryTime}`).textContent(), new RegExp(`^${total - 14} frames`));
    // Dragging the start end past the other stops at it.
    const box = await page.locator('.ui-range-strip').boundingBox(), handle = await start.boundingBox();
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down(); await page.mouse.move(box.x + box.width - 2, handle.y + handle.height / 2, {steps: 4}); await page.mouse.up();
    assert.equal(await value('#export-start'), String(total - 10));
    await page.locator('#export-start').fill('9'); await page.locator('#export-end').fill('3');
    assert.ok(await page.locator('#export-submit').isDisabled());
    assert.match(await page.locator('#export-validation').textContent(), /frame range/);
    await page.locator('#export-all-frames').click();
    assert.deepEqual([await value('#export-start'), await value('#export-end')], ['1', String(total)]);
    assert.equal(await page.locator('#export-all-frames').isVisible(), false);
  });

  await step('Quality is one click, and the arrow keys move it', async () => {
    await page.locator('#export-video-quality [data-value="high"]').click();
    assert.equal(await attribute('#export-video-quality', 'data-value'), 'high');
    await page.keyboard.press('ArrowLeft');
    assert.equal(await attribute('#export-video-quality', 'data-value'), 'recommended');
  });

  await step('the preview plays the range and pauses', async () => {
    const snapshot = () => page.locator('#export-dialog .ui-export-stage canvas').evaluate(canvas => canvas.toDataURL());
    const first = await snapshot();
    await page.locator('#export-play').click();
    assert.equal(await attribute('#export-play', 'aria-pressed'), 'true');
    await page.waitForFunction(first => document.querySelector('#export-dialog .ui-export-stage canvas').toDataURL() !== first, first, {timeout: 10000});
    await page.locator('#export-play').click();
    assert.equal(await attribute('#export-play', 'aria-pressed'), 'false');
  });

  await step('Encoding opens in place and stays open the next time; Escape closes the dialog', async () => {
    await openEncoding(page);
    assert.ok(await page.locator('#export-bitrate-mode').isVisible());
    assert.match(await page.locator('.export-encoding-summary').textContent(), /automatic bitrate$/);
    await page.keyboard.press('Escape');
    await exportDialogClosed(page);
    await open();
    assert.equal(await attribute('#export-encoding-toggle', 'aria-expanded'), 'true');
    await page.locator('#export-encoding-toggle').click();
    await page.locator('#export-dialog .ui-dialog-foot button:not([data-primary])').click();
    await exportDialogClosed(page);
  });

  await step('quick presets fill in the settings, say what the export will be, and leave when a setting they chose changes', async () => {
    await open();
    const preset = () => page.locator('#export-presets [aria-checked="true"]').evaluate(item => item.dataset.preset).catch(() => null);
    assert.equal(await preset(), null, 'no preset is chosen at rest');
    assert.equal(await page.locator('#export-type-hint').textContent(), 'An open video format for browsers and web pages.');
    await page.locator('[data-preset="youtube"]').click();
    // The browser has no MP4 encoder, so YouTube uses WebM; the settings it chose are the dialog's own controls.
    assert.deepEqual([await preset(), await value('#output-format'), await value('#export-resolution'), await attribute('#export-video-quality', 'data-value')],
      ['youtube', 'export-video', '1080', 'high']);
    assert.equal(await page.locator('#export-preset-note').textContent(), 'Ready for YouTube: 1920 × 1080.');
    assert.match(await page.locator('#export-quality-hint').textContent(), /^The most detail/);
    // A vertical platform on this landscape canvas: the note warns of bars and the preview takes the phone's shape.
    await page.locator('[data-preset="youtube"]').focus();
    await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight');
    assert.equal(await preset(), 'tiktok');
    assert.equal(await page.locator('#export-preset-note').getAttribute('data-fits'), 'false');
    assert.match(await page.locator('#export-preset-note').textContent(), /vertical \(9:16\).*bars.*Canvas size/);
    assert.equal(await attribute('#export-dialog .ui-export-stage', 'data-frame'), 'portrait');
    // An MP4-only platform keeps MP4 and says why it cannot export here.
    await page.locator('[data-preset="instagram"]').click();
    assert.equal(await value('#output-format'), 'export-mp4');
    assert.ok(await page.locator('#export-submit').isDisabled());
    // Changing a setting the preset chose leaves it; the name does not.
    await page.locator('[data-preset="gif"]').click();
    await page.locator('#export-name').fill('chat loop');
    assert.equal(await preset(), 'gif');
    assert.equal(await attribute('#export-dialog .ui-export-stage', 'data-frame'), null);
    assert.equal(await page.locator('#export-type-hint').textContent(), 'Loops in chats, forums and web pages. Up to 256 colours a frame.');
    await page.locator('[data-preset="youtube"]').click();
    await page.locator('#export-video-quality [data-value="small"]').click();
    assert.equal(await preset(), null);
    assert.equal(await page.locator('#export-preset-note').isVisible(), false);
    // The chat GIF saves at 480 pixels on its short side.
    await page.locator('[data-preset="gif"]').click();
    assert.deepEqual([await value('#export-width'), await value('#export-height')], ['853', '480']);
    const download = page.waitForEvent('download');
    await page.locator('#export-submit').click();
    const file = await download;
    assert.equal(file.suggestedFilename(), 'chat loop.gif');
    const bytes = await readFile(await file.path());
    assert.deepEqual([bytes.subarray(0, 6).toString('latin1'), bytes.readUInt16LE(6), bytes.readUInt16LE(8)], ['GIF89a', 853, 480]);
    await exportDialogClosed(page);
  });

  await step('an export remembers the format and size; the range and the name start over', async () => {
    await open();
    assert.equal(await attribute('#export-encoding-toggle', 'aria-expanded'), 'false');
    await chooseExport(page, 'export-gif');
    await page.locator('#export-resolution').selectOption('720');
    await page.locator('#export-start').fill('2'); await page.locator('#export-end').fill('4');
    await page.locator('#export-name').fill('walk cycle');
    const download = page.waitForEvent('download');
    await page.locator('#export-submit').click();
    const file = await download;
    assert.equal(file.suggestedFilename(), 'walk cycle.gif');
    await exportDialogClosed(page);
    await open();
    assert.deepEqual([await checked('#export-format'), await value('#output-format'), await value('#export-resolution')], ['animated', 'export-gif', '720']);
    assert.deepEqual([await value('#export-start'), await value('#export-end'), await value('#export-name')], ['1', String(total), 'Kick combo']);
    await page.keyboard.press('Escape');
    await exportDialogClosed(page);
  });

  await step('while exporting, Escape and × ask "Stop exporting?"; Keep exporting goes on and the question leaves when the file is saved', async () => {
    // Slow the render worker's frames so the export is still running while the question is asked.
    await page.evaluate(() => {
      window.slowRenders = true;
      const post = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function(message, ...rest) {
        if (window.slowRenders && message?.operation === 'render') setTimeout(() => post.call(this, message, ...rest), 300);
        else post.call(this, message, ...rest);
      };
    });
    await open();
    await chooseExport(page, 'export-apng');
    await page.locator('#export-start').fill('1'); await page.locator('#export-end').fill('6');
    let downloads = 0;
    const count = () => downloads++;
    page.on('download', count);
    const saved = page.waitForEvent('download', {timeout: 30000});
    await page.locator('#export-submit').click();
    await page.locator('#cancel-export').waitFor();
    await page.keyboard.press('Escape');
    await page.locator('#export-stop[open]').waitFor();
    assert.equal(await page.locator('#export-stop .ui-dialog-title').textContent(), 'Stop exporting?');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'keep-exporting', 'the safe choice starts focused');
    await page.locator('#keep-exporting').click();
    assert.equal(await page.locator('#export-stop').count(), 0);
    assert.ok(await page.locator('#export-dialog[open] #export-progress').isVisible(), 'the export goes on');
    await page.locator('#export-dialog .ui-dialog-close').click();
    await page.locator('#export-stop[open]').waitFor();
    await saved;
    await exportDialogClosed(page);
    assert.equal(await page.locator('#export-stop').count(), 0, 'the question leaves with the finished export');
    page.off('download', count);
    assert.equal(downloads, 1);
  });

  await step('Stop exporting stops the export and saves nothing', async () => {
    await open();
    assert.equal(await value('#output-format'), 'export-apng');
    let downloads = 0;
    const count = () => downloads++;
    page.on('download', count);
    await page.locator('#export-submit').click();
    await page.locator('#cancel-export').waitFor();
    await page.keyboard.press('Escape');
    await page.locator('#stop-export').click();
    await exportDialogClosed(page);
    await page.waitForFunction(() => /cancelled/i.test(document.querySelector('#status')?.textContent ?? ''));
    await page.waitForTimeout(1500);
    page.off('download', count);
    assert.equal(downloads, 0);
    await page.evaluate(() => { window.slowRenders = false; });
  });

  await step('a palette command exports today\'s defaults, with its progress in a dialog of its own', async () => {
    const download = page.waitForEvent('download');
    await page.evaluate(() => { window.pendingExport = styk.actions['export-png'](); });
    const file = await download;
    const bytes = Buffer.from(await (await import('node:fs/promises')).readFile(await file.path()));
    assert.deepEqual([bytes.readUInt32BE(16), bytes.readUInt32BE(20)], [960, 540], 'the artboard size, not the remembered 720p');
    await page.evaluate(() => window.pendingExport);
    await exportDialogClosed(page);
  });

  await step('with installed Windows codecs, Windows AVI stays chosen, shows its codec rows, and typing is never undone', async () => {
    // A stand-in for the Windows app's codec check: its controls follow every input event in the dialog.
    const windows = await browser.newPage({viewport: {width: 1440, height: 900}});
    windows.on('pageerror', error => errors.push(error.message));
    await windows.addInitScript(() => {
      window.stykDesktop = {getVfwCapabilities: async () => ({platform: 'win32', codecs: [{id: 'vfw:x86:63766964', label: 'Cinepak', fourcc: 'cvid',
        provider: 'Radius', arch: 'x86', kind: 'installed', supported: true, quality: true, keyframes: true, dataRate: true, configure: true}]})};
    });
    await windows.goto(base);
    await windows.waitForFunction(() => window.styk?.ready, null, {timeout: 60000});
    await windows.locator('.titlebar [data-action="export"]').click();
    await windows.locator('#export-dialog[open]').waitFor();
    await chooseExport(windows, 'export-vfw');
    assert.equal(await windows.locator('#output-format').inputValue(), 'export-vfw');
    await openEncoding(windows);
    await windows.waitForFunction(() => !document.querySelector('#export-vfw-codec')?.disabled);
    assert.ok(await windows.locator('#export-vfw-configure').isEnabled());
    assert.match(await windows.locator('.export-encoding-summary').textContent(), /^Cinepak/);
    assert.deepEqual([await windows.locator('#export-submit').textContent(), await windows.locator('#export-submit').isEnabled()], ['Export AVI', true]);
    await windows.locator('#export-vfw-quality').fill('75');
    assert.equal(await windows.locator('#output-format').inputValue(), 'export-vfw');
    await chooseExport(windows, 'export-video');
    await windows.locator('#export-bitrate-mode').selectOption('manual');
    await windows.locator('#export-video-bitrate').fill('');
    await windows.locator('#export-video-bitrate').pressSequentially('0.25');
    assert.equal(await windows.locator('#export-video-bitrate').inputValue(), '0.25');
    await windows.locator('#export-resolution').selectOption('custom');
    await windows.locator('#export-aspect').uncheck();
    assert.equal(await windows.locator('#export-aspect').isChecked(), false);
    await windows.close();
  });

  assert.deepEqual(errors, []);
  console.log('export sheet browser test passed');
} finally {
  await browser.close();
}
