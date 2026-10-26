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
  await writeFile(path.join(engine, 'engine-open.mjs'), 'let registered = null; export function registeredEngine() { return registered; } export function useEngine(engine) { registered = engine; }');
  // Model the real loader's static dependency on generated build output.
  await writeFile(path.join(engine, 'engine.mjs'), "export {loadEngine} from './pkg/styk_engine.js';");
  if (built) {
    await writeFile(path.join(engine, 'pkg/styk_engine_bg.wasm'), '');
    await writeFile(path.join(engine, 'pkg/styk_engine.js'), broken
      ? "export function loadEngine() {} throw new Error('broken engine module');"
      : 'let calls = 0; export async function loadEngine(options) { return {options, calls: ++calls}; }');
  }
  return {helper: pathToFileURL(path.join(support, 'engine-node.mjs')).href, registry: pathToFileURL(path.join(engine, 'engine-open.mjs')).href};
}

test('an unbuilt checkout can import the engine test helper before deciding to skip', async t => {
  const helper = await import((await checkout(t)).helper);
  assert.equal(helper.engineBuilt, false);
  // Calling the loader still exposes the missing build; only importing the helper is safe.
  await assert.rejects(helper.nodeEngine(), {code: 'ERR_MODULE_NOT_FOUND'});
});

test('a built checkout loads one engine lazily and reuses the registered engine', async t => {
  const helper = await import((await checkout(t, {built: true})).helper);
  assert.equal(helper.engineBuilt, true);
  const first = await helper.nodeEngine();
  assert.deepEqual(first.engine, {options: {workers: 0}, calls: 1});
  assert.equal((await helper.nodeEngine()).engine, first.engine);
});

test('a broken built module fails when requested without hiding the error', async t => {
  const helper = await import((await checkout(t, {built: true, broken: true})).helper);
  assert.equal(helper.engineBuilt, true);
  await assert.rejects(helper.nodeEngine(), /broken engine module/);
});


test('a previously registered engine is reused without importing broken build output', async t => {
  const fixture = await checkout(t, {built: true, broken: true});
  const {useEngine} = await import(fixture.registry);
  const engine = {registered: true};
  useEngine(engine);
  const helper = await import(fixture.helper);
  assert.equal((await helper.nodeEngine()).engine, engine);
});
