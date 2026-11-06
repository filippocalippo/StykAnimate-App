/** Stress the reported zoom -> joint edit sequence without touching a user's project. */
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {chromium} from './support/playwright.mjs';
import backend from '../desktop/web-host.cjs';

const server = await backend.startDesktopHost({appRoot: process.cwd()});
const browser = await chromium.launch({channel: 'chrome', headless: true});
const out = 'artifacts/zoom-edit-stability', results = [];
await mkdir(out, {recursive: true});
try {
  {
    const page = await browser.newPage({viewport: {width: 1440, height: 960}}), errors = [], samples = [];
    page.on('pageerror', e => errors.push(e.message)); page.on('crash', () => errors.push('Browser renderer crashed'));
    await page.addInitScript(() => localStorage.setItem('stykanimate.editor.settings.v1',
      JSON.stringify({locale: 'en', canvasZoomGesture: 'ctrl-scroll'})));
    await page.goto(server.origin); await page.waitForFunction(() => window.styk?.ready);
    await page.evaluate(async () => (await import('/tests/support/stage-probe.mjs')).watchStage());
    const initial = await page.evaluate(async () => {
      const {emptyDocument, createObject, createFrame} = await import('/src/demo.mjs');
      const report = emptyDocument(), figure = report.figure_types[0];
      report.canvas_width = 3200; report.canvas_height = 1900;
      report.keyframes = Array.from({length: 12}, (_, tick) => createFrame(Array.from({length: 400}, (_, i) =>
        createObject(figure, i + 1, i === 0 ? 180 : 500 + i % 20 * 120,
          i === 0 ? 250 : 150 + Math.floor(i / 20) * 80, {scale: i === 0 ? 1 : .45,
            field28: i % 80 === 79 ? 100 : 0,
            angles: figure.segments.map((s, j) => s.angle_rad + (j > 1 ? Math.sin(tick * .4) * .05 : 0))})), 1));
      styk.editor.load(report); styk.editor.seek(0); styk.editor.select(1, 3);
      styk.state.onion = false; styk.state.handles = true; styk.fit();
      return {backend: styk.state.renderer.stats.backend, adapter: styk.state.renderer.stats.adapter,
        frames: report.keyframes.length, figuresPerFrame: 400, segmentsPerFrame: 400 * figure.segments.length};
    });
    assert.ok(['WebGPU', 'WebGL2'].includes(initial.backend), initial.backend);
    const settle = () => page.waitForFunction(() => !styk.state.dirtyRender );
    await settle();
    for (let cycle = 0; cycle < 3; cycle++) for (const scale of [.001, .1, 1, 4, 16, 100]) {
      const p = await page.evaluate(({scale, cycle}) => {
        const e = styk.editor, viewport = document.querySelector('#viewport'), box = viewport.getBoundingClientRect();
        e.seek(cycle * 3); e.select(1, 3);
        const point = e.geometry.objects.get(e.selectedSlot).segments[3].end, v = styk.state.view;
        // Centre the edited handle, then exercise the actual anchored wheel path
        // (.003 is the wheel's zoom per pixel of a notch; settle() waits for its glide).
        v.x = box.width / 2 - point.x * v.scale; v.y = box.height / 2 - point.y * v.scale;
        const x = box.x + box.width / 2, y = box.y + box.height / 2;
        viewport.dispatchEvent(new WheelEvent('wheel', {bubbles: true, cancelable: true, ctrlKey: true,
          clientX: x, clientY: y, deltaY: -Math.log(scale / v.scale) / .003}));
        return {x, y};
      }, {scale, cycle});
      await settle();
      if (scale >= 1) {
        await page.mouse.move(p.x, p.y); await page.mouse.down();
        await page.mouse.move(p.x + 18, p.y + 28, {steps: 6});
        assert.equal(await page.evaluate(() => styk.state.drag?.kind), 'pose');
        await page.mouse.up(); await settle();
        const after = await page.evaluate(() => JSON.stringify(styk.editor.serialize()));
        await page.evaluate(() => {styk.editor.undo(); styk.editor.redo();}); await settle();
        assert.equal(await page.evaluate(() => JSON.stringify(styk.editor.serialize())), after);
      }
      samples.push(await page.evaluate(async () => {
        const r = styk.state.renderer; await r.device?.queue.onSubmittedWorkDone();
        return {scale: styk.state.view.scale, backend: r.stats.backend, gpuBytes: r.stats.gpuBytes ?? 0,
          heapBytes: performance.memory?.usedJSHeapSize ?? null, errorVisible: !document.querySelector('#renderer-error').hidden};
      }));
      assert.ok(Math.abs(samples.at(-1).scale - scale) < 1e-8);
      assert.equal(samples.at(-1).backend, initial.backend); assert.equal(samples.at(-1).errorVisible, false);
    }
    await page.evaluate(() => styk.fit()); await settle();
    await page.screenshot({path: `${out}/zoom.png`});
    const final = await page.evaluate(() => {
      // Copy the GPU surface in the same task as rendering, before presentation
      // clears its drawing buffer. The screenshot above checks the displayed UI.
      const {call, ...last} = window.stageLast; styk.state.renderer.render(last);
      const source = document.querySelector('#scene'), canvas = new OffscreenCanvas(source.width, source.height);
      const ctx = canvas.getContext('2d', {willReadFrequently: true}); ctx.drawImage(source, 0, 0);
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let ink = 0; for (let i = 0; i < data.length; i += 4) if (data[i+3] > 100 && data[i] < 100 && data[i+1] < 100 && data[i+2] < 100) ink++;
      return {ink, history: styk.editor._undo.length};
    });
    assert.ok(final.ink > 100, 'Artwork must remain visible after zooming and editing');
    assert.deepEqual(errors, []);
    results.push({...initial, samples, final, errors});
    console.log(`PASS ${initial.backend}: 18 zoom cycles, 12 joint edits with undo/redo, visible artwork and bounded raster memory`);
    await page.close();
  }
  await writeFile(`${out}/report.json`, JSON.stringify({measuredAt: new Date().toISOString(), results}, null, 2));
} finally {await browser.close(); server.stop();}
