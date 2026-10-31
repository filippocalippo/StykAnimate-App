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
/** Loaded by the page, by URL, and kept as separate entries: `engine.mjs` so that a script importing it from the page
 * (the benchmark reads the engine's memory) meets the application's engine rather than a second copy. */
const PAGE_ENTRIES = ['src/app.mjs', 'src/engine/engine-start.mjs', 'src/engine/engine.mjs'];
/** The entries the page loads at launch: their static imports are preloaded. */
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

/** Modules locate their neighbours with `new URL('./x', import.meta.url)`; in a bundle `import.meta.url` is the
 * bundle's file, so each module's own path is written in its place. */
function importMetaUrl(root) {
  return {
    name: 'import-meta-url',
    setup(build) {
      build.onLoad({ filter: /\.m?js$/ }, async ({ path: file }) => {
        const relative = path.relative(root, file);
        if (relative.startsWith('..') || relative.split(path.sep).includes('node_modules')) return null;
        const text = await readFile(file, 'utf8');
        if (!text.includes('import.meta.url')) return null;
        const url = `(self.location.origin+${JSON.stringify(`/${relative.split(path.sep).join('/')}`)})`;
        return { contents: text.replaceAll('import.meta.url', url), loader: 'js' };
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

/** Builds the bundle. Needs the engine built (src/engine/pkg/styk_engine.js). */
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
    minify: true,
    // Code that reaches Node (guarded by a check for it) stays a plain import, never run in the page.
    external: ['node:*', 'fs'],
    plugins: [importMetaUrl(root)],
    metafile: true,
    logLevel: 'warning',
  };
  const [result, workers] = await Promise.all([
    build({ ...options, entryPoints: entries.page, splitting: true, chunkNames: 'src/chunks/[name]-[hash]' }),
    build({ ...options, entryPoints: entries.workers }),
  ]);
  // The metafile names files relative to the working directory.
  const prefix = `${path.relative(root, output).split(path.sep).join('/')}/`;
  const preloads = new Set();
  for (const entry of LAUNCH_ENTRIES) for (const file of launchFiles(result.metafile, prefix + entry)) preloads.add(`./${file.slice(prefix.length)}`);
  const html = bundledIndex(await readFile(path.join(root, 'index.html'), 'utf8'), [...preloads].sort());
  await writeFile(path.join(output, 'index.html'), html);
  return { output, files: Object.keys(result.metafile.outputs).length + Object.keys(workers.metafile.outputs).length + 1, preloads: [...preloads].sort() };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const started = performance.now();
  const result = await buildApp();
  console.log(`Bundled ${result.files} files (${result.preloads.length} preloaded at launch) in ${path.relative(process.cwd(), result.output)} in ${Math.round(performance.now() - started)} ms`);
}
