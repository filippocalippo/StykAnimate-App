/** Actual native WebM UI, codec dialog coexistence, and independently decoded alpha. */
import {_electron as electron} from 'playwright';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import assert from 'node:assert/strict';
import backend from '../desktop/backend.cjs';

const root = path.resolve(import.meta.dirname, '..'), output = path.join(root, 'artifacts', 'webm-alpha-renderer'); await mkdir(output, {recursive: true});
const app = await electron.launch({args: [root], cwd: root, timeout: 45000, env: {...process.env, STYK_USER_DATA_DIR: path.join(output, `profile-${Date.now()}`)}});
try {
  const page = await app.firstWindow(), errors = [], checks = []; page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => window.styk?.ready && window.stykDesktop?.beginVfwExport, undefined, {timeout: 30000});
  await app.evaluate(({ipcMain}) => {
    const original = ipcMain._invokeHandlers.get('styk:video-begin'); globalThis.__videoOptions = [];
    ipcMain.removeHandler('styk:video-begin'); ipcMain.handle('styk:video-begin', (event, options) => { globalThis.__videoOptions.push({...options}); return original(event, options); });
  });
  await page.evaluate(async () => {
    const {emptyDocument, createFrame, createObject} = await import('/src/demo.mjs'), report = emptyDocument(), figure = report.figure_types[0];
    report.canvas_width = 64; report.canvas_height = 36; report.fps = 16;
    figure.segments = [{...figure.segments[0], angle_rad: 0, length: 32, thickness: 8, transparency: 128, color_alpha: 127 / 255, color_rgb: [245, 20, 30]}]; figure.segment_count = 1;
    report.keyframes = [createFrame([createObject(figure, 1, 12, 10)], 5), createFrame([createObject(figure, 1, 12, 26)], 1)];
    for (const frame of report.keyframes) frame._stykBackgroundColor = 0;
    window.styk.editor.load(report); window.styk.editor.markSaved();
  });
  await page.locator('[data-action="export"]').first().click(); await page.locator('.export-settings > summary').click();
  await page.waitForFunction(() => !document.querySelector('#export-vfw-codec')?.disabled, undefined, {timeout: 30000});
  const caps = await page.evaluate(async () => (await import('/src/export-capabilities.mjs')).getExportCapabilities({width: 64, height: 36, fps: 16}));
  const webm = caps.formats.find(format => format.id === 'webm'); assert.equal(webm.supported, true); assert.equal(webm.provider, 'FFmpeg'); checks.push('Desktop capability selects the actual FFmpeg WebM provider');
  await page.waitForFunction(() => document.querySelector('#export-mp4-codec')?.options.length >= 2 && document.querySelector('#export-avi-codec')?.options.length >= 3, undefined, {timeout: 30000});
  const installedId = await page.evaluate(async () => (await window.stykDesktop.getVfwCapabilities({width: 64, height: 36})).codecs.find(codec => codec.arch === 'x86' && codec.supported && codec.configure).id);
  await page.locator('#export-vfw-codec').selectOption(installedId); await page.locator('#export-vfw-configure').click();
  const python = backend.pythonCandidates()[0], configuration = JSON.parse(execFileSync(python.command, [...python.args, path.join(root, 'tests/vfw-owned-dialog-cancel.py'), '--parent', String(await app.evaluate(() => process.pid))], {windowsHide: true, encoding: 'utf8', timeout: 15000}));
  await page.waitForFunction(() => document.querySelector('.vfw-config-state')?.textContent === 'Custom codec settings');
  const codecOptions = await page.evaluate(() => Object.fromEntries(['mp4', 'avi'].map(format => { const select = document.querySelector(`#export-${format}-codec`); return [format, {value: select.value, disabled: select.disabled, labels: [...select.options].map(option => option.label)}]; })));
  assert.ok(codecOptions.mp4.value && codecOptions.avi.value && !codecOptions.mp4.disabled && !codecOptions.avi.disabled); checks.push('MP4 and AVI codec choices remain populated and usable after the native Configure dialog');
  await page.locator('#export-webm-bitrate').fill('0.25'); await page.locator('#export-quality').fill('90');
  assert.equal(await page.locator('[data-action="export-video"]').getAttribute('data-provider'), 'FFmpeg'); checks.push('Actual WebM export tile routes to the native alpha-capable provider');
  assert.ok(await page.locator('#dialog').evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth + 1));
  await page.screenshot({path: path.join(output, 'controls.png')});
  const destination = path.join(output, 'transparent.webm'); await app.evaluate(({dialog}, filename) => { dialog.showSaveDialog = async () => ({canceled: false, filePath: filename}); }, destination);
  await page.locator('[data-action="export-video"]').click(); await page.waitForFunction(() => !document.querySelector('#dialog').open, undefined, {timeout: 30000});
  const bytes = await readFile(destination), requests = await app.evaluate(() => globalThis.__videoOptions), request = requests.at(-1);
  assert.ok(bytes.length > 256); assert.equal(request.format, 'webm'); assert.equal(request.bitrate, 250000); checks.push('Actual Save produces WebM and forwards the entered 250 kbit/s bitrate');
  const ffmpeg = path.join(root, 'build', 'video-encoder', 'ffmpeg.exe');
  const decoded = execFileSync(ffmpeg, ['-v', 'error', '-c:v', 'libvpx-vp9', '-threads', '1', '-i', destination, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-threads', '1', 'pipe:1'], {windowsHide: true, maxBuffer: 2 * 1024 * 1024});
  assert.equal(decoded.length, 64 * 36 * 4 * 6); checks.push('Independent libvpx-vp9 decode returns all six ordered RGBA frames');
  const pixel = (frame, x, y) => [...decoded.subarray(((frame * 36 + y) * 64 + x) * 4, ((frame * 36 + y) * 64 + x) * 4 + 4)];
  const probes = {corner: pixel(0, 0, 0), first: pixel(0, 24, 10), final: pixel(5, 24, 26), oldPosition: pixel(5, 24, 10)};
  assert.equal(probes.corner[3], 0); assert.equal(probes.oldPosition[3], 0); assert.ok(Math.abs(probes.first[3] - 127) <= 2 && Math.abs(probes.final[3] - 127) <= 2);
  assert.ok(probes.first[0] > 220 && probes.first[1] < 50 && probes.first[2] < 60); checks.push('Native UI WebM preserves transparent background, partial opacity and animated figure position');
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-c:v', 'libvpx-vp9', '-i', destination, '-frames:v', '1', path.join(output, 'decoded-first.png')], {windowsHide: true});
  assert.deepEqual(errors, []); await writeFile(path.join(output, 'report.json'), JSON.stringify({checks, request, webm, codecOptions, configuration, bytes: bytes.length, frames: 6, probes, errors}, null, 2)); console.log(JSON.stringify({checks: checks.length, probes, errors}));
} finally { await app.close(); }
