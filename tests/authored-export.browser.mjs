/** Real export worker, native PIV encode/decode, and Canvas pixel comparisons. */
import {chromium} from 'playwright';
import {createRequire} from 'node:module';
import {mkdir, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const require = createRequire(import.meta.url), {startBackend} = require('../desktop/backend.cjs');
const appRoot = fileURLToPath(new URL('..', import.meta.url)), out = path.join(appRoot, 'artifacts');
const backend = await startBackend({appRoot}); let browser;
try {
  browser = await chromium.launch({channel: 'chrome', headless: true});
  const page = await browser.newPage({viewport: {width: 1000, height: 720}}), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${backend.origin}/api/health`);
  await page.setContent('<style>body{margin:24px;background:#f5f5f5;font:14px system-ui}canvas{display:block;background:white;border:1px solid #ddd;margin:12px 0}h1{font-size:18px}</style><h1>Authored frame / Native Pivot reimport</h1><canvas id="before" width="480" height="300"></canvas><canvas id="after" width="480" height="300"></canvas>');
  const result = await page.evaluate(async () => {
    const [{Editor}, {emptyDocument, createFrame, createObject}, geometry, {drawBackground, backgroundBounds}, {cameraMatrix}, {DocumentExporter}, {ImportClient}] = await Promise.all([
      import('/src/editor.mjs'), import('/src/demo.mjs'), import('/src/pivot/geometry.mjs'), import('/src/pivot/background.mjs'),
      import('/src/renderer-geometry.mjs'), import('/src/document-export.mjs'), import('/src/import-client.mjs'),
    ]);
    const check = (value, message) => { if (!value) throw new Error(message); };
    const doc = emptyDocument(); doc.canvas_width = 480; doc.canvas_height = 300;
    doc.keyframes = [110, 220, 130].map((x, index) => createFrame([
      createObject(doc.figure_types[0], 1, x, 150), createObject(doc.figure_types[0], 2, 330 - index * 15, 140),
      createObject(doc.figure_types[0], 3, x, 72, {scale: .35, join: {target_object_slot: 0, target_unique_id: 1, target_handle_id: 1}}),
    ], 5));
    const editor = new Editor({demo: false}).load(doc), layer = editor.createLayer('Front figure');
    editor.assignFiguresToLayer([2], layer.id); editor.moveLayerTo(layer.id, 0);
    const pose = editor.nativePoseChannel({kind: 'layer', id: 'layer-1'});
    editor.deleteAnimationKeys([{channelId: pose.id, keyIds: [pose.keys[1].id]}]);
    const entries = [];
    for (const [target, property, from, to] of [
      [{kind: 'figure', uid: 1}, 'rotation', 0, .6], [{kind: 'figure', uid: 3}, 'opacity', 1, .4],
      [{kind: 'camera'}, 'x', 0, 20], [{kind: 'camera'}, 'scale', 1, 1.12], [{kind: 'camera'}, 'rotation', 0, .12],
      [{kind: 'scene'}, 'color', 0xffe7efff, 0xffffddcc],
    ]) entries.push({target, property, tick: 0, value: from}, {target, property, tick: 14, value: to});
    editor.addAnimationKeys(entries);
    editor.seek(3); editor.addAnimationKey({kind: 'camera'}, 'pose', 3); // retained interpolated source asset
    const originalChannels = JSON.stringify(editor.report._styk.animation), originalSources = JSON.stringify(editor.report._styk.frameSources);
    const originalFrames = JSON.stringify(editor.report.keyframes), exporter = new DocumentExporter(), importer = new ImportClient();
    let active = true, previous = performance.now(), maxGap = 0; const tasks = [];
    const observer = new PerformanceObserver(list => tasks.push(...list.getEntries().map(entry => entry.duration))); observer.observe({type: 'longtask'});
    const beat = now => { maxGap = Math.max(maxGap, now - previous); previous = now; if (active) requestAnimationFrame(beat); }; requestAnimationFrame(beat);
    const piv = await exporter.export(editor.report, {format: 'piv', name: 'Authored channels'}), pivTimings = {...exporter.lastTimings};
    active = false; observer.disconnect();
    const imported = await importer.importFile(new File([piv], 'authored.piv')), native = imported.document;
    check(native.version === 5 && native.total_output_frames === 15, 'PIV worker export lost authored timeline duration.');
    check(!native._styk?.animation, 'Native reimport contains duplicate authored channel overlays.');
    check(JSON.stringify(editor.report.keyframes) === originalFrames, 'Worker changed the original native poses.');
    check(JSON.stringify(editor.report._styk.animation) === originalChannels, 'Worker changed original animation metadata.');
    const sample = (report, tick) => {
      const rows = geometry.timeline(report); let index = 0;
      while (index + 1 < rows.length && rows[index + 1].start <= tick) index++;
      return geometry.evaluatedFrame(report, index, rows[index].count ? (tick - rows[index].start) / rows[index].count : 0, tick);
    };
    function render(canvas, report, frame) {
      const ctx = canvas.getContext('2d', {willReadFrequently: true}); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.save(); ctx.beginPath(); ctx.rect(0, 0, canvas.width, canvas.height); ctx.clip(); ctx.setTransform(...cameraMatrix({report, frame}));
      // Native materialization represents the authored override as this exact solid brush.
      if (frame._stykBackgroundColor !== undefined) {
        const raw = frame._stykBackgroundColor, bounds = backgroundBounds(frame, canvas.width, canvas.height, true);
        ctx.fillStyle = `rgba(${raw >>> 16 & 255},${raw >>> 8 & 255},${raw & 255},${(raw >>> 24) / 255})`;
        ctx.fillRect(bounds.x, bounds.y, bounds.width, bounds.height);
      } else drawBackground(ctx, report, frame, canvas.width, canvas.height, {bounds: backgroundBounds(frame, canvas.width, canvas.height, true)});
      geometry.drawGeometry(ctx, geometry.buildGeometry(report, frame), {}); ctx.restore();
      return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    }
    const pixels = [];
    for (const tick of [0, 3, 5, 8, 10, 14]) {
      const a = sample(editor.report, tick), b = sample(native, tick);
      check(JSON.stringify(a.object_draw_order_unique_ids) === JSON.stringify(b.object_draw_order_unique_ids), `Figure draw order differs at ${tick}.`);
      const first = render(document.querySelector('#before'), editor.report, a), second = render(document.querySelector('#after'), native, b);
      let total = 0, changed = 0, max = 0;
      for (let i = 0; i < first.length; i++) { const delta = Math.abs(first[i] - second[i]); total += delta; max = Math.max(max, delta); if (delta > 8) changed++; }
      const mean = total / first.length, ratio = changed / first.length;
      check(mean < .12 && ratio < .002, `Reimport render differs at ${tick}: mean=${mean}, changed=${ratio}, max=${max}.`);
      pixels.push({tick, meanByteDifference: mean, changedChannelFraction: ratio, maxByteDifference: max});
    }
    const styk = await exporter.export(editor.report, {format: 'styk', name: 'Authored channels'}), restored = await importer.importFile(new File([styk], 'authored.styk'));
    check(JSON.stringify(restored.document._styk.animation) === originalChannels, 'STYK changed sparse authored keys.');
    check(JSON.stringify(restored.document._styk.frameSources) === originalSources, 'STYK changed retained source identities or poses.');
    const sourceFiles = [];
    for (const name of ['Pivot Animator v5/Animations/tween_NY_day-night.piv', 'Pivot Animator v5/Animations/text_bike.piv', 'Pivot Animator v5/Animations/Legacy/sprite_demo.piv']) {
      const opened = await importer.openSample(name), sourceEditor = new Editor({demo: false}).load(opened.document);
      sourceEditor.addAnimationKeys([{target: {kind: 'camera'}, property: 'x', tick: 0, value: 23},
        {target: {kind: 'scene'}, property: 'color', tick: 0, value: 0xffbada55}]);
      const saved = await exporter.export(sourceEditor.report, {sourceId: opened.sourceId, format: 'piv'}), timings = {...exporter.lastTimings};
      const checked = (await importer.importFile(new File([saved], 'source-edited.piv'))).document;
      check(checked.keyframes[0].camera.x === 23, `Source-backed export lost camera edit for ${name}.`);
      check(checked.backgrounds.find(bg => bg.background_id === checked.keyframes[0].background_id)?.color === 0xffbada55, `Source-backed export lost scene color for ${name}.`);
      const images = report => report.figure_types.reduce((count, figure) => count + (figure.image_assets?.length || 0), 0);
      const texts = report => report.figure_types.flatMap(figure => (figure.text_assets || []).map(asset => asset.text)).sort();
      check(images(checked) === images(opened.document), `Source-backed export lost sprite assets for ${name}.`);
      check(JSON.stringify(texts(checked)) === JSON.stringify(texts(opened.document)), `Source-backed export lost glyph assets for ${name}.`);
      const raster = report => report.backgrounds.filter(bg => [0, 1, 'bmp', 'png', 'jpeg', 'jpg'].includes(bg.kind));
      check(raster(checked).length === raster(opened.document).length, `Source-backed export lost image backgrounds for ${name}.`);
      if (opened.document.version === 5) {
        const payloads = report => raster(report).map(bg => bg.data_base64 ?? bg.data_url ?? bg.data_uri).filter(Boolean).sort();
        check(JSON.stringify(payloads(checked)) === JSON.stringify(payloads(opened.document)), `Source-backed export changed native image payloads for ${name}.`);
      }
      sourceFiles.push({name, bytes: saved.size, sourceVersion: opened.document.version, outputVersion: checked.version, outputFrames: checked.total_output_frames,
        images: images(checked), textAssets: texts(checked).length, rasterBackgrounds: raster(checked).length, timings});
    }
    window.exportFiles = {piv, styk}; exporter.dispose(); importer.dispose();
    return {pivBytes: piv.size, stykBytes: styk.size, pivTimings, outputFrames: native.total_output_frames, pixels, sourceFiles,
      mainThreadLongTasks: tasks, maxAnimationFrameGapMs: maxGap, nativePosesUntouched: true, stykChannelsExact: true, stykSourcesExact: true};
  });
  await mkdir(out, {recursive: true});
  for (const kind of ['piv', 'styk']) {
    const bytes = await page.evaluate(async kind => Array.from(new Uint8Array(await window.exportFiles[kind].arrayBuffer())), kind);
    await writeFile(path.join(out, `authored-export.${kind}`), Buffer.from(bytes));
  }
  await page.screenshot({path: path.join(out, 'authored-export-render.png')});
  if (errors.length) throw new Error(errors.join('\n'));
  await writeFile(path.join(out, 'authored-export-browser.json'), JSON.stringify({...result, errors}, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally { await browser?.close(); backend.stop(); }
