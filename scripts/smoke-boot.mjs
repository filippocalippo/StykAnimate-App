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
// without a display, run it under xvfb-run; without a GPU it reports WebGL2
// instead of WebGPU, and both are accepted.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
    health: await (await (async (path, init) => { const [{codecJob}, {codecRequest}] = await Promise.all([import('/src/codec-job.mjs'), import('/src/codec-request.mjs')]); const job = codecJob(); try { return await codecRequest(job.link().fields, path, init); } finally { job.finish(); } })('/api/health')).json(),
    video: await window.stykDesktop.getVideoCapabilities({ width: 320, height: 240 }),
    vfw: (await window.stykDesktop.getVfwCapabilities({ width: 320, height: 240 })).available === true,
    updates: (await window.stykDesktop.getUpdateState()).status,
    title: document.title,
  }));
  expect('The window opens on the editor', /StykAnimate/.test(facts.title), facts.title);
  expect('The desktop bridge is present and Node is not exposed to the page', facts.desktop && !facts.nodeExposed);
  expect('The bridge reports this platform', facts.platform === process.platform, facts.platform);
  expect('The renderer started', ['WebGPU', 'WebGL2'].includes(facts.renderer), facts.renderer);
  expect('The codec answers', facts.health?.ok === true, `${facts.health?.jsonEncoder}, scanner ${facts.health?.nativeFrameScanner}`);
  expect('The codec runs its WebAssembly module with the desktop limits', facts.health?.jsonEncoder === 'rust' && facts.health?.maxImportBytes === 128 * 1024 * 1024);
  if (packaged) {
    for (const id of ['webm', 'mp4', 'avi', 'wmv']) expect(`The bundled encoder exports ${id}`, facts.video.formats?.some((format) => format.id === id && format.supported));
  }
  expect('Installed Windows codecs are offered only on Windows', process.platform === 'win32' || facts.vfw === false);
  expect('The update service starts without an error', facts.updates !== 'error', facts.updates);
  if (!packaged) expect('Source builds do not update', facts.updates === 'unavailable', facts.updates);
  if (packaged && process.platform === 'linux' && executablePath?.endsWith('.AppImage')) {
    expect('The Linux AppImage enables updates', facts.updates !== 'unavailable', facts.updates);
  }
  expect('The page raised no errors', errors.length === 0, errors[0]);
} finally {
  await app?.close().catch(() => {});
  await rm(profile, { recursive: true, force: true });
}
if (failures.length) { console.error(`\n${failures.length} check(s) failed:\n - ${failures.join('\n - ')}`); process.exitCode = 1; }
else console.log('\nThe desktop app booted cleanly.');
