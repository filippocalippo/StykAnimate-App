/** Pivot's opaque-video black matte through actual UI, native Save and decoding. */
import { _electron as electron } from 'playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..'), output = path.join(root, 'artifacts', 'native-video-matte');
await mkdir(output, { recursive: true });
const app = await electron.launch({ args: [root], cwd: root, timeout: 45000,
  env: { ...process.env, STYK_USER_DATA_DIR: path.join(output, `profile-${Date.now()}`) } });
try {
  const page = await app.firstWindow(), checks = [], errors = [], outputs = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => window.styk?.ready && window.stykDesktop?.beginVideoExport, undefined, { timeout: 30000 });
  await page.evaluate(async () => {
    const { emptyDocument, createFrame, createObject } = await import('/src/demo.mjs'), report = emptyDocument(), figure = report.figure_types[0];
    report.canvas_width = 65; report.canvas_height = 33; report.fps = 16;
    figure.segments = [{ ...figure.segments[0], angle_rad: 0, length: 20, thickness: 7,
      transparency: 128, color_alpha: 127 / 255, color_rgb: [240, 20, 10] }]; figure.segment_count = 1;
    report.keyframes = [createFrame([createObject(figure, 1, 16, 16)], 1), createFrame([createObject(figure, 1, 28, 16)], 1)];
    for (const frame of report.keyframes) frame._stykBackgroundColor = 0;
    window.styk.editor.load(report); window.styk.editor.markSaved();
  });
  const capabilities = await page.evaluate(async () => (await import('/src/export-capabilities.mjs')).getExportCapabilities({ width: 65, height: 33, fps: 16 }));
  for (const format of ['mp4', 'avi', 'wmv']) assert.equal(capabilities.formats.find(item => item.id === format).matte, 'black');
  assert.equal(capabilities.formats.find(item => item.id === 'webm').matte, null);
  checks.push('Capabilities declare native black matte for opaque video and alpha preservation for WebM');
  for (const format of ['mp4', 'avi', 'wmv', 'webm']) {
    await page.locator('[data-action="export"]').first().click();
    await page.locator('.export-settings > summary').click();
    await page.locator('#export-quality').fill('100');
    const action = format === 'webm' ? 'export-video' : `export-${format}`, button = page.locator(`[data-action="${action}"]`);
    await page.waitForFunction(action => !document.querySelector(`[data-action="${action}"]`)?.disabled, action);
    if (format === 'avi') {
      await page.waitForFunction(() => document.querySelector('#export-avi-codec')?.options.length >= 3);
      await page.locator('#export-avi-codec').selectOption('ffv1');
    }
    const filename = path.join(output, `transparent-source.${format}`);
    await app.evaluate(({ dialog }, filename) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: filename }); }, filename);
    await button.click();
    await page.waitForFunction(() => !document.querySelector('#dialog').open, undefined, { timeout: 30000 });
    const bytes = await readFile(filename); assert.ok(bytes.length > 256);
    const codec = format === 'avi' ? 'ffv1' : capabilities.formats.find(item => item.id === format).defaultCodec;
    const details = capabilities.formats.find(item => item.id === format).codecs.find(item => item.id === codec), alpha = format === 'webm';
    const width = details.encodedWidth, height = details.encodedHeight, channels = alpha ? 4 : 3;
    const decoded = execFileSync(path.join(root, 'build/video-encoder/ffmpeg.exe'), ['-v', 'error', ...(alpha ? ['-c:v', 'libvpx-vp9'] : []), '-threads', '1', '-i', filename, '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', alpha ? 'rgba' : 'rgb24', '-threads', '1', 'pipe:1'], { windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
    assert.equal(decoded.length, width * height * channels * 2);
    const pixel = (frame, x, y) => [...decoded.subarray(((frame * height + y) * width + x) * channels, ((frame * height + y) * width + x) * channels + channels)];
    const corner = pixel(0, 0, 0), outside = pixel(1, width - 1, height - 1), interior = pixel(0, 26, 16);
    if (alpha) {
      assert.equal(corner[3], 0); assert.equal(outside[3], 0); assert.equal(interior[3], 127);
      assert.equal(width, 65); assert.equal(height, 33);
      checks.push('Actual WebM Save still preserves transparent background and partial alpha at exact odd dimensions');
    } else {
      assert.ok(corner.every(value => value < 15) && outside.every(value => value < 15));
      assert.ok(interior[0] > 70 && interior[0] < 160 && interior[1] < 60 && interior[2] < 60);
      if (format === 'avi') {
        assert.equal(width, 65); assert.equal(height, 33);
        // Canvas stores premultiplied alpha; conversion at the worker boundary
        // can round a source color by one byte before its black composite.
        assert.ok(interior.every((value, index) => Math.abs(value - [120, 10, 5][index]) <= 1));
      }
      else { assert.equal(width, 66); assert.equal(height, 34); assert.match(details.notice, /black edge/); }
      checks.push(`Actual ${format.toUpperCase()} Save decodes black transparent regions and partial-opacity pixels over black`);
    }
    outputs.push({ format, codec, width, height, bytes: bytes.length, frames: 2, corner, outside, interior, notice: details.notice });
  }
  assert.deepEqual(errors, []);
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ checks, outputs, errors }, null, 2));
  console.log(JSON.stringify({ checks: checks.length, outputs: outputs.length, errors }));
} finally { await app.close(); }
