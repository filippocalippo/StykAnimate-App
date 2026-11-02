// Bundles the desktop app's scripts into build/app, so that the page loads a few files instead of about 370 modules.
//
//   npm run app:bundle                         build/app
//   STYK_BUNDLE_DIR=build/app electron .       the source tree, served with that bundle (desktop/web-host.cjs)
//
// build/app is an overlay on the web assets (the files package.json's "web" resource item ships, which stay as they are:
// the main process still reads some modules from them, the Pivot codec's and the drawing engine's glue are loaded by
// URL, and the browser build serves them unbundled). Its files answer in place of the same paths: the page (index.html,
// with the bundle's files preloaded), the application (src/app.mjs), the engine's first script, every worker, and the
// chunks they share (src/chunks/). `before-pack.cjs` runs this build and the packager ships the result as resources/bundle.
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ERROR_MODULES } from '../src/telemetry-schema.mjs';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** Electron 39's Chromium. */
const TARGET = 'chrome142';
/** Loaded by the page, by URL, and kept as separate entries. The modules the benchmark imports from the page (it reads the engine's memory and
 * patches `PlaybackMetrics`) and the export renderer the determinism smoke creates are entries so that they meet the application's module
 * and not a second copy; tests/app-bundle.test.mjs keeps the list in step with the scripts. */
const PAGE_ENTRIES = ['src/app.mjs', 'src/engine/engine-start.mjs', 'src/engine/engine.mjs', 'src/engine/engine-export.mjs', 'src/playback-metrics.mjs', 'src/canvas-interactions.mjs', 'src/renderer-geometry.mjs'];
/** The page's tables of where its bundled lines came from (frameTable), a classic script the page runs before its modules. */
const FRAME_SCRIPT = 'src/frame-map.js';
/** The one stylesheet index.html links. */
const STYLESHEET = 'src/styles/app.css';
const LAUNCH_ENTRIES = ['src/app.mjs', 'src/engine/engine-start.mjs'];

async function* walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

const entryMap = (files) => Object.fromEntries(files.sort().map((file) => [file.slice(0, -'.mjs'.length), file]));

/** The entry points: `page` is what the page loads, bundled together so that what it shares is loaded once; `workers`
 * is every worker script, each bundled on its own (a worker starts alone, and `new Worker(new URL('./x-worker.mjs',
 * import.meta.url))` finds the entry at its own path). Maps such as { 'src/app': 'src/app.mjs' }. */
export async function appEntries(root = appRoot) {
  const workers = [];
  for await (const file of walk(path.join(root, 'src'))) {
    const relative = path.relative(root, file).split(path.sep).join('/');
    if (relative.endsWith('-worker.mjs') && !relative.startsWith('src/engine/pkg/')) workers.push(relative);
  }
  return { page: entryMap([...PAGE_ENTRIES]), workers: entryMap(workers) };
}

/** What the bundle changes in a module's text:
 * - Modules locate their neighbours with `new URL('./x', import.meta.url)`; in a bundle `import.meta.url` is the bundle's file,
 *   so each module's own path is written in its place.
 * - A vendored library's licence header (a doc comment first in its file that names a licence) becomes a legal comment (`/*!`),
 *   which esbuild keeps at the end of the bundle's file; a plain comment it would drop. */
