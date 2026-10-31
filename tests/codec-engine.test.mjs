import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createCodecEngine} from '../src/codec-engine.mjs';
import {loadCodecModule} from './support/codec.mjs';
import {resolvePython} from '../scripts/run-python.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = name => readFileSync(path.join(root, 'engine/crates/styk-piv/tests/fixtures', name));
const decode = bytes => new TextDecoder().decode(bytes);
const encode = text => new TextEncoder().encode(text);
const JSON_ACCEPT = {Accept: 'application/json'};
const volatile = value => Array.isArray(value) ? value.map(volatile)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'timings').map(([key, v]) => [key, volatile(v)])) : value;

function realEngine({limits = 'web'} = {}) {
  const state = {loads: 0, statuses: []};
  const engine = createCodecEngine({
    limits,
    onStatus: status => state.statuses.push(status.state),
    loadModule: async () => { state.loads++; return loadCodecModule(); },
  });
  return {engine, state};
}

test('the codec loads on first use and serves health, import, export and the retained source', async () => {
  const {engine, state} = realEngine();
  assert.deepEqual(state.statuses, [], 'nothing loads before the first request');
  const health = await engine.handle({method: 'GET', path: '/api/health'});
  assert.equal(health.status, 200);
  assert.equal(JSON.parse(decode(health.body)).host, 'browser');
  assert.deepEqual(state.statuses, ['loading', 'loading', 'ready']);

  const piv = fixture('blank.piv');
  const imported = await engine.handle({method: 'POST', path: '/api/import?filename=blank.piv', headers: JSON_ACCEPT, body: piv});
  assert.equal(imported.status, 200);
  const result = JSON.parse(decode(imported.body));
  assert.equal(result.ok, true);
  assert.equal(result.kind, 'piv');
  assert.ok(result.timings.total_ms >= 0, 'responses carry timings from the worker clock');

  const request = encode(JSON.stringify({document: result.document, format: 'piv', filename: 'blank.piv', sourceId: result.sourceId}));
  const exported = await engine.handle({method: 'POST', path: '/api/export', headers: {'Content-Type': 'application/json'}, body: request});
  assert.equal(exported.status, 200);
  assert.match(exported.headers['Content-Disposition'], /blank\.piv/);
  assert.equal(exported.headers['X-Styk-Request-Bytes'], String(request.length));
  assert.ok(Buffer.from(exported.body).equals(piv), 'an unchanged import exports the original bytes');

  const source = await engine.handle({method: 'GET', path: `/api/source?id=${result.sourceId}`});
  assert.equal(decode(source.body.subarray(0, 8)), 'STYKSRC1', 'the imported source is retained for the session');
  assert.equal(state.loads, 1, 'one module serves every request');
});

test('limits follow the profile: the desktop codec accepts larger sources than the web one', async () => {
  const health = async limits => JSON.parse(decode((await realEngine({limits}).engine.handle({method: 'GET', path: '/api/health'})).body));
  assert.equal((await health('web')).maxImportBytes, 96 * 1024 * 1024);
  const desktop = await health('desktop');
  assert.equal(desktop.maxImportBytes, 128 * 1024 * 1024);
  assert.equal(desktop.host, undefined, 'the desktop limits report no browser host');
});

test('a bad file is a JSON 422, and the codec keeps working afterwards', async () => {
  const {engine} = realEngine();
  const bad = await engine.handle({method: 'POST', path: '/api/import?filename=x.piv', body: encode('this is not a pivot file')});
  assert.equal(bad.status, 422);
  assert.equal(JSON.parse(decode(bad.body)).code, 'invalid_project');
  const health = await engine.handle({method: 'GET', path: '/api/health'});
  assert.equal(health.status, 200);
});

test('a cancelled request answers 499 without touching the cache, and the codec goes on', async () => {
  const {engine} = realEngine();
  let polls = 0;
  const piv = fixture('modern-media.piv');
  const cancelled = await engine.handle({method: 'POST', path: '/api/import?filename=media.piv', headers: JSON_ACCEPT, body: piv,
    cancel: {cancelled: () => ++polls > 1}});
  assert.equal(cancelled.status, 499);
  assert.equal(JSON.parse(decode(cancelled.body)).code, 'cancelled');
  assert.ok(polls > 1, 'the codec polled the flag while it worked');
  const imported = await engine.handle({method: 'POST', path: '/api/import?filename=media.piv', headers: JSON_ACCEPT, body: piv});
  assert.equal(imported.status, 200);
  assert.equal(JSON.parse(decode(imported.body)).timings.cache_hit, false, 'nothing of the cancelled import was cached');
});

