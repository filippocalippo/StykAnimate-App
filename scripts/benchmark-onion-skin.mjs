/** Repeatable onion-on/off CPU and GPU-work counters on a layered, joined scene. */
import {chromium} from 'playwright';
import {mkdir, writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';

const label = process.argv[2] ?? 'latest', count = Number(process.env.STYK_BENCH_OBJECTS ?? 160);
const output = 'artifacts/onion-performance';
await mkdir(output, {recursive: true});
const browser = await chromium.launch({channel: 'chrome', headless: true});
try {
  const page = await browser.newPage({viewport: {width: 1440, height: 960}}), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.text().startsWith('ONION BENCH')) console.log(message.text()); });
  await page.goto(process.env.STYK_URL ?? 'http://127.0.0.1:47831');
  await page.waitForFunction(() => window.styk?.ready);
  const results = await page.evaluate(async count => {
    const {Editor} = await import('/src/editor.mjs');
    const {OnionSkinCache} = await import('/src/onion-skin.mjs');
    const {normalizeEditorSettings} = await import('/src/settings.mjs');
    const {emptyDocument, createFrame, createObject} = await import('/src/demo.mjs');
    const {createRenderer} = await import('/src/renderer.mjs');
    const summary = rows => Object.fromEntries(Object.keys(rows[0]).map(key => {
      const values = rows.map(r => r[key]).sort((a, b) => a - b);
      return [key, {p50: values[Math.floor(values.length * .5)], p95: values[Math.floor(values.length * .95)], max: values.at(-1)}];
    }));
    const results = [];
    for (const transparent of [false, true]) for (const enabled of [false, true]) {
      const report = emptyDocument(), figure = report.figure_types[0];
      report.canvas_width = 960; report.canvas_height = 540;
      report.keyframes = Array.from({length: 40}, (_, frame) => createFrame(Array.from({length: count}, (_, slot) => {
        const object = createObject(figure, slot + 1, 35 + slot % 16 * 55 + (slot < 2 ? frame : 0), 65 + Math.floor(slot / 16) * 45,
          {scale: .22, field28: transparent ? 80 : 0});
        if (slot === 1) object.join = {target_object_slot: 0, target_handle_id: 1};
        return object;
      }), 3));
      const editor = new Editor({demo: false, propertyChannels: true, layerTimeline: true}).load(report);
      const cache = new OnionSkinCache(), settings = normalizeEditorSettings();
      const canvas = document.createElement('canvas'), renderer = await createRenderer(canvas);
      renderer.resize(960, 540, 1);
      const render = () => {
        const start = performance.now(), builds = cache.stats.builds;
        const frame = editor.evaluatedFrame, geometry = editor.geometry, beforeOnion = performance.now();
        const onionFrames = enabled ? cache.get(editor, settings) : [], beforeRender = performance.now();
        renderer.render({report: editor.report, frame, geometry, onionFrames, view: {x: 0, y: 0, scale: 1}, cameraEnabled: false, liveEditing: true});
        return {cpuMs: performance.now() - start, onionMs: beforeRender - beforeOnion, builds: cache.stats.builds - builds,
          compiled: renderer.stats.compiledObjects ?? 0, rasterized: renderer.stats.rasterizedObjects ?? 0,
          uploadBytes: renderer.stats.uploadBytes, drawCalls: renderer.stats.drawCalls};
      };
      const measure = async action => {
        const start = performance.now(); action(); const mutationMs = performance.now() - start;
        const row = render(); await renderer.device?.queue.onSubmittedWorkDone(); return {...row, mutationMs};
      };
      try {
        editor.seek(30); editor.select(1, 0);
        const cold = render(); await renderer.device?.queue.onSubmittedWorkDone();
        editor.beginDrag(); const drag = [];
        for (let i = 0; i < 90; i++) {
          const row = await measure(() => editor.rotateJoint((i % 2 ? -1 : 1) * .015));
          if (i >= 20) drag.push(row);
        }
        editor.cancelDrag(); render(); await renderer.device?.queue.onSubmittedWorkDone();
        const commit = [];
        for (let i = 0; i < 24; i++) {
          editor.select(1, 0); editor.beginDrag(); editor.rotateJoint(.02);
          const row = await measure(() => editor.commitDrag()); if (i >= 4) commit.push(row);
        }
        const scrub = [];
        for (let i = 0; i < 100; i++) {
          const row = await measure(() => editor.seek(i % 80)); if (i >= 20) scrub.push(row);
        }
        const warmScrub = [];
        for (let i = 0; i < 80; i++) {
          const row = await measure(() => editor.seek(27 + i % 9)); if (i >= 20) warmScrub.push(row);
        }
        results.push({objects: count, segments: count * figure.segments.length, transparent, enabled,
          backend: renderer.stats.backend, cold, drag: summary(drag), commit: summary(commit),
          scrub: summary(scrub), warmScrub: summary(warmScrub), cacheEntries: cache.samples.size});
        console.log(`ONION BENCH ${transparent ? 'transparent' : 'opaque'}, onion ${enabled ? 'on' : 'off'} complete`);
      } finally { renderer.destroy(); }
    }
    return results;
  }, count);
  await writeFile(`${output}/${label}.json`, JSON.stringify({results, errors}, null, 2));
  console.log(JSON.stringify({results, errors}, null, 2));
  if (errors.length) throw new Error('Browser errors during onion benchmark.');
  for (const result of results.filter(r => r.enabled)) {
    assert.equal(result.drag.builds.max, 0, 'Posing must reuse committed ghost samples.');
    assert.ok(result.drag.compiled.max + result.drag.rasterized.max <= 2, 'Only the moved figure and its attachment may rebuild during posing.');
    assert.ok(result.commit.compiled.max + result.commit.rasterized.max <= count, 'Committing this key must not rebuild unchanged ghost artwork.');
    assert.ok(result.scrub.compiled.max + result.scrub.rasterized.max <= 4, 'Cold scrubbing must retain static artwork across neighboring samples.');
    assert.equal(result.warmScrub.builds.max, 0, 'Warm scrubbing must reuse ghost geometry.');
    assert.ok(result.warmScrub.compiled.max + result.warmScrub.rasterized.max <= 2, 'Warm scrubbing must retain ghost textures.');
    assert.ok(result.cacheEntries <= 24, 'Sample residency must remain bounded.');
  }
} finally { await browser.close(); }