function sourceText(root) {
  return {
    name: 'source-text',
    setup(build) {
      build.onLoad({ filter: /\.m?js$/ }, async ({ path: file }) => {
        const relative = path.relative(root, file);
        if (relative.startsWith('..') || relative.split(path.sep).includes('node_modules')) return null;
        const original = await readFile(file, 'utf8');
        let text = original;
        if (relative.split(path.sep)[0] === 'vendor') text = text.replace(/^\/\*\*(?=(?:(?!\*\/)[^])*licen[sc]e)/i, '/*!');
        if (text.includes('import.meta.url')) {
          const url = `(self.location.origin+${JSON.stringify(`/${relative.split(path.sep).join('/')}`)})`;
          text = text.replaceAll('import.meta.url', url);
        }
        return text === original ? null : { contents: text, loader: 'js' };
      });
    },
  };
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
/** The numbers of one source-map segment (base64 VLQ). */
function segmentNumbers(segment) {
  const numbers = [];
  let shift = 0, value = 0;
  for (const character of segment) {
    const digit = BASE64.indexOf(character);
    value += (digit & 31) << shift;
    if (digit & 32) shift += 5;
    else { numbers.push(value & 1 ? -(value >> 1) : value >> 1); value = 0; shift = 0; }
  }
  return numbers;
}

/** For each generated line (0-based) the source file and 0-based line of its first mapping, or undefined where it has none. */
function mappedLines(mappings) {
  const lines = [];
  let source = 0, sourceLine = 0;
  for (const line of mappings.split(';')) {
    let first;
    if (line) for (const segment of line.split(',')) {
      const numbers = segmentNumbers(segment);
      if (numbers.length < 4) continue;
      source += numbers[1];
      sourceLine += numbers[2];
      first ??= [source, sourceLine];
    }
    lines.push(first);
  }
  return lines;
}

/**
 * Where a line of a bundled file came from, for the crash reports that name only module basenames and line numbers
 * (src/telemetry-schema.mjs): `[module, lastLine, bundleLine, sourceLine, bundleLine, sourceLine, ...]` for each run of lines
 * (1-based, as a stack trace counts them) that came from one of the modules reports may name. A run lists a pair wherever the
 * distance between the two numbers changes, so a line of the run is found from the last pair at or before it.
 */
export function frameTable(map, allowed = new Set(ERROR_MODULES)) {
  const names = map.sources.map((source) => path.posix.basename(source));
  const runs = [];
  let run = null;
  mappedLines(map.mappings).forEach((entry, index) => {
    if (!entry) return;
    const module = names[entry[0]], bundleLine = index + 1, sourceLine = entry[1] + 1;
    if (!allowed.has(module)) { run = null; return; }
    if (!run || run[0] !== module) runs.push(run = [module, bundleLine, bundleLine, sourceLine]);
    else if (sourceLine - bundleLine !== run.at(-1) - run.at(-2)) run.push(bundleLine, sourceLine);
    run[1] = bundleLine;
  });
  return runs;
}

/** The statement that hands a bundle's tables to the code that builds crash reports. */
const frameStatement = (tables) => `globalThis.__stykFrames=Object.assign(globalThis.__stykFrames??{},${JSON.stringify(tables)});`;

/** The stylesheet imports its ninety-odd files with `@import`; bundled, it is one request. Fonts and images stay files of
 * the web assets, and their `url()`s are rewritten to be right from the bundled sheet's own place. */
function stylesheetAssets(root, sheet) {
  return {
    name: 'stylesheet-assets',
    setup(build) {
      build.onResolve({ filter: /\.(woff2?|ttf|svg|png|jpe?g|webp|gif)$/i }, ({ path: url, resolveDir }) => {
        const target = path.resolve(resolveDir, url);
        return { path: path.relative(path.dirname(sheet), target).split(path.sep).join('/'), external: true };
      });
    },
  };
}

/** The page with the bundle's launch files preloaded where it preloaded the engine's modules. */
export function bundledIndex(html, preloads) {
  const line = /^[ \t]*<link rel="modulepreload"[^>]*>\r?\n/gm;
  const first = html.search(line);
  if (first < 0) throw new Error('index.html has no modulepreload links to replace with the bundle\'s.');
  const indent = /^[ \t]*/.exec(html.slice(first))[0];
  const links = preloads.map((href) => `${indent}<link rel="modulepreload" href="${href}" />\n`).join('');
  const bundled = html.slice(0, first) + links + html.slice(first).replace(line, '');
  const theme = '<script src="./src/theme-bootstrap.js"></script>';
  if (!bundled.includes(theme)) throw new Error('index.html does not load src/theme-bootstrap.js, which the frame tables go before.');
  return bundled.replace(theme, () => `<script src="./${FRAME_SCRIPT}"></script>\n${indent}${theme}`);
}

/** The files `entry` loads when it starts: its static imports, and theirs. Paths as the metafile has them. */
function launchFiles(metafile, entry) {
  const seen = new Set(), pending = [entry];
  while (pending.length) {
    const file = pending.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const item of metafile.outputs[file].imports) if (item.kind === 'import-statement') pending.push(item.path);
  }
  return seen;
}

