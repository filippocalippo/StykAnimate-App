/**
 * Builds the engine's three WebAssembly modules into src/engine/pkg/ (git-ignored):
 *
 *   node scripts/engine-build.mjs            release build (wasm-opt when available)
 *   node scripts/engine-build.mjs --dev      iteration build (profile wasm-dev): seconds, for diagnosis, never for a measured result
 *
 * - The engine (`styk-wasm`, styk_engine.js) uses WebAssembly threads over one shared
 *   memory, which needs the standard library rebuilt with atomics: the pinned nightly
 *   toolchain below, with `rust-src` and the wasm32 target (see docs/engine/wasm.md).
 * - The Pivot codec (`styk-codec-wasm`, styk_codec.js), which src/codec-web-worker.mjs
 *   runs, has no threads: stable Rust with the wasm32 target builds it.
 * - The drawing raster engine (`styk-drawing-wasm`, styk_drawing.js), which every drawing
 *   worker and the brush model load through src/engine/engine-drawing.mjs, has no threads
 *   either (docs/engine/decisions/0017-drawing-raster-engine.md).
 *
 * Both need wasm-bindgen-cli at the version below.
 */
import {spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, statSync, writeFileSync, readFileSync, copyFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const engine = path.join(root, 'engine');
const out = path.join(root, 'src/engine/pkg');
export const TOOLCHAIN = 'nightly-2026-09-15';
export const WASM_BINDGEN = '0.2.129';
// The codec needs no atomics, so the stable toolchain builds it.
export const CODEC_TOOLCHAIN = 'stable';
// 2 GiB of address space: every thread shares it, and a shared memory's maximum is fixed when it links.
const MAX_MEMORY = 2147483648;
const dev = process.argv.includes('--dev');
const profile = dev ? 'wasm-dev' : 'wasm';
// Worktrees share one target directory through CARGO_TARGET_DIR: build caches are what fills the disk.
const target = process.env.CARGO_TARGET_DIR ? path.resolve(process.env.CARGO_TARGET_DIR) : path.join(engine, 'target');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {stdio: 'inherit', cwd: engine, ...options});
  if (result.error) throw new Error(`${command}: ${result.error.message}`);
  if (result.status !== 0) process.exit(result.status ?? 1);
}
function has(command, args = ['--version']) {
  const result = spawnSync(command, args, {encoding: 'utf8'});
  return result.status === 0 ? result.stdout.trim() : null;
}

const bindgen = has('wasm-bindgen');
if (!bindgen?.endsWith(WASM_BINDGEN))
  throw new Error(`wasm-bindgen ${WASM_BINDGEN} is required (found ${bindgen ?? 'none'}): cargo install wasm-bindgen-cli --version ${WASM_BINDGEN} --locked`);

const rustflags = ['-C', 'target-feature=+atomics,+bulk-memory,+mutable-globals', '-C', 'link-arg=--shared-memory', '-C', 'link-arg=--import-memory',
  '-C', `link-arg=--max-memory=${MAX_MEMORY}`, '-C', 'link-arg=--export=__wasm_init_tls', '-C', 'link-arg=--export=__tls_size',
  '-C', 'link-arg=--export=__tls_align', '-C', 'link-arg=--export=__tls_base'];
run('cargo', [`+${TOOLCHAIN}`, 'build', '--profile', profile, '-p', 'styk-wasm', '--target', 'wasm32-unknown-unknown', '-Z', 'build-std=std,panic_abort'],
  {env: {...process.env, CARGO_ENCODED_RUSTFLAGS: rustflags.join('\x1f'), CARGO_TARGET_DIR: path.join(target, 'wasm-threads')}});

mkdirSync(out, {recursive: true});
const built = path.join(target, 'wasm-threads/wasm32-unknown-unknown', profile, 'styk_wasm.wasm');
run('wasm-bindgen', ['--target', 'web', '--out-dir', out, '--out-name', 'styk_engine', '--no-typescript', ...(dev ? ['--keep-debug'] : ['--remove-name-section', '--remove-producers-section']), built]);
const wasm = path.join(out, 'styk_engine_bg.wasm');
const before = statSync(wasm).size;
if (!dev && has('wasm-opt')) {
  run('wasm-opt', ['-O3', '--enable-threads', '--enable-bulk-memory', '--enable-mutable-globals', '--enable-nontrapping-float-to-int', '--enable-sign-ext', '--enable-simd', '-o', wasm, wasm]);
}

