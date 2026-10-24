#!/usr/bin/env node
// The engine's parity suite in one command (docs/RUST-ENGINE-PORT.md, "Parity harness").
//
//   npm run engine:parity                # the repository tier: needs nothing outside the checkout
//   npm run engine:parity -- --corpus    # also the private corpus (~/Downloads), where present
//
// Repository tier: the Rust fixture suites (IK, evaluation, effects, 3D, property channels, draw lists, the Pivot
// codec's recorded answers, command replays, the drawing raster engine), the container reader and writer (the app's open and save path against the Rust store)
// on every native file in the repository, and fixture regeneration (byte-stable: a fixture
// that changes means the editor's behaviour changed).
// Corpus tier: geometry of every tick of the benchmark files and of the catalogue's 3D scenes against the editor
// (engine/tools/reference.mjs + styk compare) and the Pivot codec replay when a recording
// exists. Exit code 1 when any check fails.
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
const styk = `engine/target/release/styk${windows ? '.exe' : ''}`;
/** Whether `paths` are as committed: no changed file and no new one (`git diff` misses new files). */
const unchanged = (...paths) => spawnSync('git', ['status', '--porcelain', '--untracked-files=all', '--', ...paths], {cwd: root, encoding: 'utf8'}).stdout.trim() === '';
const cargo = (...rest) => [nice[0] ?? 'cargo', [...nice.slice(1), ...(nice.length ? ['cargo'] : []), ...rest, '--manifest-path', 'engine/Cargo.toml']];

// Fixture suites (fast: a few seconds once built).
run('Rust fixture suites', ...cargo('test', '--release', '-p', 'styk-doc', '-p', 'styk-formats', '-p', 'styk-draw', '-p', 'styk-eval', '-p', 'styk-engine', '-p', 'styk-render', '-p', 'styk-raster', '-p', 'styk-export', '-p', 'styk-piv', '-p', 'styk-edit', '-p', 'styk-math', '-p', 'styk-drawing'));

// Fixture generators are byte-stable: regenerating changes nothing.
const editFixtureFolders = {'movieclip-native-vfx-fixtures': 'engine/tests/movieclip-native-vfx', 'movieclip-bake-fixtures': 'engine/tests/movieclip-bake', 'vfx-owner-edge-fixtures': 'engine/tests/vfx-owner-edges', 'movieclip-timed-sheet-planning-fixtures': 'engine/tests/movieclip-timed-sheet', 'movieclip-timed-sheet-commands-fixtures': 'engine/tests/movieclip-timed-sheet-commands', 'movieclip-timed-sheet-expansion-fixtures': 'engine/tests/movieclip-timed-sheet-expansion', 'movieclip-sheet-extension-fixtures': 'engine/tests/movieclip-sheet-extension', 'movieclip-native-extension-fixtures': 'engine/tests/movieclip-native-extension', 'movieclip-insertion-fixtures': 'engine/tests/movieclip-insertion', 'movieclip-admission-fixtures': 'engine/tests/movieclip-admission', 'movieclip-key-capacity-fixtures': 'engine/tests/movieclip-key-capacity', 'layer-migration-fixtures': 'engine/tests/layer-migration', 'layer-sheet-migration-fixtures': 'engine/tests/layer-sheet-migration', 'inbetween-fixtures': 'engine/tests/inbetween', 'history-fixtures': 'engine/tests/history', 'history-readiness-fixtures': 'engine/tests/history-readiness', 'publication-fixtures': 'engine/tests/publication', 'native-layer-publication-fixtures': 'engine/tests/native-layer-publication', 'publication-selection-fixtures': 'engine/tests/publication-selection', 'load-fixtures': 'engine/tests/load'};
for (const tool of ['movieclip-native-vfx-fixtures', 'movieclip-bake-fixtures', 'vfx-owner-edge-fixtures', 'ik-fixtures', 'eval-fixtures', 'vfx-fixtures', 'generator-fixtures', 'spatial-fixtures', 'origin-fixtures', 'origin-invalid-fixtures', 'origin-rig-invalid-fixtures', 'drawing-grid-fixtures', 'channel-fixtures', 'picking-fixtures', 'picking-construction-fixtures', 'picking-bounds-fixtures', 'movieclip-source-fixtures', 'movieclip-materialize-fixtures', 'movieclip-source-coverage-fixtures', 'movieclip-source-generator-fixtures', 'edit-scenarios-movieclips-presence', 'edit-scenarios-movieclips-membership', 'edit-scenarios-movieclips-timed', 'movieclip-timed-sheet-planning-fixtures', 'movieclip-timed-sheet-commands-fixtures', 'movieclip-timed-sheet-expansion-fixtures', 'movieclip-sheet-extension-fixtures', 'movieclip-native-extension-fixtures', 'movieclip-insertion-fixtures', 'movieclip-admission-fixtures', 'picking-joints-fixtures', 'document-fixtures', 'preview-fixtures', 'movieclip-key-capacity-fixtures', 'layer-migration-fixtures', 'layer-sheet-migration-fixtures', 'inbetween-fixtures', 'history-fixtures', 'history-readiness-fixtures', 'publication-fixtures', 'native-layer-publication-fixtures', 'publication-selection-fixtures', 'load-fixtures']) {
  if (!existsSync(path.join(root, `engine/tools/${tool}.mjs`))) continue;
  run(`${tool} regenerate unchanged`, process.execPath, [`engine/tools/${tool}.mjs`], {quiet: true,
    check: () => unchanged('engine/crates/styk-eval/tests/fixtures', ...(editFixtureFolders[tool] ? [editFixtureFolders[tool]] : []))});
}

