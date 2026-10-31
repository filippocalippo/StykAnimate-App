import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
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

test('metadata failures cannot turn an already committed file into a failed save', async t => {
  const errors=[];
  const {streams,destination}=await fixture(t,{onCommitError:error=>{errors.push(error.code);throw new Error('Diagnostic reporter failed');}});
  await writeFile(destination,'previous');
  const {token}=await streams.beginWrite({destination,size:4,onCommit:()=>{throw Object.assign(new Error('Metadata unavailable'),{code:'ENOSPC'});}});
  await streams.write(token,buffer([1,2,3,4]));
  const result=await streams.finish(token);
  assert.equal(result.saved,true);assert.equal(result.metadataSaved,false);
  assert.deepEqual(errors,['ENOSPC']);assert.deepEqual(await readFile(destination),Buffer.from([1,2,3,4]));
  assert.equal(streams.jobs.size,0);assert.deepEqual(await streams.cancel(token),{cancelled:false});
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

test('streamed writes accept an unknown size, patch in place, and finish at any position', async t => {
  const { streams, destination } = await fixture(t, { maxStreamBytes: 32 });
  await writeFile(destination, 'previous');
  const session = await streams.beginWrite({ destination, size: null, stream: true });
  assert.equal(session.size, null);
  for (const values of [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10]]) await streams.write(session.token, buffer(values));
  await streams.patch(session.token, 2, buffer([90, 91]));
  assert.deepEqual(await streams.finish(session.token), { saved: true, path: destination, size: 10 });
  assert.deepEqual(await readFile(destination), Buffer.from([1, 2, 90, 91, 5, 6, 7, 8, 9, 10]));
});

test('streamed writes still bound chunk size, total bytes and patch range', async t => {
  const { streams, destination } = await fixture(t, { maxStreamBytes: 10 });
  await writeFile(destination, 'keep me');
  const { token } = await streams.beginWrite({ destination, size: null, stream: true });
  await streams.write(token, buffer([1, 2, 3, 4]));
  await streams.write(token, buffer([5, 6]));
  await rejection(() => streams.patch(token, 5, buffer([7, 8])));
  await rejection(() => streams.patch(token, -1, buffer([7])));
  await rejection(() => streams.patch(token, 0, new Uint8Array(0)));
  await rejection(() => streams.write(token, buffer([7, 8, 9, 10, 11])));
  await rejection(() => streams.write(token, 'text'));
  assert.equal(await readFile(destination, 'utf8'), 'keep me');
  await streams.finish(token);
  assert.deepEqual(await readFile(destination), Buffer.from([1, 2, 3, 4, 5, 6]));
});

test('cancelling a streamed write removes the temporary file and preserves the destination', async t => {
  const { streams, destination } = await fixture(t);
  await writeFile(destination, 'original');
  const { token } = await streams.beginWrite({ destination, size: null, stream: true });
  await streams.write(token, buffer([1, 2, 3, 4]));
  await streams.cancel(token);
  assert.equal(await readFile(destination, 'utf8'), 'original');
  await rejection(() => streams.patch(token, 0, buffer([9])));
});

test('a streamed write with a declared size still enforces it', async t => {
  const { streams, destination } = await fixture(t, { maxStreamBytes: 32 });
  const { token } = await streams.beginWrite({ destination, size: 5, stream: true });
  await streams.write(token, buffer([1, 2, 3, 4]));
  await rejection(() => streams.write(token, buffer([5, 6])));
  await rejection(() => streams.finish(token));
  await streams.write(token, buffer([5]));
  assert.deepEqual(await streams.finish(token), { saved: true, path: destination, size: 5 });
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

/** Makes `rename` fail with `code` the first `failures` times it is called (always, for Infinity), then do what it does. */
function failingRename(t, code, failures) {
  const fsPromises = createRequire(import.meta.url)('node:fs/promises'), real = fsPromises.rename, calls = [];
  fsPromises.rename = async (...args) => {
    calls.push(args);
    if (calls.length <= failures) throw Object.assign(new Error(`${code}: rename`), { code });
    return real(...args);
  };
  t.after(() => { fsPromises.rename = real; });
  return calls;
}

async function written(streams, destination, text = 'new') {
  const session = await streams.beginWrite({ destination, size: text.length });
  await streams.write(session.token, new TextEncoder().encode(text));
  return session.token;
}

for (const code of ['EPERM', 'EACCES', 'EBUSY']) test(`a save whose rename is refused for a moment with ${code} still replaces the file`, async t => {
  const { streams, destination } = await fixture(t);
  await writeFile(destination, 'previous');
  const token = await written(streams, destination), calls = failingRename(t, code, 3);
  assert.equal((await streams.finish(token)).saved, true);
  assert.equal(calls.length, 4, 'three refusals and the rename that went through');
  assert.equal(await readFile(destination, 'utf8'), 'new');
});

test('a rename that keeps being refused fails after about a second, keeps the old file and removes the temporary file', async t => {
  const { root, streams, destination } = await fixture(t);
  await writeFile(destination, 'previous');
  const token = await written(streams, destination), calls = failingRename(t, 'EPERM', Infinity), started = Date.now();
  await assert.rejects(streams.finish(token), { code: 'EPERM' });
  const elapsed = Date.now() - started;
  assert.ok(calls.length > 3 && calls.length <= 8, `${calls.length} attempts`);
  assert.ok(elapsed >= 500 && elapsed < 3000, `${elapsed} ms`);
  assert.equal(await readFile(destination, 'utf8'), 'previous');
  assert.deepEqual((await readdir(root)).filter(name => name !== 'animation.styk'), [], 'nothing is left beside the file');
});

test('a failure that is not a refusal of the moment is reported at once', async t => {
  const { streams, destination } = await fixture(t);
  await writeFile(destination, 'previous');
  const token = await written(streams, destination), calls = failingRename(t, 'ENOSPC', Infinity);
  await assert.rejects(streams.finish(token), { code: 'ENOSPC' });
  assert.equal(calls.length, 1);
  assert.equal(await readFile(destination, 'utf8'), 'previous');
});
