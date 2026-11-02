// Does the browser's `GPUQueue.writeTexture` lose part of a large write, and does it matter where the bytes are? No engine involved.
//
//   node scripts/probe-webgpu-shared-writes.mjs [--trials 12] [--packaged]
//
// A worker of the desktop app's page (cross-origin isolated, so it has SharedArrayBuffer) gets a WebGPU device, writes 116 pictures of
// 802x452 noise (the size of tdd2's) into a 4096x4096x3 texture with `writeTexture`, waits for the queue, reads every picture back and
// compares it with the bytes it wrote. A trial is one such pass; each condition runs `--trials` of them:
//   arraybuffer          the source bytes are in an ordinary ArrayBuffer (a copy at the call is what the specification says)
//   shared               the same bytes in a SharedArrayBuffer, as the engine's WebAssembly memory is
//   arraybuffer+warm     a one-texel write to every layer first, the queue waited for, so the texture is not new for the pictures (what the
//                        engine does where it makes a texture: styk-render `warm_texture`)
//   arraybuffer+warmnowait  the same, without waiting for the queue
//   arraybuffer+staged   the pictures reach the texture through a buffer made mapped and a GPU copy
//   shared+warm, shared+staged   the same from the SharedArrayBuffer
//   arraybuffer+scribble  the source is overwritten with 0xAA right after each call returns: a browser that read it late would write 0xAA
//   shared+scribble       the same for the SharedArrayBuffer
//   shared+writers        the SharedArrayBuffer, with three other threads writing beside the pictures all the while (the engine's workers)
// The result separates a fault of the browser's (it shows in a condition with no engine, and tells whether the source's kind or
// lifetime matters) from one in the engine (it shows in none of them): see docs/engine/rendering.md, Uploads. The window opens off-screen
// (STYK_BACKGROUND_WINDOW) and the run ends the app's own process tree if it does not close in 15 s.
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron as electron } from '../tests/support/playwright.mjs';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const option = (name, fallback) => { const at = process.argv.indexOf(`--${name}`); return at < 0 ? fallback : process.argv[at + 1]; };
const trials = Number(option('trials', 12));
const packaged = process.argv.includes('--packaged');
const unpacked = process.platform === 'win32' ? ['win-unpacked', 'StykAnimate.exe']
  : process.platform === 'darwin' ? [process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'StykAnimate.app', 'Contents', 'MacOS', 'StykAnimate']
  : [process.arch === 'arm64' ? 'linux-arm64-unpacked' : 'linux-unpacked', 'stykanimate'];
const executablePath = packaged ? process.env.STYK_PACKAGED_EXECUTABLE || path.join(appRoot, 'release', ...unpacked) : undefined;
const work = await mkdtemp(path.join(os.tmpdir(), 'styk-writes-'));
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
const watchdog = setTimeout(() => { console.error('The probe ran past its limit.'); close().finally(() => process.exit(3)); }, 25 * 60 * 1000);

