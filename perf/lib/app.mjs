/**
 * Starts the app for a profiling run and holds the runner's connections to it (docs/PERFORMANCE.md "How a run
 * reaches the app").
 *
 * A run always starts its own app: this checkout's developer launch, on scratch data and library folders that the run
 * deletes, in a window that opens off-screen without focus. It never attaches to an app a person is using and never
 * touches their settings, library or recovery files. Three connections come back:
 *   - the inspector protocol (inspector.mjs): input, profiles of every thread, tracing, the processes' CPU time;
 *   - the developer tools' control channel in the page (`request`): the app's own operations and captures;
 *   - on the desktop, the control channel's pipe (`pipe`): opening a file as the shell does, the processes' memory.
 */
import {execFile, spawn} from 'node:child_process';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {connect as connectPipe} from '../../scripts/styk-dev.mjs';
import {Inspector} from './inspector.mjs';

const require = createRequire(import.meta.url);
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** A port nothing listens on now. */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const {port} = server.address(); server.close(() => resolve(port)); });
  });
}

/** Ends a process this run started, with the processes it started, and resolves when it is gone (at most `waitMs`). */
function endProcess(child, waitMs = 5000) {
  if (child.exitCode !== null || child.signalCode) return Promise.resolve();
  const gone = new Promise(resolve => child.once('exit', resolve));
  if (process.platform === 'win32') execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], {windowsHide: true}, () => {});
  else child.kill('SIGKILL');
  return Promise.race([gone, sleep(waitMs)]);
}

/**
 * Starts the app as `environment` describes (perf/environments.mjs) and waits until the editor is ready with its
 * developer tools. `root` is the checkout to run; `bundle` the folder of a bundle to start the desktop app from, as a
 * packaged app does (null: the sources). Returns the app's handle; call `close()` when done.
 */
export async function launch(environment, {root = ROOT, bundle = null, log = () => {}} = {}) {
  const data = await mkdtemp(path.join(os.tmpdir(), 'styk-perf-'));
  // A profile that has answered the privacy question, so no prompt covers the stage; nothing is sent from a scratch profile.
  await writeFile(path.join(data, 'telemetry-state.json'), JSON.stringify({decided: true, consent: {analytics: false, diagnostics: false, policyVersion: '2026-09-10', updatedAt: Date.now()}}));
  const port = await freePort();
  const host = environment.host === 'browser' ? await launchBrowser(environment, {root, port, data}) : launchDesktop(environment, {root, port, data, bundle});
  const started = Date.now();
  let inspector = null;
  const close = async () => {
    inspector?.close();
    await host.stop();
    await rm(data, {recursive: true, force: true, maxRetries: 20, retryDelay: 250}).catch(() => {});
  };
  try {
    inspector = await Inspector.connect(port, {alive: host.alive});
    const inspectorMs = Date.now() - started;
    await host.navigate?.(inspector);
    const page = await editorPage(inspector, host.alive);
    const readyMs = Date.now() - started;
    log(`app ready in ${readyMs} ms (${environment.id})`);
    const app = new App({environment, inspector, page, host, close, timings: {inspectorMs, readyMs, startedTime: started}});
    await app.prepare();
    return app;
  } catch (error) { await close(); throw error; }
}

/** The desktop app: this checkout's Electron in a developer launch (desktop/devtools.cjs). */
function launchDesktop(environment, {root, port, data, bundle}) {
  const {ELECTRON_RUN_AS_NODE: _unset, ...inherited} = process.env;
  const env = {...inherited, STYK_USER_DATA_DIR: data, STYK_LIBRARY_DIR: path.join(data, 'library'), STYK_BACKGROUND_WINDOW: '1', STYK_STARTUP_VIEW: 'editor',
    STYK_REMOTE_DEBUGGING_PORT: String(port), STYK_DEVTOOLS_ENVIRONMENT: JSON.stringify(environment.page ?? {}), ...(bundle ? {STYK_BUNDLE_DIR: bundle} : {})};
  // `require('electron')` from Node is the path of the checkout's Electron binary.
  const child = spawn(createRequire(path.join(root, 'package.json'))('electron'), [root, '--styk-developer', ...(environment.switches ?? [])], {env, stdio: 'ignore', windowsHide: true});
  return {kind: 'desktop', pid: child.pid, alive: () => child.exitCode === null && !child.signalCode, stop: () => endProcess(child)};
}

