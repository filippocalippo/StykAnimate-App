// The real engine in Node (no worker threads: background work runs in slices here),
// for tests that drive styk-edit sessions through the WebAssembly module.
import {existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {EngineMirror} from '../../src/engine/engine-mirror.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
/** Whether the engine module is built (`npm run engine:build`). */
export const engineBuilt = existsSync(path.join(root, 'src/engine/pkg/styk_engine_bg.wasm'));

let shared = null;
/** The engine and a mirror, once per test process. */
export async function nodeEngine() {
  if (!shared) {
    // Let tests inspect engineBuilt before loading the generated WebAssembly glue.
    const {loadEngine} = await import('../../src/engine/engine.mjs');
    const engine = await loadEngine({workers: 0});
    shared = {engine, mirror: new EngineMirror(engine)};
  }
  return shared;
}

/** Mirrors `report` at `revision` into the engine and starts an edit session with `state`. */
export async function startSession(report, revision, state) {
  const {engine, mirror} = await nodeEngine();
  mirror.reset();
  await mirror.syncFrames(report, revision, {allFigures: true, allFrames: true, allSources: true});
  if (!mirror.framesCurrent(report, revision)) throw new Error('The engine did not take the document.');
  const session = engine.handle.edit_session(JSON.stringify(state));
  if (!session) throw new Error('The engine did not start an edit session.');
  return session;
}

/** A session on `report` exactly as given (its JSON), without the mirror. */
export async function sessionFromDocument(report, state, revision = 1) {
  const {engine} = await nodeEngine();
  return engine.editSession(JSON.stringify(report), JSON.stringify(state), revision);
}
