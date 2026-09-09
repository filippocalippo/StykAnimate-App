import { _electron as electron } from 'playwright';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(path.join(root, '..', 'docs', 'piv_corpus_manifest.json'), 'utf8'));
const filter = process.argv.find(a => a.startsWith('--filter='))?.slice(9);
const prepared = process.argv.includes('--prepared');
const output = path.join(root, 'artifacts', `renderer-corpus${prepared ? '-prepared' : ''}${filter ? '-' + filter.replace(/[^a-z0-9]/ig, '-') : ''}`); await mkdir(output, { recursive: true });
const fixtures = manifest.fixtures.filter(f => !filter || f.path.toLowerCase().includes(filter.toLowerCase()));
const app = await electron.launch({ args: [root], cwd: root, timeout: 45000, env: { ...process.env, STYK_USER_DATA_DIR: path.join(output, 'profile') } });
const browserErrors = [], results = [];
try {
  const page = await app.firstWindow(); page.on('pageerror', error => browserErrors.push(error.message));
  await page.waitForFunction(() => window.styk?.ready === true, { timeout: 25000 });
  await page.evaluate(async () => {
    const rendererModule = await import('/src/renderer.mjs'), geometryModule = await import('/src/pivot/geometry.mjs'), backgroundModule = await import('/src/pivot/background.mjs');
    const { ImportClient } = await import('/src/import-client.mjs');
    const { PlaybackCache } = await import('/src/playback.mjs');
    const canvas = document.createElement('canvas'); document.body.append(canvas);
    Object.assign(canvas.style, { position: 'fixed', inset: '0', zIndex: 100000, background: '#ccc' });
    const images = new Map();
    const resources = { url: a => a?.asset_url || a?.data_url || a?.asset_path_relative || a?.asset_path,
      image: url => { if (!url) return null; if (images.has(url)) return images.get(url); const image = new Image(); image.src = url; images.set(url, image); return image; } };
    const renderer = await rendererModule.createRenderer(canvas, { resources });
    window.__corpus = { renderer, rendererModule, geometryModule, backgroundModule, client: new ImportClient(), playback: new PlaybackCache({maxFrames: 6}), images, resources };
  });
  for (const [i, fixture] of fixtures.entries()) {
    let result;
    try {
      result = await page.evaluate(async ({ filename, version, prepared }) => {
        const { renderer, rendererModule, geometryModule, backgroundModule, client, resources, images, playback } = window.__corpus;
        renderer.last = null; images.clear();
        const imported = await client.openSample(filename), report = imported.document || imported.report || imported;
        const assets = [...report.backgrounds || []]; for (const figure of report.figure_types) assets.push(...figure.image_assets || []);
        for (const asset of assets) resources.image(resources.url(asset));
        await Promise.all([...images.values()].filter(image => !image.complete).map(image => image.decode().catch(() => {})));
        const badAssets = [...images].filter(([, image]) => !image.naturalWidth).map(([url]) => url);
        const t = geometryModule.timeline(report), totalTicks = t.length ? t.at(-1).start + t.at(-1).count : 0;
        const selectedTicks = [...new Set([0, Math.floor(Math.max(0, totalTicks - 1) / 2), Math.max(0, totalTicks - 1)])];
        const scale = Math.min(1, 960 / report.canvas_width, 960 / report.canvas_height), width = Math.max(1, Math.ceil(report.canvas_width * scale)), height = Math.max(1, Math.ceil(report.canvas_height * scale));
        renderer.resize(width, height, 1); renderer.canvas.style.width = `${width}px`; renderer.canvas.style.height = `${height}px`;
        if (prepared) { playback.load(report, {scale}); await playback.prepareRange(selectedTicks); }
        const frames = [];
        for (const tick of selectedTicks) {
          let keyframeIndex = 0; for (let k = 0; k < t.length; k++) if (t[k].start <= tick) keyframeIndex = k;
          const tween = t[keyframeIndex]?.count > 1 ? (tick - t[keyframeIndex].start) / t[keyframeIndex].count : 0;
          const frame = geometryModule.evaluatedFrame(report, keyframeIndex, tween), geometry = geometryModule.buildGeometry(report, frame), view = { x: 0, y: 0, scale };
          if (prepared) { const packet = playback.get(tick); if (!packet) throw new Error('Worker preparation did not retain the requested frame.'); renderer.prepareFrame(packet, {report, view}); if (!renderer.renderPrepared(packet.key, {report, view})) throw new Error('Prepared frame was not ready for presentation.'); }
          else renderer.render({ report, frame, geometry, view });
          await renderer.device.queue.onSubmittedWorkDone();
          const gpu = renderer.canvas.toDataURL('image/png');
          const reference = document.createElement('canvas'); reference.width = width; reference.height = height; const ctx = reference.getContext('2d');
          ctx.beginPath(); ctx.rect(0, 0, report.canvas_width * scale, report.canvas_height * scale); ctx.clip(); ctx.transform(...rendererModule.cameraMatrix({ report, frame, view }));
          backgroundModule.drawBackground(ctx, report, frame, report.canvas_width, report.canvas_height, { ...resources, bounds: backgroundModule.backgroundBounds(frame, report.canvas_width, report.canvas_height) });
          geometryModule.drawGeometry(ctx, geometry, resources);
          const snapshot = new Image(); snapshot.src = gpu; await snapshot.decode();
          const actual = document.createElement('canvas'); actual.width = width; actual.height = height; const target = actual.getContext('2d'); target.drawImage(snapshot, 0, 0);
          const a = target.getImageData(0, 0, width, height).data, b = ctx.getImageData(0, 0, width, height).data;
          let error = 0, changed = 0, alphaError = 0, interiorChanged = 0;
          for (let p = 0; p < a.length; p += 4) {
            let diff = 0; for (let c = 0; c < 4; c++) diff += Math.abs(a[p + c] - b[p + c]); error += diff; alphaError += Math.abs(a[p + 3] - b[p + 3]);
            if (diff > 80) {
              changed++; const pixel = p / 4, x = pixel % width, y = Math.floor(pixel / width); let nearEdge = false;
              for (let dy = -2; dy <= 2 && !nearEdge; dy++) for (let dx = -2; dx <= 2 && !nearEdge; dx++) {
                const q = (Math.min(height - 1, Math.max(0, y + dy)) * width + Math.min(width - 1, Math.max(0, x + dx))) * 4;
                for (let c = 0; c < 4; c++) if (Math.abs(b[p + c] - b[q + c]) > 20) { nearEdge = true; break; }
              }
              if (!nearEdge) interiorChanged++;
            }
          }
          frames.push({ tick, keyframeIndex, tween, objects: frame.objects.length, gpu: { ...renderer.stats }, meanAbsoluteChannelError: error / a.length, percentPixelsOverThreshold: changed / (a.length / 4) * 100, meanAlphaError: alphaError / (a.length / 4), interiorMismatchPercent: interiorChanged / (a.length / 4) * 100, percentDifferencesWithinTwoPixelsOfReferenceEdge: changed ? (changed - interiorChanged) / changed * 100 : 100, gpuImage: gpu, referenceImage: reference.toDataURL('image/png') });
        }
        return { filename, version, mode:prepared?'worker-prepared':'retained-editor', keyframes: report.keyframes.length, totalTicks, renderedSize: [width, height], timings: imported.timings, badAssets, frames };
      }, { filename: fixture.path, version: fixture.version, prepared });
      for (const [frameIndex, frame] of result.frames.entries()) {
        const stem = `${String(i).padStart(2, '0')}-${frameIndex}`;
        await writeFile(path.join(output, `${stem}-gpu.png`), Buffer.from(frame.gpuImage.split(',')[1], 'base64'));
        await writeFile(path.join(output, `${stem}-reference.png`), Buffer.from(frame.referenceImage.split(',')[1], 'base64'));
        delete frame.gpuImage; delete frame.referenceImage; frame.artifactStem = stem;
      }
    } catch (error) { result = { filename: fixture.path, version: fixture.version, error: error.message }; }
    results.push(result);
    console.log(JSON.stringify({ progress: `${i + 1}/${fixtures.length}`, filename: result.filename, error: result.error, frames: result.frames?.map(f => ({ tick: f.tick, objects: f.objects, mae: +f.meanAbsoluteChannelError.toFixed(3), mismatch: +f.percentPixelsOverThreshold.toFixed(3), gpuWarnings: f.gpu.warnings })) }));
    await writeFile(path.join(output, 'results.json'), JSON.stringify({ checkedAt: new Date().toISOString(), reference: 'Existing studio Canvas renderer; representative first/middle/last display ticks, maximum 960 pixels per dimension.', browserErrors, files: results }, null, 2));
  }
  const frames = results.flatMap(r => r.frames || []), material = frames.filter(f => f.meanAbsoluteChannelError > 2 || f.percentPixelsOverThreshold > 1);
  const summary = { files: results.length, failedFiles: results.filter(r => r.error).length, frames: frames.length, framesAboveConservativePixelThreshold: material.length, conservativeThreshold: 'Mean absolute channel error >2/255 OR >1% pixels with summed RGBA difference >80/1020.', framesWithInteriorMismatchAbove0_1Percent: frames.filter(f => f.interiorMismatchPercent > .1).length, interiorDefinition: 'Differing pixels more than two pixels from a reference edge (neighbor channel difference >20/255).', gpuErrors: frames.reduce((n, f) => n + f.gpu.warnings.length, 0), browserErrors, maxMAE: Math.max(...frames.map(f => f.meanAbsoluteChannelError)), maxMismatchPercent: Math.max(...frames.map(f => f.percentPixelsOverThreshold)), maxInteriorMismatchPercent: Math.max(...frames.map(f => f.interiorMismatchPercent)) };
  await writeFile(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2)); console.log(JSON.stringify(summary, null, 2));
} finally { await app.close(); }
