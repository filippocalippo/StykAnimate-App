import {chromium} from 'playwright';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), output = path.join(root, 'artifacts', 'animation-style');
await mkdir(output, {recursive: true});
const browser = await chromium.launch({channel: 'chrome', headless: true});
try {
  const page = await browser.newPage({viewport: {width: 1000, height: 760}}), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${process.env.STYK_URL || 'http://127.0.0.1:47831'}/api/health`);
  const result = await page.evaluate(async () => {
    const [{createRenderer}, {emptyDocument, createObject, createFrame}, {evaluatedFrame, buildGeometry, drawGeometry}, {exportSVG}, {compilePlaybackPacket}, {animationChannelId}] = await Promise.all([
      import('/src/renderer.mjs'), import('/src/demo.mjs'), import('/src/pivot/geometry.mjs'), import('/src/svg-export.mjs'), import('/src/playback-worker.mjs'), import('/src/animation-channels.mjs'),
    ]);
    const assert = (condition, message) => { if (!condition) throw new Error(message); };
    document.body.innerHTML = '<h1>Instance style animation: native field oracle / WebGPU / SVG</h1><main></main>';
    document.head.insertAdjacentHTML('beforeend', '<style>body{font:13px system-ui;margin:20px;background:#e8e9ef}h1{font-size:18px}main{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}section{background:white;padding:8px;border-radius:6px}b{display:block;font-size:11px}canvas{width:256px;height:192px;background:repeating-conic-gradient(#ddd 0% 25%,white 0% 50%) 0/12px 12px}</style>');
    const makeCanvas = () => { const canvas = document.createElement('canvas'); canvas.width = 128; canvas.height = 96; return canvas; };
    const bytes = canvas => { const copy = makeCanvas(), ctx = copy.getContext('2d', {willReadFrequently: true}); ctx.drawImage(canvas, 0, 0); return ctx.getImageData(0, 0, 128, 96).data; };
    const score = (a, b) => { let total = 0, max = 0; for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); total += d; max = Math.max(max, d); } return {mae: total / a.length, max}; };
    const show = (name, canvas) => { const section = document.createElement('section'), title = document.createElement('b'), copy = makeCanvas(); title.textContent = name; copy.getContext('2d').drawImage(canvas, 0, 0); section.append(title, copy); document.querySelector('main').append(section); };
    const gpuCanvas = makeCanvas(), gpu = await createRenderer(gpuCanvas); gpu.resize(128, 96, 1);
    assert(gpu.stats.backend === 'WebGPU', `WebGPU required, got ${gpu.stats.backend}`);
    const fallbackCanvas = makeCanvas(); fallbackCanvas.getContext('2d'); const fallback = await createRenderer(fallbackCanvas); fallback.resize(128, 96, 1);
    const rows = [];
    for (const mode of ['vector-gradient', 'outline-gradient', 'curved-gradient']) {
      const report = emptyDocument(), figure = report.figure_types[0]; report.canvas_width = 128; report.canvas_height = 96;
      figure.segments = [{...figure.segments[0], length: 80, angle_rad: 0, thickness: 12, color_rgb: [245, 20, 40], secondary: {rgb: [20, 60, 230], a: 0}, bend_rad: mode === 'curved-gradient' ? .2 : 0}]; figure.segment_count = 1;
      figure.segment_decode = {global_style: {u28: mode === 'outline-gradient' ? 1077936128 : 0, outline_thickness: mode === 'outline-gradient' ? 3 : 0, u30: 0, rgb: [10, 20, 30]}};
      report.keyframes = [createFrame([createObject(figure, 1, 20, 24), createObject(figure, 2, 20, 72)], 10), createFrame([], 1)];
      for (const frame of report.keyframes) frame._stykBackgroundColor = 0;
      const channel = (target, property, a, b) => ({id: animationChannelId(target, property), target, property, keys: [{id: 'a', tick: 0, value: a, interpolation: 'linear'}, {id: 'b', tick: 10, value: b, interpolation: 'linear'}]});
      report._styk.animation = {version: 1, channels: [channel({kind: 'figure', uid: 1}, 'outlineOpacity', 1, 0), channel({kind: 'segment', uid: 1, handleId: 1}, 'opacity', 1, 0), channel({kind: 'segment', uid: 1, handleId: 1}, 'gradientOpacity', 0, 1)]};
      for (const tick of [0, 5, 9]) {
        const frame = evaluatedFrame(report, 0, tick / 10, tick), geometry = buildGeometry(report, frame), options = {report, frame, geometry, view: {x: 0, y: 0, scale: 1}};
        // Independent native-field oracle: two native types with literal alpha bytes.
        const oracle = structuredClone(report); delete oracle._styk.animation;
        const altered = structuredClone(oracle.figure_types[0]); altered.figure_type_id = 2;
        altered.segment_decode.global_style.u30 = Math.round(tick / 10 * 255);
        altered.segments[0].transparency = Math.round(tick / 10 * 255); altered.segments[0].color_alpha = 1 - altered.segments[0].transparency / 255;
        altered.segments[0].secondary.a = Math.round((1 - tick / 10) * 255);
        oracle.figure_types.push(altered); oracle.keyframes[0].objects[0].figure_type_id = 2;
        const expectedCanvas = makeCanvas(); drawGeometry(expectedCanvas.getContext('2d'), buildGeometry(oracle, oracle.keyframes[0])); const expected = bytes(expectedCanvas);
        gpu.render(options); await gpu.device.queue.onSubmittedWorkDone(); const live = bytes(gpuCanvas);
        fallback.render(options); const canvas = bytes(fallbackCanvas);
        const svgBlob = await exportSVG(options), url = URL.createObjectURL(svgBlob), image = new Image(); let svgCanvas;
        try { image.src = url; await image.decode(); svgCanvas = makeCanvas(); svgCanvas.getContext('2d').drawImage(image, 0, 0); } finally { URL.revokeObjectURL(url); }
        const packet = await compilePlaybackPacket(report, tick, {revision: rows.length + 1});
        await gpu.prepareBackgrounds(report, packet.frame); const key = gpu.prepareFrame(packet, {report, view: options.view});
        assert(key && gpu.renderPrepared(key, {report, view: options.view}), 'Prepared style frame did not render.'); await gpu.device.queue.onSubmittedWorkDone();
        const scores = {live: score(live, expected), prepared: score(bytes(gpuCanvas), expected), canvas: score(canvas, expected), svg: score(bytes(svgCanvas), expected)};
        for (const [backend, difference] of Object.entries(scores)) assert(difference.mae < 2.5, `${mode}/${tick}/${backend}: ${JSON.stringify(difference)}`);
        assert(report.figure_types.length === 1 && report.figure_types[0].segments[0].transparency === 0 && report.figure_types[0].segment_decode.global_style.u30 === 0, 'Rendering mutated shared native style.');
        rows.push({mode, tick, scores}); gpu.preparedFrames.clear();
        if (tick === 5) { show(`${mode} / literal native oracle`, expectedCanvas); show(`${mode} / WebGPU`, gpuCanvas); show(`${mode} / SVG`, svgCanvas); }
      }
    }
    assert(!gpu.stats.warnings.length, gpu.stats.warnings.join('\n')); const adapter = gpu.stats.adapter; gpu.destroy(); fallback.destroy(); return {checks: rows.length * 5, rows, adapter};
  });
  if (errors.length) throw new Error(errors.join('\n'));
  await page.screenshot({path: path.join(output, 'pixels.png'), fullPage: true});
  await writeFile(path.join(output, 'report.json'), JSON.stringify({...result, errors}, null, 2)); console.log(JSON.stringify({checks: result.checks, errors}));
} finally { await browser.close(); }
