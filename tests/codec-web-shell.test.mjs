import test, {afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {createCodecShell} from '../src/codec-web-shell.mjs';

// No fixed sleeps: every wait is for a condition, so the tests hold on a loaded machine.
async function until(condition, what) {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}
const ok = text => ({status: 200, headers: {'Content-Type': 'text/plain'}, body: new TextEncoder().encode(text)});
const textOf = buffer => new TextDecoder().decode(buffer);

/** An engine whose requests finish only when the test says so. */
function controlledEngine() {
  const calls = [], gates = [];
  return {
    calls,
    engine: {handle: request => new Promise(resolve => { calls.push(request.path); gates.push(() => resolve(ok('done ' + request.path))); })},
    finish: index => gates[index](),
  };
}

// Open ports keep Node alive, so every channel a test makes is closed after it.
const channels = [];
afterEach(() => { for (const channel of channels.splice(0)) { channel.port1.close(); channel.port2.close(); } });

function job(shell, jobId, cancel) {
  const channel = new MessageChannel(), replies = [];
  channels.push(channel);
  shell.handleMessage({type: 'connect', jobId, port: channel.port2, ...(cancel ? {cancel} : {})});
  channel.port1.onmessage = ({data}) => replies.push(data);
  return {replies, send: (id, path) => channel.port1.postMessage({id, method: 'GET', path, headers: {}, body: new Uint8Array(0)}),
    reply: id => replies.find(item => item.id === id)};
}

test('requests from different jobs run one at a time, in arrival order', async () => {
  const posted = [], control = controlledEngine();
  const shell = createCodecShell({engine: control.engine, post: message => posted.push(message)});
  const a = job(shell, 'a'), b = job(shell, 'b');
  a.send(1, '/first'); b.send(1, '/second');
  await until(() => control.calls.length === 1, 'the first request to start');
  assert.equal(shell.state().queued, 1, 'the second request waits behind the first');
  control.finish(0);
  await until(() => control.calls.length === 2, 'the second request to start');
  control.finish(1);
  await until(() => a.reply(1) && b.reply(1), 'both replies');
  assert.equal(textOf(a.reply(1).body), 'done /first');
  assert.equal(textOf(b.reply(1).body), 'done /second');
  assert.deepEqual(control.calls, ['/first', '/second']);
  assert.deepEqual(posted.map(m => m.type + (m.jobId ? ':' + m.jobId : '')), ['busy:a', 'idle', 'busy:b', 'idle']);
});

test('a skipped job is answered 499 without reaching the interpreter, and others still run', async () => {
  const control = controlledEngine();
  const shell = createCodecShell({engine: control.engine, post: () => {}});
  const running = job(shell, 'running'), doomed = job(shell, 'doomed'), later = job(shell, 'later');
  running.send(1, '/running');
  await until(() => control.calls.length === 1, 'the running request to start');
  doomed.send(1, '/doomed'); later.send(1, '/later');
  await until(() => shell.state().queued === 2, 'both requests to queue');
  shell.handleMessage({type: 'skip', jobId: 'doomed'});
  control.finish(0);
  await until(() => control.calls.length === 2, 'the next request to start');
  assert.deepEqual(control.calls, ['/running', '/later'], 'the cancelled request never ran');
  control.finish(1);
  await until(() => doomed.reply(1) && later.reply(1), 'both replies');
  assert.equal(doomed.reply(1).status, 499);
  assert.equal(JSON.parse(textOf(doomed.reply(1).body)).code, 'cancelled');
  assert.equal(textOf(later.reply(1).body), 'done /later');
});

test('releasing a job right after skipping it still skips what was already queued', async () => {
  const control = controlledEngine();
  const shell = createCodecShell({engine: control.engine, post: () => {}});
  const running = job(shell, 'running'), doomed = job(shell, 'doomed'), sentinel = job(shell, 'sentinel');
  running.send(1, '/running');
  await until(() => control.calls.length === 1, 'the running request to start');
  doomed.send(1, '/doomed'); sentinel.send(1, '/sentinel');
  await until(() => shell.state().queued === 2, 'both requests to queue');
  // Exactly what the page sends on cancel: skip, then release.
  shell.handleMessage({type: 'skip', jobId: 'doomed'});
  shell.handleMessage({type: 'release', jobId: 'doomed'});
  control.finish(0);
  // The sentinel queued after the doomed request: once it starts, the doomed one has been passed over.
  await until(() => control.calls.length === 2, 'the sentinel to start');
  assert.deepEqual(control.calls, ['/running', '/sentinel'], 'release must not un-skip the queued request');
  control.finish(1);
  await until(() => shell.state().running === false, 'the queue to drain');
  assert.deepEqual(shell.state(), {jobs: 2, skipped: 0, queued: 0, running: false}, 'the doomed job left nothing behind');
});

test('releasing a finished job drops its port and its bookkeeping', async () => {
  const control = controlledEngine();
  const shell = createCodecShell({engine: control.engine, post: () => {}});
  const a = job(shell, 'a');
  a.send(1, '/x');
  await until(() => control.calls.length === 1, 'the request to start');
  control.finish(0);
  await until(() => a.reply(1), 'its reply');
  assert.equal(shell.state().jobs, 1);
  shell.handleMessage({type: 'release', jobId: 'a'});
  assert.deepEqual(shell.state(), {jobs: 0, skipped: 0, queued: 0, running: false});
  // A released job cannot make requests: prove it with a request from a live job queued afterwards.
  a.send(2, '/after-release');
  const live = job(shell, 'live');
  live.send(1, '/live');
  await until(() => control.calls.length === 2, 'the live request to start');
  assert.deepEqual(control.calls, ['/x', '/live']);
  control.finish(1);
  await until(() => live.reply(1), 'the live reply');
});

test('one job may keep several requests in flight over its port', async () => {
  const control = controlledEngine();
  const shell = createCodecShell({engine: control.engine, post: () => {}});
  const a = job(shell, 'a');
  a.send(1, '/one'); a.send(2, '/two');
  await until(() => control.calls.length === 1, 'the first request to start');
  control.finish(0);
  await until(() => control.calls.length === 2, 'the second request to start');
  control.finish(1);
  await until(() => a.replies.length === 2, 'both replies');
  assert.deepEqual(a.replies.map(reply => [reply.id, textOf(reply.body)]), [[1, 'done /one'], [2, 'done /two']]);
});

test('unknown messages are ignored', () => {
  const shell = createCodecShell({engine: {handle: async () => ok('')}, post: () => {}});
  shell.handleMessage(null); shell.handleMessage({type: 'nonsense'}); shell.handleMessage(undefined);
  assert.deepEqual(shell.state(), {jobs: 0, skipped: 0, queued: 0, running: false});
});

/** An engine that works until the request's cancel probe says stop, polling it as the codec does at its checkpoints. */
function pollingEngine() {
  const calls = [];
  return {calls, engine: {handle: request => new Promise(resolve => {
    calls.push(request.path);
    const poll = () => request.cancel.cancelled()
      ? resolve({status: 499, headers: {}, body: new TextEncoder().encode('{"code":"cancelled"}')})
      : setTimeout(poll, 1);
    poll();
  })}};
}

test('a shared cancellation flag stops the running request; the worker serves the next job', async () => {
  const control = pollingEngine(), flag = new Int32Array(new SharedArrayBuffer(4));
  const shell = createCodecShell({engine: control.engine, post: () => {}});
  const running = job(shell, 'running', flag);
  running.send(1, '/running');
  await until(() => control.calls.length === 1, 'the request to start');
  Atomics.store(flag, 0, 1);
  await until(() => running.reply(1), 'the cancelled reply');
  assert.equal(running.reply(1).status, 499, 'no skip message was needed');
  const nextFlag = new Int32Array(new SharedArrayBuffer(4)), next = job(shell, 'next', nextFlag);
  next.send(1, '/next');
  await until(() => control.calls.length === 2, 'the next job to start');
  assert.deepEqual(control.calls, ['/running', '/next']);
  assert.equal(next.reply(1), undefined, 'the next job runs on: its own flag is clear');
  Atomics.store(nextFlag, 0, 1);
  await until(() => next.reply(1), 'the next reply');
});

test('a flagged job\'s queued requests are answered 499 without reaching the codec', async () => {
  const control = controlledEngine(), flag = new Int32Array(new SharedArrayBuffer(4));
  const shell = createCodecShell({engine: control.engine, post: () => {}});
  const running = job(shell, 'running'), doomed = job(shell, 'doomed', flag), later = job(shell, 'later');
  running.send(1, '/running');
  await until(() => control.calls.length === 1, 'the running request to start');
  doomed.send(1, '/doomed'); later.send(1, '/later');
  await until(() => shell.state().queued === 2, 'both requests to queue');
  Atomics.store(flag, 0, 1);
  control.finish(0);
  await until(() => control.calls.length === 2, 'the next request to start');
  assert.deepEqual(control.calls, ['/running', '/later']);
  control.finish(1);
  await until(() => doomed.reply(1) && later.reply(1), 'both replies');
  assert.equal(doomed.reply(1).status, 499);
  assert.equal(JSON.parse(textOf(doomed.reply(1).body)).code, 'cancelled');
});

test('a flag that is not an Int32Array is ignored, never trusted', async () => {
  const control = controlledEngine();
  const shell = createCodecShell({engine: control.engine, post: () => {}});
  const a = job(shell, 'a', {0: 1});
  a.send(1, '/x');
  await until(() => control.calls.length === 1, 'the request to run');
  control.finish(0);
  await until(() => a.reply(1), 'its reply');
  assert.equal(a.reply(1).status, 200);
});
