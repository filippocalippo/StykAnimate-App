// Boots the desktop app and checks it came up whole, on any OS and with no
// private sample files (scripts/smoke-desktop.mjs needs a sibling Samples.stk).
//
//   node scripts/smoke-boot.mjs                      the source tree, through Electron
//   node scripts/smoke-boot.mjs --packaged           release/<platform>-unpacked (or STYK_PACKAGED_EXECUTABLE)
//
// Checks: the window and renderer start, the bridge is present and Node is not
// exposed, the codec answers (and, packaged, is the frozen build with its native
// scanner), video export offers what the platform's encoder supports, updates and
// telemetry are in their expected state, and there were no page errors. On Linux
// without a display, run it under xvfb-run; without a GPU it reports the Canvas 2D
// compatibility renderer instead of WebGPU, and both are accepted.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from '../tests/support/playwright.mjs';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packaged = process.argv.includes('--packaged');
const unpacked = process.platform === 'win32' ? ['win-unpacked', 'StykAnimate.exe']
  : process.platform === 'darwin' ? [process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'StykAnimate.app', 'Contents', 'MacOS', 'StykAnimate']
  : [process.arch === 'arm64' ? 'linux-arm64-unpacked' : 'linux-unpacked', 'stykanimate'];
const executablePath = packaged ? process.env.STYK_PACKAGED_EXECUTABLE || path.join(appRoot, 'release', ...unpacked) : undefined;

const profile = await mkdtemp(path.join(os.tmpdir(), 'styk-boot-'));
// No first-run privacy prompt: consent is recorded as declined.
await writeFile(path.join(profile, 'telemetry-state.json'), JSON.stringify({ decided: true, consent: { analytics: false, diagnostics: false, policyVersion: '2026-09-10', updatedAt: Date.now() } }));
const failures = [];
const output = path.join(appRoot, 'artifacts', packaged ? 'boot-packaged' : 'boot-source');
await mkdir(output, { recursive: true });
const expect = (name, condition, detail = '') => { if (!condition) failures.push(`${name}${detail ? ` (${detail})` : ''}`); console.log(`${condition ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };
let app;
try {
  app = await electron.launch({ executablePath, args: packaged ? [] : [appRoot], cwd: appRoot, timeout: 60000, env: { ...process.env, STYK_USER_DATA_DIR: profile } });
  const page = await app.firstWindow({ timeout: 60000 });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForFunction(() => window.styk?.ready === true, undefined, { timeout: 60000 });
  const facts = await page.evaluate(async () => ({
    desktop: window.stykDesktop?.isDesktop === true,
    platform: window.stykDesktop?.platform,
    nodeExposed: typeof window.require !== 'undefined' || typeof window.process !== 'undefined',
    renderer: window.styk.state.renderer?.stats?.backend,
    health: await (await fetch('/api/health')).json(),
    video: await window.stykDesktop.getVideoCapabilities({ width: 320, height: 240 }),
    vfw: (await window.stykDesktop.getVfwCapabilities({ width: 320, height: 240 })).available === true,
    updates: (await window.stykDesktop.getUpdateState()).status,
    title: document.title,
  }));
  facts.architecture = await app.evaluate(() => process.arch);
  expect('Electron runs with the native architecture', facts.architecture === process.arch, facts.architecture);
  expect('The window opens on the editor', /StykAnimate/.test(facts.title), facts.title);
  expect('The desktop bridge is present and Node is not exposed to the page', facts.desktop && !facts.nodeExposed);
  expect('The bridge reports this platform', facts.platform === process.platform, facts.platform);
  expect('The renderer started', ['WebGPU', 'Canvas 2D fallback'].includes(facts.renderer), facts.renderer);
  expect('The codec answers', facts.health?.ok === true, `${facts.health?.jsonEncoder}, scanner ${facts.health?.nativeFrameScanner}`);
  if (packaged) {
    expect('The frozen codec uses the compiled JSON encoder', facts.health.jsonEncoder === 'orjson');
    expect('The frozen codec loaded its native scanner', facts.health.nativeFrameScanner === 'cpp');
    for (const id of ['webm', 'mp4', 'avi', 'wmv']) expect(`The bundled encoder exports ${id}`, facts.video.formats?.some((format) => format.id === id && format.supported));
  }
  expect('Installed Windows codecs are offered only on Windows', process.platform === 'win32' || facts.vfw === false);
  expect('The update service starts without an error', facts.updates !== 'error', facts.updates);
  if (!packaged) expect('Source builds do not update', facts.updates === 'unavailable', facts.updates);
  if (packaged && process.platform === 'linux' && executablePath?.endsWith('.AppImage')) {
    expect('The Linux AppImage enables updates', facts.updates !== 'unavailable', facts.updates);
  }
  expect('The page raised no errors', errors.length === 0, errors[0]);
  // Exercise the real native save bridge and frozen importer without private fixtures.
  await page.waitForFunction(() => window.styk.state.documentToken, undefined, { timeout: 30000 });
  if (packaged) await page.getByRole('button', { name: 'Close welcome screen', exact: true }).click();
  await page.bringToFront();
  await page.screenshot({ path: path.join(output, 'editor.png') });
  const target = path.join(output, 'roundtrip.styk');
  await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, target);
  const width = await page.evaluate(() => {
    const editor = window.styk.editor;
    editor.setCanvasSize(961, editor.report.canvas_height);
    return editor.report.canvas_width;
  });
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s');
  await page.waitForFunction(() => !window.styk.editor.dirty && document.getElementById('status')?.textContent === 'Project saved', undefined, { timeout: 30000 });
  await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, target);
  const restored = await page.evaluate(async () => {
    const native = await window.stykDesktop.openFile();
    const { ImportClient } = await import('/src/import-client.mjs');
    const importer = new ImportClient();
    try {
      const result = await importer.importFile(new File([native.bytes], native.filename));
      return { width: result.document.canvas_width, frames: result.document.keyframes.length };
    } finally { importer.dispose(); }
  });
  expect('Save shortcut writes a project that can be imported again', restored.width === width && restored.frames > 0);
  expect('Saving and importing raised no page errors', errors.length === 0, errors[0]);
  await page.screenshot({ path: path.join(output, 'editor.png') });
  await writeFile(path.join(output, 'result.json'), JSON.stringify({
    checkedAt: new Date().toISOString(), platform: process.platform, architecture: process.arch,
    packaged, executablePath, executableSha256: executablePath ? createHash('sha256').update(await readFile(executablePath)).digest('hex') : null,
    facts, restored, errors, failures,
  }, null, 2));
} finally {
  // A failed save check can leave a dirty project; do not block on a close prompt.
  if (app) {
    const closed = app.waitForEvent('close', { timeout: 10000 }).catch(() => {});
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await closed;
  }
  await rm(profile, { recursive: true, force: true, maxRetries: 3 });
}
if (failures.length) { console.error(`\n${failures.length} check(s) failed:\n - ${failures.join('\n - ')}`); process.exitCode = 1; }
else console.log('\nThe desktop app booted cleanly.');
