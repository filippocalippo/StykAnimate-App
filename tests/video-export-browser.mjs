/** Verify an actual WebCodecs/WebM file decodes, seeks, and plays in Chromium. */
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
    const {encodeWebM} = await import(`${origin}/src/video-export.mjs`);
    const assert = (value, message) => { if (!value) throw new Error(message); };
    const canvas = new OffscreenCanvas(320, 180), ctx = canvas.getContext('2d');
    const progress = [];
    const started = performance.now();
    const blob = await encodeWebM({width: 320, height: 180, fps: 24, totalFrames: 48,
      renderFrame(index) {
        ctx.fillStyle = index < 24 ? '#ff0000' : '#0000ff';
        ctx.fillRect(0, 0, 320, 180);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(40 + index * 3, 40, 20, 100);
        return canvas;
      }, onProgress: value => progress.push(value.completed)});
    const encodingMs = performance.now() - started;
    assert(blob.size > 1000, `Video has only ${blob.size} bytes.`);
    assert(progress.length === 48 && progress.at(-1) === 48, 'Frame progress is incomplete.');
    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'auto';
    video.style.width = '320px';
    document.body.append(video);
    const url = URL.createObjectURL(blob);
    const event = (target, name) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${name}.`)), 15000);
      target.addEventListener(name, () => { clearTimeout(timer); resolve(); }, {once: true});
      target.addEventListener('error', () => { clearTimeout(timer); reject(new Error(target.error?.message || 'Video decode failed.')); }, {once: true});
    });
    try {
      const loaded = event(video, 'loadeddata');
      video.src = url;
      await loaded;
      assert(video.videoWidth === 320 && video.videoHeight === 180, 'Decoded dimensions are wrong.');
      assert(Math.abs(video.duration - 2) < 0.002, `Decoded duration is ${video.duration}, expected 2 seconds.`);
      const sample = async time => {
        const seeked = event(video, 'seeked');
        video.currentTime = time;
        await seeked;
        const target = new OffscreenCanvas(320, 180), sampleContext = target.getContext('2d');
        sampleContext.drawImage(video, 0, 0);
        return [...sampleContext.getImageData(5, 5, 1, 1).data];
      };
      const first = await sample(0.2), last = await sample(1.6);
      assert(first[0] > 200 && first[2] < 70, `First decoded frame is not red: ${first}.`);
      assert(last[2] > 200 && last[0] < 70, `Last decoded frame is not blue: ${last}.`);
      await sample(0.01);
      let decodedFrames = 0;
      const played = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Playback did not present changing video frames.')), 10000);
        const frame = () => { if (++decodedFrames >= 6) { clearTimeout(timer); resolve(); } else video.requestVideoFrameCallback(frame); };
        video.requestVideoFrameCallback(frame);
      });
      await video.play();
      await played;
      video.pause();

      const controller = new AbortController();
      let cancellation;
      try {
        await encodeWebM({width: 320, height: 180, fps: 24, totalFrames: 48,
          signal: controller.signal, renderFrame(index) { if (index === 3) controller.abort(); return canvas; }});
      } catch (error) { cancellation = error.name; }
      assert(cancellation === 'AbortError', 'Cancellation did not reject with AbortError.');

      let renderFailure;
      try {
        await encodeWebM({width: 320, height: 180, fps: 24, totalFrames: 5,
          renderFrame(index) { if (index === 2) throw new Error('expected render failure'); return canvas; }});
      } catch (error) { renderFailure = error.message; }
      assert(renderFailure === 'expected render failure', 'Renderer errors were lost.');
      const afterFailure = await encodeWebM({width: 320, height: 180, fps: 24, totalFrames: 1, renderFrame: () => canvas});
      assert(afterFailure.size > 200, 'Encoder resources were not reusable after cancellation/errors.');
      return {width: video.videoWidth, height: video.videoHeight, duration: video.duration,
        bytes: blob.size, framesRequested: 48, presentedFrames: decodedFrames,
        firstPixel: first, lastPixel: last, encodingMs: +encodingMs.toFixed(2),
        cancellation, renderFailure, videoBytes: [...new Uint8Array(await blob.arrayBuffer())]};
    } finally { video.pause(); video.removeAttribute('src'); video.load(); URL.revokeObjectURL(url); video.remove(); }
  }, backend.origin);
  if (errors.length) throw new Error(errors.join('\n'));
  const {videoBytes, ...report} = result;
  await mkdir(path.join(appRoot, 'artifacts'), {recursive: true});
  await writeFile(path.join(appRoot, 'artifacts/webcodecs-export.webm'), Uint8Array.from(videoBytes));
  await writeFile(path.join(appRoot, 'artifacts/video-export-browser.json'),
    JSON.stringify({...report, errors, checkedAt: new Date().toISOString()}, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally { await browser?.close(); backend.stop(); }
