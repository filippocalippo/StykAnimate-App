// The renderer's side of a native file write (src/native-files.mjs): a blob goes to the main process in few, large chunks, the next one
// read while the last is written, and a stop or a failure on the way cancels the transfer and keeps the previous file.
import assert from 'node:assert/strict';
import test from 'node:test';
import {CHUNK_BYTES, writeNativeBlob} from '../src/native-files.mjs';

/** A main process that remembers what it is sent. */
function desktop({maxChunkBytes, failAt = Infinity, onChunk} = {}) {
  const log = {chunks: [], started: 0, finished: 0, cancelled: 0, order: []};
  return {log, bridge: {
    beginFileWrite: async () => { log.started++; return {token: 't', size: 0, maxChunkBytes}; },
    writeFileChunk: async (token, bytes) => {
      log.order.push(`write ${log.chunks.length}`);
      if (log.chunks.length === failAt) throw new Error('the disk is full');
      log.chunks.push(new Uint8Array(bytes));
      await onChunk?.(log.chunks.length - 1);
    },
    finishFileWrite: async () => { log.finished++; return {saved: true, path: '/x.styk', size: log.chunks.reduce((n, c) => n + c.length, 0)}; },
    cancelFileWrite: async () => { log.cancelled++; return {cancelled: true}; },
  }};
}
const blobOf = size => new Blob([Uint8Array.from({length: size}, (_, i) => (i * 7 + (i >> 9)) & 255)]);
const joined = chunks => { const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0)); let at = 0; for (const c of chunks) { out.set(c, at); at += c.length; } return out; };

test('a project is sent in chunks of megabytes, in order, and arrives whole', async () => {
  const blob = blobOf(CHUNK_BYTES * 2 + 12345), {log, bridge} = desktop({maxChunkBytes: 64 * 1024 * 1024});
  assert.equal(await writeNativeBlob(bridge, blob), true);
  assert.deepEqual(log.chunks.map(chunk => chunk.length), [CHUNK_BYTES, CHUNK_BYTES, 12345], 'three round trips for 8 MB, not thirty');
  assert.deepEqual(joined(log.chunks), new Uint8Array(await blob.arrayBuffer()));
  assert.equal(log.finished, 1);
  assert.equal(log.cancelled, 0);
});

test('the main process names the largest chunk it takes, and an empty blob is one finish', async () => {
  const {log, bridge} = desktop({maxChunkBytes: 100_000});
  await writeNativeBlob(bridge, blobOf(250_000), {onProgress: () => {}});
  assert.deepEqual(log.chunks.map(chunk => chunk.length), [100_000, 100_000, 50_000]);
  const empty = desktop({maxChunkBytes: 100_000});
  assert.equal(await writeNativeBlob(empty.bridge, new Blob([])), true);
  assert.equal(empty.log.chunks.length, 0);
  assert.equal(empty.log.finished, 1);
});

test('a write that fails on the way cancels the transfer and the error is the write\'s', async () => {
  const {log, bridge} = desktop({maxChunkBytes: 100_000, failAt: 1});
  await assert.rejects(writeNativeBlob(bridge, blobOf(350_000)), /disk is full/);
  assert.equal(log.cancelled, 1);
  assert.equal(log.finished, 0);
});

test('a stop on the way is a cancelled save: no finish, the transfer is cancelled, the error is an AbortError', async () => {
  const controller = new AbortController(), {log, bridge} = desktop({maxChunkBytes: 100_000, onChunk: index => { if (index === 1) controller.abort(); }});
  await assert.rejects(writeNativeBlob(bridge, blobOf(500_000), {signal: controller.signal}), {name: 'AbortError'});
  assert.equal(log.finished, 0);
  assert.equal(log.cancelled, 1);
  assert.ok(log.chunks.length < 5, 'it stopped sending');
});

test('a failure after the stop was asked for is reported as the cancel it is', async () => {
  const controller = new AbortController(), {bridge, log} = desktop({maxChunkBytes: 100_000});
  bridge.finishFileWrite = async () => { controller.abort(); throw new Error('The file transfer was cancelled.'); };
  await assert.rejects(writeNativeBlob(bridge, blobOf(150_000), {signal: controller.signal}), {name: 'AbortError'});
  assert.equal(log.cancelled, 1);
});
