'use strict';
// The developer launch's desktop half of the developer tools (docs/DEVTOOLS.md). Never packaged: the build's file
// list leaves this file and src/devtools/ out, and main.cjs requires it only from a source checkout started with
// --styk-developer (`npm run dev`) or STYK_DEVELOPER=1.
//
// It gives the page's preload script the early script (src/devtools/early.js, run before any page script) and the name
// of the bridge the page answers through, turns on the inspector, and serves the control channel: a named pipe (a
// socket file outside Windows) that only this user reaches, one JSON request per line, answered in order.
const { ipcMain } = require('electron');
const { readFileSync, unlinkSync } = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const MAX_REQUEST = 64 * 1024, MAX_ANSWER = 1024 * 1024, WAIT_MS = 120000;
const BRIDGE = '__stykDevtoolsBridge';
const pipePath = pid => process.platform === 'win32' ? `\\\\.\\pipe\\stykanimate-dev-${pid}` : path.join(os.tmpdir(), `stykanimate-dev-${pid}.sock`);

/** Whether this launch is a developer launch: a source checkout asked for it. A packaged app never is. */
function developerLaunch(app) {
  return !app.isPackaged && (process.argv.includes('--styk-developer') || process.env.STYK_DEVELOPER === '1');
}

/**
 * Starts the desktop half. `page()` returns the editor's webContents, or null while there is none; `openFile(path)`
 * opens a file as the app opens one from outside.
 * Returns the argument the preload script looks for and a `close` that ends the pipe.
 */
function startDevtools({ appRoot, page, openFile }) {
  const early = readFileSync(path.join(appRoot, 'src', 'devtools', 'early.js'), 'utf8');
  // The preload script asks once, before the page's first script: a synchronous answer keeps the early script first.
  ipcMain.on('styk:developer-early', event => { event.returnValue = { script: early, bridge: BRIDGE }; });

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
  /** One request line to one answer line. */
  const ask = line => {
    let request;
    try { request = JSON.parse(line); } catch { return Promise.resolve(failure(null, 'The request is not JSON.', 'Send one JSON object per line.')); }
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
      for (const ticket of [...waiting.keys()]) settle(ticket, failure(null, 'The app is closing.', ''));
      if (process.platform !== 'win32') { try { unlinkSync(file); } catch { /* already gone */ } }
    },
  };
}

module.exports = { developerLaunch, startDevtools };
