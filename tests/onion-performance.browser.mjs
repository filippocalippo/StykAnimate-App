import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';

const output = 'artifacts/onion-performance';
await mkdir(output, {recursive: true});
const browser = await chromium.launch({channel: 'chrome', headless: true});
try {
  const page = await browser.newPage({viewport: {width: 1440, height: 960}}), errors = [], gestures = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(process.env.STYK_URL ?? 'http://127.0.0.1:47831');
  await page.waitForFunction(() => window.styk?.ready);
  for (const onionMode of ['keyframes', 'frames']) {
    await page.evaluate(async onionMode => {
      const {emptyDocument, createFrame, createObject} = await import('/src/demo.mjs');
      const r = emptyDocument(), f = r.figure_types[0];
      r.keyframes = Array.from({length: 24}, (_, i) => createFrame(Array.from({length: 80}, (_, j) => {
        const o = createObject(f, j + 1, 100 + j % 10 * 70 + (j < 2 ? i * 2 : 0), 100 + Math.floor(j / 10) * 65, {scale: .25, field28: 80});
        if (j === 1) o.join = {target_object_slot: 0, target_handle_id: 1};
        return o;
      }), 3));
      styk.editor.load(r); styk.editor.seek(30); styk.editor.select(1, 0);
      styk.settingsUI.commit({timelineMode: 'advanced', onionMode, onionBefore: 2, onionAfter: 1});
      styk.state.onion = true; styk.fit();
    }, onionMode);
    await page.locator('.tool-dock [data-tool="pose"]').click();
    const target = await page.evaluate(async () => {
      const {getPivotHandles, pickCanvasHandle} = await import('/src/canvas-interactions.mjs');
      const {worldToScreen} = await import('/src/renderer-geometry.mjs');
      const e = styk.editor, s = styk.state, g = e.geometry;
      const options = {frame: e.evaluatedFrame, selectedUid: e.selectedUid, selectedUids: e.selectedUids,
        showUnselected: s.settings.showUnselectedHandles, viewScale: s.view.scale};
      const handles = getPivotHandles(g, options), project = point => worldToScreen(point, {report: e.report, frame: e.evaluatedFrame, view: s.view, cameraEnabled: false});
      const handle = handles.find(h => {
        if (h.uid !== 1 || h.action !== 'pose' || h.static) return false;
        const hit = pickCanvasHandle(g, h.point, {...options, handles, project, nearest: true, minRadius: 8});
        return hit?.uid === h.uid && hit?.joint === h.joint;
      });
      if (!handle) throw new Error('No exposed joint for the pointer regression.');
      const rect = document.querySelector('#viewport').getBoundingClientRect(), point = project(handle.point);
      window.onionPointer = {before: JSON.stringify(e.evaluatedFrame.objects), history: e._undo.length, frames: []};
      const renderer = s.renderer, render = renderer.render;
      renderer.render = function(...args) {
        const result = render.apply(this, args);
        if (styk.editor.dragging) onionPointer.frames.push({cpuMs: this.stats.frameMs, compiled: this.stats.compiledObjects ?? 0,
          rasterized: this.stats.rasterizedObjects ?? 0, ghostBuilds: styk.onionCache.stats.builds});
        return result;
      };
      onionPointer.restore = () => {renderer.render = render;};
      return {x: rect.left + point.x, y: rect.top + point.y};
    });
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    await page.mouse.move(target.x, target.y); await page.mouse.down();
    assert.equal(await page.evaluate(() => styk.state.drag?.kind), 'pose');
    for (let step = 1; step <= 24; step++) {
      await page.mouse.move(target.x + step, target.y - step * .4);
      await page.evaluate(() => new Promise(r => requestAnimationFrame(r)));
    }
    await page.mouse.up();
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    const gesture = await page.evaluate(() => {
      const e = styk.editor, b = onionPointer;
      b.restore();
      return {frames: b.frames, changed: JSON.stringify(e.evaluatedFrame.objects) !== b.before,
        commands: e._undo.length - b.history};
    });
    assert.equal(gesture.changed, true); assert.equal(gesture.commands, 1);
    assert.ok(gesture.frames.length >= 12, 'Observe enough actual app presentations during the pointer drag.');
    const steady = gesture.frames.slice(2);
    assert.equal(new Set(steady.map(f => f.ghostBuilds)).size, 1, 'Actual node dragging must not rebuild onion samples.');
    assert.ok(steady.every(f => f.compiled + f.rasterized <= 2), 'Actual dragging must retain untouched artwork.');
    gestures.push({onionMode, ...gesture});
  }
  // Compare retained versus fresh samples on both rendering backends after a
  // pose commit, retiming, slot changes and shared-definition edits.
  const parity = await page.evaluate(async () => {
    const {OnionSkinCache} = await import('/src/onion-skin.mjs');
    const {createRenderer} = await import('/src/renderer.mjs');
    const {buildGeometry} = await import('/src/pivot/geometry.mjs');
    const e = styk.editor, results = [], cache = styk.onionCache, settings = styk.state.settings;
    const make = async fallback => {const canvas = document.createElement('canvas'); if (fallback) canvas.getContext('2d');
      const renderer = await createRenderer(canvas); renderer.resize(960, 540, 1); return renderer;};
    const pixels = async renderer => {
      await renderer.device?.queue.onSubmittedWorkDone();
      const bitmap = await createImageBitmap(renderer.canvas), surface = new OffscreenCanvas(960, 540), context = surface.getContext('2d');
      context.drawImage(bitmap, 0, 0); bitmap.close(); return context.getImageData(0, 0, 960, 540).data;
    };
    const gpu = await make(false), gpuFresh = await make(false), canvas = await make(true), canvasFresh = await make(true);
    try {
      for (const [name, mutate] of [
        ['pose', () => {}],
        ['retime', () => e.sheetMoveFrames(['layer-1'], 33, 33, 1)],
        ['membership', () => {e.select(3); e.deleteSelection();}],
        ['definition', () => {e.select(1, 0); e.moveBuilderOrder({kind: 'segment', index: 0}, 'front');}],
      ]) {
        mutate();
        const fresh = new OnionSkinCache(), options = {report: e.report, frame: e.evaluatedFrame, geometry: e.geometry,
          onionFrames: cache.get(e, settings), cameraEnabled: false, view: {x: 0, y: 0, scale: 1}, liveEditing: true};
        const reference = {...options, geometry: buildGeometry(e.report, e.evaluatedFrame), onionFrames: fresh.get(e, settings)};
        for (const [retained, rebuilt] of [[gpu, gpuFresh], [canvas, canvasFresh]]) {
          retained.render(options); rebuilt.render(reference);
          const a = await pixels(retained), b = await pixels(rebuilt); let max = 0;
          for (let i = 0; i < a.length; i++) max = Math.max(max, Math.abs(a[i] - b[i]));
          results.push({name, backend: retained.stats.backend, maxDifference: max});
        }
      }
      return results;
    } finally {for (const renderer of [gpu, gpuFresh, canvas, canvasFresh]) renderer.destroy();}
  });
  assert.ok(parity.every(r => r.maxDifference <= 1), JSON.stringify(parity));
  assert.deepEqual(errors, []);
  await page.screenshot({path: `${output}/verified.png`});
  await writeFile(`${output}/pointer-and-pixels.json`, JSON.stringify({gestures, parity, errors}, null, 2));
  console.log(JSON.stringify({gestures: gestures.map(g => ({mode: g.onionMode, frames: g.frames.length, maxGhostBuilds: Math.max(...g.frames.map(f => f.ghostBuilds)) - Math.min(...g.frames.map(f => f.ghostBuilds)),
    maxCompiled: Math.max(...g.frames.map(f => f.compiled)), maxRasterized: Math.max(...g.frames.map(f => f.rasterized))})), parity, errors}, null, 2));
} finally { await browser.close(); }
