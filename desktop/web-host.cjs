'use strict';
const { messageError } = require('./localization.cjs');


const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs/promises');
const {pipeline} = require('node:stream/promises');

const MIME = new Map(Object.entries({'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8',
  '.js':'text/javascript','.mjs':'text/javascript','.json':'application/json','.svg':'image/svg+xml',
  '.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.ico':'image/x-icon',
  '.woff':'font/woff','.woff2':'font/woff2','.ttf':'font/ttf','.wasm':'application/wasm'}));
const LOOPBACK = new Set(['localhost','127.0.0.1','[::1]']);
function error(status, code, key, params) { return Object.assign(messageError(new Error(''), key, params), {status,code}); }
function inside(root, target) { const relative = path.relative(root,target); return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`); }
function reject(response, failure) {
  if (response.destroyed) return;
  if (response.headersSent) { response.destroy(); return; }
  const visible = failure.status ? failure : messageError(new Error(''), 'desktop.webHost.errors.resourceUnreadable');
  const data = Buffer.from(JSON.stringify({ok:false,code:failure.code || 'file_error',
    error:visible.message, messageKey:visible.messageKey, messageParams:visible.messageParams}));
  response.writeHead(failure.status || 500, {'Content-Type':'application/json','Content-Length':data.length,
    'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Connection':'close'});
  response.end(data);
}

/** The editor's loopback origin: the web assets, read-only, for this machine only.
 * Packaged, it serves resources/web; from source, the app folder (also `tests` and
 * `artifacts`, for the browser tests and `npm run serve`). It reads and converts no
 * projects: the Pivot codec runs in the page (src/codec-web-worker.mjs). `port` 0
 * picks a free one. */
async function startDesktopHost({appRoot, resourcesPath, packaged=false, port=0}={}) {
  const root = await fs.realpath(packaged ? path.join(resourcesPath,'web') : appRoot);
  let closing;

  async function serveStatic(request,response,pathname) {
    const relative = decodeURIComponent(pathname).slice(1) || 'index.html';
    const parts = relative.split('/');
    if (relative.includes('\\') || relative.includes(':') || parts.some(part=>part.startsWith('.')) ||
        (parts.length > 1 && !['src','vendor','assets',...(!packaged?['tests','artifacts']:[])].includes(parts[0])) ||
        (parts.length === 1 && !['.html','.css','.svg','.png','.ico'].includes(path.extname(relative).toLowerCase())))
      throw error(403,'resource_forbidden',"desktop.webHost.errors.resourceForbidden");
    const type = MIME.get(path.extname(relative).toLowerCase());
    if (!type) throw error(403,'resource_forbidden',"desktop.webHost.errors.resourceForbidden");
    let target;
    try { target = await fs.realpath(path.join(root,relative)); }
    catch (cause) { if (cause.code==='ENOENT') throw error(404,'file_not_found',"desktop.webHost.errors.fileNotFound"); throw cause; }
    if (!inside(root,target)) throw error(403,'path_forbidden',"desktop.webHost.errors.pathForbidden");
    const file = await fs.open(target,'r');
    try {
      const stat = await file.stat({bigint:true});
      if (!stat.isFile()) throw error(404,'file_not_found',"desktop.webHost.errors.fileNotFound");
      const etag = `"${stat.mtimeNs.toString(16)}-${stat.size.toString(16)}"`;
      const tags = String(request.headers['if-none-match'] || '').split(',').map(tag=>tag.trim().replace(/^W\//,''));
      const unchanged = tags.includes('*') || tags.includes(etag);
      response.writeHead(unchanged ? 304 : 200, {'Content-Type':type,'Content-Length':String(stat.size),
        'ETag':etag,'Cache-Control':'no-cache','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',
        // The engine's worker threads share one WebAssembly memory, and cancelling a Pivot import flags the codec
        // through shared memory: the page must be cross-origin isolated.
        'Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp','Cross-Origin-Resource-Policy':'same-origin'});
      if (unchanged || request.method==='HEAD') response.end();
      else await pipeline(file.createReadStream({autoClose:false}),response);
    } finally { await file.close(); }
  }

  const server = http.createServer((request,response) => {
    void (async()=>{
      let host; try { host = new URL(`http://${request.headers.host || ''}`); }
      catch { throw error(403,'host_forbidden',"desktop.webHost.errors.hostForbidden"); }
      if (!LOOPBACK.has(host.hostname) || host.port !== String(server.address().port))
        throw error(403,'host_forbidden',"desktop.webHost.errors.hostForbidden");
      if (request.headers.origin) {
        let origin; try { origin = new URL(request.headers.origin); } catch { /* Invalid and null origins are rejected. */ }
        if (!origin || origin.protocol!=='http:' || !LOOPBACK.has(origin.hostname))
          throw error(403,'origin_forbidden',"desktop.webHost.errors.originForbidden");
      }
      if (!request.url.startsWith('/') || request.url.startsWith('//')) throw error(400,'invalid_request',"desktop.webHost.errors.invalidRequest");
      const url = new URL(request.url,`http://${request.headers.host}`);
      if (!['GET','HEAD'].includes(request.method)) throw error(405,'method_not_allowed',"desktop.webHost.errors.resourcesReadOnly");
      await serveStatic(request,response,url.pathname);
    })().catch(cause=>reject(response,cause instanceof URIError ? error(400,'invalid_path',"desktop.webHost.errors.invalidPath") : cause));
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {origin,port:server.address().port,
    stop(){
      if (closing) return closing;
      closing=new Promise(resolve=>server.close(resolve));server.closeAllConnections();return closing;
    }};
}

module.exports = {startDesktopHost};
