'use strict';
// The developer launch's desktop half of the developer tools (docs/DEVTOOLS.md). Never packaged: the build's file
// list leaves this file and src/devtools/ out, and main.cjs requires it only from a source checkout started with
// --styk-developer (`npm run dev`) or STYK_DEVELOPER=1.
//
// It gives the page's preload script the early script (src/devtools/early.js, run before any page script) and the name
// of the bridge the page answers through, turns on the inspector, and serves the control channel: a named pipe (a
// socket file outside Windows) that only this user reaches, one JSON request per line, answered in order.
const { readFileSync, unlinkSync } = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const MAX_REQUEST = 64 * 1024, MAX_ANSWER = 1024 * 1024, WAIT_MS = 120000;
const BRIDGE = '__stykDevtoolsBridge';
const pipePath = pid => process.platform === 'win32' ? `\\\\.\\pipe\\stykanimate-dev-${pid}` : path.join(os.tmpdir(), `stykanimate-dev-${pid}.sock`);
// Electron is asked for only by the functions that run in its main process. The others are plain functions the unit
// tests call in Node, where a checkout installed without Electron's binary (as the Tests workflow installs) cannot load it.
const electron = () => require('electron');

/** Whether this launch is a developer launch: a source checkout asked for it. A packaged app never is. */
function developerLaunch(app) {
  return !app.isPackaged && (process.argv.includes('--styk-developer') || process.env.STYK_DEVELOPER === '1');
}

/**
 * The machine a profiling run asks this launch to behave as (perf/environments.mjs sets STYK_DEVTOOLS_ENVIRONMENT):
 * live parameters' starting values, and the memory and processor count the page reports. Only these three keys pass,
 * and only as numbers, booleans and short strings; anything else is dropped, and a value that is not JSON is ignored.
 */
function profilingEnvironment(text) {
  let asked;
  try { asked = JSON.parse(text ?? 'null'); } catch { return null; }
  if (!asked || typeof asked !== 'object' || Array.isArray(asked)) return null;
  const environment = {};
  for (const key of ['deviceMemoryGiB', 'hardwareConcurrency']) if (Number.isFinite(asked[key]) && asked[key] > 0) environment[key] = asked[key];
  if (asked.parameters && typeof asked.parameters === 'object' && !Array.isArray(asked.parameters)) {
    environment.parameters = {};
    for (const [name, value] of Object.entries(asked.parameters).slice(0, 64)) {
      if (/^[\w.-]{1,64}$/.test(name) && (typeof value === 'boolean' || Number.isFinite(value) || (typeof value === 'string' && value.length <= 64))) environment.parameters[name] = value;
    }
  }
  return Object.keys(environment).length ? environment : null;
}

/**
 * Answers for the main process's save and open dialogs, given over the control channel (`dialog.answer`): a script
 * that drives the app (a profiling run, docs/PERFORMANCE.md) can neither see nor click a native dialog, and must never
 * leave one waiting on the screen of whoever is at the computer. main.cjs asks for every path through
 * `dialog.showSaveDialog` and `dialog.showOpenDialog`, so `answerDialogs` wraps those two functions of Electron's
 * `dialog` here, in the developer launch only: the packaged app neither has this file nor gains a line for it.
 *
 * An answer is one use: the next dialog of its kind takes the oldest answer queued for that kind (a path, or a
 * cancel). A dialog with no answer queued is shown as usual, unless the driver said `unanswered: 'cancel'`; then it is
 * answered as cancelled instead, so a run that lost track of a dialog fails visibly rather than waits on a window.
 * The last dialogs asked are kept, with what answered them, so the driver can check the dialog it expected came.
 * An error box (`dialog.showErrorBox`: a file that could not be opened) asks nothing but holds the main process while
 * it shows: under `unanswered: 'cancel'` it is kept in that list, with its message, and not shown.
 */
