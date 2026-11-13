// Interactive rendering of a synthetic dense scene in the real desktop app, per
// renderer. Needs no private sample files: the scene is the startup figure cloned
// N times, so the same workload runs on any machine.
//
//   node scripts/benchmark-synthetic-scene.mjs [--figures 300] [--seconds 4] [--runs 3]
//
// Each run launches the app twice: with its default renderer (WebGPU where the
// platform enables it) and forced to Canvas 2D (STYK_GPU_UNSAFE=0). While the
// canvas zooms in and out through the app's own Ctrl+wheel handler, so every frame
// redraws the whole scene, it measures achieved frames per second, the 95th
// percentile and worst frame interval, and how many intervals exceeded 25 ms, from
// requestAnimationFrame in the page. Run it on an idle machine, on the same scene
// and settings, before and after a rendering change. Frame rate is capped by the
// display's refresh rate, so raise --figures until the faster renderer no longer
// reaches it.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from '../tests/support/playwright.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const option = (name, fallback) => { const index = process.argv.indexOf(name); return index >= 0 ? Number(process.argv[index + 1]) : fallback; };
const figures = option('--figures', 300), seconds = option('--seconds', 4), runs = option('--runs', 3);
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

async function measure(mode) {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'styk-bench-'));
  // Statistics off (docs/STATISTICS.md): a script's runs are not counted and nothing waits to be sent.
await writeFile(path.join(profile, 'stats-state.json'), JSON.stringify({v: 1, enabled: false, noticeSeen: true}));
  const env = { ...process.env, STYK_USER_DATA_DIR: profile };
  if (mode === 'canvas2d') env.STYK_GPU_UNSAFE = '0';
  const app = await electron.launch({ args: [root], cwd: root, timeout: 60000, env });
  try {
    const page = await app.firstWindow({ timeout: 60000 });
    await page.waitForFunction(() => window.styk?.ready === true, undefined, { timeout: 60000 });
    const backend = await page.evaluate(() => window.styk.state.renderer.stats.backend);
    await page.evaluate((count) => {
      const { editor } = window.styk;
      const document = structuredClone(editor.report);
      const first = document.keyframes[0], template = first.objects[0];
      const columns = Math.ceil(Math.sqrt(count * document.canvas_width / document.canvas_height)), rows = Math.ceil(count / columns);
      first.objects = []; first.object_draw_order = []; delete first.object_draw_order_unique_ids;
      for (let i = 0; i < count; i++) {
        first.objects.push({ ...structuredClone(template), object_slot: i, unique_id: 1000 + i, scale: 0.35,
          root_x: ((i % columns) + 0.5) * document.canvas_width / columns, root_y: (Math.floor(i / columns) + 0.5) * document.canvas_height / rows });
        first.object_draw_order.push(i);
      }
      editor.load(document);
    }, figures);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.waitForTimeout(1000);
    const stats = await page.evaluate((duration) => new Promise((resolve) => {
      const viewport = document.getElementById('viewport'), box = viewport.getBoundingClientRect();
      const intervals = []; let last = performance.now(), frame = 0; const end = last + duration * 1000;
      const tick = (now) => {
        intervals.push(now - last); last = now;
        // Ctrl+wheel zooms about the pointer; alternating direction keeps the scene in view.
        viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: frame++ % 2 ? 45 : -45, ctrlKey: true, clientX: box.x + box.width / 2, clientY: box.y + box.height / 2, bubbles: true, cancelable: true }));
        if (now < end) requestAnimationFrame(tick); else resolve(intervals);
      };
      requestAnimationFrame(tick);
    }), seconds);
    const sorted = [...stats].sort((a, b) => a - b);
    return { backend, fps: 1000 / (stats.reduce((sum, value) => sum + value, 0) / stats.length), p95: sorted[Math.floor(sorted.length * 0.95)], worst: sorted.at(-1), slow: stats.filter((value) => value > 25).length, frames: stats.length };
  } finally {
    await app.close().catch(() => {});
    await rm(profile, { recursive: true, force: true });
  }
}

const results = { default: [], canvas2d: [] };
for (let run = 0; run < runs; run++) for (const mode of ['default', 'canvas2d']) results[mode].push(await measure(mode));
console.log(`\n${figures} figures, ${seconds}s of playback, ${runs} runs, ${os.cpus()[0].model}, ${process.platform}\n`);
for (const [mode, list] of Object.entries(results)) {
  const row = (key) => median(list.map((item) => item[key]));
  console.log(`${mode.padEnd(9)} ${list[0].backend.padEnd(20)} fps ${row('fps').toFixed(1).padStart(6)}   p95 ${row('p95').toFixed(1).padStart(6)} ms   worst ${row('worst').toFixed(1).padStart(6)} ms   intervals >25ms ${String(row('slow')).padStart(4)} of ${row('frames')}`);
}
