/** Verify animated image pixels/timing, ZIP entries/CRCs, and cancellation. */
import {chromium} from 'playwright';
import {createRequire} from 'node:module';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const require = createRequire(import.meta.url);
const {startBackend} = require('../desktop/backend.cjs');
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const backend = await startBackend({appRoot});
let browser;
try {
  try { browser = await chromium.launch({headless: true}); }
  catch { browser = await chromium.launch({channel: 'chrome', headless: true}); }
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${backend.origin}/api/health`);
  const result = await page.evaluate(async origin => {
    const {exportAnimation} = await import(`${origin}/src/image-export.mjs`);
    const {crc32} = await import(`${origin}/src/image-codecs.mjs`);
    const assert = (value, message) => { if (!value) throw new Error(message); };
    const canvas = new OffscreenCanvas(160, 90), ctx = canvas.getContext('2d');
    const renderFrame = index => {
      ctx.clearRect(0, 0, 160, 90);
      ctx.fillStyle = index < 4 ? '#ff0000' : '#0000ff';
      ctx.fillRect(10, 10, 140, 70);
      ctx.fillStyle = '#fff'; ctx.fillRect(50 + index * 6, 30, 10, 40);
      return canvas;
    };
    const options = {width: 160, height: 90, fps: 24, totalFrames: 8, renderFrame};
    const files = [], reports = {};
    for (const format of ['gif', 'apng', 'png-sequence', 'jpeg-sequence']) {
      const progress = [], start = performance.now();
      const blob = await exportAnimation({...options, format, onProgress: value => progress.push(value.completed)});
      assert(blob.size > 100, `${format} is empty.`);
      assert(progress.length === (format === 'gif' ? 16 : 8) && progress.at(-1) === (format === 'gif' ? 16 : 8), `${format} progress did not include every frame.`);
      const report = {bytes: blob.size, encodingMs: +(performance.now() - start).toFixed(2)};
      const data = new Uint8Array(await blob.arrayBuffer());
      files.push({name: `image-export-test.${format === 'gif' ? 'gif' : format === 'apng' ? 'apng' : format + '.zip'}`, bytes: [...data]});
      if (format === 'gif' || format === 'apng') {
        const decoder = new ImageDecoder({data, type: format === 'gif' ? 'image/gif' : 'image/png', preferAnimation: true});
        try {
          await decoder.tracks.ready;
          const track = decoder.tracks.selectedTrack;
          assert(track.frameCount === 8, `${format} decoded ${track.frameCount} frames instead of 8.`);
          const samples = [], durations = [];
          for (let frameIndex = 0; frameIndex < 8; frameIndex++) {
            const {image} = await decoder.decode({frameIndex});
            try {
              assert(image.displayWidth === 160 && image.displayHeight === 90, `${format} dimensions are wrong.`);
              const target = new OffscreenCanvas(160, 90), c = target.getContext('2d'); c.drawImage(image, 0, 0);
              const pixel = [...c.getImageData(20, 20, 1, 1).data], clear = [...c.getImageData(1, 1, 1, 1).data];
              if (frameIndex < 4) assert(pixel[0] > 245 && pixel[2] < 10, `${format} frame ${frameIndex} lost red pixels: ${pixel}.`);
              else assert(pixel[2] > 245 && pixel[0] < 10, `${format} frame ${frameIndex} lost blue pixels: ${pixel}.`);
              assert(clear[3] === 0, `${format} transparent pixels became opaque.`);
              samples.push(pixel); durations.push(image.duration);
            } finally { image.close(); }
          }
          report.frames = track.frameCount; report.durationsUs = durations;
          report.totalDurationUs = durations.reduce((a, b) => a + b, 0);
          // Chromium's ImageDecoder reports APNG frame durations truncated to
          // milliseconds; inspect the encoded rational separately below.
          const expected = 8e6 / 24, tolerance = format === 'gif' ? 5000 : 8000;
          assert(Math.abs(report.totalDurationUs - expected) <= tolerance, `${format} animation timing drifted: ${report.totalDurationUs}.`);
          if (format === 'apng') {
            let cursor = 8, encodedSeconds = 0; const view = new DataView(data.buffer);
            while (cursor + 12 <= data.length) {
              const length = view.getUint32(cursor), name = String.fromCharCode(...data.subarray(cursor + 4, cursor + 8));
              if (name === 'fcTL') encodedSeconds += view.getUint16(cursor + 28) / view.getUint16(cursor + 30);
              cursor += length + 12;
            }
            report.encodedDurationUs = Math.round(encodedSeconds * 1e6);
            assert(Math.abs(encodedSeconds - 8 / 24) < 1e-9, 'APNG rational frame timing is incorrect.');
          }
          report.firstPixel = samples[0]; report.lastPixel = samples.at(-1);
        } finally { decoder.close(); }
      } else {
        const view = new DataView(data.buffer), entries = []; let offset = 0;
        while (view.getUint32(offset, true) === 0x04034b50) {
          const method = view.getUint16(offset + 8, true), size = view.getUint32(offset + 18, true);
          const nameSize = view.getUint16(offset + 26, true), extraSize = view.getUint16(offset + 28, true);
          const name = new TextDecoder().decode(data.subarray(offset + 30, offset + 30 + nameSize));
          const start = offset + 30 + nameSize + extraSize, content = data.subarray(start, start + size);
          assert(method === 0 && crc32(content) === view.getUint32(offset + 14, true), `ZIP CRC/method mismatch for ${name}.`);
          entries.push({name, content}); offset = start + size;
        }
        assert(entries.length === 9, `ZIP contains ${entries.length} entries instead of 8 frames and metadata.`);
        assert(view.getUint32(offset, true) === 0x02014b50, 'ZIP central directory is missing.');
        const manifest = JSON.parse(new TextDecoder().decode(entries.at(-1).content));
        assert(manifest.fps === 24 && manifest.totalFrames === 8, 'ZIP timing metadata is wrong.');
        for (const index of [0, 7]) {
          const bitmap = await createImageBitmap(new Blob([entries[index].content]));
          try {
            assert(bitmap.width === 160 && bitmap.height === 90, 'Sequence image dimensions are wrong.');
            const target = new OffscreenCanvas(160, 90), c = target.getContext('2d'); c.drawImage(bitmap, 0, 0);
            const pixel = [...c.getImageData(20, 20, 1, 1).data];
            assert(pixel[index === 0 ? 0 : 2] > 240, `Sequence frame ${index} content is wrong: ${pixel}.`);
            const background = [...c.getImageData(1, 1, 1, 1).data];
            assert(format === 'png-sequence' ? background[3] === 0 : background.every(v => v > 245), 'Sequence transparency/matte is wrong.');
          } finally { bitmap.close(); }
        }
        report.frames = 8; report.entries = entries.map(entry => entry.name);
      }
      reports[format] = report;
    }
    // Rich colors exercise adaptive quantization, every LZW code-width boundary,
    // dictionary resets, and content beyond simple two-color stick figures.
    const gradient = new OffscreenCanvas(256, 128), gc = gradient.getContext('2d');
    const source = gc.createImageData(256, 128);
    for (let y = 0; y < 128; y++) for (let x = 0; x < 256; x++) {
      const p = (y * 256 + x) * 4; source.data.set([x, y * 2, (x * 13 + y * 7) % 256, 255], p);
    }
    gc.putImageData(source, 0, 0);
    const gradientBlob = await exportAnimation({format: 'gif', width: 256, height: 128, fps: 30, totalFrames: 1, renderFrame: () => gradient});
    const bitmap = await createImageBitmap(gradientBlob), target = new OffscreenCanvas(256, 128), tc = target.getContext('2d');
    tc.drawImage(bitmap, 0, 0); bitmap.close();
    const actual = tc.getImageData(0, 0, 256, 128).data;
    let difference = 0;
    for (let p = 0; p < actual.length; p += 4) for (let channel = 0; channel < 3; channel++) difference += Math.abs(actual[p + channel] - source.data[p + channel]);
    const meanColorError = difference / (256 * 128 * 3);
    assert(meanColorError < 15, `GIF quantization/LZW reconstruction error is too large: ${meanColorError}.`);
    reports.gradient = {bytes: gradientBlob.size, meanColorError: +meanColorError.toFixed(3)};
    files.push({name: 'image-export-gradient.gif', bytes: [...new Uint8Array(await gradientBlob.arrayBuffer())]});

    const controller = new AbortController(); let cancellation;
    try { await exportAnimation({...options, format: 'apng', signal: controller.signal,
      onProgress({completed}) { if (completed === 2) controller.abort(); }}); }
    catch (error) { cancellation = error.name; }
    assert(cancellation === 'AbortError', 'Image export cancellation did not abort.');
    let sizeError;
    try { await exportAnimation({...options, format: 'png-sequence', maxBytes: 1024}); }
    catch (error) { sizeError = error.message; }
    assert(sizeError?.includes('size limit'), 'Image export size bound was not enforced.');
    let rendererError;
    try { await exportAnimation({...options, format: 'gif', renderFrame(index) { if (index === 2) throw new Error('expected image renderer failure'); return renderFrame(index); }}); }
    catch (error) { rendererError = error.message; }
    assert(rendererError === 'expected image renderer failure', 'Image renderer failure was lost.');
    return {reports, cancellation, sizeError, rendererError, files};
  }, backend.origin);
  if (errors.length) throw new Error(errors.join('\n'));
  const {files, ...report} = result;
  await mkdir(path.join(appRoot, 'artifacts'), {recursive: true});
  for (const file of files) await writeFile(path.join(appRoot, 'artifacts', file.name), Uint8Array.from(file.bytes));
  await writeFile(path.join(appRoot, 'artifacts/image-export-browser.json'), JSON.stringify({...report, errors, checkedAt: new Date().toISOString()}, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally { await browser?.close(); backend.stop(); }
