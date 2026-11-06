#!/usr/bin/env node
// The engine's parity suite in one command (docs/RUST-ENGINE-PORT.md, "Parity harness").
//
//   npm run engine:parity                # the repository tier: needs nothing outside the checkout
//   npm run engine:parity -- --corpus    # also the Pivot codec's recorded answers, where a recording exists
//
// Repository tier: the Rust fixture suites (IK, evaluation, effects, 3D, property channels, draw lists, the Pivot
// codec's recorded answers, the command tapes, the drawing raster engine), V8's own Math against the styk-math
// fixtures, the container reader and writer (the app's open and save path against the Rust store) on every native
// file in the repository, and the live-worker replays. The recorded fixtures and tapes are frozen (docs/engine/README.md, "Fixtures"):
// nothing regenerates them from the JavaScript any more, so the engine is checked against them as they are.
// Exit code 1 when any check fails.
import {spawnSync} from 'node:child_process';
import {existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const args = new Set(process.argv.slice(2));
const results = [];
const run = (name, command, commandArgs, options = {}) => {
  const started = Date.now();
  const result = spawnSync(command, commandArgs, {cwd: root, stdio: options.quiet ? 'pipe' : 'inherit', encoding: 'utf8', ...options});
  const ok = result.status === 0 && (!options.check || options.check(result));
  results.push({name, ok, seconds: (Date.now() - started) / 1000});
  if (!ok && options.quiet) process.stdout.write(`${result.stdout ?? ''}${result.stderr ?? ''}`.split('\n').slice(-30).join('\n') + '\n');
  return result;
};
const windows = process.platform === 'win32';
const nice = windows ? [] : ['nice', '-n', '10'];
const styk = path.join(process.env.CARGO_TARGET_DIR ?? 'engine/target', 'release', `styk${windows ? '.exe' : ''}`);
/** Whether `paths` are as committed: no changed file and no new one (`git diff` misses new files). */
const unchanged = (...paths) => spawnSync('git', ['status', '--porcelain', '--untracked-files=all', '--', ...paths], {cwd: root, encoding: 'utf8'}).stdout.trim() === '';
const cargo = (...rest) => [nice[0] ?? 'cargo', [...nice.slice(1), ...(nice.length ? ['cargo'] : []), ...rest, '--manifest-path', 'engine/Cargo.toml']];

// Fixture suites (fast: a few seconds once built).
run('Rust fixture suites', ...cargo('test', '--release', '-p', 'styk-doc', '-p', 'styk-formats', '-p', 'styk-draw', '-p', 'styk-eval', '-p', 'styk-engine', '-p', 'styk-render', '-p', 'styk-raster', '-p', 'styk-export', '-p', 'styk-piv', '-p', 'styk-edit', '-p', 'styk-math', '-p', 'styk-drawing'));

// V8's Math results for styk-math are byte-stable unless V8 changes.
run('math fixtures regenerate unchanged', process.execPath, ['engine/tools/math-fixtures.mjs'], {quiet: true,
  check: () => unchanged('engine/crates/styk-math/tests')});

// Containers: every native file in the repository, read and written again by the app's path against the Rust store.
// The repository's own are engine/tests/containers (container-fixtures.mjs writes them through the app's save path,
// byte-stable); files of the local asset packs and artifacts are compared too where they exist.
run('container fixtures regenerate unchanged', process.execPath, ['engine/tools/container-fixtures.mjs'], {quiet: true,
  check: () => unchanged('engine/tests/containers')});
run('styk CLI build', ...cargo('build', '--release', '-p', 'styk-cli'), {quiet: true});
// Complete-return recordings identify the admitted live-worker pairs; async
// preflight tapes have no admitted return recording and remain explicit guards.
const livePairs = readdirSync(path.join(root, 'engine/tests/session-live-return'))
  .filter(name => name.endsWith('.json')).sort()
  .flatMap(name => [`engine/tests/session-live/${name}`, `engine/tests/session-live-return/${name}`]);
run('live worker command replays', styk,
  ['edit-replay', '--live-worker', ...livePairs], {quiet: true});
const natives = [];
const walk = dir => {
  for (const entry of readdirSync(path.join(root, dir), {withFileTypes: true})) {
    const relative = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (!['node_modules', 'target', '.git', 'tmp', 'build', 'dist'].includes(entry.name) && !entry.name.startsWith('.')) walk(relative); }
    else if (/\.(styk|stkz|stykmov)$/i.test(entry.name) && statSync(path.join(root, relative)).size < 64 * 1024 * 1024) natives.push(path.join(root, relative));
  }
};
for (const dir of ['artifacts', 'AssetReleases', 'tests', 'assets', 'engine/tests/containers']) if (existsSync(path.join(root, dir))) walk(dir);
const temp = mkdtempSync(path.join(os.tmpdir(), 'styk-parity-'));
try {
  const list = path.join(temp, 'native-files.txt');
  writeFileSync(list, natives.join('\n') + '\n');
  // A stage that compares nothing must not pass: engine/tests/containers always holds files.
  if (natives.length) run(`containers (${natives.length} repository files)`, process.execPath, ['engine/tools/container-parity.mjs', list], {quiet: true});
  else results.push({name: 'containers (no native files found)', ok: false, seconds: 0});
} finally { rmSync(temp, {recursive: true, force: true}); }

// The Pivot codec against what the Python codec answered for the private corpus, where a recording exists
// (engine/tools/piv/parity.sh records it).
if (args.has('--corpus')) {
  const recording = path.join(root, 'engine/target/piv-parity');
  if (existsSync(recording)) run('Pivot codec replay', ...cargo('run', '--release', '-p', 'styk-piv', '--bin', 'styk-piv', '--', 'replay', recording), {quiet: true});
  else results.push({name: 'Pivot codec replay (no recording: engine/tools/piv/parity.sh makes one)', ok: true, seconds: 0});
}

console.log('\nEngine parity');
for (const {name, ok, seconds} of results) console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name} (${seconds.toFixed(1)} s)`);
process.exit(results.every(result => result.ok) ? 0 : 1);
