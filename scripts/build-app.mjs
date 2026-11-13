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

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** Electron 39's Chromium. */
const TARGET = 'chrome142';
/** Loaded by the page, by URL, and kept as separate entries. The modules a script imports from the page by URL (the developer tools read
 * the canvas's handles through `canvas-interactions.mjs` and `renderer-geometry.mjs`) and the export renderer the determinism smoke creates
 * are entries so that they meet the application's module and not a second copy; tests/app-bundle.test.mjs keeps the list in step with the
 * developer tools. `engine.mjs` and `playback-metrics.mjs` became entries for a benchmark that `perf/` has replaced; they stay, because
 * taking an entry out changes the bundle's chunks, which is a change of its own to measure (docs/APP-START.md). */
const PAGE_ENTRIES = ['src/app.mjs', 'src/engine/engine-start.mjs', 'src/engine/engine.mjs', 'src/engine/engine-export.mjs', 'src/playback-metrics.mjs', 'src/canvas-interactions.mjs', 'src/renderer-geometry.mjs'];
/** The tables of where the page's and the workers' bundled lines came from (frameTable). Nothing loads them at start: statistics
 * fetch them the first time they describe a problem (src/stats/stack.mjs `loadFrameTables`). */
export const FRAME_TABLES = 'src/frame-map.json';
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

/** A module of ours, by its path in this repository: every module under src/ except the engine's generated glue, anything vendored
 * and the language files (text tables, which a stack never runs through: leaving them out halves the tables). */
export const ourModule = (module) => module.startsWith('src/') && !/(^|\/)(node_modules|pkg|locales)\//.test(module);

/**
 * Where a line of a bundled file came from, for the stack lines statistics send (src/stats/stack.mjs): `{modules, runs}`, where
 * `modules` are paths in this repository ("src/engine/engine-stage.mjs") and each run is `[module index, lastLine, bundleLine,
 * sourceLine, bundleLine, sourceLine, ...]` for lines (1-based, as a stack trace counts them) that came from one module of ours
 * (`ourModule`). A run lists a pair wherever the distance between the two numbers changes, so a line of the run is found from the
 * last pair at or before it. `moduleOf` turns a source of the map into its path in this repository.
 */
export function frameTable(map, moduleOf = (source) => source, ours = ourModule) {
  const names = map.sources.map(moduleOf);
  const modules = [], index = new Map(), runs = [];
  let run = null;
  mappedLines(map.mappings).forEach((entry, line) => {
    if (!entry) return;
    const module = names[entry[0]], bundleLine = line + 1, sourceLine = entry[1] + 1;
    if (!ours(module)) { run = null; return; }
    if (!index.has(module)) { index.set(module, modules.length); modules.push(module); }
    const at = index.get(module);
    if (!run || run[0] !== at) runs.push(run = [at, bundleLine, bundleLine, sourceLine]);
    else if (sourceLine - bundleLine !== run.at(-1) - run.at(-2)) run.push(bundleLine, sourceLine);
    run[1] = bundleLine;
  });
  return { modules, runs };
}

/** A source of a script's map as its path in `root`. The bundler names a source relative to the map's `folder`, or as a file: URL
 * when the output is on another drive than the sources (a temporary folder on Windows). */
export const sourceModule = (root, folder, source) =>
  path.relative(root, source.startsWith('file:') ? fileURLToPath(source) : path.resolve(folder, source)).split(path.sep).join('/');

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
  return html.slice(0, first) + links + html.slice(first).replace(line, '');
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
  // The metafile names files relative to the working directory, or in full when the output is on another drive (path.resolve takes both).
  const prefix = `${path.relative(root, output).split(path.sep).join('/')}/`;
  const preloads = new Set();
  for (const entry of LAUNCH_ENTRIES) for (const file of launchFiles(result.metafile, prefix + entry)) preloads.add(`./${file.slice(prefix.length)}`);
  // Each script's table of where its lines came from, for statistics' stack lines, all in one file; the maps are then deleted.
  const tablesOf = async (metafile) => {
    const tables = [];
    for (const file of Object.keys(metafile.outputs).filter((name) => name.endsWith('.mjs'))) {
      const map = JSON.parse(await readFile(path.resolve(root, `${file}.map`), 'utf8'));
      const folder = path.dirname(path.resolve(root, file));
      tables.push([path.resolve(root, file), frameTable(map, (source) => sourceModule(root, folder, source))]);
      await rm(path.resolve(root, `${file}.map`));
    }
    return tables;
  };
  const named = (tables) => Object.fromEntries(tables.filter(([, table]) => table.runs.length).map(([file, table]) => [path.basename(file), table]));
  await writeFile(path.join(output, FRAME_TABLES), `${JSON.stringify(named([...await tablesOf(result.metafile), ...await tablesOf(workers.metafile)]))}\n`);
  const html = bundledIndex(await readFile(path.join(root, 'index.html'), 'utf8'), [...preloads].sort());
  await writeFile(path.join(output, 'index.html'), html);
  return { output, files: Object.keys(result.metafile.outputs).length + Object.keys(workers.metafile.outputs).length + 2, preloads: [...preloads].sort() };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const started = performance.now();
  const result = await buildApp();
  console.log(`Bundled ${result.files} files (${result.preloads.length} preloaded at launch) in ${path.relative(process.cwd(), result.output)} in ${Math.round(performance.now() - started)} ms`);
}
