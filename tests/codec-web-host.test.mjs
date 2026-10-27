import test from 'node:test';
import assert from 'node:assert/strict';
import {BrowserCodecHost as Host, codecProfile} from '../src/codec-web-host.mjs';
import {codecJob} from '../src/codec-job.mjs';

/** A Worker stand-in: records what the page posts and lets the test speak as the worker. */
class FakeWorker extends EventTarget {
  posted = [];
  terminated = false;
  postMessage(message, transfer = []) { this.posted.push({message, transfer}); }
  terminate() { this.terminated = true; }
  say(data) { this.dispatchEvent(Object.assign(new Event('message'), {data})); }
  fail(message) { this.dispatchEvent(Object.assign(new Event('error', {cancelable: true}), {message})); }
}
function fixture(options = {}) {
  const workers = [];
  const host = new Host({createWorker: () => { const worker = new FakeWorker(); workers.push(worker); return worker; }, ...options});
  return {host, workers, types: worker => worker.posted.map(item => item.message.type)};
}

test('the worker is created lazily and one port per job is connected to it', () => {
  const {host, workers} = fixture();
  host.register('a');
  assert.equal(workers.length, 0, 'registering a job does not create the codec worker');
  const link = host.link('a');
  assert.equal(workers.length, 1);
  assert.ok(link.fields.codecPort instanceof MessagePort);
  assert.deepEqual(link.transfer, [link.fields.codecPort]);
  assert.deepEqual(workers[0].posted[0].message, {type: 'configure', limits: 'desktop'}, 'the worker learns its limits first');
  const connect = workers[0].posted[1];
  assert.equal(connect.message.type, 'connect');
  assert.equal(connect.message.cancel, undefined, 'no shared flag without cross-origin isolation');
  assert.equal(connect.message.jobId, 'a');
  assert.deepEqual(connect.transfer, [connect.message.port]);
  host.link('a');
  assert.equal(workers.length, 1, 'one worker serves every job');
});

test('releasing a finished job tells the worker to close its ports', () => {
  const {host, workers, types} = fixture();
  host.register('a'); host.link('a'); host.release('a');
  assert.deepEqual(types(workers[0]), ['configure', 'connect', 'release']);
  host.release('a');
  assert.deepEqual(types(workers[0]), ['configure', 'connect', 'release'], 'releasing twice is harmless');
});

test('cancelling the only running job stops the worker; the next job starts a fresh one', () => {
  const {host, workers} = fixture();
  host.register('a'); host.link('a');
  workers[0].say({type: 'busy', jobId: 'a'});
  host.cancel('a');
  assert.equal(workers[0].terminated, true);
  host.register('b');
  host.link('b');
  assert.equal(workers.length, 2, 'the interpreter restarts on demand');
});

test('cancelling while another job is waiting skips instead of discarding its request', () => {
  const {host, workers, types} = fixture();
  host.register('running'); host.register('waiting');
  host.link('running'); host.link('waiting');
  workers[0].say({type: 'busy', jobId: 'running'});
  host.cancel('running');
  assert.equal(workers[0].terminated, false, "the waiting job's request must survive");
  assert.ok(types(workers[0]).includes('skip'));
});

test('cancelling a queued job skips and releases that job and touches no other', () => {
  const {host, workers} = fixture();
  host.register('running'); host.register('queued');
  host.link('running'); host.link('queued');
  workers[0].say({type: 'busy', jobId: 'running'});
  host.cancel('queued');
  assert.equal(workers[0].terminated, false, 'the running job is unaffected');
  const aimedAtQueued = type => workers[0].posted.filter(item => item.message.type === type).map(item => item.message.jobId);
  assert.deepEqual(aimedAtQueued('skip'), ['queued']);
  assert.deepEqual(aimedAtQueued('release'), ['queued']);
});

test('cancelling also releases the job, so its port and skip entry do not accumulate', () => {
  const {host, workers, types} = fixture();
  host.register('running'); host.register('other');
  host.link('running'); host.link('other');
  workers[0].say({type: 'busy', jobId: 'running'});
  host.cancel('other');
  assert.deepEqual(types(workers[0]).slice(-2), ['skip', 'release'], 'skip first so queued requests are answered, then release');
});

test('a cancelled or unknown job cannot connect', () => {
  const {host, workers} = fixture();
  host.register('a'); host.cancel('a');
  assert.throws(() => host.link('a'), {name: 'AbortError'});
  assert.throws(() => host.link('never-registered'), {name: 'AbortError'});
  assert.equal(workers.length, 0);
});

