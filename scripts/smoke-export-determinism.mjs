// An export of the same document twice must give the same frames, byte for byte, in the desktop app with a real GPU.
//
//   node scripts/smoke-export-determinism.mjs [--runs 14] [--pictures 64] [--keep <folder>] [--packaged]
//   node scripts/smoke-export-determinism.mjs --file <document> --first <tick> --last <tick> [--runs 14]   a document of yours instead
//
// The document is made here (no private files): one large picture of noise a frame, each in a figure of its own, so the engine
// uploads that many pictures to the export's atlas and every frame draws one of them. Each run exports the PNG-sequence frames of
// every tick through the engine's export renderer (what the PNG sequence and native video exports use) on a fresh renderer, and
// hashes them. A frame that differs from the first run's is reported, and written to --keep when given.
//
// Why: a browser's `writeTexture` and `writeBuffer` from the engine's shared memory sometimes left rows of a large upload out, so
// an export of tdd2 gave a frame of garbage streaks about one run in three (docs/engine/rendering.md, Exports). Pictures and the
// engine's other large uploads go through staging buffers now (styk-render `resources::write_buffer`). A machine without WebGPU
// uses the CPU rasterizer, which this checks as well but which never showed the problem.
//
// With --packaged it runs the packaged app (release/<platform>-unpacked, or STYK_PACKAGED_EXECUTABLE), where the export renderer it
// creates is the application's own module (build-app.mjs lists it as a page entry), not a second copy.
//
// The window opens off-screen and takes no focus (STYK_BACKGROUND_WINDOW); the native "unsaved changes" prompt is replaced and the
// run ends the app's own process tree if it does not close in 15 s.
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron as electron } from '../tests/support/playwright.mjs';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packaged = process.argv.includes('--packaged');
const unpacked = process.platform === 'win32' ? ['win-unpacked', 'StykAnimate.exe']
  : process.platform === 'darwin' ? [process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'StykAnimate.app', 'Contents', 'MacOS', 'StykAnimate']
  : [process.arch === 'arm64' ? 'linux-arm64-unpacked' : 'linux-unpacked', 'stykanimate'];
