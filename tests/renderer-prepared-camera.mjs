import {chromium} from 'playwright';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';

const output = path.resolve('artifacts/renderer-prepared-camera'); await mkdir(output, {recursive: true});
const browser = await chromium.launch({channel: 'chrome', headless: true});
try {
  const page = await browser.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${process.env.STYK_URL || 'http://127.0.0.1:47831'}/api/health`);
  const rows = await page.evaluate(async () => {
    const [{createRenderer}, {PlaybackCache}, {defaultFigure, createObject, createFrame}, {buildGeometry}] = await Promise.all([
      import('/src/renderer.mjs'), import('/src/playback.mjs'), import('/src/demo.mjs'), import('/src/pivot/geometry.mjs')]);
    const figures = [[220, 20, 50], [30, 60, 230]].map((rgb, index) => {
      const f = defaultFigure(index + 1);
      f.segments = [{...f.segments[0], angle_rad: 0, bend_rad: 0, segment_kind: 'squareLine', segment_type: 'line', color_rgb: rgb, length: 60, thickness: 40}];
      f.segment_count = 1; return f;
    });
    const frame = createFrame(figures.map((f, index) => createObject(f, index + 1, 30 + 300 * index, 55, {field28: 64})));
    frame.camera = {x: 300, y: 0, scale: 1, angle_rad: .17}; frame._stykBackgroundColor = 0xffddeadf;
    const report = {version: 5, canvas_width: 200, canvas_height: 120, figure_types: figures, keyframes: [frame], backgrounds: []};
    const geometry = buildGeometry(report, frame), gpu = await createRenderer(document.createElement('canvas'));
    const fresh = await createRenderer(document.createElement('canvas')), fallbackCanvas = document.createElement('canvas'); fallbackCanvas.getContext('2d');
    const canvas = await createRenderer(fallbackCanvas), playback = new PlaybackCache(), results = [];
    const capture = async renderer => {
      await renderer.device?.queue.onSubmittedWorkDone(); const png = renderer.canvas.toDataURL(), bitmap = await createImageBitmap(renderer.canvas);
      const surface = new OffscreenCanvas(200, 120), ctx = surface.getContext('2d'); ctx.drawImage(bitmap, 0, 0); bitmap.close();
      return {png, data: ctx.getImageData(0, 0, 200, 120).data};
    };
    const diff = (a, b) => {let sum = 0, significant = 0; for (let i = 0; i < a.length; i += 4) {
      let pixel = 0; for (let c = 0; c < 4; c++) {const d = Math.abs(a[i + c] - b[i + c]); sum += d; pixel = Math.max(pixel, d);}
      if (pixel > 5) significant++;
    } return {mae: sum / a.length, significantPercent: significant / (a.length / 4) * 100};};
    try {
      for (const r of [gpu, fresh, canvas]) r.resize(200, 120, 1);
      playback.load(report, {cameraEnabled: false});
      for (const cameraEnabled of [false, true, false]) {
        playback.updateView({cameraEnabled}); await playback.prepareRange([0]); const packet = playback.get(0);
        if (packet.cameraEnabled !== cameraEnabled) throw new Error('Worker returned the wrong crop mode.');
        const expectedUid = cameraEnabled ? 2 : 1;
        if (packet.compatibility.length !== 1 || packet.compatibility[0].uid !== expectedUid) throw new Error('Worker did not cull the opposite camera view.');
        const key = gpu.prepareFrame(packet, {report, view: {scale: 1}});
        for (const hidden of [false, true]) {
          const hiddenUids = {has: uid => hidden && uid === expectedUid};
          gpu.renderPrepared(key, {report, view: {scale: 1}, hiddenUids}); const actual = await capture(gpu);
          const options = {report, frame, geometry, cameraEnabled, view: {scale: 1}, hiddenUids};
          fresh.render(options); const normal = await capture(fresh); canvas.render(options); const reference = await capture(canvas);
          const fromFresh = diff(actual.data, normal.data), fromCanvas = diff(actual.data, reference.data);
          // A rotated texture covers roughly 1% of this tiny fixture with edge
          // pixels; Canvas and four-sample GPU antialiasing differ there. The
          // independent uncropped GPU comparison detects crop/sample changes.
          if (fromFresh.mae > .2 || fromFresh.significantPercent > .1 || fromCanvas.mae > .5)
            throw new Error(`Camera ${cameraEnabled}, hidden ${hidden}: ${JSON.stringify({fromFresh, fromCanvas})}`);
          results.push({cameraEnabled, hidden, cropUid: expectedUid, fromFresh, fromCanvas, gpuPNG: actual.png, freshPNG: normal.png, canvasPNG: reference.png});
        }
        let rejected = false; try {gpu.renderPrepared(key, {report, cameraEnabled: !cameraEnabled});} catch {rejected = true;}
        if (!rejected) throw new Error('Mismatched camera mode was accepted.');
      }
    } finally {playback.dispose(); gpu.destroy(); fresh.destroy(); canvas.destroy();}
    return results;
  });
  for (const [index, row] of rows.entries()) for (const field of ['gpuPNG', 'freshPNG', 'canvasPNG']) {
    await writeFile(path.join(output, `${index}-${field}.png`), Buffer.from(row[field].split(',')[1], 'base64')); delete row[field];
  }
  await writeFile(path.join(output, 'report.json'), JSON.stringify({rows, errors}, null, 2)); console.log(JSON.stringify({rows, errors}, null, 2));
  if (errors.length) throw new Error('Browser errors during prepared camera regression.');
} finally {await browser.close();}
