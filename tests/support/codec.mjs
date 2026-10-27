/** The app's Pivot codec in Node: the WebAssembly module the codec worker runs
 * (src/engine/pkg/styk_codec*, built by `node scripts/engine-build.mjs`), behind the
 * same engine (src/codec-engine.mjs), so tests exercise what ships.
 *
 *   const codec = nodeCodec();                          // desktop limits, its own source cache
 *   const response = await codec.fetch('/api/import?filename=a.piv', {method: 'POST', body});
 *   const {bytes, name} = await exportDocument({document, format: 'piv'});
 *   const result = await importBytes(bytes, name);      // {ok, document, sourceId, ...}
 */
import {existsSync, readFileSync} from 'node:fs';
import {createCodecEngine} from '../../src/codec-engine.mjs';
import {createCodecShell} from '../../src/codec-web-shell.mjs';

const PKG = new URL('../../src/engine/pkg/', import.meta.url);
const WASM = new URL('styk_codec_bg.wasm', PKG), GLUE = new URL('styk_codec.js', PKG);
const NO_BODY = new Set([101, 204, 205, 304]);

let glue = null;
export async function loadCodecModule() {
  if (glue) return glue;
  if (!existsSync(WASM)) throw new Error('The Pivot codec is not built: run node scripts/engine-build.mjs (src/engine/pkg/styk_codec_bg.wasm is missing).');
  const module = await import(GLUE.href);
  module.initSync({module: readFileSync(WASM)});
  return glue = module;
}

function bytesOf(body) {
  if (body == null) return new Uint8Array(0);
  if (typeof body === 'string') return new TextEncoder().encode(body);
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  throw new TypeError('The codec accepts text or binary request bodies.');
}

/** One codec with its own source cache. `fetch` answers like the HTTP codec service did. */
export function nodeCodec({limits = 'desktop'} = {}) {
  const engine = createCodecEngine({loadModule: loadCodecModule, limits});
  return {
    engine,
    async fetch(path, {method = 'GET', headers = {}, body, cancel} = {}) {
      const result = await engine.handle({method, path: String(path), headers: Object.fromEntries(new Headers(headers)), body: bytesOf(body), cancel});
      return new Response(NO_BODY.has(result.status) ? null : result.body, {status: result.status, headers: result.headers});
    },
  };
}

/** A MessagePort to `codec` through the worker's own request queue (src/codec-web-shell.mjs), for code that
 * reaches the codec as a job does: pass `port` as `codecPort` (transfer it), and close() when done. */
export function codecPort(codec = nodeCodec()) {
  const shell = createCodecShell({engine: codec.engine, post: () => {}});
  const {port1, port2} = new MessageChannel(), jobId = crypto.randomUUID().replaceAll('-', '');
  shell.handleMessage({type: 'connect', jobId, port: port2});
  return {port: port1, close() { shell.handleMessage({type: 'release', jobId}); port1.close(); }};
}

async function failed(response) {
  const text = await response.text();
  let body; try { body = JSON.parse(text); } catch { body = {error: text}; }
  return Object.assign(new Error(body.error || `The codec answered ${response.status}`), {status: response.status, code: body.code});
}

/** `store.export(request)`: the exported bytes and the file name the codec gave them. */
export async function exportDocument(request, {codec = nodeCodec()} = {}) {
  const response = await codec.fetch('/api/export', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(request)});
  if (!response.ok) throw await failed(response);
  const disposition = response.headers.get('Content-Disposition') ?? '';
  const name = decodeURIComponent(/filename\*=UTF-8''(.*)$/.exec(disposition)?.[1] ?? '');
  return {bytes: new Uint8Array(await response.arrayBuffer()), name};
}

/** `store.import_bytes(bytes, name)`: the import answer as JSON ({ok, document, sourceId, kind, version, ...}). */
export async function importBytes(bytes, name, {codec = nodeCodec()} = {}) {
  const response = await codec.fetch(`/api/import?filename=${encodeURIComponent(name)}`, {method: 'POST', headers: {Accept: 'application/json'}, body: bytes});
  if (!response.ok) throw await failed(response);
  return response.json();
}

/** Export `request` and import the result again with a fresh codec: the reopened document. */
export async function roundTrip(request) {
  const {bytes, name} = await exportDocument(request);
  return (await importBytes(bytes, name)).document;
}
