import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const { RecentFiles, MAX_RECENT_BYTES, canonicalPathKey } = createRequire(import.meta.url)('../desktop/recent-files.cjs');
const root = () => fs.mkdtemp(path.join(os.tmpdir(), 'stykanimate-recent-test-'));
async function fixture(names, options = {}) {
  const directory = await root(), files = [];
  for (const name of names) {
    const filename = path.join(directory, name);
    await fs.writeFile(filename, `source:${name}`);
    files.push(filename);
  }
  return { directory, files, recent: new RecentFiles({ directory, ...options }) };
}

test('recent native files survive restart in newest-first order with stable opaque IDs', async () => {
  const { directory, files, recent } = await fixture(['animation.piv', 'figure.stk', 'Native.STKZ', 'Scène 日本語.STYK']);
  assert.deepEqual(await recent.list(), []);
  const entries = [];
  for (const file of files) entries.push(await recent.remember(file));
  assert.deepEqual(await recent.list(), entries.toReversed());
  const restarted = new RecentFiles({ directory });
  assert.deepEqual(await restarted.list(), entries.toReversed());
  for (let i = 0; i < entries.length; i++) {
    assert.match(entries[i].id, /^[\da-f-]{36}$/);
    assert.equal(entries[i].id.includes(path.basename(files[i])), false);
    assert.equal(await restarted.resolve(entries[i].id), await fs.realpath(files[i]));
    assert.equal(entries[i].name, path.basename(files[i]));
    assert.equal(entries[i].directory, directory);
    assert.equal(entries[i].missing, false);
    assert.equal(Object.hasOwn(entries[i], 'path'), false);
  }
});

test('duplicate opens move the original identity to the front and normalize dot paths', async () => {
  const { files, recent } = await fixture(['one.piv', 'two.stk']);
  const first = await recent.remember(files[0]);
  const second = await recent.remember(files[1]);
  const alias = path.dirname(files[0]) + path.sep + '.' + path.sep + path.basename(files[0]);
  assert.equal((await recent.remember(alias)).id, first.id);
  assert.deepEqual((await recent.list()).map(entry => entry.id), [first.id, second.id]);
});

test('the store caps at 20 and concurrent mutations preserve request order', async () => {
  const { directory, files, recent } = await fixture(Array.from({ length: 24 }, (_, i) => `${i}.piv`));
  await Promise.all(files.map(file => recent.remember(file)));
  const list = await recent.list();
  assert.equal(list.length, 20);
  assert.deepEqual(list.map(entry => entry.name), files.slice(4).toReversed().map(file => path.basename(file)));
  assert.deepEqual(await new RecentFiles({ directory }).list(), list);
  assert.ok((await fs.stat(path.join(directory, 'recent-files.json'))).size <= MAX_RECENT_BYTES);
});

test('a smaller configured limit is retained on load and later mutations', async () => {
  const { directory, files, recent } = await fixture(['a.piv', 'b.piv', 'c.piv']);
  for (const file of files) await recent.remember(file);
  const smaller = new RecentFiles({ directory, limit: 2 });
  assert.deepEqual((await smaller.list()).map(entry => entry.name), ['c.piv', 'b.piv']);
  await smaller.remember(files[0]);
  assert.deepEqual((await smaller.list()).map(entry => entry.name), ['a.piv', 'c.piv']);
});

test('Windows case folds canonical paths while macOS/Linux retain case distinctions', async () => {
  assert.equal(canonicalPathKey('C:\\Animation\\Scene.PIV', 'win32'), canonicalPathKey('c:\\animation\\scene.piv', 'win32'));
  for (const platform of ['darwin', 'linux'])
    assert.notEqual(canonicalPathKey('/Animation/Scene.piv', platform), canonicalPathKey('/Animation/scene.piv', platform));
  if (process.platform === 'win32') {
    const { files, recent } = await fixture(['MixedCase.PIV']);
    const first = await recent.remember(files[0]);
    assert.equal((await recent.remember(files[0].toUpperCase())).id, first.id);
    assert.equal((await recent.list()).length, 1);
  }
});

test('missing documents remain visible and resolve gives an actionable error', async () => {
  const { directory, files, recent } = await fixture(['gone.styk']);
  const entry = await recent.remember(files[0]);
  await fs.unlink(files[0]);
  assert.deepEqual(await recent.list(), [{ ...entry, missing: true }]);
  assert.deepEqual(await new RecentFiles({ directory }).list(), [{ ...entry, missing: true }]);
  await assert.rejects(recent.resolve(entry.id), /no longer available.*Open file/);
  await fs.writeFile(files[0], 'restored document');
  assert.equal((await recent.list())[0].missing, false);
  assert.equal(await recent.resolve(entry.id), await fs.realpath(files[0]));
});

test('forged IDs and renderer path strings cannot resolve or change the history', async () => {
  const { files, recent } = await fixture(['original.piv']);
  const entry = await recent.remember(files[0]);
  for (const id of ['forged', files[0], undefined, null, {}, 1, []]) {
    await assert.rejects(recent.resolve(id), /no longer in the list/);
    await assert.rejects(recent.remove(id), /no longer in the list/);
  }
  assert.deepEqual(await recent.list(), [entry]);
});

