/** Actual imported scene, live editor commands, incremental GPU timing and fresh-render equality. */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const root = process.cwd(), source = process.argv[2] || 'C:/Users/aleri/Downloads/16 Akane vs Akato Segundo round (3).piv';
const onionZoom = process.argv.includes('--onion-zoom');
const output = path.join(root, 'artifacts', `renderer-edit-profile${onionZoom ? '-onion-zoom' : ''}`); await mkdir(output, {recursive: true});
const browser = await chromium.launch({channel: 'chrome', headless: true});
try {
  const page = await browser.newPage({viewport: {width: 1400, height: 950}}), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(process.env.STYK_URL || 'http://127.0.0.1:47831'); await page.waitForFunction(() => window.styk?.ready);
  await page.evaluate(() => styk.editor.markSaved()); await page.locator('#file-input').setInputFiles(source);
  await page.waitForFunction(name => !styk.state.importing && styk.editor.name === name, path.basename(source, '.piv'), {timeout: 180000});
  const result = await page.evaluate(async ({onionZoom}) => {
    const { Editor } = await import('/src/editor.mjs'), { createRenderer } = await import('/src/renderer.mjs');
    const { buildGeometry } = await import('/src/pivot/geometry.mjs');
    const source = styk.editor.report, sizes = new Map(source.figure_types.map(f => [f.figure_type_id, f.segments.length]));
    const index = source.keyframes.reduce((best, f, i, frames) => f.objects.reduce((n, o) => n + sizes.get(o.figure_type_id), 0) >= frames[best].objects.reduce((n, o) => n + sizes.get(o.figure_type_id), 0) ? i : best, 0);
    const editor = new Editor({demo: false}); editor.load({...source, keyframes: [structuredClone(source.keyframes[index])]});
    const report = editor.report, canvas = document.createElement('canvas'), referenceCanvas = document.createElement('canvas');
    const renderer = await createRenderer(canvas, {resources: styk.state.renderer.resources}), reference = await createRenderer(referenceCanvas, {resources: styk.state.renderer.resources});
    const view = {x: 0, y: 0, scale: Math.min(1, 960 / report.canvas_width)};
    for (const target of [renderer, reference]) { target.resize(report.canvas_width * view.scale, report.canvas_height * view.scale, 1); await target.prepareBackgrounds(report); }
    const children = new Map(); for (const [slot, object] of editor.frame.objects.entries()) if (object.join) { const parent = object.join.target_object_slot; if (!children.has(parent)) children.set(parent, []); children.get(parent).push(slot); }
    const affected = slot => { const slots = new Set([slot]), queue = [slot]; for (let q = 0; q < queue.length; q++) for (const child of children.get(queue[q]) || []) if (!slots.has(child)) { slots.add(child); queue.push(child); } return slots.size; };
    const ordered = [...editor.geometry.objects.values()].filter(g => g && g.segments.some(s => !s.static && s.length > 3)).sort((a, b) => affected(b.slot) - affected(a.slot) || b.segments.length - a.segments.length);
    const selected = editor.frame.objects.find(o => o.unique_id === 271591) || ordered[0].obj;
    const scenarios = [{name: 'numeric-root-translation', uid: selected.unique_id, translation: true}, {name: 'joined-rig-pose', uid: ordered[0].obj.unique_id, translation: false}];
    if (editor.frame.objects.some(o => o.unique_id === 460616)) scenarios.push({name: 'native-parent-460616-pose', uid: 460616, translation: false});
    const results = [];
    const snapshot = async target => { await target.device.queue.onSubmittedWorkDone(); return target.canvas.toDataURL('image/png'); };
    for (const scenario of scenarios) {
      editor.select(scenario.uid); const g = editor.geometry.objects.get(editor.selectedSlot), joint = g.segments.findIndex(s => !s.static && s.length > 3);
      if (!scenario.translation) editor.select(scenario.uid, joint);
      renderer.render({report, frame: editor.evaluatedFrame, geometry: editor.geometry, view}); await renderer.device.queue.onSubmittedWorkDone();
      const baselineBytes = renderer.stats.uploadBytes;
      if (scenario.translation) editor.beginTranslationDrag(); else editor.beginDrag();
      const metrics = [];
      for (let i = 0; i < 24; i++) {
        const start = performance.now();
        if (scenario.translation) editor.moveSelection(.5, .25);
        else { const shape = editor.geometry.objects.get(editor.selectedSlot).segments[joint]; editor.poseJoint(shape.end.x + Math.sin(i / 4) * 2, shape.end.y + Math.cos(i / 4) * 2); }
        const mutated = performance.now(), geometry = editor.geometry, built = performance.now();
        renderer.render({report, frame: editor.evaluatedFrame, geometry, view});
        metrics.push({mutationMs: mutated - start, geometryMs: built - mutated, rendererMs: performance.now() - built, totalMs: performance.now() - start,
          changedSlots: geometry.changedSlots?.size, updatedObjects: renderer.stats.updatedObjects, compiledObjects: renderer.stats.compiledObjects, rasterizedObjects: renderer.stats.rasterizedObjects, uploadBytes: renderer.stats.uploadBytes, preparation: renderer.stats.preparation});
        await new Promise(requestAnimationFrame);
      }
      // Compare the incremental final result to a brand-new geometry graph/GPU compilation.
      renderer.render({report, frame: editor.evaluatedFrame, geometry: editor.geometry, view}); const actual = await snapshot(renderer);
      reference.render({report, frame: editor.evaluatedFrame, geometry: buildGeometry(report, editor.evaluatedFrame), view}); const expected = await snapshot(reference);
      if (actual !== expected) throw new Error(`Incremental GPU image differed from a fresh render for ${scenario.name}.`);
      const quantiles = key => { const v = metrics.map(m => m[key]).sort((a, b) => a - b); return {p50: v[Math.floor(v.length * .5)], p95: v[Math.floor(v.length * .95)], max: v.at(-1)}; };
      results.push({...scenario, slot: editor.selectedSlot, joint, affected: affected(editor.selectedSlot), baselineBytes, metrics,
        summary: Object.fromEntries(['mutationMs', 'geometryMs', 'rendererMs', 'totalMs'].map(key => [key, quantiles(key)])), freshPixelsIdentical: true});
      editor.commitDrag();
    }
    const onionZoomResults = [];
    if (onionZoom) {
      const onionFrames = source.keyframes.slice(Math.max(0, index - 2), index), geometry = editor.geometry;
      for (const scale of [1, 2, 8, 2, 1]) {
        const zoomView = {x: 0, y: 0, scale}, options = {report, frame: editor.evaluatedFrame, geometry, view: zoomView, onionFrames, clipToCanvas: false};
        const started = performance.now(); renderer.render(options); const coldMs = performance.now() - started, coldStats = structuredClone(renderer.stats);
        const onionGeometry = renderer.onionScenes.map(onion => onion.geometry), metrics = [];
        for (let i = 0; i < 24; i++) {
          const begin = performance.now(); renderer.render({...options, dragTranslations: new Map([[selected.unique_id, {x: i / 4, y: i / 8}]])});
          metrics.push({rendererMs: performance.now() - begin, uploadedBytes: renderer.stats.uploadBytes, compiledObjects: renderer.stats.compiledObjects, rasterizedObjects: renderer.stats.rasterizedObjects});
          if (renderer.onionScenes.some((onion, i) => onion.geometry !== onionGeometry[i])) throw new Error('Onion scene cache changed during a retained translation.');
          await new Promise(requestAnimationFrame);
        }
        renderer.render(options); const actual = await snapshot(renderer);
        reference.render({...options, geometry: buildGeometry(report, editor.evaluatedFrame)}); const expected = await snapshot(reference);
        let pixelDifference = {pixels: 0, maxChannel: 0};
        if (actual !== expected) {
          const pixels = await Promise.all([actual, expected].map(async url => { const image = new Image(); image.src = url; await image.decode(); const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height; const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0); return ctx.getImageData(0, 0, canvas.width, canvas.height).data; }));
          for (let i = 0; i < pixels[0].length; i += 4) { let changed = false; for (let c = 0; c < 4; c++) { const difference = Math.abs(pixels[0][i + c] - pixels[1][i + c]); if (difference) changed = true; pixelDifference.maxChannel = Math.max(pixelDifference.maxChannel, difference); } if (changed) pixelDifference.pixels++; }
          if (pixelDifference.maxChannel > 1 || pixelDifference.pixels > pixels[0].length / 4000) { onionZoomResults.push({scale, coldMs, coldStats, pixelDifference, failure: 'Onion differs materially from fresh geometry', actual, expected}); break; }
        }
        const times = metrics.map(m => m.rendererMs).sort((a, b) => a - b);
        onionZoomResults.push({scale, coldMs, coldStats, p50: times[12], p95: times[22], max: times.at(-1), metrics, pixelDifference, freshPixelsIdentical: actual === expected});
      }
    }
    const scene = {keyframe: index, objects: editor.frame.objects.length, segments: editor.frame.objects.reduce((n, o) => n + sizes.get(o.figure_type_id), 0), adapter: renderer.stats.adapter};
    renderer.destroy(); reference.destroy(); return {scene, results, onionZoomResults, limitation: 'Main-thread mutation, geometry and CPU GPU submission; excludes input dispatch, app panels, GPU completion and display latency. 24 live edits per scenario.'};
  }, {onionZoom});
  for (const sample of result.onionZoomResults || []) for (const kind of ['actual', 'expected']) if (sample[kind]) {
    await writeFile(path.join(output, `onion-${sample.scale}-${kind}.png`), Buffer.from(sample[kind].split(',')[1], 'base64')); delete sample[kind];
  }
  await writeFile(path.join(output, 'report.json'), JSON.stringify({...result, errors}, null, 2));
  console.log(JSON.stringify({...result, onionZoomResults: result.onionZoomResults.map(({metrics, ...sample}) => sample), results: result.results.map(({metrics, ...summary}) => ({...summary, incrementalFrames: metrics.filter(m => m.preparation === 'incremental').length, maxCompiledObjects: Math.max(...metrics.map(m => m.compiledObjects)), maxUploadBytes: Math.max(...metrics.map(m => m.uploadBytes))})), errors}, null, 2));
  if (result.onionZoomResults.some(sample => sample.failure)) throw new Error('Onion zoom verification failed; see captured images and report.');
} finally { await browser.close(); }
