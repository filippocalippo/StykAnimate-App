import { _electron as electron } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'artifacts'); await mkdir(output, { recursive: true });
const fps = Number(process.argv.find(arg => arg.startsWith('--fps='))?.slice(6) || 24), suffix = fps === 24 ? '' : `-${fps}fps`;
const app = await electron.launch({ args: [root], cwd: root, timeout: 45000, env: { ...process.env, STYK_USER_DATA_DIR: path.join(output, 'gpu-ui-profile') } });
const errors = [];
const quantiles = values => { const sorted = [...values].sort((a, b) => a - b); return { count: sorted.length, p50: sorted[Math.floor(sorted.length * .5)] ?? 0, p95: sorted[Math.floor(sorted.length * .95)] ?? 0, max: sorted.at(-1) ?? 0 }; };
try {
  const page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => window.styk?.ready === true, { timeout: 25000 });
  const target = await page.evaluate(async fps => {
    const { defaultFigure, createObject, createFrame, emptyDocument } = await import('/src/demo.mjs');
    const { worldToScreen } = await import('/src/renderer.mjs');
    const report = emptyDocument(), figure = defaultFigure(); report.fps = fps; report.figure_types = [figure];
    report.keyframes = Array.from({ length: 24 }, (_, frameIndex) => createFrame(Array.from({ length: 1000 }, (_, i) => {
      const phase = frameIndex / 24 * Math.PI * 2, selected = i === 999;
      const object = createObject(figure, i + 1, selected ? 480 : 25 + i % 40 * 23, selected ? 280 : 18 + Math.floor(i / 40) * 20, { scale: selected ? .65 : .055 });
      object.root_x += Math.sin(phase + i * .08) * (selected ? 14 : 2);
      object.angles[6] += Math.sin(phase) * .2; object.angles[8] -= Math.sin(phase) * .2;
      return object;
    })));
    const { editor, state } = window.styk; editor.load(report, '1,000 figure performance scene'); editor.select(1000, -1); window.styk.fit();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const originalRoot = { x: editor.object.root_x, y: editor.object.root_y };
    const renderer = state.renderer, originalRender = renderer.render.bind(renderer);
    const bench = window.__uiBench = { drag: [], playback: [], inputReceived: 0, originalRoot, started: false };
    document.getElementById('overlay').addEventListener('pointermove', () => { bench.inputReceived = performance.now(); }, { capture: true });
    renderer.render = options => {
      const start = performance.now(), result = originalRender(options), done = performance.now();
      if (state.drag?.kind === 'move' && options.dragTranslations?.size) {
        bench.dragGeometry ??= options.geometry;
        bench.drag.push({ cpuMs: done - start, eventToSubmitMs: done - bench.inputReceived, geometryUnchanged: options.geometry === bench.dragGeometry, uploadBytes: renderer.stats.uploadBytes, primitiveCount: renderer.stats.primitives, drawCalls: renderer.stats.drawCalls, at: done });
      }
      if (state.playing) bench.playback.push({ cpuMs: done - start, tick: editor.tick, at: done, uploadBytes: renderer.stats.uploadBytes, primitiveCount: renderer.stats.primitives });
      return result;
    };
    if (renderer.renderPrepared) {
      const originalPrepared = renderer.renderPrepared.bind(renderer);
      renderer.renderPrepared = (key, options) => {
        const start = performance.now(), result = originalPrepared(key, options), done = performance.now();
        if (result && state.playing) bench.playback.push({ cpuMs: done - start, tick: editor.tick, at: done, uploadBytes: renderer.stats.uploadBytes, primitiveCount: renderer.stats.primitives, prepared: true, preparedFrames: renderer.stats.preparedFrames, preparedBytes: renderer.stats.preparedBytes });
        return result;
      };
    }
    const rect = document.getElementById('viewport').getBoundingClientRect(), point = worldToScreen(editor.geometry.objects.get(999).root, { report, frame: editor.frame, view: state.view });
    return { x: rect.left + point.x, y: rect.top + point.y, scale: state.view.scale, adapter: renderer.stats.adapter };
  }, fps);
  await page.mouse.move(target.x, target.y); await page.mouse.down();
  await page.waitForFunction(() => window.styk.state.drag?.kind === 'move');
  const afterDown = await page.evaluate(() => window.__uiBench.drag.length);
  for (let step = 1; step <= 60; step++) {
    const previous = await page.evaluate(() => window.__uiBench.drag.length);
    await page.mouse.move(target.x + step * 1.5, target.y - step * .4);
    await page.waitForFunction(previous => window.__uiBench.drag.length > previous, previous);
  }
  await page.screenshot({ path: path.join(output, `renderer-ui-drag-1000${suffix}.png`) });
  await page.mouse.up();
  await page.waitForFunction(() => !window.styk.state.drag && !window.styk.state.dirtyRender);
  const dragResult = await page.evaluate(afterDown => ({ samples: window.__uiBench.drag.slice(Math.max(afterDown, 1)), finalRoot: { x: window.styk.editor.object.root_x, y: window.styk.editor.object.root_y }, originalRoot: window.__uiBench.originalRoot }), afterDown);
  await page.evaluate(async () => {
    const { state, editor, actions } = window.styk; state.renderSamples.length = 0; editor.seek(0); window.__uiBench.playRequestedAt = performance.now(); actions.play();
    await new Promise(resolve => { const start = performance.now(); const next = now => { if (now - start >= 3200) resolve(); else requestAnimationFrame(next); }; requestAnimationFrame(next); });
    if (state.playing) actions.play(); editor.dirty = false;
  });
  const playback = await page.evaluate(() => ({ samples: window.__uiBench.playback, playRequestedAt: window.__uiBench.playRequestedAt, fullFrameCpu: [...window.styk.state.renderSamples], warnings: window.styk.state.renderer.stats.warnings, backend: window.styk.state.renderer.stats.backend, worker: window.styk.performance().playback, gpuCache: { ...window.styk.state.renderer.preparedFrames?.stats } }));
  await page.screenshot({ path: path.join(output, `renderer-ui-playback-1000${suffix}.png`) });
  const presented = playback.samples.filter((sample, i) => !i || sample.tick !== playback.samples[i - 1].tick);
  const cadence = presented.slice(1).map((sample, i) => sample.at - presented[i].at), warm = presented.filter(sample => sample.at >= playback.playRequestedAt + 1200), warmCadence = warm.slice(1).map((sample, i) => sample.at - warm[i].at);
  let skipped = 0; for (let i = 1; i < presented.length; i++) skipped += Math.max(0, (presented[i].tick - presented[i - 1].tick + 24) % 24 - 1);
  const metrics = { backend: playback.backend, adapter: target.adapter, scene: { figures: 1000, keyframes: 24, fps },
    drag: { rendererCpuMs: quantiles(dragResult.samples.map(s => s.cpuMs)), pointerReceiptToSubmitMs: quantiles(dragResult.samples.map(s => s.eventToSubmitMs)), totalGeometryUploadBytes: dragResult.samples.reduce((sum, s) => sum + s.uploadBytes, 0), allGeometryReferencesStable: dragResult.samples.every(s => s.geometryUnchanged), drawCalls: [...new Set(dragResult.samples.map(s => s.drawCalls))], finalWorldDelta: { x: dragResult.finalRoot.x - dragResult.originalRoot.x, y: dragResult.finalRoot.y - dragResult.originalRoot.y }, expectedWorldDelta: { x: 90 / target.scale, y: -24 / target.scale } },
    playback: { rendererCpuMs: quantiles(playback.samples.map(s => s.cpuMs)), editorRenderWorkMs: quantiles(playback.fullFrameCpu), renderIntervalMs: quantiles(cadence), renderedFrames: presented.length, totalSubmissions: playback.samples.length, skippedTicks: skipped,
      startToFirstFrameMs: presented[0]?.at - playback.playRequestedAt, warmRendererCpuMs: quantiles(warm.map(sample => sample.cpuMs)), warmRenderIntervalMs: quantiles(warmCadence), warmEffectiveFPS: warm.length > 1 ? (warm.length - 1) * 1000 / (warm.at(-1).at - warm[0].at) : 0, worker: playback.worker, gpuCache: playback.gpuCache },
    errors: [...errors, ...playback.warnings], measuredAt: new Date().toISOString(), limitation: 'Browser pointer receipt to GPU submission, not OS input or completed GPU/display latency. editorRenderWorkMs includes evaluation/preparation and overlay work inside the editor render section, excluding DOM/transport work afterward. Warm samples start1.2seconds after Play.' };
  await writeFile(path.join(output, `renderer-ui-performance${suffix}.json`), JSON.stringify(metrics, null, 2)); console.log(JSON.stringify(metrics, null, 2));
  if (metrics.errors.length) throw new Error(metrics.errors.join('\n'));
  if (!metrics.drag.allGeometryReferencesStable || metrics.drag.totalGeometryUploadBytes !== 0) throw new Error('A translation gesture rebuilt or uploaded scene geometry.');
  if (Math.abs(metrics.drag.finalWorldDelta.x - metrics.drag.expectedWorldDelta.x) > .01 || Math.abs(metrics.drag.finalWorldDelta.y - metrics.drag.expectedWorldDelta.y) > .01) throw new Error('Pointer release did not commit the GPU translation delta.');
} finally { await app.close(); }