const DIALOG_KINDS = ['save', 'open'], MAX_QUEUED = 8, MAX_ASKED = 16;
function createDialogAnswers({ now = () => Date.now() } = {}) {
  const queued = { save: [], open: [] }, asked = [];
  let unanswered = 'show';
  const status = () => ({ pending: { save: queued.save.length, open: queued.open.length }, unanswered, asked: asked.map(row => ({ ...row })) });
  return {
    /** `{kind, path}` or `{kind, cancel: true}` queues an answer; `{clear: true}` drops every queued one; `{unanswered}` sets the policy. */
    answer(args = {}) {
      if (args.clear === true) { queued.save.length = 0; queued.open.length = 0; }
      if (args.unanswered !== undefined) {
        if (!['show', 'cancel'].includes(args.unanswered)) throw new Error('unanswered is "show" or "cancel".');
        unanswered = args.unanswered;
      }
      if (args.kind !== undefined) {
        if (!DIALOG_KINDS.includes(args.kind)) throw new Error('kind is "save" or "open".');
        const cancel = args.cancel === true;
        if (!cancel && !(typeof args.path === 'string' && args.path.length <= 1024 && path.isAbsolute(args.path))) throw new Error('Give an absolute path (at most 1024 characters), or cancel: true.');
        if (queued[args.kind].length >= MAX_QUEUED) throw new Error(`At most ${MAX_QUEUED} answers wait for ${args.kind} dialogs.`);
        queued[args.kind].push(cancel ? { cancel: true } : { path: path.normalize(args.path) });
      }
      return status();
    },
    /** What answers the dialog of `kind` being asked now: {path}, {cancel: true} or null (show it), recorded with the dialog's title and default path. */
    take(kind, options = {}) {
      const answer = queued[kind].shift() ?? (unanswered === 'cancel' ? { cancel: true, unanswered: true } : null);
      asked.push({ kind, title: String(options.title ?? ''), defaultPath: String(options.defaultPath ?? ''), answer: answer ? (answer.cancel ? (answer.unanswered ? 'cancelled (unanswered)' : 'cancelled') : answer.path) : 'shown', at: now() });
      if (asked.length > MAX_ASKED) asked.shift();
      return answer;
    },
    /** Records an error box; true when it is to be shown. */
    error(title, message) {
      asked.push({ kind: 'error', title: String(title ?? '').slice(0, 200), message: String(message ?? '').slice(0, 500), answer: unanswered === 'cancel' ? 'not shown' : 'shown', at: now() });
      if (asked.length > MAX_ASKED) asked.shift();
      return unanswered !== 'cancel';
    },
    status,
  };
}

/** Wraps `dialog.showSaveDialog`, `showOpenDialog` and `showErrorBox` so that `answers` decides each before a window shows. */
function answerDialogs(dialog, answers) {
  const original = { save: dialog.showSaveDialog, open: dialog.showOpenDialog, error: dialog.showErrorBox };
  // Electron takes (window, options) or (options).
  const optionsOf = args => (args.length > 1 ? args[1] : args[0]) ?? {};
  dialog.showSaveDialog = function (...args) {
    const answer = answers.take('save', optionsOf(args));
    if (!answer) return original.save.apply(this, args);
    return Promise.resolve(answer.cancel ? { canceled: true, filePath: '' } : { canceled: false, filePath: answer.path });
  };
  dialog.showOpenDialog = function (...args) {
    const answer = answers.take('open', optionsOf(args));
    if (!answer) return original.open.apply(this, args);
    return Promise.resolve(answer.cancel ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: [answer.path] });
  };
  dialog.showErrorBox = function (title, message) {
    if (answers.error(title, message)) original.error.call(this, title, message);
  };
  return () => { dialog.showSaveDialog = original.save; dialog.showOpenDialog = original.open; dialog.showErrorBox = original.error; };
}

/** The app's processes as the operating system counts them: type, CPU seconds so far, and memory in bytes. */
function processMetrics() {
  return electron().app.getAppMetrics().map(metric => ({
    pid: metric.pid, type: metric.type, name: metric.serviceName || metric.name || '',
    cpuSeconds: metric.cpu?.cumulativeCPUUsage ?? null, cpuPercent: metric.cpu?.percentCPUUsage ?? null,
    workingSetBytes: (metric.memory?.workingSetSize ?? 0) * 1024, peakWorkingSetBytes: (metric.memory?.peakWorkingSetSize ?? 0) * 1024,
    privateBytes: Number.isFinite(metric.memory?.privateBytes) ? metric.memory.privateBytes * 1024 : null,
  }));
}

/**
 * Starts the desktop half. `page()` returns the editor's webContents, or null while there is none; `openFile(path)`
 * opens a file as the app opens one from outside.
 * Returns the argument the preload script looks for and a `close` that ends the pipe.
 */
