// Shared by the engine build and the native portability guard. Importing these
// settings neither probes tools nor builds modules.
import path from 'node:path';

export const TOOLCHAIN = 'nightly-2026-09-15';
// Every thread shares one memory; its 2 GiB maximum is fixed when it links.
export const MAX_MEMORY = 2147483648;
export const THREADED_WASM_ARGS = Object.freeze([
  '--target', 'wasm32-unknown-unknown', '-Z', 'build-std=std,panic_abort',
]);
const rustflags = ['-C', 'target-feature=+atomics,+bulk-memory,+mutable-globals,+simd128', '-C', 'link-arg=--shared-memory', '-C', 'link-arg=--import-memory',
  '-C', `link-arg=--max-memory=${MAX_MEMORY}`, '-C', 'link-arg=--export=__wasm_init_tls', '-C', 'link-arg=--export=__tls_size',
  '-C', 'link-arg=--export=__tls_align', '-C', 'link-arg=--export=__tls_base'];

export function threadedWasmEnv(targetBase, env = process.env) {
  return {...env, CARGO_ENCODED_RUSTFLAGS: rustflags.join('\x1f'), CARGO_TARGET_DIR: path.join(targetBase, 'wasm-threads')};
}
