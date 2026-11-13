// The real engine in Node (no worker threads: background work runs in slices here),
// for tests that drive styk-edit sessions through the WebAssembly module.
import {existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadEngine} from '../../src/engine/engine.mjs';
import {registeredEngine, useEngine} from '../../src/engine/engine-open.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
/** Whether the engine module is built (`npm run engine:build`). */
export const engineBuilt = existsSync(path.join(root, 'src/engine/pkg/styk_engine_bg.wasm'));

/** The engine, once per test process: the one `npm test` registers, else loaded here. */
export async function nodeEngine() {
  if (!registeredEngine()) useEngine(await loadEngine({workers: 0}));
  return {engine: registeredEngine()};
}

/**
 * The engine's generated module, started by `nodeEngine()`: the classes `src/engine/` uses on its other threads (the CPU export
 * renderer, `OpenedDocument`), for tools that run them on this one. The same module instance the engine was loaded from, not a
 * second load: a module URL is evaluated once per process.
 */
export async function engineBindings() {
  await nodeEngine();
  return import('../../src/engine/pkg/styk_engine.js');
}

/** A session on `report` exactly as given (its JSON), without opening it: no normalization, no publication. */
export async function sessionFromDocument(report, state, revision = 1) {
  const {engine} = await nodeEngine();
  return engine.editSession(JSON.stringify(report), JSON.stringify(state), revision);
}