// Recorded Canvas paint/sampling and composited-export source decisions stay byte-stable.
for (const [tool, folder] of [
  ['clip-paint-fixtures', 'engine/crates/styk-eval/tests/fixtures/clip-paint'],
  ['canvas-paint-fixtures', 'engine/crates/styk-raster/tests/fixtures/canvas-paint'],
  ['drawing-root-sampling-fixtures', 'engine/crates/styk-raster/tests/fixtures/drawing-root-sampling'],
  ['export-policy-fixtures', 'engine/crates/styk-export/tests/fixtures/policy'],
]) run(`${tool} regenerate unchanged`, process.execPath, [`engine/tools/${tool}.mjs`], {quiet: true,
  check: () => unchanged(folder)});

// V8's Math results for styk-math are byte-stable unless V8 changes.
run('math fixtures regenerate unchanged', process.execPath, ['engine/tools/math-fixtures.mjs'], {quiet: true,
  check: () => unchanged('engine/crates/styk-math/tests')});

// So is what the editor's evaluated frame stores (styk-eval's tests/records.rs compares).
run('record fixtures regenerate unchanged', process.execPath, ['engine/tools/records-fixtures.mjs'], {quiet: true,
  check: () => unchanged('engine/crates/styk-eval/tests/fixtures/records')});

// Command recordings are byte-stable too: re-recording them in the JavaScript editor changes
// nothing (styk-edit's test above replays them in the engine).
run('effect preset catalogue and scenarios regenerate unchanged', process.execPath, ['engine/tools/edit-vfx-scenarios.mjs'], {quiet: true,
  check: () => unchanged('engine/crates/styk-edit/src/vfx_presets.json', 'engine/tests/edit')});
run('edit recordings regenerate unchanged', process.execPath, ['engine/tools/edit-scenarios.mjs'], {quiet: true,
  check: () => spawnSync(process.execPath, ['engine/tools/edit-replay.mjs', '--all'], {cwd: root}).status === 0
    && unchanged('engine/tests/edit')});
run('native motion history and reads regenerate unchanged', process.execPath, ['engine/tools/origin-motion-native-history.mjs'], {quiet: true,
  check: () => unchanged('engine/tests/edit/origin-motion-native-history.json', 'engine/tests/edit/origin-motion-native-reads.json')});
run('saved native motion history regenerates unchanged', process.execPath, ['engine/tools/origin-motion-native-saved-history.mjs'], {quiet: true,
  check: () => unchanged('engine/tests/edit/origin-motion-native-saved-history.json')});
run('native draft displays regenerate unchanged', process.execPath, ['engine/tools/origin-motion-draft-records.mjs'], {quiet: true,
  check: () => unchanged('engine/tests/edit/origin-motion-draft-records.json')});

