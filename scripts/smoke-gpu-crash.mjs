// The canvas comes back after the browser's GPU process crashes, again and again.
//
//   node scripts/smoke-gpu-crash.mjs [--crashes 4]
//
// A driver reset or a hung GPU ends Chromium's GPU process, and the stage loses its device. The app replaces the canvas
// and starts a stage on a new device (docs/engine/rendering.md, "A lost device"). After two such crashes Chromium used to
// refuse WebGPU and WebGL to the page for the rest of the run, so the canvas stayed dead until a restart; from the third
// crash on it draws on the processor, where the stage runs on WebGL2 and the processor stage. This crashes the GPU process
// `--crashes` times through the inspector protocol and requires, after each, the error banner gone and a newly edited
// frame on show. It needs a real window and a GPU, so it is not part of the unit tests or the Tests workflow.
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from '../tests/support/playwright.mjs';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const option = (name, fallback) => { const at = process.argv.indexOf(`--${name}`); return at < 0 ? fallback : process.argv[at + 1]; };
const crashes = Number(option('crashes', 4));
/** How long the canvas has to come back after a crash: the app's reconnects run for about a minute. */
const BACK_MS = 60000;
const profile = await mkdtemp(path.join(os.tmpdir(), 'styk-gpu-crash-'));
// Statistics off (docs/STATISTICS.md): a script's runs are not counted and nothing waits to be sent.
await writeFile(path.join(profile, 'stats-state.json'), JSON.stringify({v: 1, enabled: false, noticeSeen: true}));
const failures = [];
const expect = (name, condition, detail = '') => { if (!condition) failures.push(`${name}${detail ? ` (${detail})` : ''}`); console.log(`${condition ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };
let app;
try {
  const env = { ...process.env, STYK_USER_DATA_DIR: profile, STYK_LIBRARY_DIR: path.join(profile, 'library'), STYK_STARTUP_VIEW: 'editor', STYK_BACKGROUND_WINDOW: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [appRoot], cwd: appRoot, timeout: 60000, env });
  const page = await app.firstWindow({ timeout: 60000 });
  await page.waitForFunction(() => window.styk?.ready === true, undefined, { timeout: 60000 });
  await page.evaluate(async () => {
    document.querySelectorAll('dialog[open]').forEach((dialog) => dialog.close());
    for (let i = 0; i < 4; i++) await window.styk.actions['add-frame']();
    window.styk.editor.seek(0);
  });
  const cdp = await page.context().newCDPSession(page);
  const stage = () => page.evaluate(() => ({ backend: window.styk.state.renderer?.stats?.backend ?? null, banner: !document.getElementById('renderer-error').hidden,
    shown: window.styk.state.lastEditingPresentation?.sequence ?? 0 }));
  console.log('start', JSON.stringify(await stage()));
  for (let crash = 1; crash <= crashes; crash++) {
    await cdp.send('Browser.crashGpuProcess').catch(() => {});
    // The loss is noticed within a second (the stage polls its device), then the reconnects run.
    await page.waitForTimeout(2000);
    const back = await page.waitForFunction(() => document.getElementById('renderer-error').hidden && window.styk.state.renderer?.stats?.backend !== 'WebGPU device lost',
      undefined, { timeout: BACK_MS, polling: 250 }).then(() => true, () => false);
    const before = await stage();
    // An edit after the reconnect must reach the screen: a frame of another tick is drawn and shown.
    await page.evaluate((tick) => window.styk.editor.seek(tick), crash % 4);
    const drawn = await page.waitForFunction((seen) => (window.styk.state.lastEditingPresentation?.sequence ?? 0) > seen, before.shown, { timeout: 20000, polling: 100 }).then(() => true, () => false);
    const after = await stage();
    expect(`The canvas reconnects after GPU crash ${crash}`, back, JSON.stringify(after));
    expect(`An edited frame is shown after GPU crash ${crash}`, drawn, `on ${after.backend}`);
  }
} finally {
  // The frames added above are unsaved work, which holds the quit behind a native prompt: it answers "discard"
  // without showing, and after 15 s this run's own process tree is ended whatever happens.
  const pid = app?.process().pid;
  await app?.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 2, checkboxChecked: false }); }).catch(() => {});
  const closed = app ? await Promise.race([app.close().then(() => true, () => true), new Promise((resolve) => setTimeout(resolve, 15000, false))]) : true;
  if (!closed && pid) {
    try { if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); else process.kill(pid, 'SIGKILL'); } catch { /* it exited */ }
  }
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}
if (failures.length) console.error(`\n${failures.length} check(s) failed:\n- ${failures.join('\n- ')}`);
else console.log(`\nThe canvas came back after each of ${crashes} GPU process crashes.`);
process.exit(failures.length ? 1 : 0);
