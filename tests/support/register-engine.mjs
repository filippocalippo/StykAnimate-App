// Preloaded by `npm test` (node --import): the engine opens every document, so a test that loads one into an
// Editor runs on it. No worker threads in Node: the engine's background work runs in slices on this thread.
import {existsSync} from 'node:fs';
import {loadEngine} from '../../src/engine/engine.mjs';
import {useEngine} from '../../src/engine/engine-open.mjs';

if (existsSync(new URL('../../src/engine/pkg/styk_engine_bg.wasm', import.meta.url))) useEngine(await loadEngine({workers: 0}));