/**
 * The web build's host: Chrome on this checkout's sources served as the desktop serves them, with the developer tools'
 * early script injected before the page's own (what the desktop's preload script does).
 */
async function launchBrowser(environment, {root, port}) {
  const {startDesktopHost} = createRequire(path.join(root, 'package.json'))('./desktop/web-host.cjs');
  const server = await startDesktopHost({appRoot: root, port: 0});
  const {chromium} = await import('../../tests/support/playwright.mjs');
  const browser = await chromium.launch({channel: 'chrome', headless: true, args: [`--remote-debugging-port=${port}`, ...(environment.switches ?? [])]});
  const early = await readFile(path.join(root, 'src', 'devtools', 'early.js'), 'utf8');
  return {
    kind: 'browser', pid: null, alive: () => browser.isConnected(),
    async navigate(inspector) {
      const {targetId} = await inspector.send('Target.createTarget', {url: 'about:blank'});
      const target = await waitFor(() => [...inspector.targets.values()].find(candidate => candidate.type === 'page' && candidate.url === 'about:blank'), 10000, `the new tab ${targetId}`);
      await inspector.send('Page.enable', {}, target.sessionId);
      await inspector.send('Emulation.setDeviceMetricsOverride', {width: 1440, height: 900, deviceScaleFactor: 1, mobile: false}, target.sessionId);
      await inspector.send('Page.addScriptToEvaluateOnNewDocument', {source: `globalThis.stykStartupView = 'editor'; globalThis.__stykDevtoolsEnvironment = ${JSON.stringify(environment.page ?? {})};\n${early}`}, target.sessionId);
      await inspector.send('Page.navigate', {url: server.origin}, target.sessionId);
    },
    async stop() { await browser.close().catch(() => {}); await server.stop(); },
  };
}

async function waitFor(test, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await test();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await sleep(50);
  }
}

/** The session id of the editor's page, once the app has finished starting and loaded its tools. */
async function editorPage(inspector, alive) {
  const ready = 'Boolean(globalThis.styk?.ready && globalThis.stykDevtools)';
  const failure = `(() => { const box = document.getElementById('renderer-error'); return box && !box.hidden ? box.textContent.trim().slice(0, 300) : ''; })()`;
  let failed = '';
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    if (!alive()) throw new Error('The app exited while it was starting.');
    for (const target of inspector.targets.values()) {
      if (target.type !== 'page') continue;
      const value = async expression => (await inspector.send('Runtime.evaluate', {expression, returnByValue: true}, target.sessionId).catch(() => null))?.result?.value;
      if (await value(ready)) return target.sessionId;
      failed = (await value(failure)) || failed;
    }
    // An app that cannot draw says so in place of the stage and never becomes ready: the run reports why.
    if (failed) throw new Error(`The app could not start its stage in this environment: ${failed}`);
    await sleep(50);
  }
  throw new Error('The editor did not become ready within two minutes.');
}

export class App {
  constructor({environment, inspector, page, host, close, timings}) {
    Object.assign(this, {environment, inspector, page, kind: host.kind, pid: host.pid, timings});
    this.host = host;
    this.pipe = null;
    this.close = async () => { this.pipe?.close(); await close(); };
    this.slowed = [];
  }

  /** After the app is ready: the pipe, the environment's processor slowdown, and a stage nothing covers. */
  async prepare() {
    if (this.kind === 'desktop') this.pipe = await connectPipe(this.pid);
    await this.inspector.send('Page.enable', {}, this.page).catch(() => {});
    const rate = this.environment.cpuSlowdown ?? 1;
    if (rate > 1) {
      // The page and every worker it has or starts later: an engine thread started by the first document is slowed too.
      const slow = target => this.inspector.send('Emulation.setCPUThrottlingRate', {rate}, target.sessionId).then(() => this.slowed.push(target.type), () => {});
      await slow({sessionId: this.page, type: 'page'});
      await Promise.all(this.inspector.workersOf(this.page).map(slow));
      this.inspector.onTarget((target, attached) => { if (attached && target.parent === this.page) void slow(target); });
    }
    // The release notes open a moment after the app is ready, over the stage.
    await sleep(600);
    await this.quiet();
  }

