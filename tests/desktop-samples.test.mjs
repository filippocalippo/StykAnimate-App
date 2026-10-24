import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm, symlink, realpath} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import samples from '../desktop/samples.cjs';
import {resolvePython} from '../scripts/run-python.mjs';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** A workspace with samples, excluded and hidden folders, a link out of it and names that sort by case and kind. */
async function workspace(t) {
  const outside = await mkdtemp(path.join(os.tmpdir(), 'styk-samples-outside-'));
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'styk-samples-')));
  t.after(async () => { await rm(root, {recursive: true, force: true}); await rm(outside, {recursive: true, force: true}); });
  const file = async (relative, bytes = 'x') => { await mkdir(path.dirname(path.join(root, relative)), {recursive: true}); await writeFile(path.join(root, relative), bytes); };
  await file('b.PIV'); await file('a.stk', 'stk!'); await file('Zebra.piv'); await file('apple.piv', '12345');
  await file('Pivot Animator v5/Animations/walk.piv'); await file('Pivot Animator v5/Figures/sheep.stk');
  await file('nested/deeper/Apple.piv'); await file('nested/notes.txt'); await file('nested/project.styk');
  await file('tests/fixture.piv'); await file('Build/out.piv'); await file('node_modules/pkg/x.piv'); await file('.hidden/secret.piv');
  await file('artifacts/run.piv'); await file('nested/.dotfile.piv'); await file('.piv');
  await file('data.json', '{}'); await file('empty.piv', '');
  await writeFile(path.join(outside, 'escape.piv'), 'outside');
  await symlink(path.join(outside, 'escape.piv'), path.join(root, 'linked-out.piv'));
  await symlink(outside, path.join(root, 'linked-folder'), process.platform === 'win32' ? 'junction' : 'dir');
  return root;
}

test('the list holds the .piv and .stk files outside excluded and hidden folders, by kind then case-folded name', async t => {
  const root = await workspace(t);
  const {ok, samples: list} = await samples.listSamples(root);
  assert.equal(ok, true);
  // Equal case-folded names keep the walk's order: a folder's files before its subfolders'.
  assert.deepEqual(list.map(item => item.path), ['nested/.dotfile.piv', 'apple.piv', 'nested/deeper/Apple.piv', 'b.PIV', 'empty.piv',
    'Pivot Animator v5/Animations/walk.piv', 'Zebra.piv', 'a.stk', 'Pivot Animator v5/Figures/sheep.stk']);
  assert.deepEqual(list.find(item => item.path === 'apple.piv'), {path: 'apple.piv', name: 'apple.piv', kind: 'piv', size: 5});
  assert.equal(list.find(item => item.path === 'b.PIV').kind, 'piv', 'the kind is the lower-case suffix');
});

test('a packaged app lists nothing and opens nothing; from source the list is the folder beside the app', async () => {
  assert.deepEqual(await samples.listSamples(null), {ok: true, samples: []});
  assert.equal((await samples.readSample(null, 'a.piv')).status, 404);
  assert.equal(await samples.sampleRoot({appRoot: app, packaged: true}), null);
  assert.equal(await samples.sampleRoot({appRoot: app, packaged: false}), path.dirname(await realpath(app)));
});

