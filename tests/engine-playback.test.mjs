import test from 'node:test';
import assert from 'node:assert/strict';
import {waitForEngineProgress} from '../src/engine/engine.mjs';
import {createStagePlayback, engineTicket} from '../src/engine/engine-playback.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
/** Waits for `condition`, polling for at most `ms`: a timer takes up to 16 ms to fire on Windows, so a fixed sleep is too short there. */
async function until(condition, ms = 2000) {
  for (const end = performance.now() + ms; !condition() && performance.now() < end;) await sleep(1);
}

function playbackSide({maxFrames} = {}) {
  let generation = 7, epoch = 2, revision = 1;
  let readinessReads = 0;
  const requests = [], ready = new Map();
  const handle = {
    request_samples(playhead, samples) { requests.push({playhead, samples}); },
    try_request_samples(playhead, samples) { handle.request_samples(playhead, samples); return 2; },
    // Calling the integer path would truncate the sample before the worker.
    request() { throw new Error('integer binding reached'); },
    frame_ready: tick => { readinessReads++; return ready.has(tick); },
    frame_ticket_ready: (gen, resourceEpoch, tick) => { readinessReads++; return gen === generation && resourceEpoch === epoch && ready.has(tick); },
    frame_meta: tick => ready.has(tick) ? JSON.stringify({...ready.get(tick), generation, epoch}) : undefined,
    generation: () => generation,
    // The revision the engine's session last published.
    try_document_identity: () => [generation, 1, revision],
    set_hidden() {}, total_ticks: () => 9,
    try_set_hidden() { return 1; }, try_set_effects() { return 1; },
  };
  const side = {engine: {handle, pump() {}}};
  return {playback: createStagePlayback({stage: () => ({engineSide: side}), maxTickets: maxFrames}), ready, requests,
    reads: () => readinessReads,
    nextGeneration() { generation++; }, nextEpoch() { epoch++; }, publish(next) { revision = next; }, handle, engine: side.engine};
}

test('fractional range requests retain Float64 samples and distinct ready packet metadata', async () => {
  const {playback, ready, requests} = playbackSide();
  playback.load({}, {revision: 1});
  await playback.prepareRange([3, 3.5]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].playhead, 3);
  assert.ok(requests[0].samples instanceof Float64Array);
  assert.deepEqual([...requests[0].samples], [3, 3.5]);
  assert.equal(playback.get(3.5), null, 'cold readiness does not evaluate or fall through');
  ready.set(3, {tick: 3, camera: {x: 10}, background_id: 1});
  ready.set(3.5, {tick: 3.5, camera: {x: 12}, background_id: 2});
  const integer = playback.get(3), fractional = playback.get(3.5);
  assert.notEqual(integer, fractional);
  assert.equal(fractional, playback.get(3.5), 'same ticket in existing packet map');
  assert.equal(fractional.frame.tick, 3.5);
  assert.equal(fractional.frame.camera.x, 12);
  assert.equal(fractional.frame.background_id, 2);
  assert.equal(engineTicket(fractional.key)?.tick, 3.5);
  assert.notEqual(integer.key, fractional.key);
  assert.equal(playback.cache.size, 2);
});

test('native eviction prunes 100,000 distinct fractional metadata tickets', async () => {
  const {playback, ready, reads} = playbackSide();
  playback.load({}, {revision: 1});
  await playback.prepareRange([0]);
  for (let index = 0; index < 100_000; index++) {
    const tick = index / 100_000;
    ready.clear(); ready.set(tick, {tick});
    const before = reads(), packet = playback.get(tick);
    assert.equal(packet.tick, tick);
    assert.equal(playback.cache.size, 1, 'obsolete native ticket is released by the existing packet owner');
    assert.ok(reads() - before <= 121, 'fixed metadata scan bound');
  }
});

test('finite ticket cap preserves current and queued packet identities without limiting native requests', async () => {
  for (const [maxFrames, limit] of [[0, 1], [NaN, 120], [Infinity, 120], [1_000_000, 120], [2.9, 2]]) {
    const {playback, ready, requests, reads} = playbackSide({maxFrames});
    playback.load({}, {revision: 1});
    const ticks = Array.from({length: 500}, (_, index) => index / 1000);
    await playback.prepareRange(ticks);
    assert.equal(requests.at(-1).samples.length, ticks.length, 'native frame preparation is unchanged');
    for (const tick of ticks) ready.set(tick, {tick});
    const current = playback.get(0), queued = limit > 1 ? playback.get(.001) : null;
    for (const tick of ticks) {
      const before = reads();
      assert.equal(playback.get(tick).tick, tick);
      assert.ok(playback.cache.size <= limit);
      assert.ok(reads() - before <= 121, `${maxFrames}: configured maxFrames cannot expand the UI scan`);
    }
    assert.equal(playback.get(-0), current);
    assert.equal(current.tick, 0);
    if (queued) assert.equal(playback.get(.001), queued);
  }
});