/** The worker: no engine, only WebGPU and the bytes. */
const worker = () => {
  const PW = 802, PH = 452, PICS = 116, ROW = PW * 4, BYTES = ROW * PH, ACROSS = 5, DOWN = 9, PER_LAYER = ACROSS * DOWN, LAYERS = Math.ceil(PICS / PER_LAYER);
  const SIDE = 4096, SCRATCH = 32 << 20;
  const random = (seed) => { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s; }; };
  const expected = new Uint8Array(PICS * BYTES);
  { const next = random(0x9e3779b9), words = new Uint32Array(expected.buffer); for (let i = 0; i < words.length; i++) words[i] = next(); }
  let device;
  const place = (pic) => ({ layer: Math.floor(pic / PER_LAYER), x: (pic % PER_LAYER % ACROSS) * PW, y: Math.floor(pic % PER_LAYER / ACROSS) * PH });

  async function trial(source, scribble, warm, staged) {
    const texture = device.createTexture({ size: [SIDE, SIDE, LAYERS], format: 'rgba8unorm', usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC });
    source.set(expected.subarray(0, PICS * BYTES), 0);
    if (warm) {
      // A one-texel write to every layer first, and the queue waited for: the texture is then no longer new.
      for (let layer = 0; layer < LAYERS; layer++) device.queue.writeTexture({ texture, origin: [SIDE - 1, SIDE - 1, layer] }, new Uint8Array(4), { bytesPerRow: 4 }, [1, 1, 1]);
      if (warm === "wait") await device.queue.onSubmittedWorkDone();
    }
    const staging = [], STRIDE = (ROW + 255) & ~255;
    for (let pic = 0; pic < PICS; pic++) {
      const { layer, x, y } = place(pic), bytes = source.subarray(pic * BYTES, (pic + 1) * BYTES);
      if (staged) {
        // The engine's fix: the rows go into a buffer made mapped, and the GPU copies them.
        const buffer = device.createBuffer({ size: STRIDE * PH, usage: GPUBufferUsage.COPY_SRC, mappedAtCreation: true });
        const mapped = new Uint8Array(buffer.getMappedRange());
        for (let row = 0; row < PH; row++) mapped.set(bytes.subarray(row * ROW, (row + 1) * ROW), row * STRIDE);
        buffer.unmap();
        const encoder = device.createCommandEncoder();
        encoder.copyBufferToTexture({ buffer, bytesPerRow: STRIDE, rowsPerImage: PH }, { texture, origin: [x, y, layer] }, [PW, PH, 1]);
        device.queue.submit([encoder.finish()]);
        staging.push(buffer);
      } else {
        device.queue.writeTexture({ texture, origin: [x, y, layer] }, bytes, { bytesPerRow: ROW, rowsPerImage: PH }, [PW, PH, 1]);
      }
      if (scribble) bytes.fill(0xaa);
    }
    await device.queue.onSubmittedWorkDone();
    for (const buffer of staging) buffer.destroy();
    const bad = [];
    const readback = device.createBuffer({ size: SIDE * SIDE * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    for (let layer = 0; layer < LAYERS; layer++) {
      const encoder = device.createCommandEncoder();
      encoder.copyTextureToBuffer({ texture, origin: [0, 0, layer] }, { buffer: readback, bytesPerRow: SIDE * 4 }, [SIDE, SIDE, 1]);
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      const mapped = new Uint8Array(readback.getMappedRange());
      for (let pic = layer * PER_LAYER; pic < Math.min(PICS, (layer + 1) * PER_LAYER); pic++) {
        const { x, y } = place(pic);
        let rows = 0, first = -1;
        for (let row = 0; row < PH; row++) {
          const a = mapped.subarray(((y + row) * SIDE + x) * 4, ((y + row) * SIDE + x) * 4 + ROW), b = expected.subarray(pic * BYTES + row * ROW, pic * BYTES + (row + 1) * ROW);
          let same = true;
          for (let i = 0; i < ROW; i += 4) if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3]) { same = false; break; }
          if (!same) { rows++; if (first < 0) first = row; }
        }
        if (rows) bad.push({ pic, rows, first });
      }
      readback.unmap();
    }
    readback.destroy();
    texture.destroy();
    return bad;
  }

  onmessage = async ({ data: { condition, trials } }) => {
    try {
      if (!device) device = await (await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })).requestDevice();
      const shared = condition.startsWith('shared'), scribble = condition.includes('scribble'), writers = condition.includes('writers');
      const memory = shared ? new SharedArrayBuffer(PICS * BYTES + SCRATCH) : new ArrayBuffer(PICS * BYTES);
      const source = new Uint8Array(memory, 0, PICS * BYTES);
      const helpers = [];
      if (writers) {
        const code = `onmessage = ({data: {memory, from, to}}) => { const view = new Uint32Array(memory, from, (to - from) >> 2); for (let n = 0; ; n++) { for (let i = 0; i < view.length; i += 16) view[i] = n + i; if (n % 64 === 0 && globalThis.stop) return; } }`;
        for (let i = 0; i < 3; i++) { const helper = new Worker(URL.createObjectURL(new Blob([code]))); helper.postMessage({ memory, from: PICS * BYTES + i * (SCRATCH / 3 | 0), to: PICS * BYTES + (i + 1) * (SCRATCH / 3 | 0) & ~3 }); helpers.push(helper); }
      }
      const result = { condition, trials, pictures: trials * PICS, badPictures: 0, badTrials: 0, examples: [] };
      for (let t = 0; t < trials; t++) {
        const bad = await trial(source, scribble, condition.includes("warmnowait") ? "nowait" : condition.includes("warm") ? "wait" : false, condition.includes("staged"));
        if (bad.length) { result.badTrials++; result.badPictures += bad.length; if (result.examples.length < 4) result.examples.push({ trial: t, ...bad[0], pictures: bad.length }); }
      }
      for (const helper of helpers) helper.terminate();
      postMessage(result);
    } catch (error) { postMessage({ condition, error: String(error?.stack ?? error) }); }
  };
};

try {
  app = await electron.launch({ executablePath, args: packaged ? [] : [appRoot], cwd: appRoot, env, timeout: 120000 });
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 2, checkboxChecked: false }); });
  const page = await app.firstWindow({ timeout: 120000 });
  await page.waitForFunction(() => window.styk?.ready === true, undefined, { timeout: 120000 });
  const results = await page.evaluate(async ({ source, trials }) => {
    const url = URL.createObjectURL(new Blob([`(${source})()`]));
    const out = [];
    for (const condition of ['arraybuffer', 'shared', 'arraybuffer+warm', 'shared+warm', 'arraybuffer+warmnowait', 'arraybuffer+staged', 'shared+staged', 'shared+scribble', 'shared+writers']) {
      const worker = new Worker(url);
      out.push(await new Promise((resolve) => { worker.onmessage = ({ data }) => resolve(data); worker.postMessage({ condition, trials }); }));
      worker.terminate();
    }
    return { crossOriginIsolated, userAgent: navigator.userAgent, out };
  }, { source: worker.toString(), trials });
  console.log(JSON.stringify(results, null, 1));
  if (results.out.some((r) => r.error)) failed = true;
} catch (error) {
  console.error(error);
  failed = true;
} finally {
  clearTimeout(watchdog);
  await close();
  await rm(work, { recursive: true, force: true }).catch(() => {});
}
process.exit(failed ? 1 : 0);