const executablePath = packaged ? process.env.STYK_PACKAGED_EXECUTABLE || path.join(appRoot, 'release', ...unpacked) : undefined;
const option = (name, fallback) => { const at = process.argv.indexOf(`--${name}`); return at < 0 ? fallback : process.argv[at + 1]; };
const runs = Number(option('runs', 14)), pictures = Number(option('pictures', 64)), keep = option('keep', null);
const file = option('file', null), first = Number(option('first', 0)), last = Number(option('last', 0));
const work = await mkdtemp(path.join(os.tmpdir(), 'styk-determinism-'));
await writeFile(path.join(work, 'telemetry-state.json'), JSON.stringify({ decided: true, consent: { analytics: false, diagnostics: false, policyVersion: '2026-09-10', updatedAt: Date.now() } }));
const env = { ...process.env, STYK_USER_DATA_DIR: work, STYK_LIBRARY_DIR: path.join(work, 'library'), STYK_STARTUP_VIEW: 'editor', STYK_BACKGROUND_WINDOW: '1' };
delete env.ELECTRON_RUN_AS_NODE;
let app, failed = false;
const close = async () => {
  if (!app) return;
  const pid = app.process().pid;
  const closed = await Promise.race([app.close().then(() => true, () => true), delay(15000).then(() => false)]);
  if (!closed && pid) { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } }
};
const watchdog = setTimeout(() => { console.error('The determinism smoke ran past its limit.'); close().finally(() => process.exit(3)); }, 20 * 60 * 1000);
try {
  app = await electron.launch({ executablePath, args: packaged ? [] : [appRoot], cwd: appRoot, env, timeout: 120000 });
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 2, checkboxChecked: false }); });
  const page = await app.firstWindow({ timeout: 120000 });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForFunction(() => window.styk?.ready === true, undefined, { timeout: 120000 });
  await page.evaluate(() => {
    const dismiss = () => document.querySelectorAll('dialog.release-splash[open],dialog.styk-privacy[open]').forEach((d) => d.close());
    dismiss(); new MutationObserver(dismiss).observe(document.body, { subtree: true, attributes: true, childList: true, attributeFilter: ['open'] });
  });
  if (file) {
    await page.locator('#file-input').setInputFiles(path.resolve(file));
    await page.waitForFunction(() => !styk.state.importing && styk.editor.report?.keyframes?.length, undefined, { timeout: 240000 });
    await delay(1500);
  }
  if (keep) await mkdir(keep, { recursive: true });
  await page.exposeFunction('keepFrame', async (name, base64) => { await writeFile(path.join(keep, name), Buffer.from(base64, 'base64')); });
  const result = await page.evaluate(async ({ runs, pictures, keeping, imported, first, last }) => {
    const { emptyDocument, createFrame, createObject } = await import('/src/demo.mjs');
    const { createExportFrameRenderer } = await import('/src/engine/engine-export.mjs');
    const W = imported ? styk.editor.report.canvas_width : 800, H = imported ? styk.editor.report.canvas_height : 450;
    // A picture of noise a figure (incompressible, so each is a large upload), drawn in a frame of its own.
    const noise = async (seed) => {
      const canvas = new OffscreenCanvas(W, H), context = canvas.getContext('2d'), image = context.createImageData(W, H);
      let state = (seed * 2654435761 + 12345) >>> 0;
      for (let i = 0; i < image.data.length; i += 4) {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        image.data[i] = state >>> 24; image.data[i + 1] = state >>> 16; image.data[i + 2] = state >>> 8; image.data[i + 3] = 255;
      }
      context.putImageData(image, 0, 0);
      const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
      let text = ''; for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return `data:image/png;base64,${btoa(text)}`;
    };
    const report = imported ? styk.editor.report : emptyDocument();
    if (!imported) { report.canvas_width = W; report.canvas_height = H; report.figure_types = []; }
    for (let i = 0; !imported && i < pictures; i++) {
      report.figure_types.push({
        figure_type_id: i + 1, name: `picture ${i}`, polyfills: [], text_assets: [],
        segments: [{ segment_id: 1, parent_id: 0, primitive_code: 2, segment_type: 'image', segment_kind: 'image', length: W, angle_rad: 0, bend_rad: 0, thickness: 1,
          color_rgb: [255, 255, 255], visible: true, z_order: 1, transparency: 0 }],
        image_assets: [{ asset_index: 0, data_url: await noise(i), mime_type: 'image/png', width: W, height: H, anchor_start: { x: 0, y: 0 }, anchor_angle_rad: 0, anchor_length: W }],
      });
    }
    if (!imported) {
      report.keyframes = report.figure_types.map((figure, i) => createFrame([createObject(figure, i + 1, 0, H / 2)], 1));
      styk.editor.load(report, 'Export determinism');
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    const hex = async (blob) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
    const firstTick = imported ? first : 0, ticks = imported ? last - first + 1 : pictures, firsts = [], differing = [];
    let backend = null;
    for (let run = 0; run < runs; run++) {
      const renderer = createExportFrameRenderer({ width: W, height: H, smoothing: 'edges', getRevision: () => styk.editor.revision },
        { stage: styk.state.renderer, revision: styk.editor.revision, range: [firstTick, firstTick + ticks - 1] });
      try {
        await renderer.load(styk.editor.report);
        for (let tick = firstTick; tick < firstTick + ticks; tick++) {
          const frame = await renderer.renderNativeTick(tick, { preserveAlpha: true });
          const hash = await hex(frame.blob);
          if (run === 0) { firsts[tick] = hash; continue; }
          if (hash === firsts[tick]) continue;
          differing.push({ run, tick, hash, expected: firsts[tick], size: frame.blob.size });
          if (keeping) {
            const bytes = new Uint8Array(await frame.blob.arrayBuffer()); let text = '';
            for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
            await window.keepFrame(`run${run}-tick${tick}-${hash}.png`, btoa(text));
          }
        }
        backend = renderer.stats.engine?.backend;
      } finally { renderer.dispose(); }
    }
    return { backend, pictures, runs, ticks, distinctFrames: new Set(firsts.filter(Boolean)).size, differing };
  }, { runs, pictures, keeping: Boolean(keep), imported: Boolean(file), first, last });
  console.log(JSON.stringify({ ...result, errors }));
  // The frames must show the pictures (a blank frame is the same in every run), and the runs must agree.
  if (!file && result.distinctFrames !== result.ticks) { console.error('The frames are not all different: the pictures were not drawn.'); failed = true; }
  if (result.differing.length) { console.error(`${result.differing.length} frame(s) differ between runs.`); failed = true; }
  if (errors.length) failed = true;
} catch (error) {
  console.error(error);
  failed = true;
} finally {
  clearTimeout(watchdog);
  await close();
  await rm(work, { recursive: true, force: true }).catch(() => {});
}
process.exit(failed ? 1 : 0);