test('request replacement, native eviction and cancellation preserve only current valid identities', async () => {
  const {playback, ready, nextGeneration} = playbackSide({maxFrames: 3});
  playback.load({}, {revision: 1});
  await playback.prepareRange([0, .5, 1]);
  for (const tick of [0, .5, 1, 2, 2.5, 3]) ready.set(tick, {tick});
  const current = playback.get(0), queued = playback.get(.5), last = playback.get(1);
  assert.equal(playback.get(2).tick, 2, 'other ready sample remains available without displacing queued tickets');
  assert.equal(playback.get(0), current); assert.equal(playback.get(.5), queued); assert.equal(playback.get(1), last);
  ready.delete(.5);
  assert.equal(playback.get(.5), null);
  assert.equal(playback.cache.has(.5), false);
  await playback.prepareRange([2, 2.5, 3]);
  const replacement = playback.get(2);
  playback.get(2.5); playback.get(3);
  assert.deepEqual([...playback.cache.keys()].sort((a, b) => a - b), [2, 2.5, 3]);
  assert.equal(playback.get(2), replacement);
  nextGeneration();
  assert.notEqual(playback.get(2), replacement, 'new generation cannot retain a prior ticket');
  playback.invalidate();
  assert.equal(playback.cache.size, 0);
});

test('invalid samples never create tickets or replace valid current request priority', async () => {
  const {playback, ready, reads} = playbackSide({maxFrames: 1});
  playback.load({}, {revision: 1});
  await playback.prepareRange([0]); ready.set(0, {tick: 0}); ready.set(1, {tick: 1});
  const current = playback.get(-0);
  for (const tick of [NaN, Infinity, -Infinity, -1, '0', undefined, null]) {
    ready.set(tick, {tick});
    const before = reads();
    assert.equal(playback.get(tick), null);
    assert.equal(reads(), before, 'invalid identity does not cross the native query boundary');
  }
  await playback.prepareRange([NaN, 1]);
  assert.equal(playback.get(1).tick, 1);
  assert.equal(playback.get(0), current);
  await playback.prepareRange([1, Infinity, -1]);
  const next = playback.get(1);
  assert.equal(playback.cache.size, 1);
  assert.equal(playback.get(1), next);
});

test('invalidation cancels fractional requests and a replacement revision drops old generation packets', async () => {
  const {playback, ready, requests, nextGeneration, publish} = playbackSide();
  playback.load({}, {revision: 1});
  await playback.prepareRange([3.5]);
  ready.set(3.5, {tick: 3.5});
  const previous = playback.get(3.5);
  playback.invalidate();
  assert.equal(playback.cache.size, 0);
  assert.ok(requests.at(-1).samples instanceof Float64Array);
  assert.equal(requests.at(-1).samples.length, 0);
  playback.updateDocument({revision: 2});
  assert.equal(playback.get(3.5), null, 'metadata stays unavailable until the engine publishes the revision');
  publish(2);
  nextGeneration();
  await playback.prepareRange([3.5]);
  const current = playback.get(3.5);
  assert.notEqual(current, previous);
  assert.notEqual(current.key, previous.key);
  assert.equal(current.tick, 3.5);
});

test('a same-tick settings or resource change replaces its ticket even when readiness is already restored', async () => {
  const {playback, ready, nextEpoch, handle} = playbackSide();
  playback.load({}, {revision: 1});
  await playback.prepareRange([3.5]);
  ready.set(3.5, {tick: 3.5, background_id: 1});
  const previous = playback.get(3.5), previousIdentity = engineTicket(previous.key);
  nextEpoch();
  ready.set(3.5, {tick: 3.5, background_id: 2});
  assert.equal(handle.frame_ticket_ready(previousIdentity.generation, previousIdentity.epoch, previousIdentity.tick), false);
  const current = playback.get(3.5);
  assert.notEqual(current, previous);
  assert.notEqual(current.key, previous.key);
  assert.equal(current.frame.background_id, 2, 'overlay metadata belongs to the new native frame');
  assert.equal(playback.cache.size, 1, 'the same packet owner retains only the current ticket');
});

test('publication between metadata read and ticket admission cannot admit mismatched overlay metadata', async () => {
  const {playback, ready, nextEpoch, handle} = playbackSide();
  playback.load({}, {revision: 1});
  await playback.prepareRange([3.5]);
  ready.set(3.5, {tick: 3.5, camera: {x: 10}});
  const meta = handle.frame_meta;
  handle.frame_meta = tick => { const old = meta(tick); nextEpoch(); handle.frame_meta = meta; return old; };
  assert.equal(playback.get(3.5), null);
  assert.equal(playback.cache.size, 0);
  assert.equal(playback.get(3.5).frame.camera.x, 10);
});

