/** Local web app for glb-to-styk.mjs.
 *
 *   node scripts/glb-to-styk-web.mjs        then open http://localhost:4173
 *
 * Put this file and glb-to-styk-web.html next to glb-to-styk.mjs in scripts/.
 * No extra packages needed. The server only listens on this computer.
 */
import http from 'node:http';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {convert} from './glb-to-styk.mjs';
import {buildContainerV2, decodeDocument} from '../src/native-container.mjs';
import {validateScene} from '../src/pivot/model.mjs';

const PORT = Number(process.env.PORT ?? 4173);
const MAX_BODY = 400 * 1024 * 1024;
const ORIGINS = ['root', 'feet', 'center'];
const PAGE = new URL('./glb-to-styk-web.html', import.meta.url);

// convert() keeps its warnings and texture cache in module-level state,
// so run one conversion at a time.
let queue = Promise.resolve();
const serial = job => { const run = queue.then(job); queue = run.catch(() => {}); return run; };

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) { reject(new HttpError(413, 'That file is too large for the converter (400 MB limit).')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function send(res, status, payload, type = 'application/json; charset=utf-8') {
  res.writeHead(status, {'content-type': type, 'cache-control': 'no-store'});
  res.end(type.startsWith('application/json') ? JSON.stringify(payload) : payload);
}

function parseRequest(raw) {
  let body;
  try { body = JSON.parse(raw.toString('utf8')); } catch { throw new HttpError(400, 'The request could not be read.'); }
  if (typeof body.glb !== 'string' || !body.glb) throw new HttpError(400, 'No model file was sent.');
  const o = body.options ?? {};
  const height = Number(o.height ?? 240), turn = Number(o.turn ?? 0), origin = o.origin ?? 'root';
  if (!(height > 0)) throw new HttpError(400, 'Height must be a number above 0.');
  if (!Number.isFinite(turn)) throw new HttpError(400, 'Turn must be a number of degrees.');
  if (!ORIGINS.includes(origin)) throw new HttpError(400, 'Origin must be root, feet or center.');
  return {
    glb: Buffer.from(body.glb, 'base64'),
    filename: String(body.filename ?? 'model.glb'),
    rig: typeof body.rig === 'string' && body.rig.trim() ? body.rig : null,
    extra: typeof body.extra === 'string' && body.extra.trim() ? body.extra : null,
    options: {height, turn, origin, name: o.name ? String(o.name) : undefined, includeUnskinned: !!o.includeUnskinned, keepUnweighted: !!o.keepUnweighted},
  };
}

function runConversion({glb, filename, rig, extra, options}) {
  return serial(async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'glb-to-styk-'));
    try {
      const input = path.join(dir, 'model.glb');
      await writeFile(input, glb);
      const opts = {...options, name: options.name ?? path.basename(filename, path.extname(filename))};
      if (rig) { opts.rig = path.join(dir, 'rig.json'); await writeFile(opts.rig, rig); }
      if (extra) { opts.extra = path.join(dir, 'chains.json'); await writeFile(opts.extra, extra); }
      const {document, summary} = await convert(input, opts);
      const encoded = await buildContainerV2(document, 'styk');
      validateScene((await decodeDocument(encoded, 'styk')).document);
      const safe = summary.name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 120) || 'model';
      return {filename: `${safe}.styk`, bytes: encoded.byteLength, data: Buffer.from(encoded).toString('base64'), summary};
    } finally {
      await rm(dir, {recursive: true, force: true});
    }
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const {pathname} = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) return send(res, 200, await readFile(PAGE), 'text/html; charset=utf-8');
    if (req.method === 'GET' && pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
    if (req.method === 'POST' && pathname === '/api/convert') {
      try {
        const result = await runConversion(parseRequest(await readBody(req)));
        return send(res, 200, result);
      } catch (error) {
        if (!(error instanceof HttpError)) console.error(error);
        return send(res, error.status ?? 422, {error: error.message || 'Conversion failed.'});
      }
    }
    send(res, 404, {error: 'Not found.'});
  } catch (error) {
    console.error(error);
    if (!res.headersSent) send(res, 500, {error: 'Something went wrong on the server.'});
  }
});

server.on('error', error => {
  if (error.code === 'EADDRINUSE') console.error(`Port ${PORT} is already in use. Close the other program, or set the PORT environment variable to a different number.`);
  else console.error(error);
  process.exit(1);
});
server.listen(PORT, '127.0.0.1', () => console.log(`GLB to Styk is running at http://localhost:${PORT}`));
