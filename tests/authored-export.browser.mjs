/** Real export worker, native PIV encode/decode, and Canvas pixel comparisons. */
import {chromium} from './support/playwright.mjs';
import {createRequire} from 'node:module';
import {mkdir, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {exposeWorkspaceSamples} from './support/workspace-samples.mjs';
const require = createRequire(import.meta.url), {startDesktopHost} = require('../desktop/web-host.cjs');
const appRoot = fileURLToPath(new URL('..', import.meta.url)), out = path.join(appRoot, 'artifacts');
const backend = await startDesktopHost({appRoot}); let browser;
try {
  browser = await chromium.launch({channel: 'chrome', headless: true});
  const page = await browser.newPage({viewport: {width: 1000, height: 720}}), errors = [];
  await exposeWorkspaceSamples(page);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(backend.origin); await page.waitForFunction(() => window.styk?.ready);
  const result = await page.evaluate(async () => {
    const [{emptyDocument, createFrame, createObject}, {DocumentExporter}, {ImportClient}, {pageEditor}] = await Promise.all([
      import('/src/demo.mjs'), import('/src/document-export.mjs'), import('/src/import-client.mjs'), import('/tests/support/page-editor.mjs'),
    ]);
    const check = (value, message) => { if (!value) throw new Error(message); };
    const doc = emptyDocument(); doc.canvas_width = 480; doc.canvas_height = 300;
    doc.keyframes = [110, 220, 130].map((x, index) => createFrame([
      createObject(doc.figure_types[0], 1, x, 150), createObject(doc.figure_types[0], 2, 330 - index * 15, 140),
      createObject(doc.figure_types[0], 3, x, 72, {scale: .35, join: {target_object_slot: 0, target_unique_id: 1, target_handle_id: 1}}),
    ], 5));
    // The project on show is the engine's: it is what an export saves.
    const editor = styk.editor.load(doc), layer = editor.createLayer('Front figure');
    editor.assignFiguresToLayer([2], layer.id); editor.moveLayerTo(layer.id, 0);
    const entries = [];
    for (const [target, property, from, to] of [
      [{kind: 'figure', uid: 1}, 'rotation', 0, .6], [{kind: 'figure', uid: 3}, 'opacity', 1, .4],
      [{kind: 'camera'}, 'x', 0, 20], [{kind: 'camera'}, 'scale', 1, 1.12], [{kind: 'camera'}, 'rotation', 0, .12],
      [{kind: 'scene'}, 'color', 0xffe7efff, 0xffffddcc],
    ]) entries.push({target, property, tick: 0, value: from}, {target, property, tick: 14, value: to});
    editor.addAnimationKeys(entries);
    const originalChannels = JSON.stringify(editor.report._styk.animation);
    const originalFrames = JSON.stringify(editor.report.keyframes), exporter = new DocumentExporter(), importer = new ImportClient({readSample: (await import('/tests/support/page-samples.mjs')).sampleReader()});
    let active = true, previous = performance.now(), maxGap = 0; const tasks = [];
    const observer = new PerformanceObserver(list => tasks.push(...list.getEntries().map(entry => entry.duration))); observer.observe({type: 'longtask'});
    const beat = now => { maxGap = Math.max(maxGap, now - previous); previous = now; if (active) requestAnimationFrame(beat); }; requestAnimationFrame(beat);
    const piv = await exporter.export(editor.report, {format: 'piv', name: 'Authored channels', revision: editor.revision}), pivTimings = {...exporter.lastTimings};
    active = false; observer.disconnect();
    const imported = await importer.importFile(new File([piv], 'authored.piv')), native = imported.document;
    check(native.version === 5 && native.total_output_frames === 15, 'PIV export lost authored timeline duration.');
    check(!native._styk?.animation, 'Native reimport contains duplicate authored channel overlays.');
    check(JSON.stringify(editor.report.keyframes) === originalFrames, 'Export changed the original native poses.');
    check(JSON.stringify(editor.report._styk.animation) === originalChannels, 'Export changed original animation metadata.');
    // The reopened file plays what the project played: its frames, tick by tick, in a second editor the engine owns.
    const reopened = pageEditor().load(native);
    const frames = [];
    const sample = (target, tick) => {
      target.seek(tick); const frame = target.evaluatedFrame;
      return {order: frame.object_draw_order_unique_ids.slice(), objects: frame.objects.map(o => [o.unique_id, o.root_x, o.root_y, o.scale]).sort((a, b) => a[0] - b[0]),
        camera: [frame.camera.x, frame.camera.y, frame.camera.scale, frame.camera.angle_rad]};
    };
    const near = (a, b) => a.length === b.length && a.every((value, index) => Array.isArray(value) ? near(value, b[index]) : Math.abs(value - b[index]) <= .002 * Math.max(1, Math.abs(value)));
    for (const tick of [0, 3, 5, 8, 10, 14]) {
      const a = sample(editor, tick), b = sample(reopened, tick);
      check(JSON.stringify(a.order) === JSON.stringify(b.order), `Figure draw order differs at ${tick}.`);
      check(near(a.objects, b.objects) && near(a.camera, b.camera), `Reimported poses and camera differ at ${tick}: ${JSON.stringify([a.objects, b.objects, a.camera, b.camera])}`);
      frames.push({tick, objects: a.objects.length});
    }
    editor.seek(0);
    const stykFile = await exporter.export(editor.report, {format: 'styk', name: 'Authored channels', revision: editor.revision}), restored = await importer.importFile(new File([stykFile], 'authored.styk'));
    check(JSON.stringify(restored.document._styk.animation) === originalChannels, 'STYK changed sparse authored keys.');
    const sourceFiles = [];
    for (const name of ['Pivot Animator v5/Animations/tween_NY_day-night.piv', 'Pivot Animator v5/Animations/text_bike.piv', 'Pivot Animator v5/Animations/Legacy/sprite_demo.piv']) {
      const opened = await importer.openSample(name), sourceEditor = styk.editor.load(opened.document);
      sourceEditor.addAnimationKeys([{target: {kind: 'camera'}, property: 'x', tick: 0, value: 23},
        {target: {kind: 'scene'}, property: 'color', tick: 0, value: 0xffbada55}]);
      const saved = await exporter.export(sourceEditor.report, {sourceId: opened.sourceId, format: 'piv', revision: sourceEditor.revision}), timings = {...exporter.lastTimings};
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
    window.exportFiles = {piv, styk: stykFile}; exporter.dispose(); importer.dispose();
    return {pivBytes: piv.size, stykBytes: stykFile.size, pivTimings, outputFrames: native.total_output_frames, frames, sourceFiles,
      mainThreadLongTasks: tasks, maxAnimationFrameGapMs: maxGap, nativePosesUntouched: true, stykChannelsExact: true};
  });
  await mkdir(out, {recursive: true});
  for (const kind of ['piv', 'styk']) {
    const bytes = await page.evaluate(async kind => Array.from(new Uint8Array(await window.exportFiles[kind].arrayBuffer())), kind);
    await writeFile(path.join(out, `authored-export.${kind}`), Buffer.from(bytes));
  }
  if (errors.length) throw new Error(errors.join('\n'));
  await writeFile(path.join(out, 'authored-export-browser.json'), JSON.stringify({...result, errors}, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally { await browser?.close(); backend.stop(); }