test('only canonical finite engine identities are engine tickets', () => {
  assert.deepEqual(engineTicket('engine:7:2:3.5'), {generation: 7, epoch: 2, tick: 3.5});
  assert.equal(engineTicket('engine:7:2:0')?.tick, 0);
  for (const key of [null, '', 'legacy:7:2:3.5', 'engine:7:3.5', 'engine:0:2:3.5',
    'engine:7:-1:3.5', 'engine:7:2:NaN', 'engine:7:2:Infinity', 'engine:7:2:-0',
    'engine:7:2:-1', 'engine:7:2:', 'engine:07:2:3.5', 'engine:7:02:3.5',
    'engine:7:2:03.5', 'engine:7:2:3.5:extra', `engine:7:2:${'0'.repeat(100)}`,
    'engine:9007199254740992:2:3.5']) {
    assert.equal(engineTicket(key), null, String(key));
    assert.equal(engineTicket(key)?.tick ?? null, null, String(key));
  }
});

test('busy hidden admission stays cold and coalesces the actual latest view', async t => {
  const {playback, ready, handle, nextEpoch} = playbackSide();
  t.after(() => playback.dispose());
  playback.load({}, {revision: 1});
  await playback.prepareRange([.5]);
  ready.set(.5, {tick: .5});
  const before = playback.get(.5), applied = [];
  let busy = true;
  handle.set_hidden = () => assert.fail('UI must never use the spinning setter');
  handle.try_set_hidden = uids => {
    if (busy) return 0;
    applied.push([...uids]); nextEpoch(); ready.clear(); return 2;
  };
  playback.updateView({hiddenKey: 'first', hiddenUids: [1]});
  assert.equal(playback.get(.5), null);
  playback.updateView({hiddenKey: 'latest', hiddenUids: [2, 3]});
  assert.equal(playback.get(.5), null);
  assert.deepEqual(applied, []);
  busy = false;
  assert.equal(playback.get(.5), null, 'accepting the setting cannot revive an old cached picture');
  assert.deepEqual(applied, [[2, 3]], 'one latest request, not one queued task per view');
  ready.set(.5, {tick: .5});
  assert.notEqual(playback.get(.5).key, before.key);
  playback.dispose();
});

test('busy effects admission never reports the previous preview as ready', async t => {
  const {playback, ready, handle, nextEpoch} = playbackSide();
  t.after(() => playback.dispose());
  playback.load({}, {revision: 1}); await playback.prepareRange([.5]);
  ready.set(.5, {tick: .5}); const before = playback.get(.5);
  let busy = true; const applied = [];
  handle.set_effects = () => assert.fail('UI must never use the spinning effects setter');
  handle.try_set_effects = enabled => { if (busy) return 0; applied.push(enabled); nextEpoch(); ready.clear(); return 2; };
  playback.setVfxEnabled(false);
  assert.equal(playback.get(.5), null);
  playback.setVfxEnabled(true);
  assert.equal(playback.get(.5), null);
  busy = false; assert.equal(playback.get(.5), null);
  assert.deepEqual(applied, [true]);
  ready.set(.5, {tick: .5}); assert.notEqual(playback.get(.5).key, before.key);
  playback.dispose();
});

test('busy sample admission and invalidation replace one pending demand', async t => {
  const {playback, ready, requests, handle} = playbackSide();
  t.after(() => playback.dispose());
  playback.load({}, {revision: 1});
  let busy = true;
  handle.request_samples = () => assert.fail('UI must never use the spinning request setter');
  handle.try_request_samples = (playhead, samples) => {
    if (busy) return 0;
    requests.push({playhead, samples}); return 2;
  };
  await playback.prepareRange([1.25, 2.5]);
  await playback.prepareRange([3.5, 4.75]);
  ready.set(3.5, {tick: 3.5});
  assert.equal(playback.get(3.5), null);
  playback.invalidate();
  busy = false;
  playback.get(3.5);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].playhead, 0);
  assert.deepEqual([...requests[0].samples], []);
  playback.dispose();
});

test('a newer sample request replaces busy demand before native admission', async t => {
  const {playback, requests, handle} = playbackSide();
  t.after(() => playback.dispose());
  playback.load({}, {revision: 1});
  let busy = true;
  handle.try_request_samples = (playhead, samples) => {
    if (busy) return 0;
    requests.push({playhead, samples}); return 2;
  };
  await playback.prepareRange([1.25, 2.5]);
  await playback.prepareRange([3.5, 4.75]);
  await playback.prepareRange([NaN, 1.5]);
  busy = false; playback.get(3.5);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].playhead, 3.5);
  assert.deepEqual([...requests[0].samples], [3.5, 4.75]);
  playback.dispose();
});

