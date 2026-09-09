import {chromium} from 'playwright';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'artifacts', 'scene-background');
await mkdir(output, {recursive: true});
const browser = await chromium.launch({channel: 'chrome', headless: true});
try {
  const page = await browser.newPage({viewport: {width: 760, height: 540}}), errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.url().includes('missing-background')) requests.push(request.url()); });
  await page.goto(`${process.env.STYK_URL || 'http://127.0.0.1:47831'}/api/health`);
  const result = await page.evaluate(async () => {
    const [{createRenderer}, {emptyDocument, createObject}, {buildGeometry, drawGeometry}, {drawBackground, backgroundBounds},
      {cameraMatrix}, {exportSVG}, {compilePlaybackPacket}] = await Promise.all([
      import('/src/renderer.mjs'), import('/src/demo.mjs'), import('/src/pivot/geometry.mjs'), import('/src/pivot/background.mjs'),
      import('/src/renderer-geometry.mjs'), import('/src/svg-export.mjs'), import('/src/playback-worker.mjs'),
    ]);
    const assert = (value, message) => { if (!value) throw new Error(message); };
    document.body.innerHTML = '<h1>Scene colors and camera visibility</h1><main></main>';
    document.head.insertAdjacentHTML('beforeend', '<style>body{font:13px system-ui;margin:20px;background:#e7e7ed;color:#222}h1{font-size:18px}main{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}section{padding:8px;background:white;border-radius:6px}b{display:block;font-size:10px;margin-bottom:5px}canvas{width:128px;height:96px;image-rendering:pixelated;background:repeating-conic-gradient(#ddd 0% 25%,white 0% 50%) 0/12px 12px}</style>');
    const makeCanvas = () => { const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 48; return canvas; };
    const gpuCanvas = makeCanvas(), gpu = await createRenderer(gpuCanvas); gpu.resize(64, 48, 1);
    assert(gpu.stats.backend === 'WebGPU', `Expected WebGPU, got ${gpu.stats.backend}`);
    const fallbackCanvas = makeCanvas(); fallbackCanvas.getContext('2d');
    const fallback = await createRenderer(fallbackCanvas); fallback.resize(64, 48, 1);
    assert(fallback.stats.backend === 'Canvas 2D fallback', 'Fallback oracle did not initialize.');
    const report = emptyDocument(); report.canvas_width = 64; report.canvas_height = 48;
    const figure = report.figure_types[0]; figure.segments = [{...figure.segments[0], length: 18, thickness: 6, angle_rad: 0, color_rgb: [245, 30, 60]}]; figure.segment_count = 1;
    const frame = report.keyframes[0]; frame.objects = [createObject(figure, 1, 20, 24)]; frame.object_draw_order = [0]; frame.object_draw_order_unique_ids = [1];
    frame.camera = {is_default: false, x: 8, y: -4, scale: 0.8, angle_rad: 0.3};
    report.backgrounds = [{background_id: 1, kind: 1, asset_url: '/missing-background.png'}, {background_id: 2, kind: 2, color: 0xff884422}];
    const {ensureLayerState} = await import('/src/layers.mjs'); ensureLayerState(report);
    const geometry = buildGeometry(report, frame), results = [];
    const bytes = async canvas => {
      const copy = makeCanvas(), ctx = copy.getContext('2d'); ctx.drawImage(canvas, 0, 0);
      return ctx.getImageData(0, 0, 64, 48).data;
    };
    const measure = (actual, expected) => {
      let total = 0, max = 0; for (let i = 0; i < actual.length; i++) { const d = Math.abs(actual[i] - expected[i]); total += d; max = Math.max(max, d); }
      return {mae: total / actual.length, max};
    };
    const imageCanvas = async blob => {
      const url = URL.createObjectURL(blob), image = new Image();
      try { image.src = url; await image.decode(); const canvas = makeCanvas(); canvas.getContext('2d').drawImage(image, 0, 0); return canvas; }
      finally { URL.revokeObjectURL(url); }
    };
    const addImage = (title, source) => {
      const section = document.createElement('section'), label = document.createElement('b'), canvas = makeCanvas();
      label.textContent = title; canvas.getContext('2d').drawImage(source, 0, 0); section.append(label, canvas); document.querySelector('main').append(section);
    };
    const cases = [
      {name: 'opaque', color: 0xff224466}, {name: 'translucent', color: 0x806699cc},
      {name: 'transparent-zero', color: 0}, {name: 'scene-hidden', color: 0xffff0000, scene: false},
      {name: 'camera-hidden', color: 0xffdddddd, camera: false}, {name: 'retained-color-change', color: 0xffaa8833},
      {name: 'native-background-restored'},
    ];
    for (const [index, scenario] of cases.entries()) {
      if (scenario.color === undefined) delete frame._stykBackgroundColor; else frame._stykBackgroundColor = scenario.color;
      frame.background_id = scenario.color === undefined ? 2 : 1;
      report._styk.layers.fixed.scene.visible = scenario.scene !== false;
      report._styk.layers.fixed.camera.visible = scenario.camera !== false;
      const options = {report, frame, geometry, view: {x: 0, y: 0, scale: 1}};
      const reference = makeCanvas(), ctx = reference.getContext('2d', {willReadFrequently: true});
      ctx.transform(...cameraMatrix(options));
      drawBackground(ctx, report, frame, 64, 48, {bounds: backgroundBounds(frame, 64, 48, true, report)}); drawGeometry(ctx, geometry);
      const expected = await bytes(reference);
      gpu.render(options); await gpu.device.queue.onSubmittedWorkDone(); const nativeGPU = await bytes(gpuCanvas);
      fallback.render(options); const nativeFallback = await bytes(fallbackCanvas);
      const svg = await imageCanvas(await exportSVG(options)), svgBytes = await bytes(svg);
      const packet = await compilePlaybackPacket(report, 0, {revision: index + 1});
      assert(packet.frame._stykBackgroundColor === frame._stykBackgroundColor, 'Prepared packet lost authored background color.');
      await gpu.prepareBackgrounds(report, packet.frame);
      const key = gpu.prepareFrame(packet, {report, view: options.view});
      assert(key && gpu.renderPrepared(key, {report, view: options.view}), 'Prepared frame failed to render.');
      await gpu.device.queue.onSubmittedWorkDone(); const prepared = await bytes(gpuCanvas);
      const scores = {gpu: measure(nativeGPU, expected), prepared: measure(prepared, expected), fallback: measure(nativeFallback, expected), svg: measure(svgBytes, expected)};
      for (const [backend, score] of Object.entries(scores)) assert(score.mae < 2.5, `${scenario.name}/${backend} pixel mismatch ${JSON.stringify(score)}`);
      for (const [backend, pixels] of [['gpu', nativeGPU], ['prepared', prepared], ['fallback', nativeFallback], ['svg', svgBytes]])
        for (let channel = 0; channel < 4; channel++) assert(Math.abs(pixels[channel] - expected[channel]) <= 2, `${scenario.name}/${backend} corner color or alpha mismatch.`);
      if (scenario.camera === false) assert(cameraMatrix(options).every((value, i) => value === [1, 0, 0, 1, 0, 0][i]), 'Hidden camera still transforms the viewport.');
      results.push({name: scenario.name, scores, corner: [...expected.slice(0, 4)]});
      addImage(`${scenario.name} / GPU`, gpuCanvas); addImage(`${scenario.name} / SVG`, svg);
      gpu.preparedFrames.clear();
    }
    assert(!gpu.stats.warnings.length, gpu.stats.warnings.join('\n'));
    const adapter = gpu.stats.adapter; gpu.destroy(); fallback.destroy();
    return {adapter, cases: results, checks: results.length * 5};
  });
  if (errors.length || requests.length) throw new Error(JSON.stringify({errors, unexpectedBackgroundRequests: requests}));
  await page.screenshot({path: path.join(output, 'pixels.png'), fullPage: true});
  await writeFile(path.join(output, 'report.json'), JSON.stringify({...result, errors, unexpectedBackgroundRequests: requests}, null, 2));
  console.log(JSON.stringify({checks: result.checks, cases: result.cases.length, errors}, null, 2));
} finally { await browser.close(); }
