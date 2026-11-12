// The local UI canvas: an infinite board of generated screens, driven by the `claude` CLI.
// It listens on loopback only, and refuses any request whose Host or Origin is not its own,
// so a web page cannot reach the board or spend tokens. Start it with `npm run canvas`.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyOp, USER_OPS } from './shared/board-model.mjs';
import { openStore, safeId } from './lib/board-store.mjs';
import { createRunner } from './lib/runner.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, '..', '..');
const MAX_BODY = 4 * 1024 * 1024;
const INTENTS = new Set(['create', 'variants', 'next', 'combine', 'refine', 'element', 'restyle', 'critique']);
const SOURCE_NEEDED = { variants: 1, next: 1, refine: 1, element: 1, critique: 1, restyle: 1, combine: 2 };
const PROMPT_OPTIONAL = new Set(['variants', 'critique']);

const TYPES = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ttf': 'font/ttf' };

// URL prefix to folder. The mockup kit lives in kit/; tokens, fonts and icons are served from where they
// live in the repository, so a mockup always renders with the current design system.
const STATIC = [
  ['/app/', path.join(here, 'app')],
  ['/shared/', path.join(here, 'shared')],
  ['/frame/app/', path.join(here, 'frame')],
  ['/kit/', path.join(here, 'kit')],
  ['/src/styles/base/', path.join(repository, 'src', 'styles', 'base')],
  ['/assets/fonts/', path.join(repository, 'assets', 'fonts')],
];
const FILES = { '/src/styles/tokens.css': 'src/styles/tokens.css', '/symbol.svg': 'symbol.svg', '/mark.svg': 'mark.svg' };

function resolveStatic(pathname) {
  if (FILES[pathname]) return path.join(repository, FILES[pathname]);
  if (pathname === '/') return path.join(here, 'app', 'index.html');
  for (const [prefix, folder] of STATIC) {
    if (!pathname.startsWith(prefix)) continue;
    const file = path.resolve(folder, `.${decodeURIComponent(pathname.slice(prefix.length - 1))}`);
    return file.startsWith(folder + path.sep) ? file : null;
  }
  return null;
}

const json = (response, status, body) => {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
};

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error('Too large.'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Invalid JSON.'), { status: 400 }); }
}

function validateJob(body, board) {
  const { intent } = body ?? {};
  if (!INTENTS.has(intent)) return { error: 'Unknown intent.' };
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim().slice(0, 4000) : '';
  if (!prompt && !PROMPT_OPTIONAL.has(intent)) return { error: 'Describe what you want.' };
  const ids = Array.isArray(body.frames) ? body.frames.filter(safeId) : [];
  const sources = ids.map((id) => board.frames[id]).filter((frame) => frame && !frame.deleted && frame.versions.length);
  if (sources.length < (SOURCE_NEEDED[intent] ?? 0)) return { error: 'Select a finished screen first.' };
  const size = { w: Math.min(2560, Math.max(320, Number(body.size?.w) || 1280)), h: Math.min(1600, Math.max(480, Number(body.size?.h) || 800)) };
  const element = intent === 'element' ? body.element : null;
  if (intent === 'element' && [element?.before, element?.after, element?.html].some((part) => typeof part !== 'string')) return { error: 'Pick an element first.' };
  return { job: { intent, prompt, sources, size, element, theme: body.theme === 'dark' ? 'dark' : 'light' } };
}