test('a no-op view admission retains earlier busy demand', async t => {
  const {playback, requests, handle} = playbackSide();
  t.after(() => playback.dispose());
  playback.load({}, {revision: 1});
  let busy = true;
  handle.try_request_samples = (playhead, samples) => {
    if (busy) return 0;
    requests.push({playhead, samples}); return 2;
  };
  await playback.prepareRange([1.25, 2.5]);
  playback.updateView({hiddenKey: 'same-native-setting', hiddenUids: []});
  busy = false; playback.get(1.25);
  assert.equal(requests.length, 1);
  assert.deepEqual([...requests[0].samples], [1.25, 2.5]);
  playback.dispose();
});

test('publication discards unaccepted demand for the previous document', async t => {
  const {playback, requests, handle} = playbackSide();
  t.after(() => playback.dispose());
  playback.load({}, {revision: 1});
  let busy = true;
  handle.try_request_samples = (playhead, samples) => {
    if (busy) return 0;
    requests.push({playhead, samples}); return 2;
  };
  await playback.prepareRange([1.25, 2.5]);
  playback.load({}, {revision: 2});
  await Promise.resolve();
  busy = false; playback.get(3.5);
  assert.deepEqual(requests, [], 'a pending request has the same publication lifetime as admitted native demand');
});

test('one bounded continuation retries latest admission without progress and disposal cancels it', async t => {
  const {playback, requests, ready, handle, engine} = playbackSide();
  t.after(() => playback.dispose());
  playback.load({}, {revision: 1});
  let busy = true;
  const progress = new Int32Array(new SharedArrayBuffer(4));
  engine.progressSeen = () => Atomics.load(progress, 0);
  let active = 0, maximum = 0;
  engine.whenProgress = (seen, timeoutMs) => {
    maximum = Math.max(maximum, ++active);
    return waitForEngineProgress(progress, false, seen, timeoutMs).finally(() => { active--; });
  };
  handle.try_request_samples = (playhead, samples) => {
    if (busy) return 0;
    requests.push({playhead, samples}); return 2;
  };
  await playback.prepareRange([1.25]);
  await playback.prepareRange([2.5]);
  ready.set(2.5, {tick: 2.5});
  assert.equal(playback.get(2.5), null, 'unaccepted demand keeps even a previously ready native frame cold');
  busy = false;
  await until(() => requests.length > 0);
  assert.deepEqual(requests.map(request => [...request.samples]), [[2.5]], 'lock release without progress retries actual latest demand without another get');
  assert.equal(maximum, 1, 'only one waiter may be active');
  assert.equal(Atomics.load(progress, 0), 0, 'a retry cannot fabricate progress');
  assert.equal(playback.get(2.5).tick, 2.5, 'actual native admission releases the cold barrier');
  busy = true; await playback.prepareRange([1.5]);
  playback.dispose();
  busy = false;
  await until(() => active === 0);
  await sleep(50);
  assert.equal(requests.length, 1, 'a late scheduled retry cannot admit disposed playback demand');
  assert.equal(active, 0, 'disposed waiters finish at their actual bounded deadline');
});

test('a busy scalar generation header cannot certify buffered playback', async () => {
  const {playback, ready, handle} = playbackSide();
  playback.load({}, {revision: 1}); await playback.prepareRange([0, 1]);
  ready.set(0, {tick: 0}); ready.set(1, {tick: 1});
  assert.equal(playback.bufferedAhead(0, 2), true);
  handle.total_ticks = () => 0;
  assert.equal(playback.bufferedAhead(0, 2), false, 'a ready sample alone cannot fill a header whose read was busy');
  playback.dispose();
});

test('a document loaded before the stage exists is served once the stage has the engine holding its revision', async () => {
  let stage = null;
  const requested = [], handle = {try_request_samples: playhead => { requested.push(playhead); return 2; }, try_set_hidden: () => 1, try_set_effects: () => 1,
    generation: () => 1, total_ticks: () => 9, frame_meta: () => undefined, frame_ticket_ready: () => false, try_document_identity: () => [1, 1, 1]};
  const side = {engine: {handle, pump() {}}};
  const playback = createStagePlayback({stage: () => stage});
  const report = {};
  playback.load(report, {revision: 1});
  assert.equal(playback.report, report, 'the transport knows the document');
  assert.equal(playback.get(0), null);
  assert.equal(playback.bufferedAhead(0, 2), false);
  await playback.prepareRange([0, 1]);
  assert.deepEqual(requested, [], 'there is no engine to ask yet');
  stage = {engineSide: side};
  await playback.prepareRange([0]);
  assert.deepEqual(requested, [0], 'the engine holds the revision the transport is at');
  playback.dispose();
});