test('remove and clear erase only history, never document bytes', async () => {
  const { directory, files, recent } = await fixture(['original.piv', 'figure.stk']);
  const originals = await Promise.all(files.map(file => fs.readFile(file)));
  const first = await recent.remember(files[0]);
  const second = await recent.remember(files[1]);
  assert.deepEqual(await recent.remove(first.id), { removed: true });
  assert.deepEqual(await recent.list(), [second]);
  await assert.rejects(recent.resolve(first.id), /no longer in the list/);
  assert.deepEqual(await recent.clear(), { cleared: true });
  assert.deepEqual(await new RecentFiles({ directory }).list(), []);
  assert.deepEqual(await Promise.all(files.map(file => fs.readFile(file))), originals);
});

test('failed atomic replacement preserves previous disk and memory and later retry succeeds', async t => {
  const { directory, files, recent } = await fixture(['one.piv', 'two.piv']);
  const first = await recent.remember(files[0]);
  const store = path.join(directory, 'recent-files.json');
  const original = await fs.readFile(store);
  const rename = t.mock.method(fs, 'rename', async () => { throw Object.assign(new Error('simulated replace failure'), { code: 'EPERM' }); });
  await assert.rejects(recent.remember(files[1]), /simulated replace failure/);
  assert.deepEqual(await recent.list(), [first]);
  assert.deepEqual(await fs.readFile(store), original);
  assert.deepEqual(await new RecentFiles({ directory }).list(), [first]);
  assert.equal((await fs.readdir(directory)).some(name => name.endsWith('.tmp')), false);
  rename.mock.restore();
  await recent.remember(files[1]);
  assert.deepEqual((await recent.list()).map(entry => entry.name), ['two.piv', 'one.piv']);
});

test('invalid and unsupported remember paths leave the complete store untouched', async () => {
  const { directory, files, recent } = await fixture(['one.piv', 'wrong.txt']);
  const entry = await recent.remember(files[0]);
  await fs.mkdir(path.join(directory, 'folder.stk'));
  const original = await fs.readFile(recent.file);
  for (const filename of ['', 'relative.piv', null, undefined, 42, files[1], path.join(directory, 'missing.piv'), path.join(directory, 'folder.stk'), files[0] + '\0'])
    await assert.rejects(recent.remember(filename));
  assert.deepEqual(await fs.readFile(recent.file), original);
  assert.deepEqual(await recent.list(), [entry]);
});

test('malformed, oversized and invalid persisted records fall back safely and can be replaced', async () => {
  const { directory, files } = await fixture(['one.piv']);
  const store = path.join(directory, 'recent-files.json');
  const invalid = ['{', 'null', '[]', JSON.stringify({ version: 2, entries: [] }),
    JSON.stringify({ version: 1, entries: [{ id: 'forged', path: files[0] }] }),
    ' '.repeat(MAX_RECENT_BYTES + 1)];
  for (const bytes of invalid) {
    await fs.writeFile(store, bytes);
    const recent = new RecentFiles({ directory });
    assert.deepEqual(await recent.list(), []);
    const entry = await recent.remember(files[0]);
    assert.deepEqual(await new RecentFiles({ directory }).list(), [entry]);
  }
});

test('persisted records cannot grant unsupported paths or duplicate identities', async () => {
  const { directory, files, recent } = await fixture(['one.piv', 'two.stk']);
  const first = await recent.remember(files[0]), second = await recent.remember(files[1]);
  for (const entries of [
    [{ id: first.id, path: 'relative.piv' }],
    [{ id: first.id, path: path.join(directory, 'wrong.txt') }],
    [{ id: first.id, path: files[0] }, { id: first.id, path: files[1] }],
    Array.from({ length: 21 }, () => ({ id: second.id, path: files[1] })),
  ]) {
    await fs.writeFile(recent.file, JSON.stringify({ version: 1, entries }));
    assert.deepEqual(await new RecentFiles({ directory }).list(), []);
  }
});

test('configuration requires a native directory and a bounded positive limit', async () => {
  const directory = await root();
  for (const options of [{}, { directory: 'relative' }, { directory, limit: 0 }, { directory, limit: 21 }, { directory, limit: 1.5 }])
    assert.throws(() => new RecentFiles(options));
});

test('legacy STYK JSON projects can be remembered after native Open validation and survive restart', async () => {
  const { directory, files, recent } = await fixture(['legacy.json']);
  const bytes = await fs.readFile(files[0]);
  const entry = await recent.remember(files[0]);
  assert.equal(entry.name,'legacy.json');
  assert.equal(typeof entry.id,'string');
  assert.equal(Object.hasOwn(entry,'path'),false);
  const restored = new RecentFiles({directory});
  assert.deepEqual(await restored.list(),[entry]);
  assert.equal(await restored.resolve(entry.id),await fs.realpath(files[0]));
  await restored.clear();
  assert.deepEqual(await fs.readFile(files[0]),bytes);
});
