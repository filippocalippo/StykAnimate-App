import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, readdir, rm, stat} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
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
    '    <link rel="preload" href="./x.wasm" as="fetch" />',
    '</head>',
  ].join('\n');
  assert.equal(bundledIndex(html, ['./src/app.mjs', './src/chunks/a.mjs']), [
    '<head>',
    '    <link rel="icon" href="./mark.svg" />',
    '    <link rel="modulepreload" href="./src/app.mjs" />',
    '    <link rel="modulepreload" href="./src/chunks/a.mjs" />',
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