function startDevtools({ appRoot, page, openFile }) {
  const { dialog, ipcMain } = electron();
  const environment = profilingEnvironment(process.env.STYK_DEVTOOLS_ENVIRONMENT);
  // The environment is defined in the page before the early script reads it.
  const asked = environment ? `globalThis.__stykDevtoolsEnvironment = ${JSON.stringify(environment)};\n` : '';
  const early = asked + readFileSync(path.join(appRoot, 'src', 'devtools', 'early.js'), 'utf8');
  // The preload script asks once, before the page's first script: a synchronous answer keeps the early script first.
  ipcMain.on('styk:developer-early', event => { event.returnValue = { script: early, bridge: BRIDGE }; });

  const dialogs = createDialogAnswers();
  const restoreDialogs = answerDialogs(dialog, dialogs);
  const waiting = new Map();
  let nextTicket = 1, ready = false;
  const settle = (ticket, line) => {
    const pending = waiting.get(ticket);
    if (!pending) return;
    waiting.delete(ticket);
    clearTimeout(pending.timer);
    pending.resolve(line);
  };
  const failure = (id, what, hint) => JSON.stringify({ id, ok: false, error: { what, where: 'desktop control channel', input: null, cause: '', hint } });
  ipcMain.on('styk:developer-ready', () => { ready = true; });
  ipcMain.on('styk:developer-reply', (_event, ticket, answer) => {
    if (typeof answer !== 'string') return;
    let id = null;
    try { id = JSON.parse(answer).id ?? null; } catch { /* the page's answer is forwarded as it is */ }
    settle(ticket, answer.length > MAX_ANSWER ? failure(id, 'The answer is larger than 1 MiB.', 'Ask for less: a smaller limit or page, or detail "short".') : answer);
  });

  /** One request to the page, answered as a line. */
  const askPage = request => new Promise(resolve => {
    const id = Number.isInteger(request?.id) ? request.id : null;
    const contents = page();
    if (!contents || contents.isDestroyed() || !ready) return resolve(failure(id, 'The app\'s page is not ready.', 'Retry once the window has loaded.'));
    const ticket = nextTicket++;
    const timer = setTimeout(() => settle(ticket, failure(id, 'The page did not answer within 120 s.', 'Read logs; the page may be busy or stopped.')), WAIT_MS);
    waiting.set(ticket, { resolve, timer });
    contents.executeJavaScript(`globalThis.__stykDevtoolsReceive?.(${ticket}, ${JSON.stringify(request)}); undefined`, true)
      .catch(error => settle(ticket, failure(id, `The page could not take the request: ${error.message}`, 'Read logs.')));
  });
  /**
   * `open {path}`: the main process opens the file as it opens one from outside, between the page's `document.mark`
   * and `document.wait`, and the answer is the wait's.
   */
  const openPath = async request => {
    const id = Number.isInteger(request.id) ? request.id : null;
    const marked = JSON.parse(await askPage({ id, op: 'document.mark' }));
    if (!marked.ok) return JSON.stringify(marked);
    await openFile(path.resolve(request.args.path));
    return askPage({ id, op: 'document.wait', args: { token: marked.result.token, timeoutMs: request.args.timeoutMs }, detail: request.detail });
  };
  /**
   * One request line to one answer line. `process.metrics` and `dialog.answer` are the main process's own answers: the
   * page can see neither the other processes nor the native dialogs.
   */
  const ask = line => {
    let request;
    try { request = JSON.parse(line); } catch { return Promise.resolve(failure(null, 'The request is not JSON.', 'Send one JSON object per line.')); }
    const id = Number.isInteger(request?.id) ? request.id : null;
    if (request?.op === 'process.metrics') return Promise.resolve(JSON.stringify({ id, ok: true, result: { rows: processMetrics() } }));
    if (request?.op === 'dialog.answer') {
      try { return Promise.resolve(JSON.stringify({ id, ok: true, result: dialogs.answer(request.args ?? {}) })); }
      catch (error) { return Promise.resolve(failure(id, error.message, 'docs/DEVTOOLS.md lists the arguments of dialog.answer.')); }
    }
    return request?.op === 'open' && typeof request.args?.path === 'string' ? openPath(request) : askPage(request);
  };

  const file = pipePath(process.pid);
  if (process.platform !== 'win32') { try { unlinkSync(file); } catch { /* no socket left behind */ } }
  const server = net.createServer(socket => {
    socket.setEncoding('utf8');
    let buffer = '', chain = Promise.resolve();
    socket.on('error', () => {});
    socket.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > MAX_REQUEST && !buffer.includes('\n')) { socket.end(`${failure(null, 'A request line is longer than 64 KiB.', 'Send smaller requests.')}\n`); return; }
      for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        // Answers leave in the order their requests arrived.
        chain = chain.then(() => line.length > MAX_REQUEST ? failure(null, 'A request line is longer than 64 KiB.', 'Send smaller requests.') : ask(line))
          .then(answer => { if (!socket.destroyed) socket.write(`${answer}\n`); });
      }
    });
  });
  server.on('error', error => console.warn('[devtools] The control channel is not available:', error.message));
  // A Windows pipe made by Node accepts this user's local connections only; a socket file is owner-only below.
  server.listen({ path: file, readableAll: false, writableAll: false });

  return {
    preloadArgument: '--styk-developer',
    /** A new page starts without its tools: requests are refused until it announces itself again. */
    pageChanged() { ready = false; },
    close() {
      server.close();
      restoreDialogs();
      for (const ticket of [...waiting.keys()]) settle(ticket, failure(null, 'The app is closing.', ''));
      if (process.platform !== 'win32') { try { unlinkSync(file); } catch { /* already gone */ } }
    },
  };
}

module.exports = { developerLaunch, startDevtools, profilingEnvironment, createDialogAnswers, answerDialogs };