export async function startServer({ port = 47900, dataDirectory, command = ['claude'], open = false } = {}) {
  const directory = dataDirectory ?? path.join(repository, 'artifacts', 'ui-canvas', 'board');
  const store = await openStore(directory);
  // Calls run from an empty folder, so the CLI finds no project instructions to load.
  const cwd = path.join(directory, 'cwd');
  await mkdir(cwd, { recursive: true });
  const listeners = new Set();
  const broadcast = (event, except) => {
    const data = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of listeners) if (client !== except) client.write(data);
  };
  const runner = createRunner({ store, broadcast, command, cwd, systemPromptFile: path.join(here, 'brief', 'design-brief.md') });
  let origin = '';

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, origin);
      if (request.headers.host !== new URL(origin).host) { response.writeHead(403).end(); return; }
      if (url.pathname.startsWith('/api/')) {
        // Sandboxed screens have the origin "null", so this shuts them out too.
        const from = request.headers.origin;
        if (from !== undefined && from !== origin) { response.writeHead(403).end(); return; }
        if (request.method === 'POST' && !request.headers['content-type']?.startsWith('application/json')) { response.writeHead(415).end(); return; }
        if (request.method === 'GET' && url.pathname === '/api/board') { json(response, 200, store.board); return; }
        if (request.method === 'GET' && url.pathname === '/api/events') {
          response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
          response.write(': connected\n\n');
          listeners.add(response);
          request.on('close', () => listeners.delete(response));
          return;
        }
        const screen = /^\/api\/screen\/([a-z0-9-]+)\/(\d+)$/.exec(url.pathname);
        if (request.method === 'GET' && screen) {
          const html = await store.readScreen(screen[1], Number(screen[2]));
          if (html === null) { response.writeHead(404).end(); return; }
          response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
          response.end(html);
          return;
        }
        if (request.method === 'POST' && url.pathname === '/api/ops') {
          const { clientId, ops } = await readJson(request);
          if (!Array.isArray(ops) || ops.some((op) => !USER_OPS.has(op?.op))) { json(response, 400, { error: 'Operation not allowed.' }); return; }
          for (const op of ops) { applyOp(store.board, op); broadcast({ type: 'op', op, origin: clientId }); }
          store.touch();
          json(response, 200, { ok: true });
          return;
        }
        if (request.method === 'POST' && url.pathname === '/api/generate') {
          const { job, error } = validateJob(await readJson(request), store.board);
          if (error) { json(response, 400, { error }); return; }
          json(response, 200, { run: runner.start(job) });
          return;
        }
        if (request.method === 'POST' && url.pathname === '/api/cancel') {
          const { run } = await readJson(request);
          json(response, 200, { cancelled: runner.cancel(run) });
          return;
        }
        response.writeHead(404).end();
        return;
      }
      if (request.method !== 'GET') { response.writeHead(405).end(); return; }
      const file = resolveStatic(url.pathname);
      const info = file ? await stat(file).catch(() => null) : null;
      if (!info?.isFile()) { response.writeHead(404).end(); return; }
      const headers = { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache', 'access-control-allow-origin': '*' };
      // The page screens run in. Generated markup may style itself but cannot reach anything.
      if (url.pathname === '/frame/app/index.html') {
        headers['content-security-policy'] = `default-src 'none'; script-src ${origin}; style-src ${origin} 'unsafe-inline'; font-src ${origin}; img-src ${origin} data:`;
      }
      response.writeHead(200, headers);
      createReadStream(file).pipe(response);
    } catch (error) {
      if (!response.headersSent) json(response, error.status ?? 500, { error: error.message });
      else response.destroy();
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  const heartbeat = setInterval(() => { for (const client of listeners) client.write(': alive\n\n'); }, 25_000);
  heartbeat.unref();
  const close = async () => {
    runner.cancelAll();
    clearInterval(heartbeat);
    for (const client of listeners) client.end();
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    await store.flush();
  };
  if (open) spawn(process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open', process.platform === 'win32' ? ['/c', 'start', '', origin] : [origin], { stdio: 'ignore', detached: true, windowsHide: true }).unref();
  return { origin, close, store, sessionId: randomBytes(4).toString('hex') };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const portFlag = process.argv.indexOf('--port');
  const { origin, close } = await startServer({
    port: portFlag > 0 ? Number(process.argv[portFlag + 1]) : 47900,
    open: !process.argv.includes('--no-open'),
    command: process.env.UI_CANVAS_CLAUDE ? JSON.parse(process.env.UI_CANVAS_CLAUDE) : ['claude'],
    dataDirectory: process.env.UI_CANVAS_DATA || undefined,
  });
  console.log(`UI canvas: ${origin}`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => close().then(() => process.exit(0)));
}
