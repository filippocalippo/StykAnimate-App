import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFile, mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

async function checkout(t, {built = false, broken = false} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'styk-engine-test-loading-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const support = path.join(root, 'tests/support');
  const engine = path.join(root, 'src/engine');
  await mkdir(support, {recursive: true});
  await mkdir(path.join(engine, 'pkg'), {recursive: true});
  await writeFile(path.join(root, 'package.json'), '{"type":"module"}');
  await copyFile(new URL('./support/engine-node.mjs', import.meta.url), path.join(support, 'engine-node.mjs'));
  await writeFile(path.join(engine, 'engine-mirror.mjs'), 'export class EngineMirror { constructor(engine) { this.engine = engine; } }');
  // Model the real loader's static dependency on generated build output.
  await writeFile(path.join(engine, 'engine.mjs'), "export {loadEngine} from './pkg/styk_engine.js';");
  if (built) {
    await writeFile(path.join(engine, 'pkg/styk_engine_bg.wasm'), '');
    await writeFile(path.join(engine, 'pkg/styk_engine.js'), broken
      ? "export function loadEngine() {} throw new Error('broken engine module');"
      : 'let calls = 0; export async function loadEngine(options) { return {options, calls: ++calls}; }');
  }
  return pathToFileURL(path.join(support, 'engine-node.mjs')).href;
}

test('an unbuilt checkout can import the engine test helper before deciding to skip', async t => {
  const helper = await import(await checkout(t));
  assert.equal(helper.engineBuilt, false);
  // Calling the loader still exposes the missing build; only importing the helper is safe.
  await assert.rejects(helper.nodeEngine(), {code: 'ERR_MODULE_NOT_FOUND'});
});

test('a built checkout loads one engine lazily and reuses its mirror', async t => {
  const helper = await import(await checkout(t, {built: true}));
  assert.equal(helper.engineBuilt, true);
  const first = await helper.nodeEngine();
  assert.deepEqual(first.engine, {options: {workers: 0}, calls: 1});
  assert.equal(first.mirror.engine, first.engine);
  assert.equal(await helper.nodeEngine(), first);
});

test('a broken built module fails when requested without hiding the error', async t => {
  const helper = await import(await checkout(t, {built: true, broken: true}));
  assert.equal(helper.engineBuilt, true);
  await assert.rejects(helper.nodeEngine(), /broken engine module/);
});
