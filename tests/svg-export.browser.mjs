import {chromium} from 'playwright';
import {createRequire} from 'node:module';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const require = createRequire(import.meta.url), {startBackend} = require('../desktop/backend.cjs');
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const backend = await startBackend({appRoot});
let browser;
try {
  try { browser = await chromium.launch({headless: true}); }
  catch { browser = await chromium.launch({channel: 'chrome', headless: true}); }
  const page = await browser.newPage();
  await page.goto(`${backend.origin}/api/health`);
  const result = await page.evaluate(async origin => {
    const [{exportSVG}, {buildGeometry, drawGeometry}, {drawBackground, backgroundBounds}, {cameraMatrix}] = await Promise.all([
      import(`${origin}/src/svg-export.mjs`), import(`${origin}/src/pivot/geometry.mjs`), import(`${origin}/src/pivot/background.mjs`), import(`${origin}/src/renderer-geometry.mjs`),
    ]);
    const assert = (condition, message) => { if (!condition) throw new Error(message); };
    const imageCanvas = document.createElement('canvas'); imageCanvas.width = imageCanvas.height = 16;
    const ic = imageCanvas.getContext('2d'); ic.fillStyle = '#eb445c'; ic.fillRect(0, 0, 16, 16); ic.fillStyle = '#2058eb'; ic.fillRect(8, 0, 8, 16);
    const imageUrl = imageCanvas.toDataURL(), image = new Image(); image.src = imageUrl; await image.decode();
    const resources = {url: asset => asset.data_url, image: () => image};
    const segment = (kind, extras = {}) => ({segment_id: 1, parent_id: 0, segment_type: kind === 'circle' ? 'circle' : 'line', segment_kind: kind, length: 70, angle_rad: 0, thickness: 12, color_rgb: [34, 60, 180], ...extras});
    const fig = (id, segments, extras = {}) => ({figure_type_id: id, segments, polyfills: [], ...extras});
    const figureTypes = [
      fig(1, [segment('line', {bend_rad: 1.8, secondary: {rgb: [32, 200, 210], a: 50}})], {segment_decode: {global_style: {u28: new Uint32Array(new Float32Array([3]).buffer)[0], rgb: [30, 35, 60], u30: 40}}}),
      fig(2, [segment('circle', {segment_kind: 'circleFill', length: 35, color_rgb: [230, 55, 75]})]),
      fig(3, [segment('circle', {length: 36, thickness: 6, color_rgb: [25, 155, 110], transparency: 45})]),
      fig(4, [segment('squareLine', {length: 65, angle_rad: .35, thickness: 15, color_rgb: [200, 100, 20]})]),
      fig(5, [segment('line', {length: 55, visible: false}), segment('line', {segment_id: 2, parent_id: 1, angle_rad: 2.1, length: 60, visible: false})], {polyfills: [{segment_ids: [0, 1, 2], color_rgb: [100, 70, 225], alpha_raw: 30}]}),
      fig(6, [segment('line', {segment_type: 'text', extra_u16: 0, length: 70, color_rgb: [15, 65, 125], secondary: {rgb: [230, 80, 150], a: 0}})], {text_assets: [{asset_index: 0, normalized_svg_path: 'M0 0 L40 0 L40 40 Z', bounds: {left: 0, bottom: 40, width: 40, height: 40}, placements: [{visible: true, glyph_index: 0, x: 0, y: 0}], glyphs: [{svg_path: 'M0 40 L20 0 L40 40 Z M15 28 L25 28 L20 16 Z', bounds: {top: 0, bottom: 40}}]}]}),
      fig(7, [segment('line', {segment_type: 'image', extra_u16: 0, length: 45, angle_rad: -.3, transparency: 20})], {image_assets: [{asset_index: 0, data_url: imageUrl, mime_type: 'image/png', width: 16, height: 16, anchor_start: {x: 0, y: 0}, anchor_angle_rad: 0, anchor_length: 16}]}),
      fig(8, [segment('line', {length: 70, thickness: 22, color_rgb: [180, 30, 50]}), segment('line', {segment_id: 2, length: 70, thickness: 22, angle_rad: .6, color_rgb: [180, 30, 50]})]),
    ];
    const report = {version: 5, canvas_width: 320, canvas_height: 240, figure_types: figureTypes, backgrounds: [{background_id: 1, kind: 3, x1: 0, y1: 0, x2: 1, y2: 1, color_a: 0xfff4f6fc, color_b: 0xffd3e5fa}, {background_id: 2, kind: 4, x1: .5, y1: .5, x2: .2, y2: .6, color_a: 0xffd0d8eb, color_b: 0xfffcfaff}, {background_id: 3, kind: 1, data_url: imageUrl, mime_type: 'image/png'}], keyframes: []};
    const positions = [[35, 30], [150, 50], [240, 55], [35, 105], [140, 120], [215, 168], [50, 175], [155, 185]];
    const frame = {background_id: 1, objects: positions.map(([x, y], i) => ({unique_id: i + 1, figure_type_id: i + 1, root_x: x, root_y: y, scale: 1, field28: i === 0 ? 70 : i === 7 ? 127 : 0, color_override_raw: 0})), camera: {is_default: false, scale: 1.12, angle_rad: .08, x: 4, y: -2}};
    report.keyframes = [frame];
    const geometry = buildGeometry(report, frame), results = [];
    let lastSVG, lastPNG;
    for (const scenario of [
      {name: 'linear-background-camera', background_id: 1},
      {name: 'radial-background-camera', background_id: 2},
      {name: 'embedded-raster-background-crossfade', background_id: 3, background_id_b: 2, background_mix: 80},
      {name: 'camera-disabled', background_id: 1, cameraEnabled: false},
    ]) {
      const f = {...frame, background_id_b: 0, background_mix: 0, ...scenario};
      const blob = await exportSVG({report, frame: f, geometry, resources, cameraEnabled: scenario.cameraEnabled !== false});
      const svg = await blob.text(), xml = new DOMParser().parseFromString(svg, 'image/svg+xml');
      assert(!xml.querySelector('parsererror'), `${scenario.name}: invalid XML`);
      assert(xml.querySelectorAll('path').length >= 7 && xml.querySelectorAll('circle').length === 3, 'Geometry was not kept as vectors.');
      assert(xml.querySelector('image').getAttribute('href').startsWith('data:image/'), 'Bitmap was not embedded.');
      assert(!xml.querySelector('text'), 'Glyphs depend on system fonts.');
      const url = URL.createObjectURL(blob), exported = new Image(); exported.src = url;
      try {
        await exported.decode();
        assert(exported.naturalWidth === 320 && exported.naturalHeight === 240, 'SVG decoded dimensions are wrong.');
        const expected = new OffscreenCanvas(320, 240), actual = new OffscreenCanvas(320, 240), ctx = expected.getContext('2d'), ac = actual.getContext('2d');
        ctx.transform(...cameraMatrix({report, frame: f, cameraEnabled: scenario.cameraEnabled !== false}));
        drawBackground(ctx, report, f, 320, 240, {...resources, bounds: backgroundBounds(f, 320, 240, scenario.cameraEnabled !== false)});
        drawGeometry(ctx, geometry, resources);
        ac.drawImage(exported, 0, 0);
        const a = ctx.getImageData(0, 0, 320, 240).data, b = ac.getImageData(0, 0, 320, 240).data;
        let sum = 0, changed = 0, max = 0;
        for (let i = 0; i < a.length; i += 4) {
          let pixel = 0;
          for (let c = 0; c < 4; c++) { const delta = Math.abs(a[i + c] - b[i + c]); sum += delta; pixel = Math.max(pixel, delta); }
          max = Math.max(max, pixel); if (pixel > 10) changed++;
        }
        const meanAbsoluteError = sum / a.length, changedFraction = changed / (a.length / 4);
        assert(meanAbsoluteError < 3 && changedFraction < .065, `${scenario.name}: SVG differs from renderer: MAE ${meanAbsoluteError}, fraction ${changedFraction}`);
        results.push({name: scenario.name, bytes: blob.size, meanAbsoluteError, changedFraction, maxChannelDifference: max, paths: xml.querySelectorAll('path').length});
        lastSVG = svg; lastPNG = [...new Uint8Array(await (await actual.convertToBlob({type: 'image/png'})).arrayBuffer())];
      } finally { URL.revokeObjectURL(url); }
    }
    const scaled = await exportSVG({report, frame, geometry, resources, width: 640, height: 480});
    const scaledURL = URL.createObjectURL(scaled), scaledImage = new Image(); scaledImage.src = scaledURL;
    try { await scaledImage.decode(); assert(scaledImage.naturalWidth === 640 && scaledImage.naturalHeight === 480, 'Custom output dimensions were ignored.'); }
    finally { URL.revokeObjectURL(scaledURL); }
    let rejected = false;
    try { await exportSVG({report, width: 0}); } catch (e) { rejected = e instanceof RangeError; }
    assert(rejected, 'Invalid dimensions were accepted.');
    return {results, scaledDimensions: [640, 480], validation: 'invalid dimensions rejected', svg: lastSVG, png: lastPNG};
  }, backend.origin);
  const {svg, png, ...report} = result;
  await mkdir(path.join(appRoot, 'artifacts'), {recursive: true});
  await writeFile(path.join(appRoot, 'artifacts/vector-export.svg'), svg);
  await writeFile(path.join(appRoot, 'artifacts/vector-export.png'), Uint8Array.from(png));
  await writeFile(path.join(appRoot, 'artifacts/svg-export-browser.json'), JSON.stringify({...report, checkedAt: new Date().toISOString()}, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally { await browser?.close(); backend.stop(); }
