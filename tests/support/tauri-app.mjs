// Launches the Tauri desktop app (engine/crates/styk-desktop) for the desktop smokes and drives its page with
// Playwright over the Chrome DevTools Protocol, with the surface the smokes used from Playwright's Electron support:
// `launch(options)` answers `{firstWindow(), windows(), process(), close()}`.
//
//   import { tauri as electron } from '../tests/support/tauri-app.mjs';
//   const app = await electron.launch({ env: { ...process.env, STYK_USER_DATA_DIR: profile } });
//   const page = await app.firstWindow();
//
// **Never the owner's data.** A packaged exe keeps its data in %APPDATA%\StykAnimate, the owner's real settings, library,
// recent files and recovery. Every launch here runs on a fresh scratch folder (`STYK_USER_DATA_DIR`, made and removed
// here unless the caller names its own), and a launch that would reach the owner's folder is refused
// (`launchEnvironment`, tested by tests/tauri-app-harness.test.mjs).
//
// The window opens off-screen, without focus and out of the taskbar (`STYK_BACKGROUND_WINDOW=1`), unless the caller
// sets that variable itself; it starts in the editor unless `STYK_STARTUP_VIEW` says otherwise. The executable is
// `executablePath`, else STYK_TAURI_EXECUTABLE, else the development build (`engine/target/debug/StykAnimate.exe`).
// Only development and developer builds open the DevTools port (STYK_REMOTE_DEBUGGING_PORT); the shipping build
// does not, so it cannot be driven this way.
//
// There is no main process to evaluate code in: `app.evaluate` throws. A smoke that stubbed Electron's dialogs or
// read main-process state uses the native test hooks instead (docs/tauri/shell.md).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from './playwright.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const exe = process.platform === 'win32' ? 'StykAnimate.exe' : 'StykAnimate';

/** The executable a smoke drives: the development build, or with `packaged` the release build. */
export function tauriExecutable({ packaged = false } = {}) {
  if (process.env.STYK_TAURI_EXECUTABLE) return process.env.STYK_TAURI_EXECUTABLE;
  if (packaged && process.env.STYK_PACKAGED_EXECUTABLE) return process.env.STYK_PACKAGED_EXECUTABLE;
  return path.join(root, 'engine', 'target', packaged ? 'release' : 'debug', exe);
}

/** The owner's data folder: where a packaged copy keeps its data (Electron's and this app's). */
export function ownerDataFolder(env = process.env) {
  const base = env.APPDATA || (process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support') : path.join(os.homedir(), '.config'));
  return path.join(base, 'StykAnimate');
}

/**
 * The environment an app run gets: the caller's, with a data folder that is never the owner's. Without
 * STYK_USER_DATA_DIR a fresh scratch folder is made (`scratch`: the folder to remove afterwards). A data folder that is
 * the owner's, or inside it, is refused.
 */
export function launchEnvironment(env = process.env, { port } = {}) {
  const out = { ...env };
  let scratch = null;
  if (!out.STYK_USER_DATA_DIR) {
    scratch = mkdtempSync(path.join(os.tmpdir(), 'styk-app-'));
    out.STYK_USER_DATA_DIR = scratch;
  }
  const owner = path.resolve(ownerDataFolder(env)).toLowerCase();
  const chosen = path.resolve(out.STYK_USER_DATA_DIR).toLowerCase();
  if (chosen === owner || chosen.startsWith(owner + path.sep)) {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    throw new Error(`Refusing to run the app on the owner's data folder (${out.STYK_USER_DATA_DIR}); use a scratch STYK_USER_DATA_DIR.`);
  }
  out.STYK_BACKGROUND_WINDOW = env.STYK_BACKGROUND_WINDOW ?? '1';
  out.STYK_STARTUP_VIEW = env.STYK_STARTUP_VIEW ?? 'editor';
  if (port !== undefined) out.STYK_REMOTE_DEBUGGING_PORT = String(port);
  return { env: out, scratch };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const isEditor = page => /^http:\/\/styk-app\.localhost\//.test(page.url()) || /^styk-app:/.test(page.url());

function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* Gone. */ } }
}

async function launch({ executablePath, args = [], env = process.env, cwd = root, timeout = 60000, spawnImpl = spawn } = {}) {
  const file = executablePath || tauriExecutable();
  if (!existsSync(file)) throw new Error(`The desktop app is not built: ${file} (cargo build -p styk-desktop)`);
  const port = await freePort();
  const { env: childEnv, scratch } = launchEnvironment(env, { port });
  // Checked again where the process starts: no path through this module starts the app without its own data folder.
  if (!childEnv.STYK_USER_DATA_DIR) throw new Error('Refusing to start the app without STYK_USER_DATA_DIR.');
  const cleanup = () => { if (scratch) rmSync(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); };
  // Electron smokes passed the source folder as the first argument; the Tauri app needs no such argument.
  const launchArgs = args.filter(arg => path.resolve(String(arg)) !== root);
  const child = spawnImpl(file, launchArgs, {
    cwd, windowsHide: false, detached: process.platform !== 'win32', env: childEnv, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = [];
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output.push(String(chunk)); if (output.length > 400) output.shift(); if (process.env.STYK_TAURI_LOG === '1') process.stderr.write(chunk); });
  let exited = null;
  child.once('exit', (code, signal) => { exited = { code, signal }; });
  child.once('exit', () => setTimeout(cleanup, 500));

  const deadline = Date.now() + timeout;
  let browser;
  while (!browser) {
    if (exited) { cleanup(); throw new Error(`The desktop app exited (${exited.code ?? exited.signal}) before its page opened:\n${output.join('')}`); }
    if (Date.now() > deadline) { killTree(child.pid); throw new Error(`The desktop app's page did not open within ${timeout} ms:\n${output.join('')}`); }
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 5000 }); }
    catch { await sleep(250); }
  }

  const pages = () => browser.contexts().flatMap(context => context.pages()).filter(isEditor);
  return {
    /** The app's process (`pid`, `exitCode`, its output so far as `output()`). */
    process: () => Object.assign(child, { output: () => output.join('') }),
    windows: pages,
    async firstWindow({ timeout: wait = timeout } = {}) {
      const until = Date.now() + wait;
      for (;;) {
        const [page] = pages();
        if (page) { await page.waitForLoadState('domcontentloaded').catch(() => {}); return page; }
        if (exited) throw new Error(`The desktop app exited (${exited.code ?? exited.signal}):\n${output.join('')}`);
        if (Date.now() > until) throw new Error('The desktop app opened no editor page.');
        await sleep(100);
      }
    },
    evaluate() {
      throw new Error('The Tauri app has no main process to evaluate code in; use the native test hooks (docs/tauri/shell.md).');
    },
    /** Asks the window to close (unsaved work is handled as the app always does); ends the process if it lingers. */
    async close({ wait = 10000 } = {}) {
      const [page] = pages();
      if (page && !exited) await Promise.race([page.evaluate(() => window.stykDesktop?.close()).catch(() => {}), sleep(2000)]);
      const until = Date.now() + wait;
      while (!exited && Date.now() < until) await sleep(100);
      if (!exited) killTree(child.pid);
      await browser.close().catch(() => {});
    },
  };
}

export const tauri = { launch };
