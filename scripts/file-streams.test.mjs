import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const { FileStreams } = createRequire(import.meta.url)('../desktop/file-streams.cjs');

async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stykanimate-stream-test-'));
  const streams = new FileStreams({ recoveryDirectory: root, maxBytes: 64, maxChunkBytes: 4, ...options });
  t.after(async () => { await streams.dispose(); });
  return { root, streams, destination: path.join(root, 'animation.styk') };
}

const rejection = action => assert.rejects(async () => { await action(); });
const buffer = values => Uint8Array.from(values).buffer;

test('bounded binary writes commit only on finish and respect Uint8Array offsets', async t => {
  const { streams, destination } = await fixture(t);
  await writeFile(destination, 'previous');
  const session = await streams.beginWrite({ destination, size: 7 });
  assert.equal(typeof session.token, 'string');
  assert.ok(session.token.length > 0);
  assert.equal(session.maxChunkBytes, 4);

  const backing = Uint8Array.from([99, 10, 20, 30, 40, 88]);
  const first = await streams.write(session.token, backing.subarray(1, 5));
  assert.equal(first.written, 4);
  const second = await streams.write(session.token, buffer([50, 60, 70]));
  assert.equal(second.written, 7);
  assert.equal(await readFile(destination, 'utf8'), 'previous');

  const result = await streams.finish(session.token);
  assert.deepEqual(result, { saved: true, path: destination, size: 7 });
  assert.deepEqual(await readFile(destination), Buffer.from([10, 20, 30, 40, 50, 60, 70]));
});

test('finish rejects an incomplete declared length and preserves the destination', async t => {
  const { streams, destination } = await fixture(t);
  await writeFile(destination, 'original');
  const { token } = await streams.beginWrite({ destination, size: 6 });
  await streams.write(token, buffer([1, 2, 3, 4]));
  await rejection(() => streams.finish(token));
  assert.equal(await readFile(destination, 'utf8'), 'original');
});

test('a write cannot exceed its declared total even when each chunk is bounded', async t => {
  const { streams, destination } = await fixture(t);
  await writeFile(destination, 'original');
  const { token } = await streams.beginWrite({ destination, size: 5 });
  await streams.write(token, buffer([1, 2, 3, 4]));
  await rejection(() => streams.write(token, buffer([5, 6])));
  assert.equal(await readFile(destination, 'utf8'), 'original');
});

test('oversized and non-binary chunks reject without modifying an existing file', async t => {
  for (const [label, chunk] of [
    ['oversized', new Uint8Array(5)],
    ['string', 'data'],
    ['plain array', [1, 2]],
    ['object', { bytes: [1, 2] }],
  ]) {
    await t.test(label, async child => {
      const { streams, destination } = await fixture(child);
      await writeFile(destination, 'original');
      const { token } = await streams.beginWrite({ destination, size: 8 });
      await rejection(() => streams.write(token, chunk));
      assert.equal(await readFile(destination, 'utf8'), 'original');
    });
  }
});

test('invalid declared lengths reject before touching the destination', async t => {
  const { streams, destination } = await fixture(t);
  await writeFile(destination, 'original');
  for (const size of [-1, 1.5, NaN, Infinity, 65]) {
    await rejection(() => streams.beginWrite({ destination, size }));
    assert.equal(await readFile(destination, 'utf8'), 'original');
  }
});

test('cancelling a partially written stream preserves the previous destination', async t => {
  const { streams, destination } = await fixture(t);
  await writeFile(destination, 'keep me');
  const { token } = await streams.beginWrite({ destination, size: 8 });
  await streams.write(token, buffer([1, 2, 3, 4]));
  await streams.cancel(token);
  assert.equal(await readFile(destination, 'utf8'), 'keep me');
  await rejection(() => streams.write(token, buffer([5])));
  await rejection(() => streams.finish(token));
});

test('cancelling while a write is pending waits for cleanup and preserves the destination', async t => {
  const { streams, destination } = await fixture(t);
  await writeFile(destination, 'keep me');
  const { token } = await streams.beginWrite({ destination, size: 4 });
  const results = await Promise.allSettled([
    streams.write(token, buffer([1, 2, 3, 4])),
    streams.cancel(token),
  ]);
  assert.equal(results[1].status, 'fulfilled', 'Cancellation must complete while a chunk is in flight.');
  assert.equal(await readFile(destination, 'utf8'), 'keep me');
  await rejection(() => streams.finish(token));
  await rejection(() => streams.write(token, buffer([5])));
  assert.equal(await readFile(destination, 'utf8'), 'keep me');
});

test('finished bytes are restart-readable in bounded ArrayBuffer chunks through EOF', async t => {
  const { root, streams, destination } = await fixture(t);
  const expected = Buffer.from([0, 255, 128, 1, 2, 3, 4, 5, 6, 7, 8]);
  const write = await streams.beginWrite({ destination, size: expected.length });
  for (let offset = 0; offset < expected.length; offset += 4) {
    await streams.write(write.token, expected.subarray(offset, offset + 4));
  }
  await streams.finish(write.token);
  await streams.dispose();

  const restarted = new FileStreams({ recoveryDirectory: root, maxBytes: 64, maxChunkBytes: 4 });
  t.after(async () => { await restarted.dispose(); });
  const session = await restarted.beginRead(destination);
  assert.equal(session.size, expected.length);
  assert.equal(session.maxChunkBytes, 4);
  assert.equal(typeof session.token, 'string');
  const chunks = [];
  let done = false;
  for (let attempt = 0; attempt <= Math.ceil(expected.length / 4); attempt++) {
    const result = await restarted.read(session.token);
    assert.ok(result.bytes instanceof ArrayBuffer);
    assert.ok(result.bytes.byteLength <= session.maxChunkBytes);
    assert.equal(typeof result.done, 'boolean');
    assert.ok(result.bytes.byteLength > 0 || result.done, 'An unfinished stream must make progress.');
    chunks.push(Buffer.from(result.bytes));
    if (result.done) { done = true; break; }
  }
  assert.ok(done, 'The stream must report EOF after its final bytes.');
  assert.deepEqual(Buffer.concat(chunks), expected);
  await restarted.closeRead(session.token);
});

test('missing files return null and empty files produce an empty EOF chunk', async t => {
  const { streams, root, destination } = await fixture(t);
  assert.equal(await streams.beginRead(path.join(root, 'missing.styk')), null);
  await writeFile(destination, new Uint8Array());
  const session = await streams.beginRead(destination);
  assert.equal(session.size, 0);
  const result = await streams.read(session.token);
  assert.ok(result.bytes instanceof ArrayBuffer);
  assert.equal(result.bytes.byteLength, 0);
  assert.equal(result.done, true);
  await streams.closeRead(session.token);
});

test('read operations require a live token rather than a filename', async t => {
  const { streams, destination } = await fixture(t);
  await writeFile(destination, 'data');
  await rejection(() => streams.read(destination));
  await rejection(() => streams.write('unknown-session', buffer([1])));
  await rejection(() => streams.finish('unknown-session'));
  const session = await streams.beginRead(destination);
  await streams.closeRead(session.token);
  await rejection(() => streams.read(session.token));
});
