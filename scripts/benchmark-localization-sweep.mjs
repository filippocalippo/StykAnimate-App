import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile, readdir, mkdir, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';

// Fresh processes isolate module caches and retained catalog objects. This is a
// Node import experiment, not an Electron/browser startup benchmark or a change
// to the production localization implementation.
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const label = process.argv[2] ?? 'localization-sweep';
const rounds = Number(process.argv[3] ?? 5);
const selectedLocale = process.argv[4] ?? 'it';
assert.match(label, /^[a-zA-Z0-9_-]+$/);
assert.ok(Number.isInteger(rounds) && rounds >= 3 && rounds <= 30);
assert.match(selectedLocale, /^[a-zA-Z0-9-]+$/);
const output = path.join(root, 'artifacts', 'performance-sweep', label, 'localization.json');
const sources = new Map();
const slash = value => value.split(path.sep).join('/');

async function source(file) {
  if (!sources.has(file)) sources.set(file, await readFile(file));
  return sources.get(file);
}

// Static relative import/export graph only: excludes dynamic imports, Worker
// URLs, Wasm, CSS and JSON fetched at runtime. This is source volume, not bytes
// actually transferred by a browser, parsed machine code, or retained heap.
async function graph(entry) {
  const visited = new Set(), edges = new Map();
  async function visit(file) {
    if (visited.has(file)) return;
    visited.add(file);
    const contents = (await source(file)).toString('utf8');
    const imports = /(?:^|[;\r\n])\s*(?:import|export)\s+(?:[^;'"\r\n]*(?:[\r\n][^;'"\r\n]*)*?\s+from\s*)?['"]([^'"]+)['"]/g;
    const targets = [...contents.matchAll(imports)].map(match => match[1])
      .filter(value => value.startsWith('.')).map(value => path.resolve(path.dirname(file), value));
    edges.set(file, targets);
    for (const target of targets) await visit(target);
  }
  await visit(path.join(root, entry));
  const files = [...visited].map(file => ({file: slash(path.relative(root, file)), bytes: sources.get(file).byteLength}));
  const target = path.join(root, 'src', 'localization.mjs'), queue = [[path.join(root, entry)]], searched = new Set();
  let localizationPath = null;
  for (let index = 0; index < queue.length; index++) {
    const trail = queue[index], file = trail.at(-1);
    if (searched.has(file)) continue;
    searched.add(file);
    if (file === target) { localizationPath = trail.map(item => slash(path.relative(root, item))); break; }
    for (const dependency of edges.get(file) ?? []) queue.push([...trail, dependency]);
  }
  return {entry, modules: files.length, bytes: files.reduce((sum, file) => sum + file.bytes, 0),
    includesAllPacks: visited.has(path.join(root, 'src', 'locales', 'locale-packs.mjs')), localizationPath,
    directLocalizationImporters: [...edges].filter(([, targets]) => targets.includes(target))
      .map(([file]) => slash(path.relative(root, file))).sort(),
    largest: files.sort((a, b) => b.bytes - a.bytes).slice(0, 5)};
}

const graphEntries = ['src/app.mjs', 'src/localization.mjs', 'src/localized-error.mjs',
  'src/document-export-worker.mjs',
  'src/preview-image-worker.mjs', 'src/media-image-worker.mjs', 'src/import-worker.mjs',
  'src/clipboard-worker.mjs', 'src/audio-worker.mjs'];
const graphs = [];
for (const entry of graphEntries) graphs.push(await graph(entry));
const packs = [];
for (const name of (await readdir(path.join(root, 'src', 'locales', 'packs'))).filter(name => name.endsWith('.json')).sort()) {
  const file = path.join(root, 'src', 'locales', 'packs', name), bytes = await source(file);
  const pack = JSON.parse(bytes.toString('utf8'));
  packs.push({id: pack.locale.id, keys: Object.keys(pack.messages).length, sourceBytes: bytes.byteLength,
    compactJsonBytes: Buffer.byteLength(JSON.stringify(pack))});
}
const selected = packs.find(pack => pack.id === selectedLocale);
assert.ok(selected && selected.id !== 'en', 'Choose an existing non-English locale for the projection.');
await source(path.join(root, 'scripts', 'build-locales.mjs'));
await source(fileURLToPath(import.meta.url));
const hashes = () => Object.fromEntries([...sources].sort(([a], [b]) => a.localeCompare(b))
  .map(([file, bytes]) => [slash(path.relative(root, file)), createHash('sha256').update(bytes).digest('hex')]));

const cases = [
  {id: 'baseline', entry: null},
  {id: 'localization', entry: 'src/localization.mjs'},
  {id: 'english', entry: 'src/locales/en.mjs'},
  {id: 'errors', entry: 'src/localized-error.mjs'},
  {id: 'oneLocaleProjection', entry: 'src/locales/en.mjs', projection: `src/locales/packs/${selectedLocale}.json`},
];
const samples = [];
for (let round = 0; round < rounds; round++) {
  // Alternating forward/reverse order limits a systematic warm filesystem-cache
  // advantage. These are fresh processes, not cold operating-system disk caches.
  const order = round % 2 ? [...cases].reverse() : cases;
  for (const item of order) {
    const configuration = {entry: item.entry ? pathToFileURL(path.join(root, item.entry)).href : null,
      projection: item.projection ? path.join(root, item.projection) : null};
    const childSource = `
      const config = ${JSON.stringify(configuration)};
      globalThis.gc();
      const before = process.memoryUsage(), start = performance.now();
      let imported, projection;
      if (config.entry) imported = await import(config.entry);
      let englishReadyMs = performance.now() - start;
      if (config.projection) {
        const {readFile} = await import('node:fs/promises');
        projection = JSON.parse(await readFile(config.projection, 'utf8'));
        for (const message of Object.values(projection.messages)) if (typeof message === 'object') Object.freeze(message);
        Object.freeze(projection.messages);
        if (projection.locale.aliases) Object.freeze(projection.locale.aliases);
        Object.freeze(projection.locale); Object.freeze(projection);
      }
      const importMs = performance.now() - start, ready = process.memoryUsage();
      globalThis.gc();
      const retained = process.memoryUsage();
      const metadata = config.projection ? {selectedLocale: projection.locale.id, keys: Object.keys(projection.messages).length}
        : config.entry?.endsWith('/localization.mjs') ? {locales: imported.SUPPORTED_LOCALES.length}
        : config.entry?.endsWith('/en.mjs') ? {keys: Object.keys(imported.default).length} : {};
      console.log(JSON.stringify({importMs, englishReadyMs, before, ready, retained, metadata,
        heapDeltaBytes: retained.heapUsed-before.heapUsed, rssDeltaBytes: retained.rss-before.rss}));
    `;
    const started = performance.now();
    const child = spawnSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', childSource],
      {cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 65536});
    const processWallMs = performance.now() - started;
    assert.equal(child.status, 0, child.error?.message || child.stderr || 'Import child failed.');
    const result = JSON.parse(child.stdout.trim());
    const row = {case: item.id, round, processWallMs, ...result};
    samples.push(row);
    console.log(JSON.stringify({case: item.id, round, importMs: result.importMs, processWallMs,
      heapDeltaMiB: result.heapDeltaBytes / 1048576, rssDeltaMiB: result.rssDeltaBytes / 1048576}));
  }
}

function stats(rows, key) {
  const values = rows.map(row => row[key]).sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  return {min: values[0], median: values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2, max: values.at(-1)};
}
const summary = Object.fromEntries(cases.map(item => {
  const rows = samples.filter(row => row.case === item.id);
  return [item.id, Object.fromEntries(['importMs', 'processWallMs', 'heapDeltaBytes', 'rssDeltaBytes']
    .map(key => [key, stats(rows, key)]))];
}));
const allPackBytes = (await source(path.join(root, 'src', 'locales', 'locale-packs.mjs'))).byteLength;
const maximumPack = [...packs].sort((a, b) => b.sourceBytes - a.sourceBytes)[0];
const projection = {
  selected, maximumPack, allPackBytes,
  selectedSourceReductionPercent: (1 - selected.sourceBytes / allPackBytes) * 100,
  maximumSourceReductionPercent: (1 - maximumPack.sourceBytes / allPackBytes) * 100,
  observedImportDifferenceMs: summary.localization.importMs.median - summary.oneLocaleProjection.importMs.median,
  observedHeapDifferenceBytes: summary.localization.heapDeltaBytes.median - summary.oneLocaleProjection.heapDeltaBytes.median,
  interpretation: 'The projection measures English plus one parsed/frozen JSON pack, without the production localization service or loader. Differences are candidate ceilings for this harness, not achieved app startup/worker gains. English/error imports are lower-bound controls, not a replacement implementation.',
};
const changedSourcePaths = [];
for (const [file, original] of sources) {
  if (!original.equals(await readFile(file))) changedSourcePaths.push(slash(path.relative(root, file)));
}
const report = {at: new Date().toISOString(), command: `node scripts/benchmark-localization-sweep.mjs ${label} ${rounds} ${selectedLocale}`,
  environment: {node: process.version, executable: process.execPath, platform: process.platform, architecture: process.arch,
    os: os.release(), cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, totalMemoryBytes: os.totalmem()},
  rounds, summary, projection, graphs, packs, samples, sourceHashes: hashes(), changedSourcePaths,
  limitations: ['Node fresh-process lab samples on this workstation; Electron/Chromium worker timing is not measured.',
    'Operating-system caches are uncontrolled; process wall time includes startup and exit, while importMs excludes them.',
    'Explicit GC makes retained heap comparable and does not model normal application GC pauses.',
    'Source graph is a regex inventory of static relative imports/exports, not runtime network traffic or a bundle analyzer.',
    'RSS is process residency, not unique physical memory; graph source bytes cannot be multiplied into a working-set estimate.',
    'Per-language loading must preserve fallback, formatting, live language changes, native menu updates and offline availability.',
    'No production code changed and no end-to-end performance improvement is established.']};
await mkdir(path.dirname(output), {recursive: true});
await writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({output: slash(path.relative(root, output)), summary, projection, changedSourcePaths}));
assert.deepEqual(changedSourcePaths, [], 'Source changed during the measurement; rerun before making current-tree claims.');
