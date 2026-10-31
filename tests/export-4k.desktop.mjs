/** Real source Electron UI -> worker -> native IPC/FFmpeg -> staged file save. */
import {_electron as electron} from './support/playwright.mjs';
import {spawnSync} from 'node:child_process';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {chooseExport, exportDialogClosed} from './helpers/export-dialog.mjs';
const root = process.cwd(), output = path.resolve('artifacts/export-4k');
await mkdir(output, {recursive: true});
const app = await electron.launch({args: [root], cwd: root, timeout: 45000,
  env: {...process.env, STYK_USER_DATA_DIR: path.join(output, `profile-${Date.now()}`)}});
const errors = [], runs = [];
try {
  const page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => window.styk?.ready, null, {timeout: 30000});
  await page.evaluate(() => {
    // Dismiss first-run overlays in this isolated test profile.
    const dismiss = () => document.querySelectorAll('dialog.release-splash[open], dialog.styk-privacy[open]').forEach(dialog => dialog.close());
    dismiss(); new MutationObserver(dismiss).observe(document.body, {subtree: true, childList: true, attributes: true, attributeFilter: ['open']});
  });
  await app.evaluate(({ipcMain}) => {
    const original = ipcMain._invokeHandlers.get('styk:video-begin');
    globalThis.exportQualityRequests = [];
    ipcMain.removeHandler('styk:video-begin');
    ipcMain.handle('styk:video-begin', (event, options) => {exportQualityRequests.push({...options}); return original(event, options);});
  });
  await page.evaluate(async () => {
    const {samplingFixture} = await import('/tests/export-sampling-fixture.mjs');
    const report = samplingFixture({kind: 'outline', opacity: .7});
    report.canvas_width = 160; report.canvas_height = 90;
    report.keyframes = Array.from({length: 12}, (_, i) => {
      const frame = structuredClone(report.keyframes[i % 3]);
      frame.objects[0].root_x = 20 + i * 6; return frame;
    });
    styk.editor.load(report, '4K export verification'); styk.editor.markSaved(); styk.fit();
    window.exportSource = styk.editor.report; window.exportRevision = styk.editor.revision;
  });
  for (const [format, smoothing] of [['mp4', 'sprites'], ['webm', 'edges'], ['mp4', 'none']]) {
    const file = path.join(output, `${format}-${smoothing}.${format}`);
    await app.evaluate(({dialog}, file) => {dialog.showSaveDialog = async () => ({canceled: false, filePath: file});}, file);
    await page.locator('[data-action="export"]').first().click();
    const action = format === 'webm' ? 'export-video' : `export-${format}`;
    await chooseExport(page, action);
    await page.locator('#export-resolution').selectOption('2160');
    await page.locator('#export-smoothing').selectOption(smoothing);
    assert.ok(await page.locator('#export-submit').isEnabled());
    assert.ok(await page.locator('#export-dialog').evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth));
    if (format === 'mp4' && smoothing === 'sprites') await page.screenshot({path: path.join(output, 'desktop-panel.png')});
    const start = performance.now(); await page.locator('#export-submit').click();
    await exportDialogClosed(page, 120000);
    const bytes = (await readFile(file)).length;
    assert.ok(bytes > 1000);
    const request = await app.evaluate(() => exportQualityRequests.at(-1));
    assert.equal(request.quality, 0.8); assert.equal(request.bitrate, undefined);
    assert.ok(await page.evaluate(() => styk.editor.report === exportSource && styk.editor.revision === exportRevision));
    const decoder = path.resolve('build/video-encoder/ffmpeg.exe');
    const decoded = spawnSync(decoder, ['-hide_banner', '-loglevel', 'error', '-threads', '1', '-i', file,
      '-map', '0:v:0', '-fps_mode', 'passthrough', '-f', 'framehash', '-'], {windowsHide: true, maxBuffer: 1024 * 1024});
    assert.equal(decoded.status, 0, decoded.stderr?.toString());
    const hash = decoded.stdout.toString(), frames = hash.split('\n').filter(line => /^0,/.test(line));
    assert.match(hash, /3840x2160/); assert.equal(frames.length, 12);
    assert.ok(new Set(frames.map(line => line.split(',').at(-1).trim())).size > 1, 'Decoded animation must move');
    const run = {format, smoothing, width: 3840, height: 2160, decodedFrames: frames.length, bytes, wallMs: performance.now() - start};
    runs.push(run); console.log(JSON.stringify(run));
    await writeFile(path.join(output, `${format}-${smoothing}.framehash`), hash);
  }
  assert.deepEqual(errors, []);
  await writeFile(path.join(output, 'report.json'), JSON.stringify({runs, errors, documentPreserved: true, deviceLost: false}, null, 2));
} finally {await app.evaluate(({app}) => app.exit(0)).catch(() => {});}
