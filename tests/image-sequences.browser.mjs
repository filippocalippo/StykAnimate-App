import {chromium} from 'playwright';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), output = path.join(root, 'artifacts', 'image-sequences');
await mkdir(output, {recursive: true});
const browser = await chromium.launch({channel: 'chrome', headless: true});
try {
  const page = await browser.newPage({viewport: {width: 850, height: 420}}), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${process.env.STYK_URL || 'http://127.0.0.1:47831'}/api/health`);
  const result = await page.evaluate(async () => {
    const [{exportAnimation}, {crc32}, {exportSVG}, {emptyDocument, createObject}, {buildGeometry, drawGeometry}] = await Promise.all([
      import('/src/image-export.mjs'), import('/src/image-codecs.mjs'), import('/src/svg-export.mjs'), import('/src/demo.mjs'), import('/src/pivot/geometry.mjs'),
    ]);
    const checks = [], assert = (value, message) => { if (!value) throw new Error(message); checks.push(message); };
    const report = emptyDocument(); report.canvas_width = 160; report.canvas_height = 90;
    const figure = report.figure_types[0]; figure.segments = [{...figure.segments[0], length: 70, thickness: 10, angle_rad: 0, color_rgb: [255, 0, 0]}]; figure.segment_count = 1;
    const frame = report.keyframes[0]; frame.objects = [createObject(figure, 1, 20, 25)]; frame.object_draw_order = [0]; frame.object_draw_order_unique_ids = [1]; frame._stykBackgroundColor = 0;
    const canvas = new OffscreenCanvas(160, 90), ctx = canvas.getContext('2d');
    const at = index => { const sample = structuredClone(frame); sample.objects[0].root_y = 25 + index * 8; return sample; };
    const renderFrame = index => { ctx.clearRect(0, 0, 160, 90); drawGeometry(ctx, buildGeometry(report, at(index))); return canvas; };
    const renderSVGFrame = index => exportSVG({report, frame: at(index), width: 160, height: 90});
    const options = {width: 160, height: 90, fps: 24, totalFrames: 4, renderFrame, renderSVGFrame};
    function unzip(data) {
      const view = new DataView(data.buffer), entries = []; let offset = 0;
      while (view.getUint32(offset, true) === 0x04034b50) {
        const size = view.getUint32(offset + 18, true), nameSize = view.getUint16(offset + 26, true), extra = view.getUint16(offset + 28, true);
        const name = new TextDecoder().decode(data.subarray(offset + 30, offset + 30 + nameSize));
        const start = offset + 30 + nameSize + extra, content = data.slice(start, start + size);
        assert(crc32(content) === view.getUint32(offset + 14, true), `${name}: ZIP CRC matches`);
        entries.push({name, content}); offset = start + size;
      }
      assert(view.getUint32(offset, true) === 0x02014b50, 'ZIP central directory is present');
      return entries;
    }
    document.body.innerHTML = '<h1>Numbered vector and GIF sequences</h1><main></main>';
    document.head.insertAdjacentHTML('beforeend', '<style>body{font:13px system-ui;margin:20px;background:#f0f1f4}h1{font-size:18px}main{display:flex;gap:15px}section{background:white;padding:12px;border-radius:8px}canvas{display:block;background:repeating-conic-gradient(#ddd 0% 25%,white 0% 50%) 0/12px 12px}</style>');
    const files = [], reports = [];
    for (const format of ['gif-sequence', 'svg-sequence']) {
      const progress = [], started = performance.now(), blob = await exportAnimation({...options, format, onProgress: value => progress.push(value.completed)});
      assert(progress.join(',') === '1,2,3,4', `${format}: every frame reports progress`);
      const data = new Uint8Array(await blob.arrayBuffer()), entries = unzip(data), extension = format.split('-')[0];
      assert(entries.length === 5 && entries[0].name === `frame-000001.${extension}` && entries[3].name === `frame-000004.${extension}`, `${format}: sequence is correctly numbered`);
      const manifest = JSON.parse(new TextDecoder().decode(entries[4].content));
      assert(manifest.fps === 24 && manifest.totalFrames === 4 && manifest.filenamePattern === `frame-%06d.${extension}`, `${format}: timing manifest is exact`);
      const section = document.createElement('section'); section.textContent = format; document.querySelector('main').append(section);
      for (const index of [0, 3]) {
        const image = new Image(), url = URL.createObjectURL(new Blob([entries[index].content], {type: format === 'svg-sequence' ? 'image/svg+xml' : 'image/gif'}));
        try {
          image.src = url; await image.decode();
          assert(image.naturalWidth === 160 && image.naturalHeight === 90, `${format}/${index}: independent decoder dimensions match`);
          const result = document.createElement('canvas'); result.width = 160; result.height = 90;
          const target = result.getContext('2d'); target.drawImage(image, 0, 0);
          const pixel = target.getImageData(40, 25 + index * 8, 1, 1).data, clear = target.getImageData(1, 1, 1, 1).data;
          assert(pixel[0] === 255 && pixel[1] === 0 && pixel[2] === 0 && pixel[3] === 255 && clear[3] === 0, `${format}/${index}: posed red line and transparent canvas decode correctly`);
          section.append(result);
          if (format === 'svg-sequence') {
            const xml = new TextDecoder().decode(entries[index].content);
            assert(/<path\b/.test(xml) && !/<image\b/.test(xml), `SVG/${index}: figure remains editable vector paths`);
          }
        } finally { URL.revokeObjectURL(url); }
      }
      reports.push({format, bytes: blob.size, durationMs: performance.now() - started});
      files.push({name: `${format}.zip`, bytes: [...data]});
      const controller = new AbortController(); let aborted;
      try { await exportAnimation({...options, format, signal: controller.signal, onProgress: ({completed}) => { if (completed === 2) controller.abort(); }}); }
      catch (error) { aborted = error.name; }
      assert(aborted === 'AbortError', `${format}: mid-export cancellation rejects cleanly`);
      const recovered = await exportAnimation({...options, format, totalFrames: 1}); assert(recovered.size > 100, `${format}: next export works after cancellation`);
    }
    let invalid; try { await exportAnimation({...options, format: 'svg-sequence', renderSVGFrame: () => '<html>wrong format</html>'}); } catch (error) { invalid = error.message; }
    assert(invalid?.includes('SVG document'), 'Wrong vector output is rejected instead of receiving a false SVG extension');
    return {checks, reports, files};
  });
  if (errors.length) throw new Error(errors.join('\n'));
  await page.screenshot({path: path.join(output, 'preview.png')});
  for (const file of result.files) await writeFile(path.join(output, file.name), Uint8Array.from(file.bytes));
  delete result.files;
  await writeFile(path.join(output, 'report.json'), JSON.stringify({...result, errors, checkedAt: new Date().toISOString()}, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally { await browser.close(); }
