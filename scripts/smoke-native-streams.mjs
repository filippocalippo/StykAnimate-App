import { _electron as electron } from 'playwright';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(appRoot, 'artifacts');
const profile = path.join(output, 'native-streams-profile');
const destination = path.join(output, 'native-streams-large.bin');
await mkdir(output, { recursive: true });
const app = await electron.launch({ args: [appRoot], cwd: appRoot, timeout: 45000, env: { ...process.env, STYK_USER_DATA_DIR: profile } });
try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => window.styk?.ready, undefined, { timeout: 20000 });
  await page.evaluate(() => window.stykDesktop.deleteRecovery());
  await app.evaluate(({ dialog }, filename) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: filename }); }, destination);
  const measured = await page.evaluate(async () => {
    const { writeNativeBlob, readNativeRecovery } = await import('/src/native-files.mjs');
    // Construct the large Blob in a worker, matching the document exporter.
    const workerCode = `const part=new Uint8Array(256*1024);for(let i=0;i<part.length;i++)part[i]=i%251;self.postMessage(new Blob(Array(800).fill(part)));`;
    const url = URL.createObjectURL(new Blob([workerCode], { type: 'application/javascript' }));
    const worker = new Worker(url);
    const blob = await new Promise((resolve, reject) => { worker.onmessage = event => resolve(event.data); worker.onerror = reject; });
    worker.terminate(); URL.revokeObjectURL(url);
    const gaps = [], longTasks = [];
    let last = performance.now(), writeChunks = 0, readChunks = 0, maxChunkBytes = 0;
    const timer = setInterval(() => { const now = performance.now(); gaps.push(now - last); last = now; }, 5);
    const observer = new PerformanceObserver(list => { for (const entry of list.getEntries()) longTasks.push(entry.duration); });
    observer.observe({ type: 'longtask' });
    const desktop = {
      ...window.stykDesktop,
      writeFileChunk: async (token, bytes) => { writeChunks++; maxChunkBytes = Math.max(maxChunkBytes, bytes.byteLength); return window.stykDesktop.writeFileChunk(token, bytes); },
      readFileChunk: async token => { const result = await window.stykDesktop.readFileChunk(token); readChunks++; maxChunkBytes = Math.max(maxChunkBytes, result.bytes.byteLength); return result; },
    };
    try {
      const started = performance.now();
      if (!await writeNativeBlob(desktop, blob, { defaultPath: 'large.bin', filters: [{ name: 'Binary', extensions: ['bin'] }] })) throw new Error('Native streaming save failed.');
      const savedAt = performance.now();
      if (!await writeNativeBlob(desktop, blob, { recovery: true, name: 'Large recovery' })) throw new Error('Recovery streaming save failed.');
      const recoveredAt = performance.now();
      const info = await desktop.getRecoveryInfo();
      if (info.size !== blob.size || info.name !== 'Large recovery') throw new Error('Lightweight recovery metadata is incorrect.');
      const recovered = await readNativeRecovery(desktop);
      const readAt = performance.now();
      if (recovered.blob.size !== blob.size || recovered.name !== 'Large recovery') throw new Error('Streamed recovery metadata differs.');
      for (const offset of [0, 99 * 256 * 1024, blob.size - 256 * 1024]) {
        const sample = new Uint8Array(await recovered.blob.slice(offset, offset + 256 * 1024).arrayBuffer());
        if (sample.some((value, index) => value !== index % 251)) throw new Error('Recovery bytes changed during transfer.');
      }
      // An aborted replacement must preserve the previously committed file.
      const controller = new AbortController();
      let aborted = false;
      try { await writeNativeBlob(desktop, new Blob(['replacement']), { defaultPath: 'large.bin', signal: controller.signal, onProgress: () => controller.abort() }); }
      catch (error) { aborted = error.name === 'AbortError'; }
      if (!aborted) throw new Error('Canceled native streaming save did not abort.');
      await desktop.deleteRecovery();
      await new Promise(resolve => setTimeout(resolve, 30));
      return { bytes: blob.size, nativeSaveMs: savedAt - started, recoverySaveMs: recoveredAt - savedAt, recoveryReadMs: readAt - recoveredAt, writeChunks, readChunks, maxChunkBytes, rendererTimerMaxGapMs: Math.max(0, ...gaps), rendererLongTaskCount: longTasks.length, rendererLongestTaskMs: Math.max(0, ...longTasks), cancelledReplacementPreserved: true, infoOnlyHasNoData: !Object.hasOwn(info, 'data'), nodeExposed: typeof window.require !== 'undefined' };
    } finally { clearInterval(timer); observer.disconnect(); }
  });
  const expected = createHash('sha256');
  const part = Buffer.alloc(256 * 1024);
  for (let index = 0; index < part.length; index++) part[index] = index % 251;
  for (let index = 0; index < 800; index++) expected.update(part);
  const actual = createHash('sha256');
  for await (const chunk of createReadStream(destination)) actual.update(chunk);
  assert.equal(actual.digest('hex'), expected.digest('hex'), 'Atomic streaming save must retain exact bytes despite subsequent cancellation.');
  assert.equal(measured.maxChunkBytes, 256 * 1024);
  assert.equal(measured.nodeExposed, false);
  await writeFile(path.join(output, 'native-streams-smoke.json'), JSON.stringify({ ...measured, sha256Verified: true, measuredAt: new Date().toISOString(), note: '200 MiB worker-produced Blob. Timers include OS/test scheduling; these are observations, not input-to-display guarantees.' }, null, 2));
  console.log(JSON.stringify(measured, null, 2));
} finally {
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await unlink(destination).catch(error => { if (error.code !== 'ENOENT') throw error; });
}
