import { _electron as electron } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await mkdir(path.join(root, 'artifacts'), { recursive: true });
const app = await electron.launch({ args: [root], cwd: root, timeout: 45000, env: { ...process.env, STYK_USER_DATA_DIR: path.join(root, 'artifacts', 'gpu-test-profile') } });
try {
  const page = await app.firstWindow(); await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => window.styk?.ready === true, { timeout: 20000 });
  await page.screenshot({ path: path.join(root, 'artifacts', 'renderer-main-app.png') });
  const result = await page.evaluate(async () => {
    const { createRenderer, worldToScreen } = await import('/src/renderer.mjs');
    const { buildGeometry } = await import('/src/pivot/geometry.mjs');
    const { compilePlaybackPacket } = await import('/src/playback-worker.mjs');
    const { createDemo, defaultFigure, createObject, createFrame } = await import('/src/demo.mjs');
    const canvas = document.createElement('canvas');
    Object.assign(canvas.style, { position: 'fixed', inset: '0', width: '100vw', height: '100vh', zIndex: 99999, background: '#ececf1' });
    document.body.append(canvas);
    const renderer = await createRenderer(canvas); renderer.resize(innerWidth, innerHeight, devicePixelRatio);
    const report = createDemo(), frame = report.keyframes[0], geometry = buildGeometry(report, frame);
    renderer.render({ report, frame, geometry, view: { x: 80, y: 70, scale: .95 } });
    await renderer.device?.queue.onSubmittedWorkDone();
    const first = structuredClone(renderer.stats);
    if (first.backend !== 'WebGPU') throw new Error(`Expected WebGPU: ${JSON.stringify(first)}`);
    if (first.warnings?.length) throw new Error(`WebGPU error: ${first.warnings.join('\n')}`);
    const images = canvas.toDataURL('image/png');
    const pixelSource = document.createElement('canvas'); pixelSource.width = pixelSource.height = 2;
    const sourceContext = pixelSource.getContext('2d');
    for (const [x, y, color] of [[0, 0, '#ff0000'], [1, 0, '#00ff00'], [0, 1, '#0000ff'], [1, 1, '#ffff00']]) { sourceContext.fillStyle = color; sourceContext.fillRect(x, y, 1, 1); }
    const sourceUrl = pixelSource.toDataURL('image/png'), pixelFrame = createFrame([]); pixelFrame.background_id = 1;
    const pixelReport = { ...report, canvas_width: 32, canvas_height: 24, backgrounds: [{ background_id: 1, kind: 1, asset_url: sourceUrl, mime_type: 'image/png' }], figure_types: [], keyframes: [pixelFrame] };
    const pixelPacket = await compilePlaybackPacket(pixelReport, 0, { revision: 90 });
    renderer.resize(32, 24, 1); renderer.useReport(pixelReport);
    const readyBeforeDecode = renderer.backgroundsReady(pixelReport, pixelFrame), earlyKey = renderer.prepareFrame(pixelPacket, {report: pixelReport, view: {x: 0, y: 0, scale: 1}});
    if (!readyBeforeDecode && earlyKey !== null) throw new Error('An unresolved background was cached in a prepared frame.');
    await renderer.prepareBackgrounds(pixelReport, pixelFrame);
    const pixelKey = renderer.prepareFrame(pixelPacket, {report: pixelReport, view: {x: 0, y: 0, scale: 1}});
    if (!renderer.renderPrepared(pixelKey, {report: pixelReport, view: {x: 0, y: 0, scale: 1}})) throw new Error('Prepared background did not become ready after image decode.');
    await renderer.device.queue.onSubmittedWorkDone();
    const pixelSnapshot = new Image(); pixelSnapshot.src = canvas.toDataURL('image/png'); await pixelSnapshot.decode();
    const pixelReadback = document.createElement('canvas'); pixelReadback.width = 32; pixelReadback.height = 24; const pixelContext = pixelReadback.getContext('2d'); pixelContext.drawImage(pixelSnapshot, 0, 0);
    const pixelData = pixelContext.getImageData(0, 0, 32, 24).data;
    pixelContext.imageSmoothingEnabled = false; pixelContext.drawImage(pixelSource, 0, 0, 32, 32); const nativePixels = pixelContext.getImageData(0, 0, 32, 24).data;
    let pixelError = 0; for (let i = 0; i < pixelData.length; i++) pixelError += Math.abs(pixelData[i] - nativePixels[i]);
    if (pixelError !== 0) throw new Error(`Nearest-neighbor background sampling differed from Canvas by ${pixelError} channel units.`);
    const workspaceChecks = [], workspaceImages = {};
    const workspaceFigure = defaultFigure(71);
    workspaceFigure.segments = [{ ...workspaceFigure.segments[0], length: 20, thickness: 12, angle_rad: 0, color_rgb: [255, 0, 0] }]; workspaceFigure.segment_count = 1;
    const readPixels = async target => {
      await target.device?.queue.onSubmittedWorkDone();
      const snapshot = new Image(); readPixels.snapshotUrl = target.canvas.toDataURL('image/png'); snapshot.src = readPixels.snapshotUrl; await snapshot.decode();
      const surface = document.createElement('canvas'); surface.width = target.canvas.width; surface.height = target.canvas.height;
      const ctx = surface.getContext('2d'); ctx.drawImage(snapshot, 0, 0);
      return ctx.getImageData(0, 0, surface.width, surface.height).data;
    };
    const fallbackCanvas = document.createElement('canvas'); fallbackCanvas.getContext('2d');
    const fallback = await createRenderer(fallbackCanvas);
    if (fallback.stats.backend !== 'Canvas 2D fallback') throw new Error('Workspace fallback fixture did not acquire a Canvas 2D renderer.');
    for (const target of [renderer, fallback]) {
      target.resize(640, 480, 1);
      for (const [index, scenario] of [
        { view: { x: 100, y: 90, scale: 1 } },
        { view: { x: 40, y: 30, scale: 2 }, camera: { x: 20, y: -10, scale: .7, angle_rad: .25 } },
        { view: { x: 210, y: 150, scale: .75 }, camera: { x: 20, y: -10, scale: .7, angle_rad: .25 }, opacity: 80 },
      ].entries()) {
        const workspaceFrame = createFrame([createObject(workspaceFigure, 71, 150, 50, { field28: scenario.opacity || 0 })]);
        if (scenario.camera) workspaceFrame.camera = scenario.camera;
        const workspaceReport = { ...report, canvas_width: 100, canvas_height: 100, backgrounds: [], figure_types: [workspaceFigure], keyframes: [workspaceFrame] };
        const options = { report: workspaceReport, frame: workspaceFrame, geometry: buildGeometry(workspaceReport, workspaceFrame), view: scenario.view };
        const screen = worldToScreen({ x: 160, y: 50 }, options), px = Math.floor(screen.x), py = Math.floor(screen.y), pixel = (py * 640 + px) * 4;
        if (px <= scenario.view.x + 100 * scenario.view.scale || px >= 640 || py < 0 || py >= 480) throw new Error('Workspace fixture does not lie outside the artboard inside the viewport.');
        target.render({ ...options, clipToCanvas: false }); const open = await readPixels(target);
        if (target.device && index === 1) workspaceImages.open = readPixels.snapshotUrl;
        if (open[pixel] < 245 || open[pixel + 1] > 5 || open[pixel + 3] < 160) throw new Error(`${target.stats.backend} hid or misplaced an off-artboard figure after pan/zoom/camera transform.`);
        target.render(options); const clipped = await readPixels(target);
        if (target.device && index === 1) workspaceImages.clipped = readPixels.snapshotUrl;
        if (clipped[pixel + 3] !== 0) throw new Error('Default rendering must still clip figures for playback and export.');
        // Backgrounds can span a camera-rotated bounding box but may not paint the workspace.
        const blankFrame = { ...workspaceFrame, objects: [], object_draw_order: [], object_draw_order_unique_ids: [] };
        target.render({ ...options, frame: blankFrame, geometry: buildGeometry(workspaceReport, blankFrame), clipToCanvas: false });
        const background = await readPixels(target); let leakedBackgroundPixels = 0;
        for (let y = 0; y < 480; y++) for (let x = 0; x < 640; x++) {
          if (x + .5 >= scenario.view.x && x + .5 <= scenario.view.x + 100 * scenario.view.scale && y + .5 >= scenario.view.y && y + .5 <= scenario.view.y + 100 * scenario.view.scale) continue;
          if (background[(y * 640 + x) * 4 + 3]) leakedBackgroundPixels++;
        }
        if (leakedBackgroundPixels) throw new Error(`Background painted ${leakedBackgroundPixels} pixels outside the artboard.`);
        if (target.device) {
          const packet = await compilePlaybackPacket(workspaceReport, 0, { revision: 200 + index, scale: scenario.view.scale });
          const key = target.prepareFrame(packet, { report: workspaceReport, view: scenario.view });
          target.renderPrepared(key, { report: workspaceReport, view: scenario.view, clipToCanvas: false });
          if ((await readPixels(target))[pixel + 3] !== 0) throw new Error('Prepared playback escaped the artboard clip.');
          for (const entry of packet.compatibility) entry.bitmap?.close();
        }
        workspaceChecks.push({ backend: target.stats.backend, zoom: scenario.view.scale, rotatedCamera: !!scenario.camera, compatibilityTexture: !!scenario.opacity, offArtboardFigurePixel: [px, py], visibleAlpha: open[pixel + 3], clippedAlpha: clipped[pixel + 3], leakedBackgroundPixels });
      }
    }
    fallback.destroy();
    renderer.resize(innerWidth, innerHeight, devicePixelRatio);
    renderer.render({ report, frame, geometry, view: { x: 80, y: 70, scale: .95 }, onionFrames: [report.keyframes[1]] });
    await renderer.device.queue.onSubmittedWorkDone();
    if (renderer.stats.primitives <= first.primitives) throw new Error('Onion skin did not add a previous-frame GPU pass.');
    const texturedOnion = structuredClone(report.keyframes[1]); texturedOnion.objects[0].field28 = 80;
    const onionOptions = {report, frame, geometry, view: {x: 80, y: 70, scale: 1}, onionFrames: [texturedOnion]};
    renderer.render(onionOptions); const retainedOnion = renderer.onionScenes[0].geometry;
    renderer.render({...onionOptions, view: {...onionOptions.view, scale: 2}});
    if (renderer.onionScenes[0].geometry !== retainedOnion || renderer.stats.compiledObjects !== 0) throw new Error('Zoom rebuilt unchanged onion geometry or vector buffers.');
    renderer.render({ report, frame, geometry, view: { x: 80, y: 70, scale: .95 }, hiddenUids: new Set([1]) });
    await renderer.device.queue.onSubmittedWorkDone();
    if (renderer.stats.primitives !== first.primitives) throw new Error('Removing onion skin did not restore the active scene.');
    const figure = defaultFigure(), objects = Array.from({ length: 1000 }, (_, i) => createObject(figure, i + 1, (i % 50) * 18, 12 + Math.floor(i / 50) * 24, { scale: .1 }));
    const large = { ...report, figure_types: [figure], keyframes: [createFrame(objects)] }, f = large.keyframes[0], g = buildGeometry(large, f), times = [];
    renderer.render({ report: large, frame: f, geometry: g, view: { x: 80, y: 70, scale: .95 } });
    await renderer.device.queue.onSubmittedWorkDone();
    const untouchedEntry = renderer.entries.get(2), untouchedData = untouchedEntry.data, initialUpload = renderer.stats.uploadBytes;
    f.objects[0].angles[0] += .1;
    const editedGeometry = buildGeometry(large, f, {previous: g, dirtySlots: [0]});
    Object.defineProperty(editedGeometry, 'drawables', {get() { throw new Error('Incremental renderer must not flatten or traverse every scene drawable.'); }});
    renderer.render({ report: large, frame: f, geometry: editedGeometry, view: { x: 80, y: 70, scale: .95 } });
    const incrementalEdit = structuredClone(renderer.stats);
    if (incrementalEdit.preparation !== 'incremental' || incrementalEdit.updatedObjects !== 1 || incrementalEdit.compiledObjects !== 1 || incrementalEdit.uploadBytes >= initialUpload / 100 || renderer.entries.get(2) !== untouchedEntry || untouchedEntry.data !== untouchedData) throw new Error('A single joint edit did not retain untouched figure data and upload only its range.');
    for (let i = 0; i < 60; i++) {
      const start = performance.now(); renderer.render({ report: large, frame: f, geometry: editedGeometry, view: { x: 80, y: 70, scale: .95 }, dragTranslations: new Map([[1, { x: i, y: i / 2 }]]) });
      times.push(performance.now() - start);
    }
    await renderer.device.queue.onSubmittedWorkDone();
    const stats = structuredClone(renderer.stats); times.sort((a, b) => a - b);
    renderer.render({ report, frame, geometry, view: { x: 80, y: 70, scale: .95 } });
    await renderer.device.queue.onSubmittedWorkDone();
    const preparedPacket = await compilePlaybackPacket(report, 0, {revision: 91});
    const preparedKey = renderer.prepareFrame(preparedPacket, {report, view: {x: 80, y: 70, scale: .95}});
    if (!renderer.hasPreparedFrame(preparedKey) || !renderer.renderPrepared(preparedKey, {report, view: {x: 80, y: 70, scale: .95}})) throw new Error('Prepared packet rendering failed before device recovery.');
    await renderer.device.queue.onSubmittedWorkDone();
    // Reinitialize the same canvas after a simulated GPU-device disconnect.
    renderer.device.destroy(); await renderer.device.lost;
    const lostStatus = renderer.stats.backend; renderer.destroy();
    const recovered = await createRenderer(canvas); recovered.resize(innerWidth, innerHeight, devicePixelRatio);
    recovered.render({ report, frame, geometry, view: { x: 80, y: 70, scale: .95 } }); await recovered.device.queue.onSubmittedWorkDone();
    if (lostStatus !== 'WebGPU device lost' || recovered.stats.backend !== 'WebGPU' || recovered.stats.warnings.length || renderer.preparedFrames.bytes !== 0) throw new Error('The WebGPU canvas did not recover cleanly after device disconnection.');
    window.__gpuTestRenderer = recovered;
    return { first, largeScene: stats, incrementalEdit, translationCpuMedianMs: times[30], translationCpuP95Ms: times[57], deviceRecovery: { lostStatus, recovered: recovered.stats.backend }, nearestBackgroundSampling: { sourcePixels: [2, 2], renderedPixels: [32, 24], totalChannelError: pixelError }, workspaceChecks, workspaceImages, images };
  });
  const { images, workspaceImages, ...metrics } = result;
  for (const [mode, data] of Object.entries(workspaceImages)) await writeFile(path.join(root, 'artifacts', `renderer-workspace-${mode}.png`), Buffer.from(data.split(',')[1], 'base64'));
  await writeFile(path.join(root, 'artifacts', 'renderer-gpu.png'), Buffer.from(images.split(',')[1], 'base64'));
  await writeFile(path.join(root, 'artifacts', 'renderer-gpu.json'), JSON.stringify(metrics, null, 2));
  console.log(JSON.stringify(metrics, null, 2));
  if (process.argv.includes('--imports')) {
    await page.evaluate(() => { window.__gpuTestRenderer.destroy(); window.__gpuTestRenderer.canvas.remove(); });
    for (const [index, filename] of ['sukunatest.stk', 'Goku_Broly_Movie_by_Killer1.piv'].entries()) {
      const imported = await page.evaluate(async (filename) => {
        const { ImportClient } = await import('/src/import-client.mjs');
        const client = new ImportClient(), result = await client.openSample(filename); client.dispose();
        await window.styk.acceptImport(result, filename, { replaceApproved: true });
        const { editor, state } = window.styk;
        const renderer = state.renderer;
        // Resolve all assets before comparing with the mature Canvas reference path.
        const images = [];
        for (const fig of editor.report.figure_types) for (const asset of [...fig.image_assets || [], ...fig.text_assets || []]) {
          const image = renderer.resources.image(renderer.resources.url(asset)); if (image) images.push(image);
        }
        for (const asset of editor.report.backgrounds || []) { const image = renderer.resources.image(renderer.resources.url(asset)); if (image) images.push(image); }
        await Promise.all(images.filter(image => !image.complete).map(image => image.decode().catch(() => {})));
        const { drawGeometry } = await import('/src/pivot/geometry.mjs');
        const { drawBackground, backgroundBounds } = await import('/src/pivot/background.mjs');
        const { cameraMatrix } = await import('/src/renderer.mjs');
        const report = editor.report, frame = editor.evaluatedFrame, geometry = editor.geometry, view = state.view;
        renderer.render({ report, frame, geometry, view }); await renderer.device.queue.onSubmittedWorkDone();
        const gpuData = renderer.canvas.toDataURL('image/png');
        const reference = document.createElement('canvas'); reference.width = renderer.canvas.width; reference.height = renderer.canvas.height;
        const ctx = reference.getContext('2d'); ctx.scale(devicePixelRatio, devicePixelRatio); ctx.beginPath(); ctx.rect(view.x, view.y, report.canvas_width * view.scale, report.canvas_height * view.scale); ctx.clip(); ctx.transform(...cameraMatrix({ report, frame, view }));
        drawBackground(ctx, report, frame, report.canvas_width, report.canvas_height, { ...renderer.resources, bounds: backgroundBounds(frame, report.canvas_width, report.canvas_height) });
        drawGeometry(ctx, geometry, renderer.resources);
        const referenceData = reference.toDataURL('image/png');
        const snapshot = new Image(); snapshot.src = gpuData; await snapshot.decode();
        const actual = document.createElement('canvas'); actual.width = reference.width; actual.height = reference.height; actual.getContext('2d').drawImage(snapshot, 0, 0);
        const a = actual.getContext('2d').getImageData(0, 0, actual.width, actual.height).data, b = ctx.getImageData(0, 0, reference.width, reference.height).data;
        let error = 0, changed = 0; for (let i = 0; i < a.length; i += 4) { let difference = 0; for (let k = 0; k < 4; k++) difference += Math.abs(a[i + k] - b[i + k]); error += difference; if (difference > 80) changed++; }
        return { filename, timings: result.timings, gpu: { ...renderer.stats }, diff: { meanAbsoluteChannelError: error / a.length, percentPixelsOverThreshold: changed / (a.length / 4) * 100 }, gpuData, referenceData };
      }, filename);
      const { gpuData, referenceData, ...importMetrics } = imported;
      await writeFile(path.join(root, 'artifacts', `renderer-import-${index}-gpu.png`), Buffer.from(gpuData.split(',')[1], 'base64'));
      await writeFile(path.join(root, 'artifacts', `renderer-import-${index}-reference.png`), Buffer.from(referenceData.split(',')[1], 'base64'));
      await writeFile(path.join(root, 'artifacts', `renderer-import-${index}.json`), JSON.stringify(importMetrics, null, 2));
      await page.screenshot({ path: path.join(root, 'artifacts', `renderer-import-${index}-app.png`) });
      console.log(JSON.stringify(importMetrics, null, 2));
      if (imported.gpu.warnings.length) throw new Error(`GPU validation failed for ${filename}: ${imported.gpu.warnings.join('; ')}`);
      if (imported.diff.meanAbsoluteChannelError > 2 || imported.diff.percentPixelsOverThreshold > 1) throw new Error(`Imported scene differs materially from the reference renderer: ${filename}`);
    }
  }
} finally { await app.close(); }
