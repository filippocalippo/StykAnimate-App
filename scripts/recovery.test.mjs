import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const { RecoveryStore } = createRequire(import.meta.url)('../desktop/recovery.cjs');
const directory = () => mkdtemp(path.join(os.tmpdir(), 'stykanimate-recovery-test-'));
const document = JSON.stringify({ version: 5, keyframes: [{ objects: [] }] });
const data = Buffer.from(document).toString('base64');

test('recovery survives a new store instance with the canonical bytes unchanged', async () => {
  const root = await directory();
  const first = new RecoveryStore(root);
  assert.equal(await first.get(), null);
  await first.save({ data, name: 'Walking practice' });
  const restarted = new RecoveryStore(root);
  const result = await restarted.get();
  assert.equal(result.data, data);
  assert.equal(result.name, 'Walking practice');
  assert.equal(await readFile(path.join(root, 'recovery.styk'), 'utf8'), document);
  await restarted.delete();
  assert.equal(await restarted.get(), null);
});

test('serialized autosaves retain the latest complete document', async () => {
  const root = await directory();
  const store = new RecoveryStore(root);
  await Promise.all([
    store.save({ data: Buffer.from('first').toString('base64'), name: 'First' }),
    store.save({ data: Buffer.from('second').toString('base64'), name: 'Second' }),
    store.save({ data, name: 'Latest' }),
  ]);
  const result = await new RecoveryStore(root).get();
  assert.equal(result.data, data);
  assert.equal(result.name, 'Latest');
});

test('invalid or oversized writes preserve the previous recovery', async () => {
  const root = await directory();
  const store = new RecoveryStore(root, { maxBytes: 16 });
  const original = Buffer.from('original').toString('base64');
  await store.save({ data: original, name: 'Good' });
  await assert.rejects(store.save({ data: 'bad%%%=', name: 'Bad' }), /base64/);
  await assert.rejects(store.save({ data: Buffer.alloc(17).toString('base64') }), /limit/);
  assert.equal((await store.get()).data, original);
});

test('recovery tolerates missing or interrupted name metadata', async () => {
  const root = await directory();
  const store = new RecoveryStore(root);
  await store.save({ data, name: '../unsafe:name' });
  assert.equal((await store.get()).name, '.._unsafe_name');
  await writeFile(path.join(root, 'recovery.json'), '{');
  assert.equal((await new RecoveryStore(root).get()).data, data);
});
