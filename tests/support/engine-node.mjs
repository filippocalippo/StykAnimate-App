// The real engine in Node (no worker threads: background work runs in slices here),
// for tests that drive styk-edit sessions through the WebAssembly module.
import {existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {registeredEngine, useEngine} from '../../src/engine/engine-open.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
/** Whether the engine module is built (`npm run engine:build`). */
export const engineBuilt = existsSync(path.join(root, 'src/engine/pkg/styk_engine_bg.wasm'));

/** The engine, once per test process: the one `npm test` registers, else loaded here. */
export async function nodeEngine() {
  if (!registeredEngine()) {
    // Let tests inspect engineBuilt before loading the generated WebAssembly glue.
    const {loadEngine} = await import('../../src/engine/engine.mjs');
    useEngine(await loadEngine({workers: 0}));
  }
  return {engine: registeredEngine()};
}

/** A session on `report` exactly as given (its JSON), without opening it: no normalization, no publication. */
export async function sessionFromDocument(report, state, revision = 1) {
  const {engine} = await nodeEngine();
  return engine.editSession(JSON.stringify(report), JSON.stringify(state), revision);
}