// The codec: no shared memory, no threads. `--experimental-reset-state-function` lets the
// worker replace an instance that trapped (a panic aborts) with a fresh one.
run('cargo', [`+${CODEC_TOOLCHAIN}`, 'build', '--profile', profile, '-p', 'styk-codec-wasm', '-p', 'styk-drawing-wasm', '--target', 'wasm32-unknown-unknown'],
  {env: {...process.env, CARGO_TARGET_DIR: path.join(target, 'wasm-codec')}});
const codecBuilt = path.join(target, 'wasm-codec/wasm32-unknown-unknown', profile, 'styk_codec_wasm.wasm');
run('wasm-bindgen', ['--target', 'web', '--out-dir', out, '--out-name', 'styk_codec', '--no-typescript', '--experimental-reset-state-function',
  ...(dev ? ['--keep-debug'] : ['--remove-name-section', '--remove-producers-section']), codecBuilt]);
const codecWasm = path.join(out, 'styk_codec_bg.wasm');
const codecBefore = statSync(codecWasm).size;
if (!dev && has('wasm-opt')) {
  run('wasm-opt', ['-O3', '--enable-bulk-memory', '--enable-mutable-globals', '--enable-nontrapping-float-to-int', '--enable-sign-ext',
    '--enable-reference-types', '--enable-multivalue', '-o', codecWasm, codecWasm]);
}

// The drawing engine: built with the codec (same toolchain and target directory).
const drawingBuilt = path.join(target, 'wasm-codec/wasm32-unknown-unknown', profile, 'styk_drawing_wasm.wasm');
run('wasm-bindgen', ['--target', 'web', '--out-dir', out, '--out-name', 'styk_drawing', '--no-typescript', '--experimental-reset-state-function',
  ...(dev ? ['--keep-debug'] : ['--remove-name-section', '--remove-producers-section']), drawingBuilt]);
const drawingWasm = path.join(out, 'styk_drawing_bg.wasm');
const drawingBefore = statSync(drawingWasm).size;
if (!dev && has('wasm-opt')) {
  run('wasm-opt', ['-O3', '--enable-bulk-memory', '--enable-mutable-globals', '--enable-nontrapping-float-to-int', '--enable-sign-ext',
    '--enable-reference-types', '--enable-multivalue', '-o', drawingWasm, drawingWasm]);
}

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const bytes = readFileSync(wasm), codecBytes = readFileSync(codecWasm), drawingBytes = readFileSync(drawingWasm);
const info = {profile, toolchain: TOOLCHAIN, wasmBindgen: WASM_BINDGEN, maxMemory: MAX_MEMORY, wasmBytes: bytes.length, wasmBytesBeforeOpt: before,
  jsBytes: statSync(path.join(out, 'styk_engine.js')).size, sha256: sha256(bytes),
  codec: {toolchain: CODEC_TOOLCHAIN, rustc: has('rustc', [`+${CODEC_TOOLCHAIN}`, '--version']), wasmBytes: codecBytes.length,
    wasmBytesBeforeOpt: codecBefore, jsBytes: statSync(path.join(out, 'styk_codec.js')).size, sha256: sha256(codecBytes)},
  drawing: {toolchain: CODEC_TOOLCHAIN, wasmBytes: drawingBytes.length, wasmBytesBeforeOpt: drawingBefore,
    jsBytes: statSync(path.join(out, 'styk_drawing.js')).size, sha256: sha256(drawingBytes)}};
writeFileSync(path.join(out, 'build-info.json'), JSON.stringify(info, null, 2));
const unoptimized = !dev && !has('wasm-opt') ? ' — wasm-opt not found, module not size-optimized' : '';
console.log(`engine: ${path.relative(root, wasm)} ${(bytes.length / 1024).toFixed(0)} KiB (${info.sha256.slice(0, 12)})${unoptimized}`);
console.log(`codec: ${path.relative(root, codecWasm)} ${(codecBytes.length / 1024).toFixed(0)} KiB (${info.codec.sha256.slice(0, 12)})${unoptimized}`);
console.log(`drawing: ${path.relative(root, drawingWasm)} ${(drawingBytes.length / 1024).toFixed(0)} KiB (${info.drawing.sha256.slice(0, 12)})${unoptimized}`);
