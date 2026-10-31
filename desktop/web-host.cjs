'use strict';
const { messageError } = require('./localization.cjs');


const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs/promises');

const MIME = new Map(Object.entries({'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8',
  '.js':'text/javascript','.mjs':'text/javascript','.json':'application/json','.svg':'image/svg+xml',
  '.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.ico':'image/x-icon',
  '.woff':'font/woff','.woff2':'font/woff2','.ttf':'font/ttf','.wasm':'application/wasm'}));
const LOOPBACK = new Set(['localhost','127.0.0.1','[::1]']);
/** The desktop window's own origin: a privileged scheme the main process answers itself (no sockets, no
 * connection limit). It is the same on every launch, so Chromium's code cache for the app's modules
 * survives a restart. */
const APP_SCHEME = 'styk-app', APP_HOST = 'app', APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
function error(status, code, key, params) { return Object.assign(messageError(new Error(''), key, params), {status,code}); }
function inside(root, target) { const relative = path.relative(root,target); return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`); }
/** The answer to a request that failed: the status and the JSON body. */
function failure(cause) {
  const known = cause instanceof URIError ? error(400,'invalid_path',"desktop.webHost.errors.invalidPath") : cause;
  const visible = known.status ? known : messageError(new Error(''), 'desktop.webHost.errors.resourceUnreadable');
  const data = Buffer.from(JSON.stringify({ok:false,code:known.code || 'file_error',
    error:visible.message, messageKey:visible.messageKey, messageParams:visible.messageParams}));
  return {status:known.status || 500, data, headers:{'Content-Type':'application/json','Content-Length':String(data.length),
    'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}};
}
function reject(response, cause) {
  if (response.destroyed) return;
  if (response.headersSent) { response.destroy(); return; }
  const answer = failure(cause);
  response.writeHead(answer.status, {...answer.headers,'Connection':'close'});
  response.end(answer.data);
}

/** The web assets, read-only: packaged, resources/web; from source, the app folder (also `tests` and
 * `artifacts`, for the browser tests and `npm run serve`). Returns `asset(pathname, {method, ifNoneMatch})`,
 * which answers `{status, headers, body}` (a Buffer, or null for HEAD and 304) or throws the failure. */
async function openAssets({appRoot, resourcesPath, packaged=false}={}) {
  const root = await fs.realpath(packaged ? path.join(resourcesPath,'web') : appRoot);
  return async function asset(pathname, {method='GET', ifNoneMatch=''}={}) {
    let relative;
    try { relative = decodeURIComponent(pathname).slice(1) || 'index.html'; }
    catch { throw error(400,'invalid_path',"desktop.webHost.errors.invalidPath"); }
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
      const tags = String(ifNoneMatch || '').split(',').map(tag=>tag.trim().replace(/^W\//,''));
      const unchanged = tags.includes('*') || tags.includes(etag);
      return {status:unchanged ? 304 : 200,
        headers:{'Content-Type':type,'Content-Length':String(stat.size),
          'ETag':etag,'Cache-Control':'no-cache','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',
          // The engine's worker threads share one WebAssembly memory, and cancelling a Pivot import flags the codec
          // through shared memory: the page must be cross-origin isolated.
          'Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp','Cross-Origin-Resource-Policy':'same-origin'},
        body:unchanged || method==='HEAD' ? null : await file.readFile()};
    } finally { await file.close(); }
  };
}

/** Declares the app scheme to Chromium. Call it before the `ready` event. `standard` and `secure` give the page
 * a real origin and a secure context (cross-origin isolation needs both); `codeCache` keeps V8's compiled
 * modules between launches. */
function registerAppScheme(protocol) {
  protocol.registerSchemesAsPrivileged([{scheme:APP_SCHEME,
    privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true,stream:true,codeCache:true}}]);
}

/** Answers the app scheme from the web assets (see `openAssets`). Nothing else is reachable through it: only GET
 * and HEAD, only the host `app`, and `owns(url)` is how the main process recognises the editor page. */
async function handleAppProtocol({protocol, appRoot, resourcesPath, packaged=false}={}) {
  const asset = await openAssets({appRoot,resourcesPath,packaged});
  protocol.handle(APP_SCHEME, async request => {
    try {
      const url = new URL(request.url);
      if (url.host !== APP_HOST) throw error(403,'host_forbidden',"desktop.webHost.errors.hostForbidden");
      if (!['GET','HEAD'].includes(request.method)) throw error(405,'method_not_allowed',"desktop.webHost.errors.resourcesReadOnly");
      const answer = await asset(url.pathname,{method:request.method,ifNoneMatch:request.headers.get('if-none-match')});
      return new Response(answer.body,{status:answer.status,headers:answer.headers});
    } catch (cause) {
      const answer = failure(cause);
      return new Response(answer.data,{status:answer.status,headers:answer.headers});
    }
  });
  return {origin:APP_ORIGIN,
    owns(url) { try { const parsed = new URL(url); return parsed.protocol===`${APP_SCHEME}:` && parsed.host===APP_HOST; } catch { return false; } }};
}

/** A loopback HTTP origin for the same assets, for what is not the desktop window: `npm run serve`, the
 * browser tests and the scripts that drive them. It reads and converts no projects: the Pivot codec runs in
 * the page (src/codec-web-worker.mjs). `port` 0 picks a free one. */
async function startDesktopHost({appRoot, resourcesPath, packaged=false, port=0}={}) {
  const asset = await openAssets({appRoot,resourcesPath,packaged});
  let closing;

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
      const answer = await asset(url.pathname,{method:request.method,ifNoneMatch:request.headers['if-none-match']});
      response.writeHead(answer.status,answer.headers);
      response.end(answer.body);
    })().catch(cause=>reject(response,cause));
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {origin,port:server.address().port,
    stop(){
      if (closing) return closing;
      closing=new Promise(resolve=>server.close(resolve));server.closeAllConnections();return closing;
    }};
}

module.exports = {startDesktopHost,registerAppScheme,handleAppProtocol,APP_ORIGIN};