/** Builds the bundle. Needs the engine built (src/engine/pkg/styk_engine.js). The output belongs inside `root` (as build/app does): the same
 * source builds the same files there, byte for byte, but the chunks' names change with where the output is. */
export async function buildApp({ root = appRoot, output = path.join(root, 'build', 'app') } = {}) {
  const { build } = await import('esbuild');
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  const entries = await appEntries(root);
  const options = {
    absWorkingDir: root,
    outdir: path.relative(root, output),
    outExtension: { '.js': '.mjs' },
    bundle: true,
    format: 'esm',
    target: TARGET,
    legalComments: 'eof',
    // Read once, by frameTable, and not shipped.
    sourcemap: 'external',
    sourcesContent: false,
    // Code that reaches Node (guarded by a check for it) stays a plain import, never run in the page.
    external: ['node:*', 'fs'],
    plugins: [sourceText(root)],
    metafile: true,
    logLevel: 'warning',
  };
  const sheet = path.join(root, STYLESHEET);
  const [result, workers] = (await Promise.all([
    build({ ...options, entryPoints: entries.page, splitting: true, chunkNames: 'src/chunks/[name]-[hash]' }),
    build({ ...options, entryPoints: entries.workers }),
    build({ absWorkingDir: root, entryPoints: { [STYLESHEET.slice(0, -'.css'.length)]: STYLESHEET }, outdir: options.outdir, bundle: true, target: TARGET,
      plugins: [stylesheetAssets(root, sheet)], logLevel: 'warning' }),
  ]));
  // The metafile names files relative to the working directory.
  const prefix = `${path.relative(root, output).split(path.sep).join('/')}/`;
  const preloads = new Set();
  for (const entry of LAUNCH_ENTRIES) for (const file of launchFiles(result.metafile, prefix + entry)) preloads.add(`./${file.slice(prefix.length)}`);
  // Each script's tables of where its lines came from, for crash reports; the maps are then deleted. A worker's own are written
  // at the start of its first line (no line moves); the page's are one classic script, run before any module.
  const tablesOf = async (metafile) => {
    const tables = [];
    for (const file of Object.keys(metafile.outputs).filter((name) => name.endsWith('.mjs'))) {
      const map = JSON.parse(await readFile(path.join(root, `${file}.map`), 'utf8'));
      tables.push([path.join(root, file), frameTable(map)]);
      await rm(path.join(root, `${file}.map`));
    }
    return tables;
  };
  const named = (tables) => Object.fromEntries(tables.filter(([, runs]) => runs.length).map(([file, runs]) => [path.basename(file), runs]));
  await writeFile(path.join(output, FRAME_SCRIPT), `${frameStatement(named(await tablesOf(result.metafile)))}\n`);
  for (const [file, runs] of await tablesOf(workers.metafile)) {
    if (runs.length) await writeFile(file, frameStatement(named([[file, runs]])) + await readFile(file, 'utf8'));
  }
  const html = bundledIndex(await readFile(path.join(root, 'index.html'), 'utf8'), [...preloads].sort());
  await writeFile(path.join(output, 'index.html'), html);
  return { output, files: Object.keys(result.metafile.outputs).length + Object.keys(workers.metafile.outputs).length + 2, preloads: [...preloads].sort() };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const started = performance.now();
  const result = await buildApp();
  console.log(`Bundled ${result.files} files (${result.preloads.length} preloaded at launch) in ${path.relative(process.cwd(), result.output)} in ${Math.round(performance.now() - started)} ms`);
}
