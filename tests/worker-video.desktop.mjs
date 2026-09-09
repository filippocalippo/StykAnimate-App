/** Actual Export UI -> scene renderer worker -> native codecs -> Save/decode. */
import { _electron as electron } from 'playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'artifacts', 'worker-video-renderer');
await mkdir(output, { recursive: true });
const app = await electron.launch({
  args: [root], cwd: root, timeout: 45000,
  env: { ...process.env, STYK_USER_DATA_DIR: path.join(output, `profile-${Date.now()}`) },
});
try {
  const page = await app.firstWindow(), checks = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => window.styk?.ready && window.stykDesktop?.beginVfwExport, undefined, { timeout: 30000 });
  await app.evaluate(({ ipcMain, dialog }) => {
    globalThis.__workerVideoEvents = [];
    globalThis.__workerVideoSaves = [];
    for (const channel of ['styk:video-begin', 'styk:video-cancel', 'styk:vfw-begin', 'styk:vfw-cancel']) {
      const original = ipcMain._invokeHandlers.get(channel);
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, (event, ...args) => {
        globalThis.__workerVideoEvents.push({ channel, value: args[0] });
        return original(event, ...args);
      });
    }
    dialog.showSaveDialog = async () => {
      globalThis.__workerVideoSaves.push(globalThis.__workerVideoDestination);
      return { canceled: false, filePath: globalThis.__workerVideoDestination };
    };
  });
  await page.evaluate(async () => {
    globalThis.__sceneExportWorkers = [];
    const NativeWorker = globalThis.Worker;
    globalThis.Worker = class extends NativeWorker {
      constructor(url, options) {
        super(url, options);
        if (String(url).includes('export-frame-worker.mjs')) {
          this.record = { options: null, ticks: [], terminated: false };
          globalThis.__sceneExportWorkers.push(this.record);
        }
      }
      postMessage(data, ...rest) {
        if (this.record && data.operation === 'start') this.record.options = { ...data.options, token: undefined };
        if (this.record && data.operation === 'render') this.record.ticks.push(data.tick);
        return super.postMessage(data, ...rest);
      }
      terminate() { if (this.record) this.record.terminated = true; return super.terminate(); }
    };
    // A real asynchronous codec lookup must not override the no-frames guard.
    const { VfwExportControls } = await import('/src/vfw-export-controls.mjs');
    const dialog = document.createElement('dialog'), container = document.createElement('div'), button = document.createElement('button');
    dialog.append(container, button); document.body.append(dialog); dialog.showModal();
    let canExport = false;
    const controls = new VfwExportControls({ container, button, dialog, canExport: () => canExport, getDimensions: () => ({ width: 64, height: 40 }) });
    await controls.refresh();
    const codec = controls.codecs.find(codec => codec.supported && codec.configure);
    if (!codec) throw new Error('Expected an installed configurable VFW compressor.');
    controls.select.value = codec.id; controls.select.dispatchEvent(new Event('change'));
    if (!button.disabled || controls.configureButton.disabled) throw new Error('No-frame guard must disable export but keep Configure available.');
    canExport = true; controls.select.dispatchEvent(new Event('change'));
    if (button.disabled) throw new Error('Export should become available after frames exist.');
    dialog.close(); dialog.showModal();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    if (controls.disposed) throw new Error('A queued earlier close must not dispose a reopened dialog.');
    dialog.close();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    if (!controls.disposed) throw new Error('Final dialog close must dispose its listeners.');
    dialog.remove();
  });
  checks.push('Asynchronous installed-codec selection keeps zero-frame export disabled while Configure stays available');
  checks.push('Adding frames enables export, and queued close/reopen preserves controls until their final close');

  const load = async totalFrames => page.evaluate(async total => {
    const { emptyDocument, createFrame, createObject } = await import('/src/demo.mjs');
    const report = emptyDocument(), figure = report.figure_types[0];
    report.canvas_width = 64; report.canvas_height = 40; report.fps = 16;
    figure.segments = [{ ...figure.segments[0], angle_rad: .2, length: 32, thickness: 5.25,
      transparency: 128, color_alpha: 127 / 255, color_rgb: [245, 20, 30] }];
    figure.segment_count = 1;
    report.keyframes = [createFrame([createObject(figure, 1, 12, 9)], total - 1), createFrame([createObject(figure, 1, 12, 25)], 1)];
    for (const frame of report.keyframes) frame._stykBackgroundColor = 0;
    window.styk.editor.load(report); window.styk.editor.markSaved();
  }, totalFrames);
  const open = async (format, smoothing, end) => {
    await page.locator('[data-action="export"]').first().click();
    await page.locator('.export-settings > summary').click();
    await page.locator('#export-smoothing').selectOption(smoothing);
    if (end) await page.locator('#export-end').fill(String(end));
    if (format === 'webm') {
      await page.waitForFunction(() => document.querySelector('[data-action="export-video"]')?.dataset.provider === 'FFmpeg');
      await page.locator('#export-webm-bitrate').fill('0.25');
      await page.locator('#export-quality').fill('100');
    } else {
      await page.waitForFunction(() => !document.querySelector('#export-vfw-codec')?.disabled);
      const id = await page.evaluate(async () => (await window.stykDesktop.getVfwCapabilities({ width: 64, height: 40 })).codecs.find(codec => codec.arch === 'x64' && codec.kind === 'uncompressed').id);
      await page.locator('#export-vfw-codec').selectOption(id);
    }
  };
  const tile = format => page.locator(`[data-action="${format === 'webm' ? 'export-video' : 'export-vfw'}"]`);
  const destinations = {};
  for (const [format, smoothing] of [['webm', 'none'], ['vfw', 'sprites']]) {
    // Cancel the actual progress dialog after source frames have reached the encoder.
    await load(1000);
    const before = await app.evaluate(() => globalThis.__workerVideoSaves.length);
    await open(format, smoothing);
    await tile(format).click();
    await page.waitForFunction(() => document.querySelector('#export-progress')?.value >= 2, undefined, { timeout: 30000 });
    await page.locator('#cancel-export').click();
    await page.waitForFunction(() => !document.querySelector('#dialog').open, undefined, { timeout: 30000 });
    assert.equal(await app.evaluate(() => globalThis.__workerVideoSaves.length), before);
    const canceled = await page.evaluate(() => globalThis.__sceneExportWorkers.at(-1));
    assert.equal(canceled.terminated, true); assert.ok(canceled.ticks.length >= 2 && canceled.ticks.length < 1000);
    checks.push(`${format}: real Cancel stops the render worker after encoding begins and opens no Save dialog`);

    await load(6);
    const filename = path.join(output, `${format}-${smoothing}.${format === 'webm' ? 'webm' : 'avi'}`);
    destinations[format] = filename;
    await app.evaluate((_, filename) => { globalThis.__workerVideoDestination = filename; }, filename);
    await open(format, smoothing);
    if (format === 'vfw') await page.screenshot({ path: path.join(output, 'smoothing-controls.png') });
    await tile(format).click();
    await page.waitForFunction(() => !document.querySelector('#dialog').open, undefined, { timeout: 30000 });
    assert.ok((await readFile(filename)).length > 256);
    const successful = await page.evaluate(() => globalThis.__sceneExportWorkers.at(-1));
    assert.equal(successful.options.smoothing, smoothing);
    assert.deepEqual(successful.ticks, [0, 1, 2, 3, 4, 5]);
    assert.equal(successful.terminated, true);
    checks.push(`${format}: retry saves six ordered frames through the worker using selected '${smoothing}' smoothing`);
  }

  const ffmpeg = path.join(root, 'build', 'video-encoder', 'ffmpeg.exe'), decoded = {};
  for (const format of ['webm', 'vfw']) {
    const alpha = format === 'webm', channels = alpha ? 4 : 3;
    const data = execFileSync(ffmpeg, ['-v', 'error', ...(alpha ? ['-c:v', 'libvpx-vp9'] : []), '-threads', '1', '-i', destinations[format], '-f', 'rawvideo', '-pix_fmt', alpha ? 'rgba' : 'rgb24', '-threads', '1', 'pipe:1'], { windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
    assert.equal(data.length, 64 * 40 * channels * 6);
    const pixel = (frame, x, y) => [...data.subarray(((frame * 40 + y) * 64 + x) * channels, ((frame * 40 + y) * 64 + x) * channels + channels)];
    const probes = { corner: pixel(0, 0, 0), first: pixel(0, 24, 11), final: pixel(5, 24, 27), oldPosition: pixel(5, 24, 11) };
    const centers = Array.from({ length: 6 }, (_, frame) => {
      let weight = 0, weightedY = 0;
      for (let y = 0; y < 40; y++) for (let x = 0; x < 64; x++) {
        const value = pixel(frame, x, y)[alpha ? 3 : 0];
        weight += value; weightedY += y * value;
      }
      return weightedY / weight;
    });
    assert.ok(centers.every((value, index) => Number.isFinite(value) && (!index || value > centers[index - 1] + .5)));
    if (alpha) {
      assert.equal(probes.corner[3], 0); assert.equal(probes.oldPosition[3], 0);
      assert.equal(probes.first[3], 127); assert.equal(probes.final[3], 127);
      const alphas = new Set(); for (let i = 3; i < data.length; i += 4) alphas.add(data[i]);
      assert.deepEqual([...alphas].sort((a, b) => a - b), [0, 127]);
      assert.ok(probes.first[0] > 220 && probes.first[1] < 50);
      decoded[format] = { frames: 6, probes, centers, alphaValues: [...alphas] };
      checks.push('Independent VP9 decode preserves transparent/partial alpha, hard no-smoothing edges and animated positions');
    } else {
      assert.deepEqual(probes.corner, [0, 0, 0]); assert.deepEqual(probes.oldPosition, [0, 0, 0]);
      assert.ok(probes.first[0] >= 120 && probes.first[0] <= 124 && probes.first[1] < 15);
      assert.ok(probes.final[0] >= 120 && probes.final[0] <= 124);
      const redLevels = new Set(); for (let i = 0; i < 64 * 40 * 3; i += 3) if (data[i] > 0) redLevels.add(data[i]);
      assert.ok(redLevels.size > 3);
      decoded[format] = { frames: 6, probes, centers, redLevels: [...redLevels].sort((a, b) => a - b) };
      checks.push('Independent uncompressed AVI decode preserves all frames, black alpha matte and supersampled edge levels');
    }
  }
  const events = await app.evaluate(() => globalThis.__workerVideoEvents);
  assert.ok(events.filter(event => event.channel === 'styk:video-cancel').length >= 1);
  assert.ok(events.filter(event => event.channel === 'styk:vfw-cancel').length >= 2);
  assert.equal(events.findLast(event => event.channel === 'styk:video-begin').value.bitrate, 250000);
  assert.deepEqual(errors, []);
  checks.push('Native encoder cleanup is acknowledged and the selected WebM bitrate reaches the actual encoder');
  const workers = await page.evaluate(() => globalThis.__sceneExportWorkers);
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ checks, workers, events, decoded, errors }, null, 2));
  console.log(JSON.stringify({ checks: checks.length, workers: workers.length, errors }));
} finally { await app.close(); }