test('a sample is read as the file it names, and refused with the codec service\'s own answers', async t => {
  const root = await workspace(t);
  const read = await samples.readSample(root, 'Pivot Animator v5/Figures/sheep.stk');
  assert.equal(read.ok, true); assert.equal(read.name, 'sheep.stk'); assert.equal(Buffer.from(read.bytes).toString(), 'x');
  assert.equal((await samples.readSample(root, 'a/./../a.stk')).code, 'path_forbidden');
  assert.equal((await samples.readSample(root, './a.stk')).ok, true, 'single-dot parts are dropped, as pathlib does');
  assert.equal((await samples.readSample(root, 'nested\\deeper\\Apple.piv')).ok, true, 'backslashes are folder separators');
  const refusals = {
    '': [400, 'invalid_path', 'A relative file path is required.'],
    'a\u0000.piv': [400, 'invalid_path', 'A relative file path is required.'],
    '../escape.piv': [403, 'path_forbidden', 'The path must stay inside the project directory.'],
    '/etc/passwd.piv': [403, 'path_forbidden', 'The path must stay inside the project directory.'],
    'C:/x.piv': [403, 'path_forbidden', 'The path must stay inside the project directory.'],
    '.hidden/secret.piv': [403, 'path_forbidden', 'The path must stay inside the project directory.'],
    'NODE_MODULES/pkg/x.piv': [403, 'path_forbidden', 'The path must stay inside the project directory.'],
    'linked-out.piv': [403, 'path_forbidden', 'The path must stay inside the project directory.'],
    'linked-folder/escape.piv': [403, 'path_forbidden', 'The path must stay inside the project directory.'],
    'nested/notes.txt': [415, 'unsupported_file', 'Choose a .styk project, .stykmov movieclip, .stkz figure, .piv, or .stk file.'],
    'data.json': [415, 'unsupported_sample', 'Use file import to open a native JSON project.'],
    'missing.piv': [404, 'file_not_found', 'This project file no longer exists.'],
    'nested': [415, 'unsupported_file', 'Choose a .styk project, .stykmov movieclip, .stkz figure, .piv, or .stk file.'],
  };
  for (const [relative, [status, code, error]] of Object.entries(refusals))
    assert.deepEqual(await samples.readSample(root, relative), {ok: false, status, code, error}, JSON.stringify(relative));
  assert.equal((await samples.readSample(root, 42)).code, 'invalid_path');
  assert.equal((await samples.readSample(root, 'tests/fixture.piv')).ok, true, 'excluded folders are hidden from the list, not forbidden');
});

test('the list and the refusals are the Python codec service\'s (development oracle)', {timeout: 120000}, async t => {
  const python = resolvePython();
  if (!python) return t.skip('Python 3.11+ is not installed (only the development oracle needs it)');
  const root = await workspace(t);
  const paths = ['', '../escape.piv', '.hidden/secret.piv', 'NODE_MODULES/pkg/x.piv', 'linked-out.piv', 'nested/notes.txt', 'data.json',
    'missing.piv', 'a/./../a.stk', 'C:/x.piv', 'nested', 'Pivot Animator v5/Figures/sheep.stk', 'empty.piv'];
  const script = `
import json, sys
sys.path[:0] = [${JSON.stringify(path.join(app, 'backend'))}]
import server
from pathlib import Path
store = server.ProjectStore(Path(sys.argv[1]))
answers = {}
for relative in json.loads(sys.argv[2]):
    try:
        result = store.open(relative, as_json=True)
        answers[relative] = {'ok': True}
    except Exception as exc:
        status, body = server.error_response(exc)
        answers[relative] = {'ok': False, 'status': status, 'code': body['code'], 'error': body['error']}
print(json.dumps({'samples': store.samples(), 'open': answers}))`;
  const run = spawnSync(python.command, [...python.args, '-c', script, root, JSON.stringify(paths)], {encoding: 'utf8', windowsHide: true});
  assert.equal(run.status, 0, run.stderr);
  const oracle = JSON.parse(run.stdout);
  assert.deepEqual((await samples.listSamples(root)).samples, oracle.samples);
  for (const relative of paths) {
    const answer = await samples.readSample(root, relative), expected = oracle.open[relative];
    // A readable sample goes on to the import, where the codec decodes it (these fixtures are not real Pivot files).
    if (answer.ok) assert.ok(expected.ok || ['invalid_project', 'empty_file'].includes(expected.code), relative);
    else assert.deepEqual(answer, expected, relative);
  }
  assert.deepEqual(oracle.open['empty.piv'], {ok: false, status: 400, code: 'empty_file', error: 'This file is empty.'});
});

test('the list stops at 5000 files, as the codec service did', async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'styk-samples-many-')));
  t.after(() => rm(root, {recursive: true, force: true}));
  for (let folder = 0; folder < 6; folder++) {
    await mkdir(path.join(root, `f${folder}`));
    await Promise.all(Array.from({length: 900}, (_, i) => writeFile(path.join(root, `f${folder}`, `${i}.piv`), '')));
  }
  assert.equal((await samples.listSamples(root)).samples.length, samples.MAX_SAMPLE_COUNT);
});