test('responses can be transferred to the page without copying', async () => {
  const {engine} = realEngine();
  const {body} = await engine.handle({method: 'GET', path: '/api/health'});
  assert.equal(body.buffer.byteLength, body.length, 'the body owns exactly its bytes');
  const moved = structuredClone(body.buffer, {transfer: [body.buffer]});
  assert.equal(body.buffer.byteLength, 0);
  assert.ok(moved.byteLength > 0);
});

test('the WebAssembly codec and the Python oracle return the same document for the same file', {timeout: 180000}, async t => {
  const python = resolvePython();
  if (!python) return t.skip('Python 3.11+ is not installed (only the development oracle needs it)');
  const {engine} = realEngine();
  const piv = fixture('modern-media.piv');
  const inWasm = JSON.parse(decode((await engine.handle({method: 'POST', path: '/api/import?filename=media.piv', headers: JSON_ACCEPT, body: piv})).body));
  const script = `
import json, sys
sys.path[:0] = [${JSON.stringify(path.join(root, 'backend'))}]
import server, browser_service
data = sys.stdin.buffer.read()
status, headers, body = browser_service.BrowserCodec().request('POST', '/api/import?filename=media.piv', {'Accept': 'application/json'}, data)
sys.stdout.buffer.write(body)`;
  const native = spawnSync(python.command, [...python.args, '-c', script], {input: piv, encoding: 'utf8', maxBuffer: 1 << 26});
  assert.equal(native.status, 0, native.stderr);
  assert.deepEqual(volatile(inWasm), volatile(JSON.parse(native.stdout)));
});

test('a module that fails to load answers 503 and the next request tries again', async () => {
  let attempts = 0;
  const statuses = [];
  const engine = createCodecEngine({
    onStatus: status => statuses.push(status.state),
    loadModule: async () => { attempts++; throw new Error('network down'); },
  });
  const first = await engine.handle({method: 'GET', path: '/api/health'});
  assert.equal(first.status, 503);
  const body = JSON.parse(decode(first.body));
  assert.equal(body.code, 'codec_unavailable');
  assert.match(body.error, /network down/);
  await engine.handle({method: 'GET', path: '/api/health'});
  assert.equal(attempts, 2, 'a failed load is not cached');
  assert.ok(statuses.includes('failed'));
});

test('a trap is a JSON 500 and the next request runs on a fresh instance', async () => {
  let resets = 0, instance = 0;
  const statuses = [];
  const glue = {
    __wbg_reset_state() { resets++; instance++; },
    PivotCodec: class {
      constructor(limits) { this.limits = limits; this.instance = instance; }
      request() {
        if (this.instance === 0) throw Object.assign(new Error('unreachable'), {name: 'RuntimeError'});
        return {status: 200, headers: '[["Content-Type","text/plain"]]', takeBody: () => new Uint8Array([1]), free() {}};
      }
    },
  };
  const engine = createCodecEngine({loadModule: async () => glue, onStatus: status => statuses.push(status.state)});
  const crashed = await engine.handle({method: 'GET', path: '/api/health'});
  assert.equal(crashed.status, 500);
  assert.equal(JSON.parse(decode(crashed.body)).code, 'codec_error');
  assert.equal(resets, 1, 'the trapped instance is replaced');
  const recovered = await engine.handle({method: 'GET', path: '/api/health'});
  assert.equal(recovered.status, 200);
  assert.deepEqual(recovered.headers, {'Content-Type': 'text/plain'});
  assert.deepEqual(statuses, ['loading', 'loading', 'ready', 'failed', 'loading', 'loading', 'ready']);
});

test('the built module can replace its instance, and objects of the old one are refused', async () => {
  const glue = await loadCodecModule();
  const stale = new glue.PivotCodec('web');
  glue.__wbg_reset_state();
  assert.throws(() => stale.request('GET', '/api/health', '{}', new Uint8Array(0), {cancelled: () => false}), /stale/i);
  const {engine} = realEngine();
  assert.equal((await engine.handle({method: 'GET', path: '/api/health'})).status, 200);
});
