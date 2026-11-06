import test from 'node:test';
import assert from 'node:assert/strict';
import {codecRequest} from '../src/codec-request.mjs';

/** A stand-in for the codec worker: answers each request the way codec-web-worker.mjs does. */
function codec(handler) {
  const {port1, port2} = new MessageChannel();
  port2.onmessage = async ({data}) => {
    const reply = await handler(data);
    if (reply.silent) return;
    port2.postMessage({id: data.id, ...reply}, reply.body ? [reply.body] : []);
  };
  return {port: port1, close: () => { port1.close(); port2.close(); }};
}
const bytesOf = text => new TextEncoder().encode(text).buffer;
const textOf = async response => new TextDecoder().decode(await response.arrayBuffer());

test('a port request becomes a standard Response', async t => {
  const seen = [];
  const {port, close} = codec(request => { seen.push(request); return {status: 200, headers: {'Content-Type': 'application/json', 'Server-Timing': 'total;dur=1.5'}, body: bytesOf('{"ok":true}')}; });
  t.after(close);
  const response = await codecRequest({codecPort: port}, '/api/import?filename=a.piv', {method: 'POST', headers: {Accept: 'application/json', 'X-Styk-Job-Id': 'job1'}, body: bytesOf('PIVDATA')});
  assert.equal(response.ok, true);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Type'), 'application/json');
  assert.equal(response.headers.get('Server-Timing'), 'total;dur=1.5');
  assert.deepEqual(await response.json(), {ok: true});
  assert.equal(seen[0].path, '/api/import?filename=a.piv');
  assert.equal(seen[0].method, 'POST');
  assert.equal(seen[0].headers['x-styk-job-id'], 'job1', 'header names are lower-cased like an HTTP request');
  assert.equal(new TextDecoder().decode(seen[0].body), 'PIVDATA');
});

test('text bodies are encoded and binary bodies are transferred, not copied', async t => {
  const seen = [];
  const {port, close} = codec(request => { seen.push(request); return {status: 200, headers: {}, body: bytesOf('')}; });
  t.after(close);
  await codecRequest({codecPort: port}, '/api/export', {method: 'POST', body: '{"document":{"name":"héllo"}}'});
  assert.equal(new TextDecoder().decode(seen[0].body), '{"document":{"name":"héllo"}}');
  const upload = bytesOf('X'.repeat(1000));
  await codecRequest({codecPort: port}, '/api/import', {method: 'POST', body: upload});
  assert.equal(upload.byteLength, 0, 'the upload buffer is handed to the codec');
  assert.equal(seen[1].body.byteLength, 1000);
});

test('204 and other bodiless statuses do not throw', async t => {
  const {port, close} = codec(() => ({status: 204, headers: {}, body: bytesOf('')}));
  t.after(close);
  const response = await codecRequest({codecPort: port}, '/api/cancel?id=1', {method: 'POST', body: ''});
  assert.equal(response.status, 204);
  assert.equal(response.body, null);
});

test('error statuses keep their JSON body and headers', async t => {
  const {port, close} = codec(() => ({status: 422, headers: {'Content-Type': 'application/json'}, body: bytesOf('{"ok":false,"code":"invalid_project"}')}));
  t.after(close);
  const response = await codecRequest({codecPort: port}, '/api/import?filename=x.piv', {method: 'POST', body: bytesOf('bad')});
  assert.equal(response.ok, false);
  assert.equal(response.status, 422);
  assert.equal((await response.json()).code, 'invalid_project');
});

test('concurrent requests on one port are matched to their own replies', async t => {
  const {port, close} = codec(async request => {
    if (request.path.endsWith('slow')) await new Promise(resolve => setTimeout(resolve, 30));
    return {status: 200, headers: {}, body: bytesOf(request.path)};
  });
  t.after(close);
  const [slow, fast] = await Promise.all([codecRequest({codecPort: port}, '/slow'), codecRequest({codecPort: port}, '/fast')]);
  assert.equal(await textOf(slow), '/slow');
  assert.equal(await textOf(fast), '/fast');
});

test('aborting rejects immediately and ignores the late reply', async t => {
  const received = Promise.withResolvers(), reply = Promise.withResolvers();
  const {port, close} = codec(request => {
    if (request.path === '/after') return {status: 200, headers: {}, body: bytesOf('next')};
    received.resolve();
    return reply.promise;
  });
  t.after(close);
  const controller = new AbortController();
  const pending = codecRequest({codecPort: port}, '/api/import', {method: 'POST', body: bytesOf('x'), signal: controller.signal});
  await received.promise;
  controller.abort();
  await assert.rejects(pending, {name: 'AbortError'});
  reply.resolve({status: 200, headers: {}, body: bytesOf('late')});
  assert.equal(await textOf(await codecRequest({codecPort: port}, '/after')), 'next');
  await assert.rejects(codecRequest({codecPort: port}, '/x', {signal: AbortSignal.abort()}), {name: 'AbortError'});
});

test('a worker-level failure rejects like a network error', async t => {
  const {port, close} = codec(() => ({error: 'The codec stopped.'}));
  t.after(close);
  await assert.rejects(codecRequest({codecPort: port}, '/x'), {name: 'TypeError', message: 'The codec stopped.'});
});

test('unsupported body types are rejected before anything is sent', async t => {
  const {port, close} = codec(() => { throw new Error('must not be reached'); });
  t.after(close);
  await assert.rejects(() => codecRequest({codecPort: port}, '/x', {method: 'POST', body: new Blob(['x'])}), TypeError);
});

test('without a port the request fails like a network error and nothing goes over HTTP', async () => {
  const original = globalThis.fetch;
  let fetched = false;
  globalThis.fetch = async () => { fetched = true; return new Response('ok'); };
  try {
    await assert.rejects(codecRequest({baseURL: 'http://127.0.0.1:47831'}, '/api/export', {method: 'POST', body: 'x'}),
      {name: 'TypeError', message: 'The Pivot codec is not connected.'});
    assert.equal(fetched, false);
  } finally { globalThis.fetch = original; }
});