test('cancelling after the work went idle does not stop a healthy worker', () => {
  const {host, workers} = fixture();
  host.register('a'); host.link('a');
  workers[0].say({type: 'busy', jobId: 'a'});
  workers[0].say({type: 'idle'});
  host.cancel('a');
  assert.equal(workers[0].terminated, false);
});

test('status reaches subscribers and a crashed worker is replaced on the next job', () => {
  const {host, workers} = fixture();
  const seen = [];
  const stop = host.subscribe(status => seen.push(status.state));
  host.register('a'); host.link('a');
  workers[0].say({type: 'status', state: 'loading', stage: 'runtime'});
  workers[0].say({type: 'status', state: 'ready'});
  workers[0].fail('out of memory');
  assert.equal(workers[0].terminated, true);
  assert.deepEqual(seen, ['loading', 'ready', 'failed', 'stopped']);
  stop();
  host.register('b'); host.link('b');
  assert.equal(workers.length, 2);
});

test('messages from a replaced worker are ignored', () => {
  const {host, workers} = fixture();
  host.register('a'); host.link('a');
  workers[0].fail('boom');
  host.register('b'); host.link('b');
  workers[1].say({type: 'busy', jobId: 'b'});
  workers[0].say({type: 'idle'});
  host.cancel('b');
  assert.equal(workers[1].terminated, true, 'the stale idle message did not clear the busy job');
});

test('codecProfile: the desktop app and plain pages use the desktop limits, the web build and ?codec=browser the web ones', () => {
  const page = (search, meta) => ({location: {search}, document: {querySelector: () => (meta ? {content: meta} : null)}});
  assert.equal(codecProfile({stykDesktop: {}, ...page('?codec=browser')}), 'desktop', 'the desktop app is always the desktop');
  assert.equal(codecProfile(page('', null)), 'desktop');
  assert.equal(codecProfile(page('', 'browser')), 'web');
  assert.equal(codecProfile(page('?codec=browser', null)), 'web');
  assert.equal(codecProfile(page('?codec=http', 'browser')), 'desktop', 'the URL overrides the page');
  assert.equal(codecProfile(page('', 'nonsense')), 'desktop');
  assert.equal(codecProfile({}), 'desktop');
});

test('the worker is told the limits of its profile', () => {
  const {host, workers} = fixture({limits: 'web'});
  host.register('a'); host.link('a');
  assert.deepEqual(workers[0].posted[0].message, {type: 'configure', limits: 'web'});
});

test('a job talks to the host, never to the network', () => {
  const {host, workers} = fixture();
  const original = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('the codec must not use fetch'); };
  try {
    const job = codecJob({host});
    assert.ok(job.link().fields.codecPort instanceof MessagePort);
    workers[0].say({type: 'busy', jobId: job.id});
    job.cancel();
    assert.equal(workers[0].terminated, true);
    const done = codecJob({host});
    done.finish(); done.cancel();
  } finally { globalThis.fetch = original; }
});

test('with shared memory a job carries one flag, and cancelling sets it instead of stopping the worker', () => {
  const {host, workers} = fixture({sharedCancel: true});
  host.register('a');
  host.link('a'); host.link('a');
  const connects = workers[0].posted.filter(item => item.message.type === 'connect').map(item => item.message);
  assert.ok(connects[0].cancel instanceof Int32Array && connects[0].cancel.buffer instanceof SharedArrayBuffer);
  assert.equal(connects[1].cancel, connects[0].cancel, 'every port of a job shares its flag');
  assert.equal(Atomics.load(connects[0].cancel, 0), 0);
  workers[0].say({type: 'busy', jobId: 'a'});
  host.cancel('a');
  assert.equal(Atomics.load(connects[0].cancel, 0), 1, 'the running request sees the cancellation at once');
  assert.equal(workers[0].terminated, false, 'the worker and its imported-source cache survive');
  assert.deepEqual(workers[0].posted.slice(-2).map(item => item.message.type), ['skip', 'release']);
  host.register('b'); host.link('b');
  assert.equal(workers.length, 1, 'the next job reuses the worker');
  const next = workers[0].posted.at(-1).message;
  assert.equal(Atomics.load(next.cancel, 0), 0, 'another job has its own clear flag');
});

test('cancelling a job that never linked sets nothing and creates no worker', () => {
  const {host, workers} = fixture({sharedCancel: true});
  host.register('a'); host.cancel('a');
  assert.equal(workers.length, 0);
  assert.throws(() => host.link('a'), {name: 'AbortError'});
});