// Canonical Session handoff, quiet publication and live worker evidence share the
// same editor oracle; complete return views follow their lifecycle recordings.
for (const [tool, folder] of [
  ['session-handoff-fixtures', 'session-handoff'],
  ['session-quiet-fixtures', 'session-quiet'],
  ['session-live-fixtures', 'session-live'],
  ['session-live-return-fixtures', 'session-live-return'],
]) run(`${tool} regenerate unchanged`, process.execPath, [`engine/tools/${tool}.mjs`], {quiet: true,
  check: () => unchanged(`engine/tests/${folder}`)});

run('native transform projection fixtures regenerate unchanged', process.execPath,
  ['engine/tools/native-transform-projection-fixtures.mjs'], {quiet: true,
    check: () => unchanged('engine/tests/edit')});

run('native transform live fixtures regenerate unchanged', process.execPath,
  ['engine/tools/native-transform-projection-live-fixtures.mjs'], {quiet: true,
    check: () => unchanged('engine/tests/edit')});

run('typed pairing fixtures regenerate unchanged', process.execPath,
  ['engine/tools/typed-pairing-fixtures.mjs'], {quiet: true,
    check: () => unchanged('engine/tests/typed-pairing')});

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

if (args.has('--corpus')) {
  const home = os.homedir();
  const files = [`${home}/Downloads/TDD2 URIEL NEMESIS 3.styk`, `${home}/Downloads/Jay on a new app (repaired).styk`].filter(existsSync);
  for (const file of files) {
    const reference = path.join(os.tmpdir(), `styk-reference-${path.basename(file).replace(/\W+/g, '-')}.json`);
    run(`reference ${path.basename(file)}`, process.execPath, ['engine/tools/reference.mjs', file, reference, '--every', '1', '--vfx'], {quiet: true});
    run(`geometry and effects ${path.basename(file)}`, styk, ['compare', file, reference], {quiet: true,
      check: result => /, 0 mismatched primitives, \d+ joints, 0 mismatched joints, 0 frames with differences/.test(result.stdout) && !/[1-9]\d* mismatched effects/.test(result.stdout)});
  }
  if (!files.length) results.push({name: 'corpus (not present on this machine)', ok: true, seconds: 0});
  // 3D scenes of the asset catalogue (meshes, surfaces, mechanisms): geometry at every tick.
  for (const file of ['AssetReleases/3D-Guns/Scenes/15-Guns-Pivot-3D.styk', 'AssetReleases/Hand-and-Face/Scenes/Hand-and-Face-Pivot-3D.styk',
    'AssetReleases/Vehicles/Scenes/Vehicles-Pivot-3D.styk', 'AssetReleases/Impact-FX/Scenes/Impact-Motion-FX-Pivot.styk'].filter(file => existsSync(path.join(root, file)))) {
    const reference = path.join(os.tmpdir(), `styk-reference-${path.basename(file).replace(/\W+/g, '-')}.json`);
    run(`reference ${path.basename(file)}`, process.execPath, ['engine/tools/reference.mjs', file, reference, '--every', '1'], {quiet: true});
    run(`geometry ${path.basename(file)}`, styk, ['compare', file, reference], {quiet: true,
      check: result => /, 0 mismatched primitives, \d+ joints, 0 mismatched joints, 0 frames with differences/.test(result.stdout)});
  }
  // The evaluated frame as records, every tick, against the editor (hashes: the frames are large).
  for (const file of files) {
    const folder = path.join(os.tmpdir(), `styk-records-${path.basename(file).replace(/\W+/g, '-')}`);
    run(`records reference ${path.basename(file)}`, process.execPath, ['--max-old-space-size=12000', 'engine/tools/records-reference.mjs', file, folder], {quiet: true});
    run(`evaluated records ${path.basename(file)}`, styk, ['records', folder], {quiet: true});
  }
  const recording = path.join(root, 'engine/target/piv-parity');
  if (existsSync(recording)) run('Pivot codec replay', ...cargo('run', '--release', '-p', 'styk-piv', '--bin', 'styk-piv', '--', 'replay', recording), {quiet: true});
}

console.log('\nEngine parity');
for (const {name, ok, seconds} of results) console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name} (${seconds.toFixed(1)} s)`);
process.exit(results.every(result => result.ok) ? 0 : 1);
