/**
 * Serves the repository with the headers a cross-origin isolated page needs, for the
 * engine viewer (engine/viewer/) and its benchmarks. Read-only, loopback only.
 *
 *   node scripts/engine-serve.mjs [--port 47860] [--files <dir>]…
 *
 * `--files <dir>` adds a folder whose files are served under /files/<name> (the
 * benchmark corpus lives outside the repository).
 */
import {createServer} from 'node:http';
import {createReadStream, statSync, existsSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const TYPES = {'.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ttf': 'font/ttf'};

export function startEngineServer({port = 47860, files = []} = {}) {
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    let target = null;
    const name = decodeURIComponent(url.pathname);
    if (name.startsWith('/files/')) {
      const base = path.basename(name);
      target = files.map(folder => path.join(folder, base)).find(existsSync) ?? null;
    } else {
      const resolved = path.resolve(root, '.' + path.posix.normalize(name));
      if (resolved === root || resolved.startsWith(root + path.sep)) target = resolved;
    }
    if (target && existsSync(target) && statSync(target).isDirectory()) target = path.join(target, 'index.html');
    if (request.method !== 'GET' || !target || !existsSync(target)) { response.writeHead(404).end('Not found'); return; }
    response.writeHead(200, {
      'Content-Type': TYPES[path.extname(target)] ?? 'application/octet-stream',
      'Content-Length': statSync(target).size,
      'Cache-Control': 'no-store',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'same-origin',
    });
    createReadStream(target).pipe(response);
  });
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve({origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(done => server.close(done))})));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), files = [];
  let port = 47860;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port') port = Number(args[++i]);
    else if (args[i] === '--files') files.push(path.resolve(args[++i]));
  }
  const {origin} = await startEngineServer({port, files});
  console.log(`Engine viewer: ${origin}/engine/viewer/`);
}