  /** Evaluates an expression, or calls `fn(argument)`, in the page; a promise is awaited. The value comes back as JSON. */
  async evaluate(fn, argument) {
    const expression = typeof fn === 'function' ? `(${fn})(${JSON.stringify(argument ?? null)})` : String(fn);
    const answer = await this.inspector.send('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true, userGesture: true}, this.page);
    if (answer.exceptionDetails) throw new Error(`In the page: ${answer.exceptionDetails.exception?.description ?? answer.exceptionDetails.text}`);
    return answer.result.value;
  }

  /** One operation of the developer tools' control channel (docs/DEVTOOLS.md "Control channel"); throws with the channel's own explanation. */
  async request(op, args = {}, detail) {
    const answer = await this.evaluate(request => globalThis.stykDevtools.request(request), {id: 1, op, args, ...(detail ? {detail} : {})});
    if (!answer.ok) throw new Error(`${op}: ${answer.error.what}${answer.error.cause ? ` (${answer.error.cause})` : ''}${answer.error.hint ? ` ${answer.error.hint}` : ''}`);
    return answer.result;
  }

  /** One operation only the desktop's main process answers (`open {path}`, `process.metrics`). */
  async shell(op, args = {}) {
    if (!this.pipe) throw new Error(`${op} needs the desktop app: this run is in a browser.`);
    const answer = await this.pipe.request(op, args);
    if (!answer.ok) throw new Error(`${op}: ${answer.error.what}${answer.error.cause ? ` (${answer.error.cause})` : ''}`);
    return answer.result;
  }

  /**
   * Opens the document at `file` as a person does. On the desktop the shell opens it, as it opens a file from
   * outside; in a browser the page fetches it from its own origin, where this answers the request with the file.
   * Resolves once the document is drawn, with {ms, document}.
   */
  async open(file) {
    if (this.pipe) return this.shell('open', {path: file, timeoutMs: 300000});
    if (!this.served) {
      this.served = new Map();
      await this.inspector.send('Fetch.enable', {patterns: [{urlPattern: '*/__styk_perf__/*'}]}, this.page);
      this.inspector.on('Fetch.requestPaused', (params, sessionId) => {
        const body = this.served.get(new URL(params.request.url).pathname);
        const answer = body ? {requestId: params.requestId, responseCode: 200, body, responseHeaders: [{name: 'content-type', value: 'application/octet-stream'}]} : {requestId: params.requestId, responseCode: 404};
        this.inspector.send('Fetch.fulfillRequest', answer, sessionId).catch(() => {});
      });
    }
    const name = path.basename(file), route = `/__styk_perf__/${encodeURIComponent(name)}`;
    this.served.set(route, (await readFile(file)).toString('base64'));
    try { return await this.request('open', {url: route, name}); }
    finally { this.served.delete(route); }
  }

  /** Closes whatever covers the stage (the release notes, a prompt, a menu) and waits until nothing does. */
  async quiet() {
    for (let attempt = 0; attempt < 20; attempt++) {
      const open = await this.evaluate(() => {
        document.querySelector('.styk-privacy [data-decline]')?.click();
        const dialogs = [...document.querySelectorAll('dialog[open]')];
        for (const dialog of dialogs) dialog.close();
        return dialogs.length;
      });
      if (!open) return;
      await sleep(100);
    }
    throw new Error('A dialog stays open over the stage.');
  }

  /** The app's processes: type, CPU seconds so far and, on the desktop, memory in bytes. */
  async processes() {
    if (this.pipe) return (await this.shell('process.metrics')).rows;
    const {processInfo} = await this.inspector.send('SystemInfo.getProcessInfo');
    return processInfo.map(row => ({pid: row.id, type: row.type, name: '', cpuSeconds: row.cpuTime, privateBytes: null, workingSetBytes: null}));
  }
}
