import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, readdir, rm, stat} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
import {sanitizeError} from '../src/telemetry-schema.mjs';
import {appEntries, bundledIndex, buildApp} from '../scripts/build-app.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function* sources(directory) {
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'pkg') yield* sources(full); }
    else if (entry.name.endsWith('.mjs')) yield full;
  }
}

test('every worker the application starts is an entry of the bundle, at the path its URL names', async () => {
  const {workers} = await appEntries(root);
  const entries = new Set(Object.values(workers));
  const started = new Set();
  for await (const file of sources(path.join(root, 'src'))) {
    for (const [, target] of (await readFile(file, 'utf8')).matchAll(/new URL\(\s*["'](\.[^"']*-worker\.mjs)["']\s*,\s*import\.meta\.url/g)) {
      started.add(path.relative(root, path.resolve(path.dirname(file), target)).split(path.sep).join('/'));
    }
  }
  assert.ok(started.size >= 10, `found ${started.size} workers`);
  for (const worker of started) assert.ok(entries.has(worker), `${worker} is a bundle entry`);
});

test('the modules the benchmark imports from the page are bundle entries, so it meets the running application, not a second copy', async () => {
  const {page} = await appEntries(root);
  const imported = [...(await readFile(path.join(root, 'scripts/benchmark-app.mjs'), 'utf8')).matchAll(/import\('\/(src\/[^']+\.mjs)'\)/g)].map(match => match[1]);
  assert.ok(imported.length >= 4, `found ${imported.length} imports`);
  for (const file of imported) assert.ok(Object.values(page).includes(file), `${file} is a page entry`);
});

test('the bundled page preloads the bundle where the page preloaded the modules', () => {
  const html = [
    '<head>',
    '    <link rel="icon" href="./mark.svg" />',
    '    <link rel="modulepreload" href="./src/engine/engine-start.mjs" />',
    '    <link rel="modulepreload" href="./src/engine/engine.mjs" />',
    '    <script src="./src/theme-bootstrap.js"></script>',
    '    <link rel="preload" href="./x.wasm" as="fetch" />',
    '</head>',
  ].join('\n');
  assert.equal(bundledIndex(html, ['./src/app.mjs', './src/chunks/a.mjs']), [
    '<head>',
    '    <link rel="icon" href="./mark.svg" />',
    '    <link rel="modulepreload" href="./src/app.mjs" />',
    '    <link rel="modulepreload" href="./src/chunks/a.mjs" />',
    '    <script src="./src/frame-map.js"></script>',
    '    <script src="./src/theme-bootstrap.js"></script>',
    '    <link rel="preload" href="./x.wasm" as="fetch" />',
    '</head>',
  ].join('\n'));
  assert.throws(() => bundledIndex('<head></head>', []), /no modulepreload links/);
});

test('the bundle holds the page, its workers and the chunks they share, and refers to nothing it lacks', async t => {
  const output = await mkdtemp(path.join(os.tmpdir(), 'styk-bundle-'));
  t.after(() => rm(output, {recursive: true, force: true}));
  const result = await buildApp({root, output});
  const {page, workers} = await appEntries(root);
  for (const file of [...Object.values(page), ...Object.values(workers)]) assert.ok((await stat(path.join(output, file))).isFile(), `${file} is built`);
  const index = await readFile(path.join(output, 'index.html'), 'utf8');
  assert.match(index, /<script type="module" src="\.\/src\/app\.mjs">/);
  assert.match(index, /rel="preload" href="\.\/src\/engine\/pkg\/styk_engine_bg\.wasm"/);
  assert.ok(result.preloads.includes('./src/app.mjs') && result.preloads.includes('./src/engine/engine-start.mjs'));
  assert.ok(result.preloads.length < 15, `${result.preloads.length} files load at launch`);
  for (const href of result.preloads) assert.ok((await stat(path.join(output, href))).isFile(), `${href} exists`);
  // The module graph is one: a page script that imports the engine meets the application's engine, not another copy.
  const engineChunks = [...(await readFile(path.join(output, 'src/engine/engine.mjs'), 'utf8')).matchAll(/chunks\/[^"']+\.mjs/g)].map(match => `./src/${match[0]}`);
  assert.ok(engineChunks.length > 0 && engineChunks.every(chunk => result.preloads.includes(chunk)));
  // Modules find their neighbours by their own path: nothing may be left asking the bundle's file for it.
  for (const file of [...Object.values(page), ...Object.values(workers)]) assert.ok(!(await readFile(path.join(output, file), 'utf8')).includes('import.meta.url'), `${file} has no import.meta.url`);
});

test('the bundled stylesheet is one file whose fonts and images are found from where it is served', async t => {
  const output = await mkdtemp(path.join(os.tmpdir(), 'styk-bundle-css-'));
  t.after(() => rm(output, {recursive: true, force: true}));
  await buildApp({root, output});
  const css = await readFile(path.join(output, 'src/styles/app.css'), 'utf8');
  assert.ok(!/@import/.test(css), 'no @import is left to fetch');
  assert.match(css, /@layer\s+legacy,\s*reset,\s*tokens,\s*base,\s*layout,\s*components,\s*features,\s*states,\s*utilities\s*;/);
  assert.match(css, /@layer legacy\s*\{/);
  const urls = [...css.matchAll(/url\(\s*(["']?)([^)"']+)\1\s*\)/g)].map(match => match[2]).filter(url => !/^(data:|#|https?:)/.test(url));
  assert.ok(urls.some(url => url.endsWith('.woff2')), 'the fonts are referenced');
  for (const url of urls) assert.ok((await stat(path.resolve(root, 'src/styles', url))).isFile(), `${url} exists from src/styles/`);
});

const BACKSLASH = String.fromCharCode(92);
/** Every line of the page's built scripts, by file. */
async function builtLines(output) {
  const files = ['src/app.mjs', ...(await readdir(path.join(output, 'src/chunks'))).map(name => `src/chunks/${name}`)];
  return new Map(await Promise.all(files.map(async file => [file, (await readFile(path.join(output, file), 'utf8')).split('\n')])));
}

test('the bundle is readable, keeps the vendored licence header, and leaves no source maps behind', async t => {
  const output = await mkdtemp(path.join(os.tmpdir(), 'styk-bundle-readable-'));
  t.after(() => rm(output, {recursive: true, force: true}));
  await buildApp({root, output});
  const lines = await builtLines(output);
  const all = [...lines.values()].flat();
  assert.ok(all.includes('// src/engine/engine-owner.mjs'), 'modules are told apart by their path comments, as unminified output does');
  assert.ok(all.some(line => line.includes('opentype.js.org') && line.includes('MIT License')), 'opentype.js keeps its MIT header');
  for (const directory of ['src', 'src/chunks', 'src/engine']) assert.ok(!(await readdir(path.join(output, directory))).some(name => name.endsWith('.map')), `no source map in ${directory}`);
});

test('a frame in a built script is reported as the module and source line it came from', async t => {
  const output = await mkdtemp(path.join(os.tmpdir(), 'styk-bundle-frames-'));
  t.after(() => rm(output, {recursive: true, force: true}));
  await buildApp({root, output});
  const index = await readFile(path.join(output, 'index.html'), 'utf8');
  assert.ok(index.indexOf('src/frame-map.js') > 0 && index.indexOf('src/frame-map.js') < index.indexOf('src/theme-bootstrap.js'), 'the tables load before anything else');
  const context = vm.createContext({});
  vm.runInContext(await readFile(path.join(output, 'src/frame-map.js'), 'utf8'), context);
  const lines = await builtLines(output);
  const seen = [];
  globalThis.__stykFrames = context.__stykFrames;
  try {
    // For some single-line statements of modules reports may name, the line the built file has them on must report the source line.
    for (const [module, file] of ['src/app.mjs', 'src/editor.mjs', 'src/import-client.mjs', 'src/document-export.mjs', 'src/camera-monitor.mjs', 'src/renderer-geometry.mjs', 'src/engine/engine-owner.mjs', 'src/engine/engine-stage.mjs', 'src/engine/engine-open.mjs', 'src/engine/engine-playback.mjs', 'src/engine/engine-previews.mjs', 'src/engine/engine-failure.mjs', 'src/engine/engine-composite.mjs', 'src/engine/engine-thumbnails.mjs', 'src/engine/engine-document.mjs'].map(file => [path.basename(file), file])) {
      const source = (await readFile(path.join(root, file), 'utf8')).split('\n');
      for (const [index, line] of source.entries()) {
        const text = line.trim();
        if (!['const ', 'throw ', 'export const '].some(start => text.startsWith(start)) || !text.endsWith(';') || text.includes(BACKSLASH) || text.includes('"')) continue;
        const literal = text.split("'").filter((part, position) => position % 2 === 1).sort((a, b) => b.length - a.length)[0] ?? '';
        if (literal.length < 30 || source.filter(other => other.includes(literal)).length !== 1) continue;
        const where = [...lines].flatMap(([name, built]) => built.flatMap((builtLine, number) => builtLine.includes(literal) ? [[name, number + 1]] : []));
        if (where.length !== 1) continue;
        const [name, number] = where[0];
        const stack = `Error: SECRET\n    at f (styk-app://app/${name}:${number}:11)`;
        assert.deepEqual(sanitizeError(Object.assign(new Error('SECRET'), {stack}), 'app').frames, [{module, line: index + 1}], `${module}:${index + 1} at ${name}:${number}`);
        seen.push(module);
        break;
      }
    }
    assert.ok(seen.length >= 3, `checked ${seen.join(', ')}`);
    // A line of a module reports may not name reports nothing.
    const timeline = lines.get('src/app.mjs').findIndex(line => line === '// src/layer-timeline.mjs');
    if (timeline >= 0) assert.deepEqual(sanitizeError(Object.assign(new Error('SECRET'), {stack: `Error\n    at f (styk-app://app/src/app.mjs:${timeline + 3}:1)`}), 'app').frames, []);
  } finally { delete globalThis.__stykFrames; }
  // A worker carries its own table at the start of its first line, which moves no line.
  const worker = (await readFile(path.join(output, 'src/import-worker.mjs'), 'utf8')).split('\n');
  assert.ok(worker[0].startsWith('globalThis.__stykFrames=Object.assign(globalThis.__stykFrames??{},{"import-worker.mjs":'), worker[0].slice(0, 80));
});

/** The modules a page script imports by URL, as `src/x.mjs`. */
function pageImports(text) {
  const found = new Set();
  for (let at = text.indexOf("import('/src/"); at >= 0; at = text.indexOf("import('/src/", at + 1)) {
    const start = at + "import('/".length;
    found.add(text.slice(start, text.indexOf("'", start)));
  }
  return found;
}

test('a smoke imports from the page only modules that are the same on a bundled app, or none the application keeps state in', async () => {
  // Imported by URL, a module that is not a bundle entry is a second copy beside the application's own (the bundle has its own
  // modules inside), so a smoke that changes or reads the application's state through one fails on a packaged app: use window.styk.
  // These keep no state of the application's (pure functions, or classes made new for the script):
  const separateCopyIsFine = new Set(['src/codec-job.mjs', 'src/codec-request.mjs', 'src/native-files.mjs', 'src/import-client.mjs', 'src/library-files.mjs', 'src/demo.mjs',
    'src/theme.mjs' /* sets the document's attributes, which is what the smoke looks at */]);
  const {page} = await appEntries(root);
  const entries = new Set(Object.values(page));
  let imports = 0;
  for (const name of (await readdir(path.join(root, 'scripts'))).filter(name => name.startsWith('smoke-') && name.endsWith('.mjs'))) {
    for (const module of pageImports(await readFile(path.join(root, 'scripts', name), 'utf8'))) {
      imports++;
      assert.ok(entries.has(module) || separateCopyIsFine.has(module), `${name} imports ${module} from the page: it is a second copy on a bundled app`);
    }
  }
  assert.ok(imports >= 10, `found ${imports} imports`);
});
