// Exports real videos from the desktop app and decodes each result, on any OS and
// with no private sample files. It answers "does export actually work here", which
// the capability probe in smoke-boot.mjs (what is offered) does not.
//
//   node scripts/smoke-video-export.mjs                 the source tree
//   node scripts/smoke-video-export.mjs --packaged      release/<platform>-unpacked
//
// The app's own export commands run against the startup scene (ten frames) through
// the bundled encoder. Only the native save dialog is replaced, by a fixed path:
// production IPC still receives no caller-selected write path. Each file is then
// decoded by the same ffmpeg; a file that does not decode, or has no frames, fails.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
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
const resources = packaged ? (process.platform === 'darwin'
  ? path.resolve(path.dirname(executablePath), '..', 'Resources')
  : path.join(path.dirname(executablePath), 'resources')) : path.join(appRoot, 'build');
const ffmpeg = path.join(resources, 'video-encoder', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
if (!existsSync(ffmpeg)) { console.error(`The bundled encoder is missing (${ffmpeg}). Run npm run build:video-encoder.`); process.exit(2); }

const EXPORTS = [['export-mp4', 'mp4'], ['export-video', 'webm'], ['export-avi', 'avi'], ['export-wmv', 'wmv'], ['export-gif', 'gif']];
const work = await mkdtemp(path.join(os.tmpdir(), 'styk-video-'));
const output = path.join(appRoot, 'artifacts', packaged ? 'exports-packaged' : 'exports-source');
await mkdir(output, { recursive: true });
await writeFile(path.join(work, 'telemetry-state.json'), JSON.stringify({ decided: true, consent: { analytics: false, diagnostics: false, policyVersion: '2026-09-10', updatedAt: Date.now() } }));
const failures = [];
const results = [];
let app;
try {
  app = await electron.launch({ executablePath, args: packaged ? [] : [appRoot], cwd: appRoot, timeout: 60000, env: { ...process.env, STYK_USER_DATA_DIR: work } });
  const page = await app.firstWindow({ timeout: 60000 });
  await page.waitForFunction(() => window.styk?.ready === true, undefined, { timeout: 60000 });
  if (packaged) await page.getByRole('button', { name: 'Close welcome screen', exact: true }).click();
  for (const [action, extension] of EXPORTS) {
    const target = path.join(output, `clip.${extension}`);
    await rm(target, { force: true });
    await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, target);
    const started = Date.now();
    let problem = '';
    try {
      await page.evaluate((id) => window.styk.actions[id](), action);
      const deadline = Date.now() + 120000;
      while (!existsSync(target) && Date.now() < deadline) await delay(100);
      if (!existsSync(target)) throw new Error('no file was written');
      let size = -1;
      for (let stable = 0; stable < 3 && Date.now() < deadline;) { const now = (await stat(target)).size; stable = now === size ? stable + 1 : 0; size = now; await delay(150); }
      const decoded = spawnSync(ffmpeg, ['-hide_banner', '-nostdin', '-i', target, '-f', 'null', '-'], { encoding: 'utf8' });
      const frames = Number([...decoded.stderr.matchAll(/frame=\s*(\d+)/g)].at(-1)?.[1] ?? 0);
      if (decoded.status !== 0) throw new Error(`ffmpeg could not decode it: ${decoded.stderr.trim().split('\n').at(-1)}`);
      if (!(frames >= 5)) throw new Error(`decoded ${frames} frames`);
      results.push({ format: extension, bytes: size, frames, elapsedMs: Date.now() - started });
      console.log(`PASS ${extension.padEnd(4)} ${String(size).padStart(8)} bytes, ${frames} frames, ${Date.now() - started} ms`);
    } catch (error) { problem = error.message; }
    if (problem) { failures.push(`${extension}: ${problem}`); console.log(`FAIL ${extension} — ${problem}`); }
  }
} finally {
  await app?.close().catch(() => {});
  await rm(work, { recursive: true, force: true, maxRetries: 3 });
  await writeFile(path.join(output, 'result.json'), JSON.stringify({
    checkedAt: new Date().toISOString(), platform: process.platform, architecture: process.arch,
    packaged, executablePath, results, failures,
  }, null, 2));
}
if (failures.length) { console.error(`\n${failures.length} export(s) failed:\n - ${failures.join('\n - ')}`); process.exitCode = 1; }
else console.log('\nEvery export decoded.');
