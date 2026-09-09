import {chromium} from 'playwright';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
const output = path.resolve('artifacts/renderer-onion-order'); await mkdir(output, {recursive: true});
const browser = await chromium.launch({channel: 'chrome', headless: true});
try {
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(process.env.STYK_URL || 'http://127.0.0.1:47831'); await page.waitForFunction(() => styk?.ready);
  const result = await page.evaluate(async () => {
    const {createRenderer} = await import('/src/renderer.mjs'), {buildGeometry} = await import('/src/pivot/geometry.mjs');
    const {defaultFigure, createObject, createFrame} = await import('/src/demo.mjs');
    const figure = (id, rgb, length, thickness) => {
      const f = defaultFigure(id); f.segments = [{...f.segments[0], angle_rad: 0, bend_rad: 0, segment_kind: 'squareLine', segment_type: 'line', color_rgb: rgb, length, thickness}];
      f.segment_count = 1; return f;
    };
    const figures = [figure(1, [255,0,0], 80, 60), figure(2, [0,255,0], 40, 10), figure(3, [255,0,255], 10, 20),
      figure(4, [0,0,255], 80, 60), figure(5, [0,255,0], 80, 60)];
    const frame = createFrame([createObject(figures[0], 1, 10, 40), createObject(figures[1], 2, 50, 80), createObject(figures[2], 3, 75, 40)]);
    const prior = createFrame([createObject(figures[3], 2, 10, 40)]), near = createFrame([createObject(figures[4], 2, 10, 40)]);
    const report = {version: 5, canvas_width: 120, canvas_height: 100, figure_types: figures, keyframes: [frame], backgrounds: []};
    const geometry = buildGeometry(report, frame), priorGeometry = buildGeometry(report, prior), nearGeometry = buildGeometry(report, near);
    const gpuCanvas = document.createElement('canvas'), fallbackCanvas = document.createElement('canvas'); fallbackCanvas.getContext('2d');
    const gpu = await createRenderer(gpuCanvas), fallback = await createRenderer(fallbackCanvas), rows = [];
    const pixels = async renderer => {
      await renderer.device?.queue.onSubmittedWorkDone();
      const png = renderer.canvas.toDataURL(), image = new Image(); image.src = png; await image.decode();
      const surface = new OffscreenCanvas(image.width, image.height), ctx = surface.getContext('2d'); ctx.drawImage(image, 0, 0);
      return {png, data: ctx.getImageData(0, 0, image.width, image.height).data};
    };
    try {
      for (const renderer of [gpu, fallback]) renderer.resize(150, 130, 1);
      for (const [name, onions, hidden, drag, expected] of [
        ['default', [{frame: prior, geometry: priorGeometry, opacity: .5}], [], null, [255,0,0]],
        ['anchored', [{frame: prior, geometry: priorGeometry, opacity: .5, beforeUid: 2}], [], null, [127,0,128]],
        ['ordered', [{frame: prior, geometry: priorGeometry, opacity: .5, beforeUid: 2}, {frame: near, geometry: nearGeometry, opacity: .5, beforeUid: 2}], [], null, [64,128,64]],
        ['hidden', [{frame: prior, geometry: priorGeometry, opacity: .5, beforeUid: 2}], [2], null, [255,0,0]],
        ['opaque-history-drag', [{frame: prior, geometry: priorGeometry, opacity: 1, beforeUid: 2}], [], {x: 0, y: -40}, [0,0,255]],
      ]) {
        const options = {report, frame, geometry, view: {x: 5, y: 5, scale: 1}, onionFrames: onions, hiddenUids: new Set(hidden), clipToCanvas: false,
          dragTranslations: drag ? new Map([[2, drag]]) : null};
        gpu.render(options); const a = await pixels(gpu); fallback.render(options); const b = await pixels(fallback);
        const sample = (data, x, y) => [...data.slice((y * 150 + x) * 4, (y * 150 + x) * 4 + 3)];
        const actual = sample(a.data, 25, 45), canvas = sample(b.data, 25, 45), front = sample(a.data, 85, 45);
        let maxDifference = 0, differingChannels = 0, significantPixels = 0, differenceSum = 0;
        for (let i = 0; i < a.data.length; i += 4) {
          let pixelDifference = 0;
          for (let c = 0; c < 4; c++) { const delta = Math.abs(a.data[i + c] - b.data[i + c]); if (delta) differingChannels++; pixelDifference = Math.max(pixelDifference, delta); differenceSum += delta; }
          maxDifference = Math.max(maxDifference, pixelDifference); if (pixelDifference > 3) significantPixels++;
        }
        const meanDifference = differenceSum / a.data.length, significantPercent = significantPixels / (a.data.length / 4) * 100;
        // Interior pixels establish order; the two rasterizers have different
        // antialias coverage at a few stroke corners and round 50% alpha apart.
        const pass = actual.every((value, i) => Math.abs(value - expected[i]) <= 1) && canvas.every((value, i) => Math.abs(value - expected[i]) <= 1)
          && front.join(',') === '255,0,255' && meanDifference < 1 && significantPercent < .2;
        rows.push({name, actual, canvas, expected, front, maxDifference, meanDifference, significantPercent, differingChannels, pass, gpuPNG: a.png, canvasPNG: b.png});
      }
    } finally {gpu.destroy(); fallback.destroy();}
    return {rows};
  });
  for (const row of result.rows) for (const field of ['gpuPNG', 'canvasPNG']) {
    await writeFile(path.join(output, `${row.name}-${field}.png`), Buffer.from(row[field].split(',')[1], 'base64')); delete row[field];
  }
  await writeFile(path.join(output, 'report.json'), JSON.stringify({...result, errors}, null, 2)); console.log(JSON.stringify({...result, errors}, null, 2));
  if (errors.length || result.rows.some(row => !row.pass)) throw new Error('Onion painter order differed from the expected scene.');
} finally {await browser.close();}
